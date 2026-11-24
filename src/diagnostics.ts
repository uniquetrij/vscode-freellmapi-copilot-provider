/**
 * Shared diagnostic helpers: one definition keeps error reporting and
 * credential redaction from drifting apart between the client, provider, and
 * command handlers.
 */

export type ErrorDetails = {
	statusCode?: number;
	statusText?: string;
	responseBody?: string;
	requestId?: string;
	url?: string;
	requestBody?: unknown;
	originalMessage?: string;
};

export function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function normalizeToString(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value instanceof Uint8Array) {
		return Buffer.from(value).toString('utf-8');
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** Pull HTTP/response diagnostics off an error or its `cause` chain. */
export function extractErrorDetails(err: unknown): ErrorDetails {
	const record = (value: unknown): Record<string, unknown> | undefined => {
		if (value && typeof value === 'object') {
			return value as Record<string, unknown>;
		}
		return undefined;
	};

	const candidates = [record(err), record((err as { cause?: unknown })?.cause)].filter(Boolean) as Record<string, unknown>[];
	const details: ErrorDetails = {};

	for (const candidate of candidates) {
		if (details.statusCode === undefined) {
			const status = candidate.statusCode ?? candidate.status;
			if (typeof status === 'number') {
				details.statusCode = status;
			}
		}
		if (details.statusText === undefined && typeof candidate.statusText === 'string') {
			details.statusText = candidate.statusText;
		}
		if (details.url === undefined && typeof candidate.url === 'string') {
			details.url = candidate.url;
		}
		if (details.requestId === undefined && typeof candidate.requestId === 'string') {
			details.requestId = candidate.requestId;
		}
		if (details.responseBody === undefined && candidate.responseBody !== undefined) {
			details.responseBody = normalizeToString(candidate.responseBody);
		}
		if (details.requestBody === undefined && candidate.requestBody !== undefined) {
			details.requestBody = candidate.requestBody;
		}
		if (details.originalMessage === undefined && typeof candidate.message === 'string') {
			details.originalMessage = candidate.message;
		}
	}

	return details;
}

/** Convert an arbitrary thrown value into a plain, loggable object. */
export function serializeError(err: unknown): unknown {
	const seen = new Set<unknown>();

	const toPlain = (value: unknown, depth: number): unknown => {
		if (value === null || value === undefined) {
			return value;
		}
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			return value;
		}
		if (value instanceof Uint8Array) {
			return Buffer.from(value).toString('utf-8');
		}
		if (typeof value !== 'object') {
			return String(value);
		}
		if (seen.has(value)) {
			return '[Circular]';
		}
		seen.add(value);
		if (depth <= 0) {
			return '[MaxDepth]';
		}

		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.getOwnPropertyNames(record)) {
			out[key] = toPlain(record[key], depth - 1);
		}
		if ('cause' in record) {
			out.cause = toPlain(record.cause, depth - 1);
		}
		return out;
	};

	return toPlain(err, 4);
}

const REDACTED_HEADERS = new Set([
	'authorization',
	'x-api-key',
	'x-goog-api-key',
	'x-proxy-token',
	'cookie',
	'set-cookie',
]);

/** Redact credential headers from a `Headers` object for safe logging. */
export function redactHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		out[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : value;
	}
	return out;
}

/** Redact credential headers from a plain object for safe logging. */
export function redactHeaderRecord(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		out[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : value;
	}
	return out;
}
