import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { ModelMessage } from 'ai';
import { getConfig } from './config';
import { safeJson, serializeError } from './diagnostics';
import {
	normalizeToolCallInput,
	streamFreeLlmApi,
	type ClientLogger,
	type FreeLlmApiUsage,
} from './freellmapiClient';
import { ModelRegistry } from './modelRegistry';
import { getOutputChannel } from './output';
import { getApiKey } from './secrets';
import { ReasoningCache } from './reasoningCache';
import {
	conversationFingerprint,
	ConversationSessionStore,
	createSessionId,
	type ConversationSession,
} from './sessionIdentity';
import { createThinkingReporter } from './thinkingParts';

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const conversationSessions = new ConversationSessionStore(createSessionId);
const sessionReasoningCache = new ReasoningCache();

let thinkingFallbackLogged = false;

export class FreeLlmApiChatProvider implements vscode.LanguageModelChatProvider {
	private readonly registry: ModelRegistry;
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;
	private hasLoggedResolve = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.registry = new ModelRegistry(context.secrets);
		this.registry.onDidChange(() => this.onDidChangeEmitter.fire());
	}

	dispose(): void {
		this.registry.dispose();
		this.onDidChangeEmitter.dispose();
	}

	getCachedModelCount(): number {
		return this.registry.getCachedModels().length;
	}

	hasLoadedModels(): boolean {
		return this.registry.hasCachedCatalog();
	}

	async refreshModels(force = false): Promise<void> {
		try {
			await this.registry.getModels({ force });
		} catch {
			// The registry already logged the reason; activation must not fail.
		}
		this.onDidChangeEmitter.fire();
	}

	provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken
	): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
		void _options;
		void _token;
		const output = getOutputChannel();
		return this.registry
			.getModels()
			.then((models) => {
				// The first resolve is what makes the models show up in the picker;
				// log it once at info level so a silent "picker is empty" report is
				// diagnosable from the log alone.
				const message = `VS Code requested the model list (${models.length} model(s) returned).`;
				if (this.hasLoggedResolve) {
					output.debug(message);
				} else {
					this.hasLoggedResolve = true;
					output.info(message);
				}
				return models;
			})
			.catch((err) => {
				output.error(
					`Failed to load FreeLLMAPI models: ${err instanceof Error ? err.message : String(err)}`
				);
				return [];
			});
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken
	): Promise<void> {
		const output = getOutputChannel();
		const apiKey = await getApiKey(this.context.secrets);
		if (!apiKey) {
			throw new Error(
				'No FreeLLMAPI API key is configured. Run "FreeLLMAPI: Set API Key" with the unified key from the FreeLLMAPI dashboard.'
			);
		}

		const config = getConfig();
		const session = resolveSession(messages);
		const requestId = randomUUID();
		output.info(
			`Request ${requestId}: model=${model.id}, messages=${messages.length}, tools=${options.tools?.length ?? 0}, session=${session.id}`
		);

		const abortController = new AbortController();
		const cancellation = token.onCancellationRequested(() => abortController.abort());

		const toolNameMap = buildToolNameMap(options.tools);
		const mappedTools = options.tools
			? await toolsToAiSdkTools(options.tools, toolNameMap.toProvider)
			: undefined;
		const allowImages = model.capabilities?.imageInput ?? false;
		const dropped = { images: 0, parts: 0 };
		const coreMessages = messagesToAiSdkMessages(
			messages,
			toolNameMap.toProvider,
			allowImages,
			dropped
		);

		// Keep the response budget inside the same context window: VS Code
		// measures maxInputTokens against the model's full window, so reserve
		// the output tokens before truncating the prompt.
		const maxInputTokens = model.maxInputTokens ?? 32_768;
		const maxOutputTokens = Math.max(
			1,
			Math.min(config.maxOutputTokens, model.maxOutputTokens ?? config.maxOutputTokens)
		);
		const inputBudget = Math.max(1_024, maxInputTokens - maxOutputTokens);
		const truncationBudget = Math.floor(inputBudget * 0.95);
		const { messages: truncated, dropped: droppedMessages } = truncateMessages(coreMessages, truncationBudget);
		if (droppedMessages > 0) {
			output.info(
				`Context limit: dropped ${droppedMessages} older message(s) to fit within ~${truncationBudget.toLocaleString()} tokens ` +
				`(model max: ${maxInputTokens.toLocaleString()}).`
			);
		}
		if (dropped.images > 0) {
			output.warn(
				`Dropped ${dropped.images} image part(s) because image input is disabled for ${model.id} ` +
				'(see "freellmapi.imageInput").'
			);
		}
		if (dropped.parts > 0) {
			output.warn(`Dropped ${dropped.parts} unsupported message part(s) before sending to FreeLLMAPI.`);
		}

		let prepared = truncated;
		const cachedReasoning = session.cacheKey
			? sessionReasoningCache.get(session.id, model.id)
			: undefined;
		if (cachedReasoning) {
			prepared = applyReasoningFallback(prepared, cachedReasoning);
		}

		if (config.debugLogging) {
			output.info(
				`Debug: ${prepared.length} AI SDK message(s), ${Object.keys(mappedTools ?? {}).length} tool(s), ` +
				`budget=${truncationBudget}, baseUrl=${config.baseUrl}`
			);
			output.append(`${safeJson(prepared.map(summarizeMessage))}\n`);
		}

		let lastReasoning = '';
		const reportThinking = createThinkingReporter({
			api: vscode,
			report: (part) => progress.report(part as vscode.LanguageModelResponsePart2),
			fallback: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
			onUnavailable: (reason) => {
				if (!thinkingFallbackLogged) {
					thinkingFallbackLogged = true;
					output.info(`Reasoning is streamed as plain text: ${reason}.`);
				}
			},
		});
		try {
			await streamFreeLlmApi(
				{
					apiKey,
					baseUrl: config.baseUrl,
					modelId: model.id,
					messages: prepared,
					tools: mappedTools,
					toolMode: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
					abortSignal: abortController.signal,
					headers: {
						'x-session-id': session.id,
						'x-request-id': requestId,
					},
					maxOutputTokens,
					debugLogging: config.debugLogging,
					logger: createClientLogger(output),
					toolNameMap: toolNameMap.toVsCode,
				},
				{
					onTextDelta: (delta) => {
						if (delta) {
							progress.report(new vscode.LanguageModelTextPart(delta));
						}
					},
					onThinkingDelta: (delta) => {
						if (delta) {
							lastReasoning += delta;
							reportThinking(delta);
						}
					},
					onToolCall: ({ toolCallId, toolName, input }) => {
						progress.report(new vscode.LanguageModelToolCallPart(toolCallId, toolName, input));
					},
					onUsage: (usage) => {
						progress.report(usageDataPart(usage));
					},
				}
			);

			if (lastReasoning && session.cacheKey) {
				sessionReasoningCache.set(session.id, model.id, lastReasoning);
			}
		} catch (err) {
			if (token.isCancellationRequested || (err instanceof Error && err.name === 'AbortError')) {
				output.info(`Request ${requestId} was cancelled.`);
				return;
			}
			output.error(
				`Request ${requestId} failed: ${err instanceof Error ? err.message : String(err)}`
			);
			output.append(`${safeJson(serializeError(err))}\n`);
			throw err;
		} finally {
			cancellation.dispose();
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		void _model;
		void _token;
		const serialized = typeof text === 'string' ? text : JSON.stringify(text.content);
		return Math.max(1, Math.ceil(serialized.length / 4));
	}
}

function usageDataPart(usage: FreeLlmApiUsage): vscode.LanguageModelDataPart {
	const promptTokens = usage.inputTokens ?? 0;
	const completionTokens = usage.outputTokens ?? 0;
	const totalTokens = usage.totalTokens ?? 0;
	const cachedTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
	const data = new TextEncoder().encode(JSON.stringify({
		prompt_tokens: Math.max(0, promptTokens),
		completion_tokens: Math.max(0, completionTokens),
		total_tokens: Math.max(0, totalTokens),
		prompt_tokens_details: {
			cached_tokens: Math.max(0, cachedTokens)
		}
	}));
	return new vscode.LanguageModelDataPart(data, 'usage');
}

function createClientLogger(output: vscode.LogOutputChannel): ClientLogger {
	return {
		info: (message) => output.info(message),
		warn: (message) => output.warn(message),
		error: (message) => output.error(message),
		raw: (text) => output.append(`${text}\n`),
	};
}

function resolveSession(
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): { id: string; cacheKey?: string } {
	const fingerprint = conversationFingerprint(messages);
	if (!fingerprint) {
		return { id: createSessionId() };
	}

	let session: ConversationSession = conversationSessions.get(fingerprint);
	if (isSessionStale(session)) {
		session = conversationSessions.renew(fingerprint);
	}
	return { id: session.id, cacheKey: fingerprint };
}

function isSessionStale(session: ConversationSession): boolean {
	return Date.now() - session.createdAt > SESSION_MAX_AGE_MS;
}

function summarizeMessage(message: any): unknown {
	const content = Array.isArray(message?.content)
		? message.content.map((part: any) => `${part?.type ?? 'unknown'}${part?.toolName ? `:${part.toolName}` : ''}`)
		: typeof message?.content === 'string'
			? `text(${message.content.length})`
			: 'unknown';
	return {
		role: message?.role,
		content,
		reasoning: Boolean(message?.providerOptions?.openaiCompatible?.reasoning_content),
	};
}

// ---------------------------------------------------------------------------
// VS Code messages -> AI SDK messages
// ---------------------------------------------------------------------------

function messagesToAiSdkMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	toolNameMap: ReadonlyMap<string, string>,
	allowImages: boolean,
	dropped: { images: number; parts: number }
): ModelMessage[] {
	const toolNameByCallId = new Map<string, string>();
	for (const message of messages) {
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolNameByCallId.set(part.callId, mapToolName(part.name, toolNameMap));
			}
		}
	}

	const out: ModelMessage[] = [];
	for (const message of messages) {
		out.push(...mapVsCodeMessageToAiSdkMessages(message, toolNameByCallId, toolNameMap, allowImages, dropped));
	}
	return out;
}

function mapVsCodeMessageToAiSdkMessages(
	message: vscode.LanguageModelChatRequestMessage,
	toolNameByCallId: ReadonlyMap<string, string>,
	toolNameMap: ReadonlyMap<string, string>,
	allowImages: boolean,
	dropped: { images: number; parts: number }
): ModelMessage[] {
	const isUser = message.role === vscode.LanguageModelChatMessageRole.User;

	const userParts: any[] = [];
	const toolResultParts: any[] = [];
	const assistantParts: any[] = [];
	const thinkingTexts: string[] = [];

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			const textPart = { type: 'text', text: part.value };
			if (isUser) {
				userParts.push(textPart);
			} else {
				assistantParts.push(textPart);
			}
			continue;
		}

		if (part instanceof vscode.LanguageModelToolCallPart) {
			assistantParts.push({
				type: 'tool-call',
				toolCallId: part.callId,
				toolName: mapToolName(part.name, toolNameMap),
				input: normalizeToolCallInput(part.input),
			});
			continue;
		}

		if (part instanceof vscode.LanguageModelToolResultPart) {
			const toolName = toolNameByCallId.get(part.callId) ?? mapToolName('unknown', toolNameMap);
			toolResultParts.push({
				type: 'tool-result',
				toolCallId: part.callId,
				toolName,
				output: languageModelToolResultContentToOutput(part.content),
			});
			continue;
		}

		if (part instanceof vscode.LanguageModelDataPart) {
			const converted = dataPartToAiSdkPart(part, isUser && allowImages);
			if (!converted) {
				if (!isUser && part.mimeType !== 'cache_control' && part.mimeType !== 'usage') {
					dropped.parts++;
				}
				continue;
			}
			if (converted.type === 'image' && !allowImages) {
				dropped.images++;
				continue;
			}
			if (isUser) {
				userParts.push(converted);
			} else if (converted.type === 'text') {
				assistantParts.push(converted);
			} else {
				// Assistant messages cannot contain image/file parts in the
				// openai-compatible message schema.
				dropped.parts++;
			}
			continue;
		}

		const ThinkingPartClass = (vscode as any).LanguageModelThinkingPart as
			| (new (...args: any[]) => any)
			| undefined;
		if (ThinkingPartClass && part instanceof ThinkingPartClass) {
			if (!isUser) {
				const thinkingValue = (part as any).value;
				const text = Array.isArray(thinkingValue) ? thinkingValue.join('') : String(thinkingValue ?? '');
				if (text.length > 0) {
					thinkingTexts.push(text);
				}
			}
			continue;
		}

		// Unknown VS Code part; drop it rather than failing AI SDK validation.
		dropped.parts++;
	}

	const out: ModelMessage[] = [];

	if (isUser) {
		if (userParts.length > 0) {
			out.push({ role: 'user', content: simplifyTextOnlyContent(userParts) } as ModelMessage);
		}
		if (toolResultParts.length > 0) {
			out.push({ role: 'tool', content: toolResultParts } as ModelMessage);
		}
	} else {
		const reasoningContent = thinkingTexts.join('');
		const assistantMessage: any = {
			role: 'assistant',
			content: simplifyTextOnlyContent(assistantParts),
		};
		if (reasoningContent.length > 0) {
			// The openai-compatible provider spreads these providerOptions into
			// the API request as `reasoning_content`.
			assistantMessage.providerOptions = {
				openaiCompatible: { reasoning_content: reasoningContent },
			};
		}
		out.push(assistantMessage as ModelMessage);
	}

	return out;
}

function applyReasoningFallback(messages: ModelMessage[], reasoning: string): ModelMessage[] {
	if (!reasoning || messages.length === 0) {
		return messages;
	}

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as any;
		if (!message || message.role !== 'assistant') {
			continue;
		}

		const existing = message.providerOptions?.openaiCompatible?.reasoning_content;
		if (existing) {
			return messages;
		}

		const updated = [...messages];
		updated[i] = {
			...message,
			providerOptions: {
				...(message.providerOptions ?? {}),
				openaiCompatible: {
					...(message.providerOptions?.openaiCompatible ?? {}),
					reasoning_content: reasoning,
				},
			},
		};
		return updated;
	}

	return messages;
}

function simplifyTextOnlyContent(parts: any[]): any {
	if (parts.length === 0) {
		return '';
	}
	if (parts.every((part) => part?.type === 'text' && typeof part.text === 'string')) {
		return parts.map((part) => part.text).join('');
	}
	return parts;
}

function dataPartToAiSdkPart(
	part: vscode.LanguageModelDataPart,
	allowImages: boolean
): any | undefined {
	// VS Code may include internal metadata such as cache_control or the
	// extension's own usage payload in Agent/Plan mode. Never forward those.
	if (part.mimeType === 'cache_control' || part.mimeType === 'usage') {
		return undefined;
	}

	const mimeType = typeof part.mimeType === 'string' && part.mimeType.trim().length > 0
		? part.mimeType
		: 'application/octet-stream';

	if (mimeType.startsWith('text/')) {
		return { type: 'text', text: new TextDecoder('utf-8').decode(part.data) };
	}

	if (mimeType.startsWith('image/')) {
		if (!allowImages) {
			return undefined;
		}
		// AI SDK's imagePartSchema uses `image` + `mediaType`, not `mimeType`.
		return { type: 'image', image: Buffer.from(part.data), mediaType: mimeType };
	}

	return undefined;
}

function languageModelToolResultContentToOutput(
	content: Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart | vscode.LanguageModelDataPart | unknown>
): { type: 'text'; value: string } | { type: 'json'; value: unknown } | { type: 'content'; value: Array<any> } {
	const parts: Array<any> = [];
	const textChunks: string[] = [];

	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			textChunks.push(part.value);
			parts.push({ type: 'text', text: part.value });
			continue;
		}
		if (part instanceof vscode.LanguageModelPromptTsxPart) {
			const value = String(part.value);
			textChunks.push(value);
			parts.push({ type: 'text', text: value });
			continue;
		}
		if (part instanceof vscode.LanguageModelDataPart) {
			if (part.mimeType === 'cache_control' || part.mimeType === 'usage') {
				continue;
			}
			const mimeType = typeof part.mimeType === 'string' && part.mimeType.trim().length > 0
				? part.mimeType
				: 'application/octet-stream';
			if (mimeType.startsWith('text/')) {
				const text = new TextDecoder('utf-8').decode(part.data);
				textChunks.push(text);
				parts.push({ type: 'text', text });
				continue;
			}
			const base64 = Buffer.from(part.data).toString('base64');
			if (mimeType.startsWith('image/')) {
				parts.push({ type: 'image-data', data: base64, mediaType: mimeType });
				continue;
			}
			parts.push({ type: 'file-data', data: base64, mediaType: mimeType });
			continue;
		}

		if (part !== undefined) {
			const value = String(part);
			textChunks.push(value);
			parts.push({ type: 'text', text: value });
		}
	}

	if (parts.length === 0) {
		return { type: 'text', value: '' };
	}
	if (parts.every((part) => part.type === 'text')) {
		return { type: 'text', value: textChunks.join('') };
	}
	return { type: 'content', value: parts };
}

// `ai` is the heaviest dependency and this extension activates on
// `onStartupFinished`, so `jsonSchema` loads on first tool use and is memoized.
let jsonSchemaPromise: Promise<typeof import('ai').jsonSchema> | undefined;

function loadJsonSchema(): Promise<typeof import('ai').jsonSchema> {
	jsonSchemaPromise ??= import('ai').then((module) => module.jsonSchema);
	return jsonSchemaPromise;
}

async function toolsToAiSdkTools(
	tools: readonly vscode.LanguageModelChatTool[],
	toolNameMap: ReadonlyMap<string, string>
): Promise<Record<string, any>> {
	const jsonSchema = await loadJsonSchema();
	const mapped: Record<string, any> = {};
	for (const tool of tools) {
		const schema = normalizeToolSchema(tool.inputSchema);
		const name = mapToolName(tool.name, toolNameMap);
		mapped[name] = {
			description: tool.description,
			inputSchema: jsonSchema(schema as any),
			// No `execute`: VS Code invokes tools and sends results next turn.
		};
	}
	return mapped;
}

function normalizeToolSchema(schema: unknown): unknown {
	const fallback = { type: 'object', properties: {}, additionalProperties: true };
	if (!schema || typeof schema !== 'object') {
		return fallback;
	}

	const record = schema as Record<string, unknown>;
	if (record.type === 'object') {
		const hasProperties = typeof record.properties === 'object' && record.properties !== null;
		return {
			...record,
			properties: hasProperties ? record.properties : {},
			additionalProperties:
				record.additionalProperties === undefined ? true : record.additionalProperties,
		};
	}
	return record;
}

function buildToolNameMap(
	tools: readonly vscode.LanguageModelChatTool[] | undefined
): { toProvider: Map<string, string>; toVsCode: Map<string, string> } {
	const toProvider = new Map<string, string>();
	const toVsCode = new Map<string, string>();
	if (!tools || tools.length === 0) {
		return { toProvider, toVsCode };
	}

	const used = new Set<string>();
	for (const tool of tools) {
		const baseName = sanitizeToolName(tool.name);
		let name = baseName;
		let suffix = 1;
		while (used.has(name)) {
			const suffixText = `_${suffix++}`;
			name = `${baseName.slice(0, 128 - suffixText.length)}${suffixText}`;
		}
		used.add(name);
		toProvider.set(tool.name, name);
		toVsCode.set(name, tool.name);
	}
	return { toProvider, toVsCode };
}

function sanitizeToolName(name: string): string {
	const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
	return cleaned.length > 0 ? cleaned.slice(0, 128) : 'tool';
}

function mapToolName(name: string, toolNameMap: ReadonlyMap<string, string>): string {
	return toolNameMap.get(name) ?? name;
}

// ---------------------------------------------------------------------------
// Message truncation to stay within context limits
// ---------------------------------------------------------------------------

/** Estimate token count for a single AI SDK message (rough: ~4 chars/token). */
function estimateMessageTokens(message: any): number {
	try {
		return Math.max(1, Math.ceil(JSON.stringify(message).length / 4));
	} catch {
		return 100;
	}
}

function estimateTotalTokens(messages: any[]): number {
	let total = 0;
	for (const message of messages) {
		total += estimateMessageTokens(message);
	}
	return total;
}

/**
 * Drop older messages to fit within the model's context window.
 *
 *  1. Keep all system messages at the start.
 *  2. From the rest, drop the oldest until the estimate fits the budget.
 *  3. Always preserve the final user/tool message so the model has something
 *     to respond to.
 *  4. Never break a tool-call / tool-result pair.
 */
function truncateMessages(
	messages: any[],
	budgetTokens: number
): { messages: any[]; dropped: number } {
	const estimated = estimateTotalTokens(messages);
	if (estimated <= budgetTokens) {
		return { messages, dropped: 0 };
	}

	const systemMessages: any[] = [];
	const nonSystemMessages: any[] = [];
	for (const message of messages) {
		if (message.role === 'system') {
			systemMessages.push(message);
		} else {
			nonSystemMessages.push(message);
		}
	}

	const systemTokens = estimateTotalTokens(systemMessages);
	const targetForNonSystem = Math.max(1, budgetTokens - systemTokens);

	if (systemTokens > budgetTokens && systemMessages.length > 1) {
		const keepSystem = [systemMessages[0]];
		const keepTokens = estimateMessageTokens(systemMessages[0]);
		const keepNonSystem = truncateNonSystemMessages(nonSystemMessages, Math.max(1, budgetTokens - keepTokens));
		return {
			messages: [...keepSystem, ...keepNonSystem],
			dropped: messages.length - 1 - keepNonSystem.length,
		};
	}

	const keepNonSystem = truncateNonSystemMessages(nonSystemMessages, targetForNonSystem);
	return {
		messages: [...systemMessages, ...keepNonSystem],
		dropped: nonSystemMessages.length - keepNonSystem.length,
	};
}

function truncateNonSystemMessages(messages: any[], budgetTokens: number): any[] {
	if (messages.length === 0) {
		return [];
	}
	if (estimateTotalTokens(messages) <= budgetTokens) {
		return messages;
	}

	const kept: any[] = [];
	let keptTokens = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const messageTokens = estimateMessageTokens(message);
		if (kept.length > 0 && keptTokens + messageTokens > budgetTokens) {
			break;
		}
		kept.unshift(message);
		keptTokens += messageTokens;
	}

	while (kept.length > 1) {
		const first = kept[0];
		if (first.role !== 'tool') {
			break;
		}
		const toolCallId = first.content?.[0]?.toolCallId;
		const hasMatchingCall = kept.some(
			(message) => message.role === 'assistant'
				&& Array.isArray(message.content)
				&& message.content.some((part: any) => part.type === 'tool-call' && part.toolCallId === toolCallId)
		);
		if (hasMatchingCall) {
			break;
		}
		kept.shift();
	}

	return kept;
}
