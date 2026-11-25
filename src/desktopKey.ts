import { isLoopbackBaseUrl, originFromBaseUrl } from './urls';

/**
 * The FreeLLMAPI desktop app hands a dashboard session to anything on this
 * machine (`POST /api/auth/desktop-session`) and its settings API returns the
 * unified key (`GET /api/settings/api-key`). Both are refused unless the
 * gateway runs with `FREEAPI_DESKTOP=1`, the request arrives over loopback,
 * and the Host header is local, so a Docker or remote install simply answers
 * 403 and the user keeps entering the key by hand.
 *
 * The key is returned to the caller only; it is never logged here.
 */

const DEFAULT_TIMEOUT_MS = 4_000;
const UNIFIED_KEY_PATTERN = /^freellmapi-\S{8,}$/;

export interface DesktopKeyResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}

export type DesktopKeyFetch = (
	url: string,
	init: {
		readonly method?: string;
		readonly headers?: Record<string, string>;
		readonly signal?: AbortSignal;
	}
) => Promise<DesktopKeyResponse>;

export interface DesktopKeyOptions {
	readonly fetchImpl?: DesktopKeyFetch;
	readonly timeoutMs?: number;
}

export interface AdoptedDesktopKey {
	readonly apiKey: string;
	readonly origin: string;
}

export async function fetchDesktopUnifiedKey(
	baseUrl: string,
	options: DesktopKeyOptions = {}
): Promise<AdoptedDesktopKey | undefined> {
	// Only the local desktop app issues these sessions; a remote gateway is
	// never asked and never sees a request from here.
	if (!isLoopbackBaseUrl(baseUrl)) {
		return undefined;
	}

	let origin: string;
	try {
		origin = originFromBaseUrl(baseUrl);
	} catch {
		return undefined;
	}

	const fetchImpl = options.fetchImpl ?? (fetch as unknown as DesktopKeyFetch);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const token = await requestSessionToken(fetchImpl, origin, timeoutMs);
	if (!token) {
		return undefined;
	}

	const apiKey = await requestUnifiedKey(fetchImpl, origin, token, timeoutMs);
	return apiKey ? { apiKey, origin } : undefined;
}

async function requestSessionToken(
	fetchImpl: DesktopKeyFetch,
	origin: string,
	timeoutMs: number
): Promise<string | undefined> {
	const response = await call(fetchImpl, `${origin}/api/auth/desktop-session`, { method: 'POST' }, timeoutMs);
	if (!response?.ok) {
		return undefined;
	}
	const body = await readJson(response);
	const token = isRecord(body) ? body.token : undefined;
	return typeof token === 'string' && token.trim() ? token.trim() : undefined;
}

async function requestUnifiedKey(
	fetchImpl: DesktopKeyFetch,
	origin: string,
	token: string,
	timeoutMs: number
): Promise<string | undefined> {
	const response = await call(
		fetchImpl,
		`${origin}/api/settings/api-key`,
		{ headers: { accept: 'application/json', authorization: `Bearer ${token}` } },
		timeoutMs
	);
	if (!response?.ok) {
		return undefined;
	}
	const body = await readJson(response);
	const apiKey = isRecord(body) ? body.apiKey : undefined;
	if (typeof apiKey !== 'string') {
		return undefined;
	}
	const trimmed = apiKey.trim();
	return UNIFIED_KEY_PATTERN.test(trimmed) ? trimmed : undefined;
}

async function call(
	fetchImpl: DesktopKeyFetch,
	url: string,
	init: { readonly method?: string; readonly headers?: Record<string, string> },
	timeoutMs: number
): Promise<DesktopKeyResponse | undefined> {
	try {
		return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
	} catch {
		return undefined;
	}
}

async function readJson(response: DesktopKeyResponse): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
