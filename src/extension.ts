import * as os from 'node:os';
import * as vscode from 'vscode';
import { describeBuild } from './buildInfo';
import { fetchModelCatalog } from './catalogClient';
import { getConfig, getServerConfig, setBaseUrlOverride } from './config';
import { fetchDesktopUnifiedKey, type AdoptedDesktopKey } from './desktopKey';
import { safeJson, serializeError } from './diagnostics';
import { formatHttpError, formatUnreachable } from './errors';
import { createNodeDiscoveryHost, discoverLoopbackGateway, type DiscoveredGateway } from './gatewayDiscovery';
import { getOutputChannel, getServerOutputChannel } from './output';
import { FreeLlmApiChatProvider } from './provider';
import { getRuntimeIdentity, getSettingName, getVendorId, initializeRuntimeMode } from './runtimeMode';
import { clearApiKey, getApiKey, setApiKey } from './secrets';
import { ServerManager, type ServerHealth } from './serverManager';
import { resolveThinkingPartConstructor } from './thinkingParts';
import { dashboardUrl, normalizeBaseUrl, originFromBaseUrl, usageUrl } from './urls';

// Resolved from the loaded manifest in activate(); the disk copy is a safe
// early value because every use runs after activation.
let CONFIG = getRuntimeIdentity().commandNamespace;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	initializeRuntimeMode(context);
	CONFIG = getRuntimeIdentity().commandNamespace;
	const output = getOutputChannel();
	output.info(describeBuild());

	const provider = new FreeLlmApiChatProvider(context);
	const server = new ServerManager(context.secrets);
	context.subscriptions.push(output, provider, server);

	try {
		context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(getVendorId(), provider));
	} catch (err) {
		output.error(
			`Could not register the FreeLLMAPI chat provider: ${err instanceof Error ? err.message : String(err)}`
		);
		void vscode.window.showErrorMessage(
			'FreeLLMAPI requires VS Code 1.104 or newer, which provides the Language Model Chat Provider API.'
		);
		return;
	}

	// Registered before the gateway probe so the provider is in place while the
	// window is still restoring: VS Code snapshots a provider's models when it
	// starts a chat session, and a list that arrives later never reaches that
	// session's picker.
	void warmModelList(context, provider);

	// Probing and port discovery happen after registration so a slow probe
	// cannot delay it; the catalog is refetched below once the port is known.
	const discovered = await detectGateway(server);

	const statusBar = new FreeLlmApiStatusBar(context, provider, server);
	context.subscriptions.push(statusBar);
	statusBar.start();

	context.subscriptions.push(
		vscode.commands.registerCommand(`${CONFIG}.setApiKey`, () => setApiKeyCommand(context, provider)),
		vscode.commands.registerCommand(`${CONFIG}.detectApiKey`, () => detectApiKeyCommand(context, provider, statusBar)),
		vscode.commands.registerCommand(`${CONFIG}.clearApiKey`, () => clearApiKeyCommand(context, provider)),
		vscode.commands.registerCommand(`${CONFIG}.setBaseUrl`, () => setBaseUrlCommand(provider)),
		vscode.commands.registerCommand(`${CONFIG}.refreshModels`, () => refreshModelsCommand(provider, server)),
		vscode.commands.registerCommand(`${CONFIG}.checkConnection`, () => checkConnectionCommand(context, provider, server)),
		vscode.commands.registerCommand(`${CONFIG}.selfTest`, () => selfTestCommand(provider, server)),
		vscode.commands.registerCommand(`${CONFIG}.showUsage`, () => showUsageCommand(context)),
		vscode.commands.registerCommand(`${CONFIG}.startServer`, () => startServerCommand(provider, server, statusBar)),
		vscode.commands.registerCommand(`${CONFIG}.stopServer`, () => stopServerCommand(provider, server, statusBar)),
		vscode.commands.registerCommand(`${CONFIG}.restartServer`, () => restartServerCommand(provider, server, statusBar)),
		vscode.commands.registerCommand(`${CONFIG}.showStatus`, () => showStatusCommand(context, provider, server)),
		vscode.commands.registerCommand(`${CONFIG}.showLogs`, () => getOutputChannel().show(true)),
		vscode.commands.registerCommand(`${CONFIG}.showServerLogs`, () => getServerOutputChannel().show(true)),
		vscode.commands.registerCommand(`${CONFIG}.openDashboard`, () => openDashboardCommand()),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!event.affectsConfiguration(CONFIG)) {
				return;
			}
			if (event.affectsConfiguration(`${CONFIG}.baseUrl`)) {
				setBaseUrlOverride(undefined);
			}
			output.info('FreeLLMAPI configuration changed; refreshing models and status.');
			statusBar.updateInterval();
			void provider.refreshModels(true);
			void statusBar.refresh();
		})
	);

	void announceDetectedGateway(discovered, provider, statusBar);
	void autoStartServer(provider, server);
	void adoptDesktopKeyThenPrompt(context, provider, statusBar);
}

export function deactivate(): void {
	// The gateway is shared by every window and may serve other clients, so a
	// server this extension started is left running. "FreeLLMAPI: Stop Server"
	// stops it deliberately.
}

/**
 * Makes the model list available as early as possible: asks VS Code for it once
 * so the provider is queried during startup instead of on first use, then
 * revalidates the replayed catalog. Without a stored key the replayed models
 * could not be called, so they are dropped instead of offered.
 */
async function warmModelList(
	context: vscode.ExtensionContext,
	provider: FreeLlmApiChatProvider
): Promise<void> {
	try {
		if (!(await getApiKey(context.secrets))) {
			provider.dropReplayedModels();
			return;
		}
		if (vscode.lm?.selectChatModels) {
			await vscode.lm.selectChatModels({ vendor: getVendorId() });
		}
	} catch {
		// The provider logs catalog failures; warming must never break activation.
	}
	void provider.refreshModels();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function setApiKeyCommand(
	context: vscode.ExtensionContext,
	provider: FreeLlmApiChatProvider
): Promise<void> {
	const input = await vscode.window.showInputBox({
		title: 'FreeLLMAPI API Key',
		prompt: 'Enter the unified FreeLLMAPI API key from the dashboard (starts with "freellmapi-").',
		placeHolder: 'freellmapi-...',
		password: true,
		ignoreFocusOut: true,
	});
	if (input === undefined) {
		return;
	}

	const apiKey = input.trim().replace(/^Bearer\s+/i, '');
	if (!apiKey) {
		void vscode.window.showWarningMessage('No API key was entered.');
		return;
	}

	let config;
	try {
		config = getConfig();
	} catch (err) {
		void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
		return;
	}

	const output = getOutputChannel();
	try {
		const result = await fetchModelCatalog(config.baseUrl, apiKey, { timeoutMs: 10_000 });
		if (result.status === 401) {
			const action = await vscode.window.showErrorMessage(
				formatHttpError(401, config.baseUrl),
				'Show Logs'
			);
			if (action === 'Show Logs') {
				output.show(true);
			}
			return;
		}
		if (!result.ok) {
			const action = await vscode.window.showWarningMessage(
				`${formatHttpError(result.status, config.baseUrl, result.body)} Save it anyway?`,
				'Save Anyway',
				'Cancel'
			);
			if (action !== 'Save Anyway') {
				return;
			}
		}

		await setApiKey(context.secrets, apiKey);
		await provider.refreshModels(true);
		output.info(`FreeLLMAPI API key saved (${result.models.length} model(s) listed).`);
		void vscode.window.showInformationMessage(
			result.models.length > 0
				? `FreeLLMAPI API key saved. ${result.models.length} model(s) available.`
				: 'FreeLLMAPI API key saved.'
		);
	} catch (err) {
		const message = `${err instanceof Error ? err.message : String(err)} Save the key anyway?`;
		const action = await vscode.window.showWarningMessage(message, 'Save Anyway', 'Cancel');
		if (action !== 'Save Anyway') {
			return;
		}
		await setApiKey(context.secrets, apiKey);
		await provider.refreshModels(true);
		output.warn('Saved the FreeLLMAPI API key without verifying it against the server.');
		void vscode.window.showInformationMessage('FreeLLMAPI API key saved.');
	}
}

async function clearApiKeyCommand(
	context: vscode.ExtensionContext,
	provider: FreeLlmApiChatProvider
): Promise<void> {
	await clearApiKey(context.secrets);
	await provider.refreshModels(true);
	void vscode.window.showInformationMessage(
		'FreeLLMAPI API key cleared. The model picker will be empty until a key is set.'
	);
}

async function setBaseUrlCommand(provider: FreeLlmApiChatProvider): Promise<void> {
	let current: string;
	try {
		current = getConfig().rawBaseUrl;
	} catch {
		current = 'http://127.0.0.1:3001/v1';
	}

	const input = await vscode.window.showInputBox({
		title: 'FreeLLMAPI Base URL',
		prompt: 'Base URL of the OpenAI-compatible API. The /v1 path is added when missing.',
		value: current,
		placeHolder: 'http://127.0.0.1:3001/v1',
		ignoreFocusOut: true,
	});
	if (input === undefined) {
		return;
	}

	try {
		const normalized = normalizeBaseUrl(input);
		await vscode.workspace
			.getConfiguration(CONFIG)
			.update('baseUrl', normalized, vscode.ConfigurationTarget.Global);
		setBaseUrlOverride(undefined);
		await provider.refreshModels(true);
		void vscode.window.showInformationMessage(`FreeLLMAPI base URL set to ${normalized}.`);
	} catch (err) {
		void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
	}
}

async function refreshModelsCommand(
	provider: FreeLlmApiChatProvider,
	server: ServerManager
): Promise<void> {
	const output = getOutputChannel();
	const health = await server.probe();
	if (!health.reachable) {
		const action = await vscode.window.showErrorMessage(
			formatUnreachable(health.url || getConfigSafeBaseUrl()),
			'Start Server',
			'Open Settings'
		);
		await handleServerAction(action);
		return;
	}

	output.info('Refreshing FreeLLMAPI model list...');
	await provider.refreshModels(true);

	if (vscode.lm?.selectChatModels) {
		try {
			const models = await vscode.lm.selectChatModels({ vendor: getVendorId() });
			output.info(`Model list refreshed: ${models.length} model(s) available through VS Code.`);
			for (const model of models.slice(0, 50)) {
				output.info(`  - ${model.name} (${model.id})`);
			}
			if (models.length > 50) {
				output.info(`  ... and ${models.length - 50} more.`);
			}
		} catch (err) {
			output.warn(`Could not query VS Code for the refreshed models: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	void vscode.window.showInformationMessage('FreeLLMAPI model list refreshed.');
}

async function checkConnectionCommand(
	context: vscode.ExtensionContext,
	provider: FreeLlmApiChatProvider,
	server: ServerManager
): Promise<void> {
	const output = getOutputChannel();
	const health = await server.probe();
	const apiKey = await getApiKey(context.secrets);
	let baseUrl: string;
	try {
		baseUrl = getConfig().baseUrl;
	} catch (err) {
		const action = await vscode.window.showErrorMessage(
			err instanceof Error ? err.message : String(err),
			'Open Settings'
		);
		await handleServerAction(action);
		return;
	}

	output.info(`Connection check: server=${health.reachable ? 'reachable' : 'unreachable'} (${health.detail}); key=${apiKey ? 'set' : 'missing'}.`);

	if (!health.reachable) {
		const action = await vscode.window.showErrorMessage(
			formatUnreachable(baseUrl),
			'Start Server',
			'Open Settings',
			'Show Logs'
		);
		await handleServerAction(action);
		return;
	}

	if (!apiKey) {
		const action = await vscode.window.showInformationMessage(
			`FreeLLMAPI is reachable at ${baseUrl}, but no API key is configured.`,
			'Set API Key'
		);
		if (action === 'Set API Key') {
			await vscode.commands.executeCommand(`${CONFIG}.setApiKey`);
		}
		return;
	}

	try {
		const result = await fetchModelCatalog(baseUrl, apiKey, { timeoutMs: 10_000 });
		if (!result.ok) {
			const action = await vscode.window.showErrorMessage(
				formatHttpError(result.status, baseUrl, result.body),
				result.status === 401 ? 'Set API Key' : 'Show Logs'
			);
			await handleServerAction(action);
			return;
		}

		const available = result.models.filter((model) => model.available).length;
		output.info(`Connected to ${baseUrl}: ${result.models.length} model(s), ${available} usable right now.`);
		void vscode.window.showInformationMessage(
			`Connected to FreeLLMAPI. ${result.models.length} model(s) listed, ${available} usable right now.`
		);
		await provider.refreshModels(true);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		output.error(`Connection check failed: ${message}`);
		const action = await vscode.window.showErrorMessage(message, 'Start Server', 'Show Logs');
		await handleServerAction(action);
	}
}

async function selfTestCommand(
	provider: FreeLlmApiChatProvider,
	server: ServerManager
): Promise<void> {
	const output = getOutputChannel();
	output.clear();
	output.show(true);
	output.info('Starting FreeLLMAPI self-test...');
	output.info(describeBuild());

	const health = await server.probe();
	if (!health.reachable) {
		output.error(formatUnreachable(getConfigSafeBaseUrl()));
		const action = await vscode.window.showErrorMessage(
			formatUnreachable(getConfigSafeBaseUrl()),
			'Start Server',
			'Show Logs'
		);
		await handleServerAction(action);
		return;
	}

	if (!vscode.lm?.selectChatModels) {
		output.error('The VS Code Language Model API is unavailable. Update VS Code to 1.104+.');
		void vscode.window.showWarningMessage('FreeLLMAPI requires VS Code 1.104+ to run the self-test.');
		return;
	}

	await provider.refreshModels();
	const availableModels = await vscode.lm.selectChatModels({ vendor: getVendorId() });
	if (availableModels.length === 0) {
		output.error('No FreeLLMAPI models are available. Set an API key and refresh the model list.');
		const action = await vscode.window.showWarningMessage(
			'No FreeLLMAPI models are available. Set an API key first.',
			'Set API Key',
			'Show Logs'
		);
		if (action === 'Set API Key') {
			await vscode.commands.executeCommand(`${CONFIG}.setApiKey`);
		} else if (action === 'Show Logs') {
			output.show(true);
		}
		return;
	}

	availableModels.sort((a, b) => {
		const aAuto = a.id === 'auto' ? 0 : 1;
		const bAuto = b.id === 'auto' ? 0 : 1;
		return aAuto - bAuto || a.name.localeCompare(b.name);
	});

	const picked = await vscode.window.showQuickPick(
		availableModels.map((model) => ({
			label: model.name,
			description: model.id,
			model,
		})),
		{ title: 'Select a FreeLLMAPI model for the self-test' }
	);
	if (!picked) {
		return;
	}

	output.info(`Selected model: ${picked.model.name} (${picked.model.id})`);

	const tool: vscode.LanguageModelChatTool = {
		name: `${CONFIG}.selfTest.getTime`,
		description: 'Returns the current time. Input: { tz?: string }',
		inputSchema: {
			type: 'object',
			properties: {
				tz: { type: 'string', description: 'IANA time zone, optional' },
			},
			additionalProperties: false,
		},
	};

	const messages: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(
			'Call the provided tool once, then explain what you did in one short paragraph.'
		),
	];

	const cts = new vscode.CancellationTokenSource();
	try {
		for (let iteration = 1; iteration <= 5; iteration++) {
			output.info(`Self-test iteration ${iteration}...`);
			const response = await picked.model.sendRequest(
				messages,
				{
					justification: 'FreeLLMAPI self-test: verify streaming and tool calling.',
					tools: [tool],
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				},
				cts.token
			);

			const assistantParts: any[] = [];
			const toolCalls: vscode.LanguageModelToolCallPart[] = [];

			for await (const part of response.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					assistantParts.push(part);
					output.append(part.value);
					continue;
				}
				if (part instanceof vscode.LanguageModelToolCallPart) {
					assistantParts.push(part);
					toolCalls.push(part);
					output.info(`\nTool call requested: ${part.name} (${part.callId})`);
					continue;
				}
				if (part instanceof vscode.LanguageModelDataPart) {
					assistantParts.push(part);
					output.info(`\nData part: ${part.mimeType} (${part.data.byteLength} bytes)`);
					continue;
				}

				const ThinkingPartClass = resolveThinkingPartConstructor(vscode);
				if (ThinkingPartClass && part instanceof ThinkingPartClass) {
					assistantParts.push(part);
					const value = (part as any).value;
					const text = Array.isArray(value) ? value.join('') : String(value ?? '');
					if (text) {
						output.info(`\n[thinking] ${text}`);
					}
					continue;
				}
			}

			messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
			if (toolCalls.length === 0) {
				output.info('\nSelf-test completed.');
				void vscode.window.showInformationMessage('FreeLLMAPI self-test completed.');
				return;
			}

			for (const call of toolCalls) {
				if (call.name !== tool.name) {
					throw new Error(`Unexpected tool call: ${call.name}`);
				}
				const result = new Date().toISOString();
				messages.push(
					vscode.LanguageModelChatMessage.User([
						new vscode.LanguageModelToolResultPart(call.callId, [
							new vscode.LanguageModelTextPart(result),
						]),
					])
				);
				output.info(`Tool result sent for ${call.callId}.`);
			}
		}

		throw new Error('Self-test exceeded the maximum of 5 tool-call iterations.');
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		output.error(`Self-test failed: ${message}`);
		output.append(`${safeJson(serializeError(err))}\n`);
		const action = await vscode.window.showErrorMessage(`FreeLLMAPI self-test failed: ${message}`, 'Show Logs');
		if (action === 'Show Logs') {
			output.show(true);
		}
	} finally {
		cts.dispose();
	}
}

type UsageRow = {
	platform?: string;
	keyId?: string;
	label?: string;
	enabled?: boolean;
	requests?: number;
	tokens?: number;
	requestCap?: number | null;
	tokenCap?: number | null;
};

type UsageBody = {
	month?: string;
	resetsAt?: string;
	requests?: number;
	tokens?: number;
	byPlatform?: UsageRow[];
	byKey?: UsageRow[];
};

async function showUsageCommand(context: vscode.ExtensionContext): Promise<void> {
	const output = getOutputChannel();
	let config;
	try {
		config = getConfig();
	} catch (err) {
		void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
		return;
	}

	const apiKey = await getApiKey(context.secrets);
	if (!apiKey) {
		const action = await vscode.window.showWarningMessage(
			'Set the FreeLLMAPI API key to view usage.',
			'Set API Key'
		);
		if (action === 'Set API Key') {
			await vscode.commands.executeCommand(`${CONFIG}.setApiKey`);
		}
		return;
	}

	const url = usageUrl(config.baseUrl);
	try {
		const response = await fetch(url, {
			headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(15_000),
		});
		const body = await response.text();
		if (!response.ok) {
			const action = await vscode.window.showErrorMessage(
				formatHttpError(response.status, url, body),
				'Show Logs'
			);
			if (action === 'Show Logs') {
				output.show(true);
			}
			return;
		}

		const usage = JSON.parse(body) as UsageBody;
		const requests = usage.requests ?? 0;
		const tokens = usage.tokens ?? 0;
		const month = usage.month ?? 'current month';

		output.info(`FreeLLMAPI usage for ${month}: ${formatNumber(requests)} request(s), ${formatNumber(tokens)} token(s).`);
		if (usage.resetsAt) {
			output.info(`Resets at ${usage.resetsAt}.`);
		}
		for (const row of usage.byPlatform ?? []) {
			output.info(`  platform ${row.platform ?? 'unknown'}: ${formatNumber(row.requests ?? 0)} request(s), ${formatNumber(row.tokens ?? 0)} token(s)`);
		}
		for (const row of usage.byKey ?? []) {
			const caps = [
				row.requestCap != null ? `req cap ${formatNumber(row.requestCap)}` : undefined,
				row.tokenCap != null ? `token cap ${formatNumber(row.tokenCap)}` : undefined,
			].filter(Boolean).join(', ');
			output.info(
				`  key ${row.keyId ?? 'unknown'} (${row.platform ?? 'unknown'}${row.label ? `, ${row.label}` : ''}): ` +
				`${formatNumber(row.requests ?? 0)} request(s), ${formatNumber(row.tokens ?? 0)} token(s)` +
				`${caps ? ` — ${caps}` : ''}${row.enabled === false ? ' [disabled]' : ''}`
			);
		}
		output.append(`${safeJson(usage)}\n`);

		const summary = `FreeLLMAPI usage for ${month}: ${formatNumber(requests)} request(s), ${formatNumber(tokens)} token(s).`;
		const action = await vscode.window.showInformationMessage(
			summary,
			'Open Dashboard',
			'Show Details'
		);
		if (action === 'Open Dashboard') {
			await openDashboardCommand();
		} else if (action === 'Show Details') {
			output.show(true);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		output.error(`Could not read FreeLLMAPI usage: ${message}`);
		const action = await vscode.window.showErrorMessage(
			`Could not read FreeLLMAPI usage: ${message}`,
			'Open Dashboard',
			'Show Logs'
		);
		if (action === 'Open Dashboard') {
			await openDashboardCommand();
		} else if (action === 'Show Logs') {
			output.show(true);
		}
	}
}

async function startServerCommand(
	provider: FreeLlmApiChatProvider,
	server: ServerManager,
	statusBar: FreeLlmApiStatusBar
): Promise<void> {
	try {
		const result = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'FreeLLMAPI: starting server',
				cancellable: false,
			},
			() => server.start()
		);
		await provider.refreshModels(true);
		statusBar.refreshNow();
		void vscode.window.showInformationMessage(result.message);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		getOutputChannel().error(`Failed to start FreeLLMAPI: ${message}`);
		const action = await vscode.window.showErrorMessage(
			`Failed to start FreeLLMAPI: ${message}`,
			'Show Server Logs',
			'Open Settings'
		);
		if (action === 'Show Server Logs') {
			getServerOutputChannel().show(true);
		} else if (action === 'Open Settings') {
			await vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG}.server`);
		}
	}
}

async function stopServerCommand(
	provider: FreeLlmApiChatProvider,
	server: ServerManager,
	statusBar: FreeLlmApiStatusBar
): Promise<void> {
	try {
		const result = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'FreeLLMAPI: stopping server',
				cancellable: false,
			},
			() => server.stop()
		);
		await provider.refreshModels(true);
		statusBar.refreshNow();
		if (result.stopped) {
			void vscode.window.showInformationMessage(result.message);
		} else {
			void vscode.window.showWarningMessage(result.message);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		getOutputChannel().error(`Failed to stop FreeLLMAPI: ${message}`);
		const action = await vscode.window.showErrorMessage(
			`Failed to stop FreeLLMAPI: ${message}`,
			'Show Server Logs',
			'Open Settings'
		);
		if (action === 'Show Server Logs') {
			getServerOutputChannel().show(true);
		} else if (action === 'Open Settings') {
			await vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG}.server`);
		}
	}
}

async function restartServerCommand(
	provider: FreeLlmApiChatProvider,
	server: ServerManager,
	statusBar: FreeLlmApiStatusBar
): Promise<void> {
	const health = await server.probe();
	if (health.reachable && !server.isManaged() && !getServerConfig().stopCommand) {
		void vscode.window.showWarningMessage(
			'FreeLLMAPI is running but was not started by this extension. Configure "' +
			`${getSettingName('server.stopCommand')}" to let Restart stop it.`,
			'Open Settings'
		).then((action) => {
			if (action === 'Open Settings') {
				void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG}.server`);
			}
		});
		return;
	}

	if (health.reachable) {
		await stopServerCommand(provider, server, statusBar);
	}
	await startServerCommand(provider, server, statusBar);
}

async function showStatusCommand(
	context: vscode.ExtensionContext,
	provider: FreeLlmApiChatProvider,
	server: ServerManager
): Promise<void> {
	const health = await server.probe();
	const apiKey = await getApiKey(context.secrets);
	let baseUrl: string;
	try {
		baseUrl = getConfig().baseUrl;
	} catch (err) {
		baseUrl = err instanceof Error ? err.message : String(err);
	}

	const items: Array<vscode.QuickPickItem & { command?: string }> = [
		{
			label: '$(info) Status',
			description: health.reachable ? 'Server reachable' : 'Server unreachable',
			detail: `${baseUrl} — ${health.detail}`,
		},
		{
			label: '$(key) API key',
			description: apiKey ? 'Configured' : 'Not set',
			detail: apiKey
				? 'Stored in VS Code SecretStorage.'
				: 'Run "FreeLLMAPI: Detect API Key" for a local desktop app, or "FreeLLMAPI: Set API Key".',
		},
		{
			label: '$(symbol-class) Models',
			description: `${provider.getCachedModelCount()} cached`,
			detail: 'Refresh to re-read the catalog from the gateway.',
		},
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ label: '$(key) Set API Key', command: `${CONFIG}.setApiKey` },
		{ label: '$(search) Detect API Key', command: `${CONFIG}.detectApiKey` },
		{ label: '$(refresh) Refresh Models', command: `${CONFIG}.refreshModels` },
		health.reachable
			? { label: '$(debug-stop) Stop Server', command: `${CONFIG}.stopServer` }
			: { label: '$(play) Start Server', command: `${CONFIG}.startServer` },
		{ label: '$(pulse) Check Connection', command: `${CONFIG}.checkConnection` },
		{ label: '$(beaker) Self Test', command: `${CONFIG}.selfTest` },
		{ label: '$(graph) Show Usage', command: `${CONFIG}.showUsage` },
		{ label: '$(globe) Open Dashboard', command: `${CONFIG}.openDashboard` },
		{ label: '$(output) Show Logs', command: `${CONFIG}.showLogs` },
		{ label: '$(output) Show Server Logs', command: `${CONFIG}.showServerLogs` },
	];

	const picked = await vscode.window.showQuickPick(items, {
		title: 'FreeLLMAPI Status',
		placeHolder: health.reachable ? 'Server reachable' : 'Server unreachable',
		matchOnDescription: true,
		matchOnDetail: true,
	});
	if (picked?.command) {
		await vscode.commands.executeCommand(picked.command);
	}
}

async function openDashboardCommand(): Promise<void> {
	try {
		await vscode.env.openExternal(vscode.Uri.parse(dashboardUrl(getConfig().baseUrl)));
	} catch (err) {
		void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
	}
}

async function handleServerAction(action: string | undefined): Promise<void> {
	if (action === 'Start Server') {
		await vscode.commands.executeCommand(`${CONFIG}.startServer`);
	} else if (action === 'Set API Key') {
		await vscode.commands.executeCommand(`${CONFIG}.setApiKey`);
	} else if (action === 'Detect API Key') {
		await vscode.commands.executeCommand(`${CONFIG}.detectApiKey`);
	} else if (action === 'Open Settings') {
		await vscode.commands.executeCommand('workbench.action.openSettings', CONFIG);
	} else if (action === 'Show Logs') {
		getOutputChannel().show(true);
	}
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

class FreeLlmApiStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private timer: NodeJS.Timeout | undefined;
	private refreshing = false;
	private disposed = false;
	private lastReachable: boolean | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly provider: FreeLlmApiChatProvider,
		private readonly server: ServerManager
	) {
		this.item = vscode.window.createStatusBarItem(`${CONFIG}.status`, vscode.StatusBarAlignment.Right, 90);
		this.item.command = `${CONFIG}.showStatus`;
	}

	start(): void {
		this.updateInterval();
		if (getConfigSafeStatusBarEnabled()) {
			this.item.show();
		}
		void this.refresh();

		this.context.subscriptions.push(
			this.provider.onDidChangeLanguageModelChatInformation(() => this.refreshNow()),
			this.server.onDidChangeHealth((health) => {
				this.handleHealthTransition(health);
			})
		);
	}

	updateInterval(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		if (!getConfigSafeStatusBarEnabled()) {
			this.item.hide();
			return;
		}

		const seconds = getConfigSafeHealthInterval();
		this.timer = setInterval(() => void this.refresh(), seconds * 1_000);
		this.timer.unref();
		this.item.show();
	}

	refreshNow(): void {
		void this.refresh();
	}

	async refresh(): Promise<void> {
		if (this.disposed || this.refreshing) {
			return;
		}
		this.refreshing = true;
		try {
			if (!getConfigSafeStatusBarEnabled()) {
				this.item.hide();
				return;
			}

			const [health, apiKey] = await Promise.all([
				this.server.probe(),
				getApiKey(this.context.secrets),
			]);
			let modelCount = this.provider.getCachedModelCount();
			if (apiKey && health.reachable && !this.provider.hasLoadedModels()) {
				await this.provider.refreshModels();
				modelCount = this.provider.getCachedModelCount();
			}
			const baseUrl = getConfigSafeBaseUrl();

			let text: string;
			let warning = false;
			if (!apiKey) {
				text = '$(key) FreeLLMAPI: no key';
				warning = true;
			} else if (!health.reachable) {
				text = '$(debug-disconnect) FreeLLMAPI: offline';
				warning = true;
			} else if (!this.provider.hasLoadedModels()) {
				text = '$(loading~spin) FreeLLMAPI';
			} else if (modelCount === 0) {
				text = '$(sparkle) FreeLLMAPI: no models';
			} else {
				text = '$(sparkle) FreeLLMAPI';
			}

			this.item.text = text;
			this.item.tooltip = [
				'**FreeLLMAPI**',
				`Server: ${health.reachable ? 'reachable' : 'unreachable'} (${health.detail})`,
				`API key: ${apiKey ? 'configured' : 'not set'}`,
				`Models: ${modelCount}`,
				`Base URL: ${baseUrl}`,
				'',
				'Click for status and actions.',
			].join('\n');
			this.item.backgroundColor = warning
				? new vscode.ThemeColor('statusBarItem.warningBackground')
				: undefined;
			this.item.show();
		} catch (err) {
			getOutputChannel().warn(
				`Failed to refresh the FreeLLMAPI status bar. ${
					err instanceof Error ? err.message : String(err)
				}`
			);
			this.item.text = '$(warning) FreeLLMAPI: error';
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			this.item.show();
		} finally {
			this.refreshing = false;
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.item.dispose();
	}

	private handleHealthTransition(health: ServerHealth): void {
		const wasReachable = this.lastReachable;
		this.lastReachable = health.reachable;
		if (health.reachable && wasReachable === false) {
			void this.provider.refreshModels(true);
		}
		void this.refresh();
	}
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function getConfigSafeBaseUrl(): string {
	try {
		return getConfig().baseUrl;
	} catch {
		return 'http://127.0.0.1:3001/v1';
	}
}

function getConfigSafeStatusBarEnabled(): boolean {
	try {
		return getConfig().statusBarEnabled;
	} catch {
		return true;
	}
}

function getConfigSafeHealthInterval(): number {
	try {
		return getConfig().healthCheckIntervalSeconds;
	} catch {
		return 30;
	}
}

function formatNumber(value: number): string {
	return value.toLocaleString('en-US');
}

async function detectGateway(server: ServerManager): Promise<DiscoveredGateway | undefined> {
	let config;
	try {
		config = getConfig();
	} catch {
		return undefined;
	}
	if (!config.autoDetectBaseUrl) {
		return undefined;
	}

	const output = getOutputChannel();
	const health = await server.probe();
	if (health.reachable) {
		return undefined;
	}

	try {
		const discovered = await discoverLoopbackGateway(
			createNodeDiscoveryHost(),
			{ platform: process.platform, env: process.env, home: os.homedir() },
			config.baseUrl
		);
		if (!discovered) {
			return undefined;
		}
		setBaseUrlOverride(discovered.baseUrl);
		output.info(
			`Detected a FreeLLMAPI gateway at ${discovered.origin} (configured ${config.baseUrl} was unreachable); using ${discovered.baseUrl} for this session.`
		);
		return discovered;
	} catch (err) {
		output.warn(`Gateway auto-detection failed: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	}
}

async function announceDetectedGateway(
	discovered: DiscoveredGateway | undefined,
	provider: FreeLlmApiChatProvider,
	statusBar: FreeLlmApiStatusBar
): Promise<void> {
	if (!discovered) {
		return;
	}

	await provider.refreshModels(true);
	statusBar.refreshNow();

	const action = await vscode.window.showInformationMessage(
		`FreeLLMAPI is serving on ${discovered.origin}. Using it for this session.`,
		'Save to Settings',
		'Dismiss'
	);
	if (action !== 'Save to Settings') {
		return;
	}
	await vscode.workspace
		.getConfiguration(CONFIG)
		.update('baseUrl', discovered.baseUrl, vscode.ConfigurationTarget.Global);
	setBaseUrlOverride(undefined);
	getOutputChannel().info(`Saved freellmapi.baseUrl = ${discovered.baseUrl}.`);
	await provider.refreshModels(true);
	statusBar.refreshNow();
}

async function autoStartServer(
	provider: FreeLlmApiChatProvider,
	server: ServerManager
): Promise<void> {
	if (!getServerConfig().autoStart) {
		return;
	}

	const output = getOutputChannel();
	const health = await server.probe();
	if (health.reachable) {
		return;
	}

	output.info(`"${getSettingName('server.autoStart')}" is enabled; starting FreeLLMAPI.`);
	try {
		const result = await server.start();
		output.info(result.message);
		await provider.refreshModels(true);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		output.error(`Auto-start failed: ${message}`);
		const action = await vscode.window.showWarningMessage(
			`FreeLLMAPI auto-start failed: ${message}`,
			'Show Server Logs',
			'Open Settings'
		);
		if (action === 'Show Server Logs') {
			getServerOutputChannel().show(true);
		} else if (action === 'Open Settings') {
			await vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG}.server`);
		}
	}
}

async function promptForKeyOnce(context: vscode.ExtensionContext): Promise<void> {
	const promptedKey = 'freellmapi.promptedForKey';
	if (context.globalState.get<boolean>(promptedKey, false)) {
		return;
	}
	const apiKey = await getApiKey(context.secrets);
	if (apiKey) {
		await context.globalState.update(promptedKey, true);
		return;
	}

	await context.globalState.update(promptedKey, true);
	const action = await vscode.window.showInformationMessage(
		'FreeLLMAPI is installed. Set your unified API key to load the gateway model catalog.',
		'Set API Key',
		'Not Now'
	);
	if (action === 'Set API Key') {
		await vscode.commands.executeCommand(`${CONFIG}.setApiKey`);
	}
}

async function adoptDesktopKeyThenPrompt(
	context: vscode.ExtensionContext,
	provider: FreeLlmApiChatProvider,
	statusBar: FreeLlmApiStatusBar
): Promise<void> {
	if (await adoptDesktopKey(context, provider, statusBar)) {
		return;
	}
	await promptForKeyOnce(context);
}

/** Imports the desktop app's unified key when this window has none stored yet. */
async function adoptDesktopKey(
	context: vscode.ExtensionContext,
	provider: FreeLlmApiChatProvider,
	statusBar: FreeLlmApiStatusBar
): Promise<boolean> {
	if (await getApiKey(context.secrets)) {
		return false;
	}

	let adopted: AdoptedDesktopKey | undefined;
	try {
		adopted = await fetchDesktopUnifiedKey(getConfigSafeBaseUrl());
	} catch (err) {
		getOutputChannel().warn(
			`Could not read the local FreeLLMAPI API key: ${err instanceof Error ? err.message : String(err)}`
		);
		return false;
	}
	if (!adopted) {
		return false;
	}
	return storeAdoptedKey(context, provider, statusBar, adopted, false);
}

async function detectApiKeyCommand(
	context: vscode.ExtensionContext,
	provider: FreeLlmApiChatProvider,
	statusBar: FreeLlmApiStatusBar
): Promise<void> {
	const output = getOutputChannel();
	const baseUrl = getConfigSafeBaseUrl();
	let origin = baseUrl;
	try {
		origin = originFromBaseUrl(baseUrl);
	} catch {
		// Keep the raw setting in the message; the gateway probe will explain it.
	}

	let adopted: AdoptedDesktopKey | undefined;
	try {
		adopted = await fetchDesktopUnifiedKey(baseUrl);
	} catch (err) {
		output.warn(`Key detection failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (!adopted) {
		const action = await vscode.window.showWarningMessage(
			`No FreeLLMAPI desktop app handed out a key at ${origin}. Detection only works when the desktop app runs on this machine; Docker and remote gateways need the key entered by hand.`,
			'Set API Key',
			'Show Logs'
		);
		if (action === 'Set API Key') {
			await vscode.commands.executeCommand(`${CONFIG}.setApiKey`);
		} else if (action === 'Show Logs') {
			output.show(true);
		}
		return;
	}

	const existing = await getApiKey(context.secrets);
	if (existing && existing !== adopted.apiKey) {
		const choice = await vscode.window.showWarningMessage(
			`Replace the stored FreeLLMAPI API key with the one from ${adopted.origin}?`,
			{ modal: true },
			'Replace'
		);
		if (choice !== 'Replace') {
			return;
		}
	}

	await storeAdoptedKey(context, provider, statusBar, adopted, true);
}

async function storeAdoptedKey(
	context: vscode.ExtensionContext,
	provider: FreeLlmApiChatProvider,
	statusBar: FreeLlmApiStatusBar,
	adopted: AdoptedDesktopKey,
	announce: boolean
): Promise<boolean> {
	const output = getOutputChannel();
	const baseUrl = getConfigSafeBaseUrl();

	try {
		const catalog = await fetchModelCatalog(baseUrl, adopted.apiKey, { timeoutMs: 10_000 });
		if (!catalog.ok) {
			output.warn(
				`The FreeLLMAPI desktop app at ${adopted.origin} returned an API key, but ${baseUrl} rejected it (HTTP ${catalog.status}).`
			);
			if (announce) {
				const action = await vscode.window.showWarningMessage(
					`The desktop app's API key was rejected by ${baseUrl} (HTTP ${catalog.status}).`,
					'Set API Key'
				);
				if (action === 'Set API Key') {
					await vscode.commands.executeCommand(`${CONFIG}.setApiKey`);
				}
			}
			return false;
		}

		await setApiKey(context.secrets, adopted.apiKey);
		await provider.refreshModels(true);
		statusBar.refreshNow();
		output.info(
			`Imported the FreeLLMAPI desktop app's unified API key from ${adopted.origin} (${catalog.models.length} model(s) listed).`
		);
		if (announce) {
			void vscode.window.showInformationMessage(
				catalog.models.length > 0
					? `FreeLLMAPI API key imported from the desktop app. ${catalog.models.length} model(s) available.`
					: 'FreeLLMAPI API key imported from the desktop app.'
			);
		}
		return true;
	} catch (err) {
		output.warn(
			`The desktop app's API key could not be verified: ${err instanceof Error ? err.message : String(err)}`
		);
		return false;
	}
}
