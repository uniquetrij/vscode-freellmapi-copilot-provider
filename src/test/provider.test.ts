import './support/register';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyReasoningFallback,
	badgeModelNames,
	buildToolNameMap,
	createDevBadgeEmitter,
	estimateTotalTokens,
	mapToolName,
	normalizeToolSchema,
	sanitizeToolName,
	stripDevBadge,
	truncateMessages,
} from '../provider';

const MODELS = [
	{
		id: 'auto',
		name: 'Auto',
		family: 'freellmapi-router',
		version: '1',
		tooltip: '**Auto**',
		detail: 'Router',
		maxInputTokens: 128_000,
		maxOutputTokens: 8_192,
		capabilities: { toolCalling: true, imageInput: true },
	},
	{
		id: 'openai/gpt-4o',
		name: 'GPT-4o',
		family: 'openai',
		version: '1',
		maxInputTokens: 128_000,
		maxOutputTokens: 8_192,
		capabilities: { toolCalling: true, imageInput: false },
	},
] as any;

test('sanitizeToolName replaces characters providers reject', () => {
	assert.equal(sanitizeToolName('mcp.server/read-file'), 'mcp_server_read-file');
	assert.equal(sanitizeToolName('   '), '___');
	assert.equal(sanitizeToolName(''), 'tool');
});

test('sanitizeToolName caps names at the provider limit', () => {
	assert.equal(sanitizeToolName('a'.repeat(300)).length, 128);
});

test('buildToolNameMap dedupes sanitized collisions and maps back', () => {
	const { toProvider, toVsCode } = buildToolNameMap([
		{ name: 'a.b' },
		{ name: 'a_b' },
	] as any);

	assert.equal(toProvider.get('a.b'), 'a_b');
	assert.equal(toProvider.get('a_b'), 'a_b_1');
	assert.equal(mapToolName('a_b', toVsCode), 'a.b');
	assert.equal(mapToolName('a_b_1', toVsCode), 'a_b');
});

test('mapToolName leaves unmapped names untouched', () => {
	assert.equal(mapToolName('unknown', new Map()), 'unknown');
});

test('normalizeToolSchema fills in an object schema', () => {
	assert.deepEqual(normalizeToolSchema(undefined), {
		type: 'object',
		properties: {},
		additionalProperties: true,
	});
	assert.deepEqual(normalizeToolSchema({ type: 'object' }), {
		type: 'object',
		properties: {},
		additionalProperties: true,
	});
	assert.deepEqual(normalizeToolSchema({ type: 'string' }), { type: 'string' });
});

test('truncateMessages returns everything when the estimate fits', () => {
	const messages = [
		{ role: 'system', content: 'sys' },
		{ role: 'user', content: 'hi' },
	];
	const result = truncateMessages(messages, 10_000);

	assert.equal(result.dropped, 0);
	assert.equal(result.messages, messages);
});

test('truncateMessages drops the oldest non-system messages first', () => {
	const messages = [
		{ role: 'system', content: 'sys' },
		{ role: 'user', content: 'u'.repeat(8_000) },
		{ role: 'user', content: 'latest' },
	];
	const result = truncateMessages(messages, 100);

	assert.equal(result.messages[0], messages[0]);
	assert.ok(result.messages.includes(messages[2]));
	assert.ok(!result.messages.includes(messages[1]));
	assert.ok(result.dropped >= 1);
});

test('truncateMessages keeps a tool call and its result together', () => {
	const messages = [
		{ role: 'user', content: 'u'.repeat(8_000) },
		{
			role: 'assistant',
			content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: {} }],
		},
		{
			role: 'tool',
			content: [
				{ type: 'tool-result', toolCallId: 'c1', toolName: 'read', output: { type: 'text', value: 'ok' } },
			],
		},
		{ role: 'user', content: 'latest' },
	];
	const result = truncateMessages(messages, 100);

	assert.ok(result.messages.some((message) => message.role === 'assistant'));
	assert.ok(result.messages.some((message) => message.role === 'tool'));
	assert.ok(!result.messages.includes(messages[0]));
});

test('truncateMessages removes an orphaned tool result', () => {
	const messages = [
		{
			role: 'assistant',
			content: [
				{ type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { pad: 'x'.repeat(8_000) } },
			],
		},
		{
			role: 'tool',
			content: [
				{ type: 'tool-result', toolCallId: 'c1', toolName: 'read', output: { type: 'text', value: 'ok' } },
			],
		},
		{ role: 'user', content: 'latest' },
	];
	const result = truncateMessages(messages, 100);

	assert.deepEqual(result.messages.map((message) => message.role), ['user']);
});

test('truncateMessages keeps only the first system message when the system block overflows', () => {
	const messages = [
		{ role: 'system', content: 'keep' },
		{ role: 'system', content: 'x'.repeat(8_000) },
		{ role: 'user', content: 'latest' },
	];
	const result = truncateMessages(messages, 100);

	assert.deepEqual(result.messages.map((message) => message.role), ['system', 'user']);
	assert.equal(result.messages[0].content, 'keep');
});

test('applyReasoningFallback attaches reasoning to the last assistant message once', () => {
	const messages = [
		{ role: 'user', content: 'hi' },
		{ role: 'assistant', content: 'hello' },
	];
	const withReasoning = applyReasoningFallback(messages as any, 'why');

	assert.equal((withReasoning[1] as any).providerOptions.openaiCompatible.reasoning_content, 'why');

	const twice = applyReasoningFallback(withReasoning, 'again');
	assert.equal((twice[1] as any).providerOptions.openaiCompatible.reasoning_content, 'why');
});

test('applyReasoningFallback is a no-op without reasoning or assistant turns', () => {
	const messages = [{ role: 'user', content: 'hi' }];

	assert.equal(applyReasoningFallback(messages as any, ''), messages);
	assert.equal(applyReasoningFallback(messages as any, 'why'), messages);
});

test('estimateTotalTokens grows with content', () => {
	const small = estimateTotalTokens([{ role: 'user', content: 'hi' }]);
	const large = estimateTotalTokens([{ role: 'user', content: 'x'.repeat(4_000) }]);

	assert.ok(small >= 1);
	assert.ok(large > small);
});

test('badgeModelNames prefixes the picker labels of a debug window', () => {
	const badged = badgeModelNames(MODELS, '🐞 ');

	assert.deepEqual(badged.map((model) => model.name), ['🐞 Auto', '🐞 GPT-4o']);
	assert.deepEqual(badged.map((model) => model.id), ['auto', 'openai/gpt-4o']);
	assert.equal(badged[0].family, 'freellmapi-router');
	assert.equal(badged[0].maxInputTokens, 128_000);
	// The registry's copy is what gets persisted, so it must stay unlabelled.
	assert.deepEqual(MODELS.map((model: any) => model.name), ['Auto', 'GPT-4o']);
});

test('badgeModelNames leaves the labels alone outside a debug window', () => {
	const plain = badgeModelNames(MODELS, '');

	assert.deepEqual(plain.map((model) => model.name), ['Auto', 'GPT-4o']);
	assert.notEqual(plain, MODELS);
});

test('createDevBadgeEmitter prefixes the first text of a response once', () => {
	const prefix = createDevBadgeEmitter('🐞 ');

	assert.equal(prefix('Hel'), '🐞 Hel');
	assert.equal(prefix('lo'), 'lo');
});

test('createDevBadgeEmitter ignores empty chunks and empty badges', () => {
	const prefix = createDevBadgeEmitter('🐞 ');

	assert.equal(prefix(''), '');
	assert.equal(prefix('answer'), '🐞 answer');
	assert.equal(createDevBadgeEmitter('')('answer'), 'answer');
});

test('stripDevBadge removes only a leading badge', () => {
	assert.equal(stripDevBadge('🐞 hello', '🐞 '), 'hello');
	assert.equal(stripDevBadge('hello', '🐞 '), 'hello');
	assert.equal(stripDevBadge('say 🐞 hi', '🐞 '), 'say 🐞 hi');
	// Release windows pass an empty badge, so a model-authored one survives.
	assert.equal(stripDevBadge('🐞 hello', ''), '🐞 hello');
});

test('the dev badge round-trips out of the response and back out of the history', () => {
	const prefix = createDevBadgeEmitter('🐞 ');
	const emitted = [prefix('Hello'), prefix(' world')].join('');

	assert.equal(emitted, '🐞 Hello world');
	assert.equal(stripDevBadge(emitted, '🐞 '), 'Hello world');
});
