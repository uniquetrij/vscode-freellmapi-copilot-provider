/**
 * Persisted copy of the last catalog the provider served.
 *
 * VS Code's chat harness snapshots the models a provider offers when it starts
 * a session, and that happens while the window is still restoring — well before
 * an HTTP round trip to the gateway can finish. Replaying the previous catalog
 * from storage lets the provider answer that first request immediately; the
 * catalog is revalidated right afterwards, and anything that changes the
 * gateway URL or the API key drops the copy.
 *
 * Kept free of `vscode` imports so it stays unit-testable.
 */

import { isLoopbackBaseUrl } from './urls';

export const CATALOG_CACHE_STORAGE_KEY = 'freellmapi.modelCatalog.v1';

export interface CatalogCacheEntry<Model> {
	/** Gateway the models were fetched from; a different URL means a stale copy. */
	readonly baseUrl: string;
	/** When the gateway last confirmed the catalog, in epoch milliseconds. */
	readonly cachedAtMs: number;
	readonly models: readonly Model[];
}

function isModelLike(value: unknown): boolean {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const model = value as { id?: unknown; name?: unknown };
	return typeof model.id === 'string' && model.id.length > 0 && typeof model.name === 'string';
}

/**
 * The gateway port is discovered per session (the desktop app does not listen
 * on the configured port), so a catalog stored for another loopback address is
 * still this machine's gateway as far as the model list is concerned.
 */
function isSameGateway(stored: string, current: string): boolean {
	return stored === current || (isLoopbackBaseUrl(stored) && isLoopbackBaseUrl(current));
}

/**
 * Returns the stored entry when it belongs to `baseUrl` and still holds usable
 * models. Anything else (another gateway, a truncated write, an old shape) is
 * discarded so the next fetch starts clean.
 */
export function readCatalogCache<Model>(
	raw: unknown,
	baseUrl: string
): CatalogCacheEntry<Model> | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}

	const candidate = raw as Partial<CatalogCacheEntry<Model>>;
	if (typeof candidate.baseUrl !== 'string' || !isSameGateway(candidate.baseUrl, baseUrl)) {
		return undefined;
	}
	if (!Array.isArray(candidate.models)) {
		return undefined;
	}

	const models = candidate.models.filter(isModelLike);
	if (models.length === 0) {
		return undefined;
	}

	const cachedAtMs = typeof candidate.cachedAtMs === 'number' && Number.isFinite(candidate.cachedAtMs)
		? candidate.cachedAtMs
		: 0;
	return { baseUrl, cachedAtMs, models };
}

export function createCatalogCacheEntry<Model>(
	baseUrl: string,
	cachedAtMs: number,
	models: readonly Model[]
): CatalogCacheEntry<Model> {
	return { baseUrl, cachedAtMs, models };
}
