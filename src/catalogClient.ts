import { parseModelCatalog, type CatalogModel } from './modelCatalog';
import { modelsUrl } from './urls';

export interface CatalogFetchResult {
	readonly status: number;
	readonly ok: boolean;
	readonly models: CatalogModel[];
	readonly etag?: string;
	readonly body?: string;
}

export interface CatalogFetchOptions {
	readonly etag?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

/**
 * Shared by the registry and the "check connection" / "set API key" commands so
 * a key is validated against exactly the request the model picker uses.
 */
export async function fetchModelCatalog(
	baseUrl: string,
	apiKey: string,
	options: CatalogFetchOptions = {}
): Promise<CatalogFetchResult> {
	const url = modelsUrl(baseUrl);
	const headers: Record<string, string> = {
		accept: 'application/json',
		authorization: `Bearer ${apiKey}`,
	};
	if (options.etag) {
		headers['if-none-match'] = options.etag;
	}

	const timeoutMs = options.timeoutMs ?? 15_000;
	const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
	const response = await fetch(url, { headers, signal });
	const body = await response.text();
	const etag = response.headers.get('etag') ?? undefined;

	if (response.status === 304) {
		return { status: 304, ok: true, models: [], etag };
	}

	if (!response.ok) {
		return {
			status: response.status,
			ok: false,
			models: [],
			etag,
			body: body.slice(0, 4_000),
		};
	}

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		throw new Error(`FreeLLMAPI returned a non-JSON model catalog from ${url}.`);
	}

	return {
		status: response.status,
		ok: true,
		models: parseModelCatalog(payload),
		etag,
	};
}
