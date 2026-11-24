import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import test from 'node:test';
import { jsonSchema } from 'ai';
import type { ModelMessage } from 'ai';
import { streamFreeLlmApi } from '../freellmapiClient';

type CapturedRequest = { body: any; authorization: string | undefined };

function listen(
	handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ server: Server; baseUrl: string; requests: CapturedRequest[]; close: () => Promise<void> }> {
	const requests: CapturedRequest[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			let body: any;
			try {
				body = raw ? JSON.parse(raw) : undefined;
			} catch {
				body = raw;
			}
			requests.push({
				body,
				authorization: typeof request.headers.authorization === 'string'
					? request.headers.authorization
					: undefined,
			});
			handler(request, response);
		});
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				throw new Error('The mock server did not expose a TCP port.');
			}
			resolve({
				server,
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				requests,
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}

function sse(response: ServerResponse, chunks: unknown[]): void {
	response.writeHead(200, {
		'content-type': 'text/event-stream',
		'cache-control': 'no-cache',
		connection: 'keep-alive',
	});
	for (const chunk of chunks) {
		response.write(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`);
	}
	response.end('data: [DONE]\n\n');
}

function chunk(delta: unknown, finishReason: string | null = null, usage?: unknown): unknown {
	return {
		id: 'chatcmpl-test',
		object: 'chat.completion.chunk',
		created: 1_700_000_000,
		model: 'test-model',
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	};
}

test('streamFreeLlmApi forwards text, reasoning, tool calls, and usage', async () => {
	const mock = await listen((_request, response) => {
		sse(response, [
			chunk({ role: 'assistant', content: '' }),
			chunk({ content: 'Hello ' }),
			chunk({ reasoning_content: 'Thinking about it. ' }),
			chunk({ content: 'world.' }),
			chunk({
				tool_calls: [
					{
						index: 0,
						id: 'call_1',
						type: 'function',
						function: { name: 'get_time', arguments: '{"tz":"UTC"}' },
					},
				],
			}),
			chunk({}, 'tool_calls'),
			chunk({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }),
		]);
	});

	const text: string[] = [];
	const thinking: string[] = [];
	const toolCalls: Array<{ toolCallId: string; toolName: string; input: object }> = [];
	let usage: unknown;

	try {
		await streamFreeLlmApi(
			{
				apiKey: 'freellmapi-test',
				baseUrl: mock.baseUrl,
				modelId: 'test-model',
				messages: [{ role: 'user', content: 'What time is it?' }] satisfies ModelMessage[],
				tools: {
					get_time: {
						description: 'Returns the current time.',
						inputSchema: jsonSchema({
							type: 'object',
							properties: { tz: { type: 'string' } },
							additionalProperties: false,
						}),
					},
				},
				toolMode: 'auto',
				abortSignal: new AbortController().signal,
				headers: { 'x-session-id': 'ses_test' },
				maxOutputTokens: 256,
				logger: {
					info: () => undefined,
					warn: () => undefined,
					error: () => undefined,
					raw: () => undefined,
				},
			},
			{
				onTextDelta: (delta) => text.push(delta),
				onThinkingDelta: (delta) => thinking.push(delta),
				onToolCall: (call) => toolCalls.push(call),
				onUsage: (value) => {
					usage = value;
				},
			}
		);
	} finally {
		await mock.close();
	}

	assert.equal(text.join(''), 'Hello world.');
	assert.equal(thinking.join(''), 'Thinking about it. ');
	assert.deepEqual(toolCalls, [
		{ toolCallId: 'call_1', toolName: 'get_time', input: { tz: 'UTC' } },
	]);
	assert.equal((usage as { inputTokens?: number }).inputTokens, 10);
	assert.equal((usage as { outputTokens?: number }).outputTokens, 4);
	assert.equal((usage as { totalTokens?: number }).totalTokens, 14);

	assert.equal(mock.requests.length, 1);
	const request = mock.requests[0];
	assert.equal(request.authorization, 'Bearer freellmapi-test');
	assert.equal(request.body.model, 'test-model');
	assert.equal(request.body.stream, true);
	assert.deepEqual(request.body.stream_options, { include_usage: true });
	assert.equal(request.body.messages[0].content, 'What time is it?');
	assert.equal(request.body.tools[0].function.name, 'get_time');
});

test('streamFreeLlmApi reports a rejected API key with actionable text', async () => {
	const mock = await listen((_request, response) => {
		response.writeHead(401, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: { message: 'invalid key' } }));
	});

	try {
		await assert.rejects(
			streamFreeLlmApi(
				{
					apiKey: 'bad-key',
					baseUrl: mock.baseUrl,
					modelId: 'test-model',
					messages: [{ role: 'user', content: 'hi' }] satisfies ModelMessage[],
					toolMode: 'auto',
					abortSignal: new AbortController().signal,
					logger: {
						info: () => undefined,
						warn: () => undefined,
						error: () => undefined,
						raw: () => undefined,
					},
				},
				{
					onTextDelta: () => undefined,
					onThinkingDelta: () => undefined,
					onToolCall: () => undefined,
				}
			),
			/(HTTP 401|Set API Key)/i
		);
	} finally {
		await mock.close();
	}
});

test('streamFreeLlmApi emits a fallback part when the model returns nothing', async () => {
	const mock = await listen((_request, response) => {
		sse(response, [chunk({}, 'stop')]);
	});

	const text: string[] = [];
	try {
		await streamFreeLlmApi(
			{
				apiKey: 'freellmapi-test',
				baseUrl: mock.baseUrl,
				modelId: 'test-model',
				messages: [{ role: 'user', content: 'hi' }] satisfies ModelMessage[],
				toolMode: 'auto',
				abortSignal: new AbortController().signal,
				logger: {
					info: () => undefined,
					warn: () => undefined,
					error: () => undefined,
					raw: () => undefined,
				},
			},
			{
				onTextDelta: (delta) => text.push(delta),
				onThinkingDelta: () => undefined,
				onToolCall: () => undefined,
			}
		);
	} finally {
		await mock.close();
	}

	assert.deepEqual(text, ['\n']);
});
