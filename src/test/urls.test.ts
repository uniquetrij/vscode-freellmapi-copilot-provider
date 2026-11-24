import assert from 'node:assert/strict';
import test from 'node:test';
import {
	chatCompletionsUrl,
	dashboardUrl,
	isLoopbackBaseUrl,
	matchesModelFilter,
	modelsUrl,
	normalizeBaseUrl,
	parseModelFilter,
	pingUrl,
	usageUrl,
} from '../urls';

test('normalizeBaseUrl adds a scheme and the /v1 path', () => {
	assert.equal(normalizeBaseUrl('localhost:3001'), 'http://localhost:3001/v1');
	assert.equal(normalizeBaseUrl('http://localhost:3001/'), 'http://localhost:3001/v1');
	assert.equal(normalizeBaseUrl('https://example.test/api'), 'https://example.test/api/v1');
});

test('normalizeBaseUrl preserves an existing version path and removes query/hash', () => {
	assert.equal(
		normalizeBaseUrl('http://localhost:3001/v1/?token=ignored#fragment'),
		'http://localhost:3001/v1'
	);
	assert.equal(normalizeBaseUrl('https://example.test/openai/v2'), 'https://example.test/openai/v2');
});

test('normalizeBaseUrl rejects invalid or non-http URLs', () => {
	assert.throws(() => normalizeBaseUrl('ftp://example.test'), /http or https/);
	assert.throws(() => normalizeBaseUrl('not a url'), /Invalid FreeLLMAPI base URL/);
});

test('derived URLs share the normalized base', () => {
	const base = 'http://127.0.0.1:3001/v1';
	assert.equal(modelsUrl(base), `${base}/models`);
	assert.equal(chatCompletionsUrl(base), `${base}/chat/completions`);
	assert.equal(usageUrl(base), `${base}/usage`);
	assert.equal(pingUrl(base), 'http://127.0.0.1:3001/api/ping');
	assert.equal(dashboardUrl(base), 'http://127.0.0.1:3001');
});

test('isLoopbackBaseUrl only accepts this machine', () => {
	assert.equal(isLoopbackBaseUrl('http://127.0.0.1:3001/v1'), true);
	assert.equal(isLoopbackBaseUrl('http://127.1.2.3:31415'), true);
	assert.equal(isLoopbackBaseUrl('localhost:3001'), true);
	assert.equal(isLoopbackBaseUrl('http://[::1]:3001/v1'), true);
	assert.equal(isLoopbackBaseUrl('http://192.168.1.20:3001/v1'), false);
	assert.equal(isLoopbackBaseUrl('https://gateway.example.test/v1'), false);
	assert.equal(isLoopbackBaseUrl('127.0.0.1:3001'), true);
	assert.equal(isLoopbackBaseUrl('not a url'), false);
});

test('parseModelFilter treats plain text as a substring and supports globs', () => {
	const patterns = parseModelFilter('claude, gpt-?*, auto*');
	assert.equal(matchesModelFilter('anthropic/claude-3', 'Claude 3', patterns), true);
	assert.equal(matchesModelFilter('openai/gpt-4o', 'GPT-4o', patterns), true);
	assert.equal(matchesModelFilter('auto:fast', 'Auto fast', patterns), true);
	assert.equal(matchesModelFilter('llama-3', 'Llama 3', patterns), false);
	assert.equal(matchesModelFilter('llama-3', 'Llama 3', parseModelFilter('')), true);
});
