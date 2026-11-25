import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogCacheEntry, readCatalogCache } from '../catalogCache';

const BASE_URL = 'http://127.0.0.1:31415/v1';
const MODELS = [
	{ id: 'auto', name: 'Auto' },
	{ id: 'fusion', name: 'Fusion' }
];

test('readCatalogCache returns the stored models for the same gateway', () => {
	const stored = createCatalogCacheEntry(BASE_URL, 1_700_000_000_000, MODELS);

	const entry = readCatalogCache<{ id: string; name: string }>(stored, BASE_URL);

	assert.deepEqual(entry?.models, MODELS);
	assert.equal(entry?.cachedAtMs, 1_700_000_000_000);
});

test('readCatalogCache ignores a copy from a remote gateway', () => {
	const stored = createCatalogCacheEntry('https://gateway.example.com/v1', 1, MODELS);

	assert.equal(readCatalogCache(stored, BASE_URL), undefined);
});

test('readCatalogCache reuses a loopback copy when the discovered port changed', () => {
	const stored = createCatalogCacheEntry('http://127.0.0.1:3001/v1', 1, MODELS);

	const entry = readCatalogCache<{ id: string; name: string }>(stored, BASE_URL);

	assert.deepEqual(entry?.models, MODELS);
	assert.equal(entry?.baseUrl, BASE_URL);
});

test('readCatalogCache ignores entries without usable models', () => {
	assert.equal(readCatalogCache(createCatalogCacheEntry(BASE_URL, 1, []), BASE_URL), undefined);
	assert.equal(readCatalogCache(undefined, BASE_URL), undefined);
	assert.equal(readCatalogCache('nonsense', BASE_URL), undefined);
	assert.equal(readCatalogCache({ baseUrl: BASE_URL }, BASE_URL), undefined);
});

test('readCatalogCache drops individual entries that are not models', () => {
	const stored = {
		baseUrl: BASE_URL,
		cachedAtMs: 5,
		models: [MODELS[0], null, { id: '' }, { name: 'no id' }]
	};

	const entry = readCatalogCache<{ id: string; name: string }>(stored, BASE_URL);

	assert.deepEqual(entry?.models, [MODELS[0]]);
});

test('readCatalogCache tolerates a missing timestamp', () => {
	const entry = readCatalogCache<{ id: string }>({ baseUrl: BASE_URL, models: MODELS }, BASE_URL);

	assert.equal(entry?.cachedAtMs, 0);
});
