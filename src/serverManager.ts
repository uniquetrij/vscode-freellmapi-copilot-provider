import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig, getServerConfig } from './config';
import { getOutputChannel, getServerOutputChannel } from './output';
import { getSettingName } from './runtimeMode';
import { getApiKey } from './secrets';
import { modelsUrl, originFromBaseUrl, pingUrl } from './urls';

const MAX_LOG_LINES = 80;
const READY_POLL_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 2_500;
const STOP_COMMAND_TIMEOUT_MS = 30_000;

export type ServerHealth = {
	readonly reachable: boolean;
	readonly checkedAt: number;
	readonly detail: string;
	readonly url: string;
};

export type StartResult = {
	readonly started: boolean;
	readonly message: string;
};

export type StopResult = {
	readonly stopped: boolean;
	readonly message: string;
};

type ResolvedStart = {
	readonly command: string;
	readonly cwd: string;
	readonly port?: number;
};

export class ServerManager {
	private readonly _onDidChangeHealth = new vscode.EventEmitter<ServerHealth>();
	readonly onDidChangeHealth = this._onDidChangeHealth.event;

	private child: ChildProcess | undefined;
	private startPromise: Promise<StartResult> | undefined;
	private lastHealth: ServerHealth | undefined;
	private readonly logLines: string[] = [];

	constructor(private readonly secrets: vscode.SecretStorage) {}

	dispose(): void {
		this._onDidChangeHealth.dispose();
		if (this.child) {
			getOutputChannel().info(
				`FreeLLMAPI server (pid ${this.child.pid}) is still running; use "FreeLLMAPI: Stop Server" to stop it.`
			);
		}
	}

	isManaged(): boolean {
		return this.child !== undefined;
	}

	getLastHealth(): ServerHealth | undefined {
		return this.lastHealth;
	}

	getTail(lines = 20): string {
		return this.logLines.slice(-lines).join('\n');
	}

	async probe(): Promise<ServerHealth> {
		let baseUrl: string;
		try {
			baseUrl = getConfig().baseUrl;
		} catch (err) {
			return this.recordHealth(false, err instanceof Error ? err.message : String(err), '');
		}

		const ping = pingUrl(baseUrl);
		try {
			const response = await fetch(ping, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			});
			if (response.ok) {
				return this.recordHealth(true, `HTTP ${response.status} from /api/ping`, ping);
			}

			// Reverse proxies often leave /api/ping unrouted or gated while /v1/*
			// works. A 401/403 from the catalog still proves the gateway is alive.
			if (response.status === 404 || response.status === 401 || response.status === 403) {
				const models = await this.probeCatalog(baseUrl);
				if (models) {
					return models;
				}
			}
			return this.recordHealth(false, `HTTP ${response.status} from /api/ping`, ping);
		} catch (err) {
			return this.recordHealth(false, describeProbeError(err), ping);
		}
	}

	private async probeCatalog(baseUrl: string): Promise<ServerHealth | undefined> {
		const key = await getApiKey(this.secrets);
		const url = modelsUrl(baseUrl);
		try {
			const response = await fetch(url, {
				headers: {
					accept: 'application/json',
					...(key ? { authorization: `Bearer ${key}` } : {}),
				},
				signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			});
			if (response.status === 200 || response.status === 401 || response.status === 403) {
				return this.recordHealth(true, `HTTP ${response.status} from /v1/models`, url);
			}
			return this.recordHealth(false, `HTTP ${response.status} from /v1/models`, url);
		} catch {
			return undefined;
		}
	}

	private recordHealth(reachable: boolean, detail: string, url: string): ServerHealth {
		const health: ServerHealth = { reachable, checkedAt: Date.now(), detail, url };
		const changed = this.lastHealth?.reachable !== health.reachable;
		this.lastHealth = health;
		if (changed) {
			this._onDidChangeHealth.fire(health);
		}
		return health;
	}

	async start(): Promise<StartResult> {
		if (this.startPromise) {
			return this.startPromise;
		}
		const pending = this.startInternal();
		this.startPromise = pending;
		try {
			return await pending;
		} finally {
			if (this.startPromise === pending) {
				this.startPromise = undefined;
			}
		}
	}

	private async startInternal(): Promise<StartResult> {
		const output = getOutputChannel();
		const existing = await this.probe();
		if (existing.reachable) {
			const message = `FreeLLMAPI is already reachable at ${originFromBaseUrl(getConfig().baseUrl)}.`;
			output.info(message);
			return { started: false, message };
		}

		if (this.child) {
			await this.waitForReady(this.child);
			return { started: false, message: 'FreeLLMAPI is already starting.' };
		}

		const resolved = resolveStartCommand();
		output.info(`Starting FreeLLMAPI: ${resolved.command} (cwd: ${resolved.cwd})`);

		const child = spawnShellCommand(resolved.command, resolved.cwd, resolved.port);
		this.child = child;
		this.attachChild(child);

		try {
			await this.waitForReady(child);
		} catch (err) {
			await this.stopProcess(child);
			throw err;
		}
		return {
			started: true,
			message: `FreeLLMAPI started at ${originFromBaseUrl(getConfig().baseUrl)}.`,
		};
	}

	private attachChild(child: ChildProcess): void {
		const serverLog = getServerOutputChannel();
		serverLog.append(`\n[FreeLLMAPI] started pid=${child.pid ?? 'unknown'}\n`);

		child.stdout?.on('data', (chunk: Buffer) => this.appendLog(chunk.toString()));
		child.stderr?.on('data', (chunk: Buffer) => this.appendLog(chunk.toString()));
		child.on('error', (err) => {
			this.appendLog(`[FreeLLMAPI] failed to start: ${err.message}\n`);
		});
		child.on('exit', (code, signal) => {
			this.appendLog(`\n[FreeLLMAPI] exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
			if (this.child === child) {
				this.child = undefined;
			}
			void this.probe();
		});
	}

	private appendLog(chunk: string): void {
		getServerOutputChannel().append(chunk);
		for (const line of chunk.split(/\r?\n/)) {
			if (line.trim().length > 0) {
				this.logLines.push(line);
			}
		}
		while (this.logLines.length > MAX_LOG_LINES) {
			this.logLines.shift();
		}
	}

	private async waitForReady(child: ChildProcess): Promise<void> {
		const config = getConfig();
		const timeoutMs = getServerConfig().startTimeoutSeconds * 1_000;
		const deadline = Date.now() + timeoutMs;
		const target = pingUrl(config.baseUrl);

		while (Date.now() < deadline) {
			if (this.child !== child) {
				// A one-shot command such as `docker compose up -d` exits successfully
				// before the container answers. Keep polling for the service it
				// launched instead of treating the exit as a startup failure.
				if (child.exitCode !== 0) {
					throw new Error(
						`FreeLLMAPI exited before it became reachable.\n\n${this.getTail(30) || '(no output)'}`
					);
				}
			}
			const health = await this.probe();
			if (health.reachable) {
				getOutputChannel().info(`FreeLLMAPI is ready: ${health.detail}`);
				return;
			}
			await delay(READY_POLL_INTERVAL_MS);
		}

		await this.stopProcess(child);
		throw new Error(
			`FreeLLMAPI did not answer at ${target} within ${Math.round(timeoutMs / 1000)}s.\n\n` +
			`${this.getTail(30) || '(no output)'}\n\n` +
			`Configure "${getSettingName('server.path')}" or "${getSettingName('server.startCommand')}" if auto-detection picked the wrong checkout.`
		);
	}

	async stop(): Promise<StopResult> {
		const output = getOutputChannel();
		const config = getServerConfig();
		let stopped = false;
		const messages: string[] = [];

		if (config.stopCommand) {
			const cwd = resolveServerPath(config.path);
			output.info(`Stopping FreeLLMAPI: ${config.stopCommand} (cwd: ${cwd})`);
			const result = await runShellCommand(config.stopCommand, cwd, STOP_COMMAND_TIMEOUT_MS);
			if (result.code !== 0) {
				messages.push(`Stop command exited with code ${result.code ?? 'null'}.`);
			}
			stopped = true;
		}

		const child = this.child;
		if (child) {
			await this.stopProcess(child);
			stopped = true;
			messages.push('Terminated the process started by this extension.');
		}

		if (!stopped) {
			return {
				stopped: false,
				message: `FreeLLMAPI was not started by this extension. Start it with "FreeLLMAPI: Start Server" or configure "${getSettingName('server.stopCommand')}".`,
			};
		}

		if (config.stopCommand) {
			const health = await this.probe();
			if (health.reachable) {
				messages.push(`The gateway is still answering at ${health.url}.`);
			}
		}

		return {
			stopped: true,
			message: messages.join(' ') || 'FreeLLMAPI stopped.',
		};
	}

	private async stopProcess(child: ChildProcess): Promise<void> {
		const pid = child.pid;
		if (!pid || child.exitCode !== null) {
			return;
		}

		if (process.platform === 'win32') {
			await runCommand('taskkill.exe', ['/pid', String(pid), '/T', '/F'], 15_000);
		} else {
			try {
				process.kill(-pid, 'SIGTERM');
			} catch {
				child.kill('SIGTERM');
			}
			const exited = await waitForExit(child, 5_000);
			if (!exited) {
				try {
					process.kill(-pid, 'SIGKILL');
				} catch {
					child.kill('SIGKILL');
				}
			}
		}

		if (this.child === child) {
			this.child = undefined;
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeProbeError(err: unknown): string {
	const code = (err as { code?: unknown; cause?: { code?: unknown } })?.cause?.code
		?? (err as { code?: unknown })?.code;
	if (typeof code === 'string') {
		return `${code}: ${err instanceof Error ? err.message : String(err)}`;
	}
	return err instanceof Error ? err.message : String(err);
}

function resolveStartCommand(): ResolvedStart {
	const config = getServerConfig();
	const cwd = resolveServerPath(config.path);
	const port = configuredPort();

	if (config.startCommand) {
		return { command: config.startCommand, cwd, port };
	}

	const root = cwd;
	const candidates: Array<{ command: string; port?: number; label: string }> = [];

	if (fs.existsSync(path.join(root, 'server', 'dist', 'index.js'))) {
		candidates.push({
			command: `node ${quoteForShell(path.join('server', 'dist', 'index.js'))}`,
			port,
			label: 'server/dist/index.js',
		});
	}

	if (fs.existsSync(path.join(root, 'dist', 'index.js'))) {
		candidates.push({
			command: `node ${quoteForShell(path.join('dist', 'index.js'))}`,
			port,
			label: 'dist/index.js',
		});
	}

	const rootPackage = readPackageJson(path.join(root, 'package.json'));
	const serverPackage = readPackageJson(path.join(root, 'server', 'package.json'));
	const workspaces = rootPackage?.workspaces;
	const hasServerWorkspace = Array.isArray(workspaces)
		? workspaces.includes('server')
		: Array.isArray(workspaces?.packages) && workspaces.packages.includes('server');

	if (serverPackage || hasServerWorkspace) {
		candidates.push({
			command: 'npm run dev -w server',
			port,
			label: 'npm workspace server',
		});
	}
	if (rootPackage?.scripts?.['dev:server']) {
		candidates.push({ command: 'npm run dev:server', port, label: 'dev:server script' });
	}
	if (rootPackage?.scripts?.dev && !hasServerWorkspace) {
		candidates.push({ command: 'npm run dev', port, label: 'dev script' });
	}

	for (const composeFile of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
		if (fs.existsSync(path.join(root, composeFile))) {
			candidates.push({ command: 'docker compose up -d', label: composeFile });
			break;
		}
	}

	if (candidates.length === 0) {
		throw new Error(
			`Could not find a FreeLLMAPI checkout to start in ${root}.\n\n` +
			`Set "${getSettingName('server.path')}" to the checkout, or set "${getSettingName('server.startCommand')}" ` +
			'to the command that starts your gateway (for example "docker compose up -d").'
		);
	}

	// The first candidate is the most specific for a source checkout. A compose
	// file is a last resort because it starts a detached container that this
	// extension cannot terminate as a child process.
	const selected = candidates[0];
	return { command: selected.command, cwd, port: selected.port };
}

function configuredPort(): number | undefined {
	try {
		const url = new URL(getConfig().baseUrl);
		if (!url.port) {
			return undefined;
		}
		const port = Number(url.port);
		return Number.isInteger(port) && port > 0 ? port : undefined;
	} catch {
		return undefined;
	}
}

function resolveServerPath(configuredPath: string): string {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	let root: string;

	if (configuredPath) {
		const expanded = configuredPath.startsWith('~')
			? path.join(os.homedir(), configuredPath.slice(1))
			: configuredPath;
		root = path.isAbsolute(expanded)
			? expanded
			: path.resolve(workspaceRoot ?? process.cwd(), expanded);
	} else {
		root = workspaceRoot ?? process.cwd();
	}

	if (!fs.existsSync(root)) {
		throw new Error(`FreeLLMAPI server path does not exist: ${root}`);
	}
	return root;
}

type PackageJson = {
	scripts?: Record<string, string>;
	workspaces?: string[] | { packages?: string[] };
};

function readPackageJson(file: string): PackageJson | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as PackageJson;
	} catch {
		return undefined;
	}
}

function quoteForShell(value: string): string {
	return `"${value.replace(/"/g, '\\"')}"`;
}

function spawnShellCommand(command: string, cwd: string, port: number | undefined): ChildProcess {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...(port !== undefined ? { PORT: String(port) } : {}),
	};

	if (process.platform === 'win32') {
		const comspec = process.env.ComSpec || 'cmd.exe';
		return spawn(comspec, ['/d', '/s', '/c', command], {
			cwd,
			env,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	}

	return spawn('/bin/sh', ['-lc', command], {
		cwd,
		env,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

async function runShellCommand(
	command: string,
	cwd: string,
	timeoutMs: number
): Promise<{ code: number | null; output: string }> {
	const child = spawnShellCommand(command, cwd, undefined);
	const chunks: string[] = [];
	child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
	child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

	const timer = setTimeout(() => {
		try {
			child.kill('SIGTERM');
		} catch {
			// Best-effort; the exit handler below still resolves the wait.
		}
	}, timeoutMs);

	const code = await new Promise<number | null>((resolve) => {
		child.on('error', () => resolve(null));
		child.on('exit', (exitCode) => resolve(exitCode));
	});
	clearTimeout(timer);

	const output = chunks.join('');
	if (output.trim().length > 0) {
		getServerOutputChannel().append(output);
	}
	return { code, output };
}

async function runCommand(
	command: string,
	args: string[],
	timeoutMs: number
): Promise<void> {
	const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
	const timer = setTimeout(() => child.kill(), timeoutMs);
	await new Promise<void>((resolve) => {
		child.on('error', () => resolve());
		child.on('exit', () => resolve());
	});
	clearTimeout(timer);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null) {
		return true;
	}
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		child.once('exit', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}
