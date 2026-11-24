import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
	DEFAULT_SERVER_PORT,
	DESKTOP_DEFAULT_PORT,
	isLoopbackBaseUrl,
	normalizeBaseUrl,
} from './urls';

/**
 * The FreeLLMAPI desktop app binds an ephemeral-looking but fixed port
 * (31415 by default) instead of the 3001 the server and Docker images use, and
 * keeps it in `config.json` in the app data directory. A gateway on a
 * non-default port is invisible to the `freellmapi.baseUrl` default, so when
 * the configured loopback URL is unreachable the extension looks for one.
 */

const PROBE_TIMEOUT_MS = 1_500;

export interface GatewayDiscoveryHost {
	readFile(path: string): Promise<string | undefined>;
	listDirectories(path: string): Promise<readonly string[]>;
	probe(origin: string): Promise<boolean>;
}

export interface GatewayDiscoveryEnvironment {
	readonly platform: NodeJS.Platform;
	readonly env: Record<string, string | undefined>;
	readonly home: string;
}

export interface DiscoveredGateway {
	readonly origin: string;
	readonly baseUrl: string;
	readonly port: number;
}

export interface ConfigPathCandidates {
	readonly paths: readonly string[];
	/** `%LOCALAPPDATA%\Packages` — Store apps redirect their roaming folder here. */
	readonly packageDirs: string | undefined;
}

export function candidateConfigPaths(environment: GatewayDiscoveryEnvironment): ConfigPathCandidates {
	const { platform, env, home } = environment;
	const paths: string[] = [];
	let packageDirs: string | undefined;

	if (platform === 'win32') {
		const appData = env.APPDATA?.trim();
		const localAppData = env.LOCALAPPDATA?.trim();
		if (appData) {
			paths.push(join(appData, 'FreeLLMAPI', 'config.json'));
		}
		if (localAppData) {
			paths.push(join(localAppData, 'FreeLLMAPI', 'config.json'));
			packageDirs = join(localAppData, 'Packages');
		}
	} else if (platform === 'darwin') {
		paths.push(join(home, 'Library', 'Application Support', 'FreeLLMAPI', 'config.json'));
	} else {
		const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
		paths.push(join(configHome, 'FreeLLMAPI', 'config.json'));
	}

	return { paths, packageDirs };
}

/** Reads the desktop app's `"port"` preference; anything unusable yields undefined. */
export function parseConfiguredPort(text: string | undefined): number | undefined {
	if (!text) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const port = (parsed as { port?: unknown }).port;
	if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535) {
		return port;
	}
	if (typeof port === 'string' && /^\d+$/.test(port.trim())) {
		const numeric = Number(port.trim());
		return numeric > 0 && numeric <= 65_535 ? numeric : undefined;
	}
	return undefined;
}

export async function discoverLoopbackGateway(
	host: GatewayDiscoveryHost,
	environment: GatewayDiscoveryEnvironment,
	configuredBaseUrl: string
): Promise<DiscoveredGateway | undefined> {
	if (!isLoopbackBaseUrl(configuredBaseUrl)) {
		return undefined;
	}

	let configured: URL;
	try {
		configured = new URL(normalizeBaseUrl(configuredBaseUrl));
	} catch {
		return undefined;
	}

	const { paths, packageDirs } = candidateConfigPaths(environment);
	const configPaths = [...paths];
	if (packageDirs) {
		for (const entry of await host.listDirectories(packageDirs)) {
			if (/freellmapi/i.test(entry)) {
				configPaths.push(join(packageDirs, entry, 'LocalCache', 'Roaming', 'FreeLLMAPI', 'config.json'));
			}
		}
	}

	const ports: number[] = [];
	for (const path of configPaths) {
		const port = parseConfiguredPort(await host.readFile(path));
		if (port !== undefined) {
			ports.push(port);
		}
	}
	ports.push(DESKTOP_DEFAULT_PORT, DEFAULT_SERVER_PORT);

	const seen = new Set<number>([portOf(configured)]);
	for (const port of ports) {
		if (seen.has(port)) {
			continue;
		}
		seen.add(port);
		const origin = `${configured.protocol}//${configured.hostname}:${port}`;
		if (await host.probe(origin)) {
			return { origin, baseUrl: `${origin}/v1`, port };
		}
	}
	return undefined;
}

export function createNodeDiscoveryHost(): GatewayDiscoveryHost {
	return {
		async readFile(path) {
			try {
				return await fs.readFile(path, 'utf8');
			} catch {
				return undefined;
			}
		},
		async listDirectories(path) {
			try {
				const entries = await fs.readdir(path, { withFileTypes: true });
				return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
			} catch {
				return [];
			}
		},
		async probe(origin) {
			try {
				const ping = await fetch(`${origin}/api/ping`, {
					headers: { accept: 'application/json' },
					signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
				});
				if (ping.ok) {
					return true;
				}
				if (ping.status !== 401 && ping.status !== 403 && ping.status !== 404) {
					return false;
				}
				// /api/ping may be unrouted behind a proxy; the catalog proves it is
				// a gateway even when the request is unauthenticated.
				const models = await fetch(`${origin}/v1/models`, {
					headers: { accept: 'application/json' },
					signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
				});
				return models.ok || models.status === 401 || models.status === 403;
			} catch {
				return false;
			}
		},
	};
}

function portOf(url: URL): number {
	if (url.port) {
		return Number(url.port);
	}
	return url.protocol === 'https:' ? 443 : 80;
}
