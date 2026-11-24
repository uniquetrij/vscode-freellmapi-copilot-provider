import assert from 'node:assert/strict';
import test from 'node:test';
import {
	catalogToChatInformation,
	isRouterModel,
	parseContextWindowHint,
	parseModelCatalog,
	sortCatalogModels,
	type CatalogModel,
} from '../modelCatalog';

const payload = {
	object: 'list',
	data: [
		{
			id: 'openai/gpt-4o',
			object: 'model',
			created: 1,
			owned_by: 'openai',
			name: 'GPT-4o',
			context_length: 128_000,
			available: true,
			execution_status: 'ready',
			supported_parameters: ['tools', 'tool_choice'],
		},
		{
			id: 'anthropic/claude-3',
			object: 'model',
			created: 2,
			owned_by: 'anthropic',
			name: 'Claude 3',
			context_window: 200_000,
			available: false,
			execution_status: 'needsKey',
			unavailable_reason: 'no_key',
			supported_parameters: ['tools'],
		},
		{
			id: 'auto',
			object: 'model',
			created: 0,
			owned_by: 'freellmapi',
			name: 'Auto',
			available: true,
			supported_parameters: [],
		},
		{
			id: 'auto:fast',
			object: 'model',
			created: 0,
			owned_by: 'freellmapi',
			name: 'Auto fast',
			available: true,
		},
		{
			id: 'meta/llama-3',
			object: 'model',
			owned_by: 'meta',
			name: 'Llama 3',
			available: false,
			execution_status: 'exhausted',
		},
		{ id: 'openai/gpt-4o', name: 'Duplicate' },
		{ id: '', name: 'Missing id' },
	],
};

test('parseModelCatalog reads the OpenAI list envelope and dedupes ids', () => {
	const models = parseModelCatalog(payload);
	assert.deepEqual(
		models.map((model) => model.id),
		['openai/gpt-4o', 'anthropic/claude-3', 'auto', 'auto:fast', 'meta/llama-3']
	);
	assert.equal(models[0].contextWindow, 128_000);
	assert.equal(models[1].contextWindow, 200_000);
	assert.equal(models[2].contextWindow, 32_768);
	assert.equal(models[4].available, false);
	assert.equal(models[4].executionStatus, 'exhausted');
});

test('parseModelCatalog accepts a bare array and rejects unrelated bodies', () => {
	assert.equal(parseModelCatalog([{ id: 'x' }]).length, 1);
	assert.throws(() => parseModelCatalog({ models: [] }), /OpenAI-style/);
});

test('catalogToChatInformation maps status, capabilities, and filters', () => {
	const models = parseModelCatalog(payload);
	const infos = catalogToChatInformation(models, {
		maxOutputTokens: 4_096,
		imageInput: 'auto',
		modelFilter: 'claude,auto',
		showUnavailableModels: true,
	});

	assert.deepEqual(infos.map((info) => info.id), ['auto', 'auto:fast', 'anthropic/claude-3']);
	assert.equal(infos[0].detail, 'Router');
	assert.equal(infos[0].capabilities?.imageInput, true);
	assert.equal(infos[2].detail, 'Needs provider key');
	assert.equal(infos[2].capabilities?.toolCalling, true);
	assert.equal(infos[2].capabilities?.imageInput, false);
	assert.equal(infos[2].maxOutputTokens, 4_096);
	assert.equal(infos[2].maxInputTokens, 200_000);
});

test('sortCatalogModels puts router entries first and available models before unavailable ones', () => {
	const catalog: CatalogModel[] = [
		{ id: 'z-ready', name: 'Z ready', ownedBy: 'p', created: 1, contextWindow: 1, available: true },
		{ id: 'a-blocked', name: 'A blocked', ownedBy: 'p', created: 1, contextWindow: 1, available: false },
		{ id: 'fusion', name: 'Fusion', ownedBy: 'freellmapi', created: 0, contextWindow: 1, available: true },
		{ id: 'auto', name: 'Auto', ownedBy: 'freellmapi', created: 0, contextWindow: 1, available: true },
		{ id: 'auto:fast', name: 'Auto fast', ownedBy: 'freellmapi', created: 0, contextWindow: 1, available: true },
	];

	assert.deepEqual(
		sortCatalogModels(catalog).map((model) => model.id),
		['auto', 'auto:fast', 'fusion', 'z-ready', 'a-blocked']
	);
});

test('catalogToChatInformation clamps output tokens to the input window', () => {
	const [info] = catalogToChatInformation(
		[{ id: 'small', name: 'Small', ownedBy: 'p', created: 1, contextWindow: 2_000, available: true }],
		{ maxOutputTokens: 8_192, imageInput: 'none' }
	);
	assert.equal(info.maxInputTokens, 2_000);
	assert.equal(info.maxOutputTokens, 2_000);
	assert.equal(info.capabilities?.imageInput, false);
});

test('isRouterModel matches router ids only, not every freellmapi-owned row', () => {
	// The live catalog advertises owned_by "freellmapi" and created 0 on all 316
	// rows, so those fields must not be used to detect a router.
	assert.equal(isRouterModel({ id: 'auto' }), true);
	assert.equal(isRouterModel({ id: 'auto-route' }), true);
	assert.equal(isRouterModel({ id: 'fusion' }), true);
	assert.equal(isRouterModel({ id: 'auto:fast' }), true);
	assert.equal(isRouterModel({ id: 'free-router' }), false);
	assert.equal(isRouterModel({ id: 'kilo-auto' }), false);
	assert.equal(isRouterModel({ id: 'ctx65536-magidonia-24b-heretic' }), false);
});

test('a real model owned by freellmapi is not advertised as a router', () => {
	const [info] = catalogToChatInformation(
		[{ id: 'free-router', name: 'Free Router', ownedBy: 'freellmapi', created: 0, contextWindow: 160_000, available: true }],
		{ maxOutputTokens: 8_192, imageInput: 'auto' }
	);
	assert.equal(info.family, 'freellmapi');
	assert.equal(info.detail, undefined);
	assert.equal(info.capabilities?.imageInput, false);
});

test('parseContextWindowHint reads the window the gateway encodes in an id or name', () => {
	assert.equal(parseContextWindowHint('ctx65536-magidonia-24b-heretic'), 65_536);
	assert.equal(parseContextWindowHint('[ctx:65536] Magidonia-24B-heretic-'), 65_536);
	assert.equal(parseContextWindowHint('gemma-4-26b'), undefined);
	assert.equal(parseContextWindowHint(undefined), undefined);
});

test('parseModelCatalog falls back to the id/name context hint when context_window is null', () => {
	const models = parseModelCatalog({
		object: 'list',
		data: [
			{ id: 'ctx65536-magidonia-24b-heretic', name: '[ctx:65536] Magidonia-24B-heretic-', context_window: null, context_length: null },
			{ id: 'qwen3.8-max', name: 'Qwen3.8 Max', context_window: null, context_length: null },
		],
	});
	assert.equal(models[0].contextWindow, 65_536);
	assert.equal(models[1].contextWindow, 32_768);
});

test('catalogToChatInformation hides models the gateway cannot serve unless asked', () => {
	const models: CatalogModel[] = [
		{ id: 'ready-model', name: 'Ready', ownedBy: 'freellmapi', created: 0, contextWindow: 8_000, available: true },
		{ id: 'needs-key', name: 'Needs key', ownedBy: 'freellmapi', created: 0, contextWindow: 8_000, available: false, executionStatus: 'needsKey' },
	];
	const options = { maxOutputTokens: 1_024, imageInput: 'none' as const };

	assert.deepEqual(
		catalogToChatInformation(models, options).map((info) => info.id),
		['ready-model']
	);
	assert.deepEqual(
		catalogToChatInformation(models, { ...options, showUnavailableModels: true }).map((info) => info.id),
		['ready-model', 'needs-key']
	);
});
