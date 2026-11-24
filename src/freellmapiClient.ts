import type { ModelMessage } from 'ai';
import { chatCompletionsUrl } from './urls';
import { wrapApiError } from './errors';
import { redactHeaderRecord, redactHeaders, safeJson } from './diagnostics';

export type ToolMode = 'auto' | 'required';

export type ClientLogger = {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	raw(text: string): void;
};

export type FreeLlmApiUsage = {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	inputTokenDetails?: { cacheReadTokens?: number };
};

export type StreamCallbacks = {
	onTextDelta: (delta: string) => void;
	onThinkingDelta: (delta: string) => void;
	onToolCall: (args: { toolCallId: string; toolName: string; input: object }) => void;
	onUsage?: (usage: FreeLlmApiUsage) => void;
};

export type FreeLlmApiStreamOptions = {
	readonly apiKey: string;
	readonly baseUrl: string;
	readonly modelId: string;
	readonly messages: ModelMessage[];
	readonly tools?: Record<string, any>;
	readonly toolMode: ToolMode;
	readonly abortSignal: AbortSignal;
	readonly headers?: Record<string, string>;
	readonly maxOutputTokens?: number;
	readonly debugLogging?: boolean;
	readonly logger: ClientLogger;
	readonly toolNameMap?: ReadonlyMap<string, string>;
};

let providerModulePromise: Promise<typeof import('@ai-sdk/openai-compatible')> | undefined;
let streamTextPromise: Promise<typeof import('ai').streamText> | undefined;

function loadProviderModule(): Promise<typeof import('@ai-sdk/openai-compatible')> {
	providerModulePromise ??= import('@ai-sdk/openai-compatible');
	return providerModulePromise;
}

function loadStreamText(): Promise<typeof import('ai').streamText> {
	streamTextPromise ??= import('ai').then((module) => module.streamText);
	return streamTextPromise;
}

/**
 * Normalize a tool-call `input` into a JSON object that providers accept.
 *
 * `@ai-sdk/openai-compatible` passes `function.arguments` through as a raw JSON
 * string, and our history mapping re-serializes `input` with JSON.stringify. If
 * a string slips through, OpenAI-style gateways reject the follow-up with
 * "function.arguments must be a JSON object".
 */
export function normalizeToolCallInput(input: unknown): Record<string, any> {
	if (input && typeof input === 'object' && !Array.isArray(input)) {
		return input as Record<string, any>;
	}

	if (typeof input === 'string') {
		const trimmed = input.trim();
		if (trimmed === '') {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, any>;
			}
		} catch {
			// Not JSON — wrap it so the field stays an object.
		}
		return { value: input };
	}

	if (input === undefined || input === null) {
		return {};
	}

	return { value: input };
}

export async function streamFreeLlmApi(
	options: FreeLlmApiStreamOptions,
	callbacks: StreamCallbacks
): Promise<void> {
	if (!options.apiKey || options.apiKey.trim() === '') {
		throw new Error('FreeLLMAPI API key is empty. Run "FreeLLMAPI: Set API Key" to configure it.');
	}

	const requestUrl = chatCompletionsUrl(options.baseUrl);
	let requestBody: unknown;

	const { createOpenAICompatible } = await loadProviderModule();
	const provider = createOpenAICompatible({
		name: 'freellmapi',
		apiKey: options.apiKey,
		baseURL: options.baseUrl,
		includeUsage: true,
		fetch: options.debugLogging ? createDebugFetch(options.logger) : undefined,
		transformRequestBody: (args) => {
			requestBody = args;
			return args;
		},
	});

	const streamText = await loadStreamText();
	const hasTools = options.tools !== undefined && Object.keys(options.tools).length > 0;
	let emitted = false;
	let sawAnyChunk = false;

	try {
		const result = streamText({
			model: provider(options.modelId),
			messages: options.messages,
			tools: hasTools ? options.tools : undefined,
			toolChoice: hasTools ? options.toolMode : undefined,
			abortSignal: options.abortSignal,
			headers: options.headers,
			maxOutputTokens: options.maxOutputTokens,
			// Errors are surfaced through `fullStream` and wrapped below; the
			// default handler would also print a duplicate stack to the host log.
			onError: () => undefined,
		});

		for await (const part of result.fullStream) {
			sawAnyChunk = true;

			if (part.type === 'text-delta') {
				emitted = emitted || part.text.length > 0;
				callbacks.onTextDelta(part.text);
				continue;
			}

			// AI SDK v6 renames the provider's `delta` field to `text` on the
			// fullStream part, but that has been inconsistent across versions.
			if (part.type === 'reasoning-delta') {
				const reasoning = (part as any).text ?? (part as any).delta;
				if (typeof reasoning === 'string' && reasoning.length > 0) {
					emitted = true;
					callbacks.onThinkingDelta(reasoning);
				}
				continue;
			}

			if (part.type === 'tool-call') {
				emitted = true;
				callbacks.onToolCall({
					toolCallId: part.toolCallId,
					toolName: options.toolNameMap?.get(part.toolName) ?? part.toolName,
					input: normalizeToolCallInput(part.input),
				});
				continue;
			}

			if (part.type === 'error') {
				throw wrapApiError(part.error, {
					url: requestUrl,
					baseUrl: options.baseUrl,
					requestBody,
				});
			}
		}

		if (callbacks.onUsage) {
			try {
				const usage = await result.usage;
				if (usage) {
					callbacks.onUsage(usage as FreeLlmApiUsage);
				}
			} catch {
				// Usage is best-effort; a missing usage block must not fail the turn.
			}
		}
	} catch (err) {
		throw wrapApiError(err, {
			url: requestUrl,
			baseUrl: options.baseUrl,
			requestBody,
		});
	}

	// VS Code shows "Sorry, no response was returned" if the provider emits
	// nothing at all, so always leave the turn with a visible part.
	if (!emitted) {
		callbacks.onTextDelta(sawAnyChunk ? '\n' : 'No response returned by model.');
	}
}

function createDebugFetch(logger: ClientLogger): typeof fetch {
	return async (input, init) => {
		let request: string;
		try {
			request = await serializeRequest(input, init);
		} catch (err) {
			request = safeJson({ error: `Could not serialize request: ${err instanceof Error ? err.message : String(err)}` });
		}
		logger.info('Debug: HTTP request');
		logger.raw(request);

		const response = await fetch(input, init);
		const summary = {
			status: response.status,
			statusText: response.statusText,
			url: response.url,
			headers: redactHeaders(response.headers),
		};

		if (response.ok) {
			// Reading a clone of an SSE body would block until the whole stream
			// finished, defeating streaming, so successful bodies stay unread.
			logger.info('Debug: HTTP response');
			logger.raw(safeJson(summary));
			return response;
		}

		let body: string | undefined;
		try {
			body = await response.clone().text();
		} catch {
			body = undefined;
		}
		logger.error('Debug: HTTP response (non-OK)');
		logger.raw(safeJson({ ...summary, body: body && body.length > 0 ? body : undefined }));
		return response;
	};
}

async function serializeRequest(
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1]
): Promise<string> {
	const request = new Request(input, init);
	let body: string | undefined;
	try {
		body = await request.clone().text();
	} catch {
		body = undefined;
	}

	const MAX_BODY_CHARS = 20_000;
	const trimmedBody = body && body.length > MAX_BODY_CHARS
		? `${body.slice(0, MAX_BODY_CHARS)}\n... [truncated ${body.length - MAX_BODY_CHARS} chars]`
		: body;

	return safeJson({
		method: request.method,
		url: request.url,
		headers: redactHeaderRecord(Object.fromEntries(request.headers.entries())),
		body: trimmedBody,
	});
}
