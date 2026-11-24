import { extractErrorDetails } from './diagnostics';

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

function errorCode(err: unknown): string | undefined {
	const record = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
	const direct = record?.code;
	if (typeof direct === 'string') {
		return direct;
	}
	const nested = record?.cause?.code;
	return typeof nested === 'string' ? nested : undefined;
}

export function isConnectionFailure(err: unknown): boolean {
	const code = errorCode(err);
	return code !== undefined && CONNECTION_CODES.has(code);
}

export function isTimeoutFailure(err: unknown): boolean {
	const code = errorCode(err);
	if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
		return true;
	}
	const name = (err as { name?: unknown })?.name;
	return name === 'TimeoutError' || name === 'AbortError';
}

export function truncateForMessage(value: string, max = 600): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return `${trimmed.slice(0, max)}…`;
}

export function formatUnreachable(baseUrl: string, err?: unknown): string {
	const details = err ? extractErrorDetails(err) : {};
	const target = details.url ?? baseUrl;
	return `FreeLLMAPI is not reachable at ${target}. Run "FreeLLMAPI: Start Server", start the gateway yourself, or change "freellmapi.baseUrl" if it runs elsewhere.`;
}

export function formatHttpError(
	status: number,
	url: string,
	body?: string
): string {
	const suffix = body && body.trim().length > 0 ? ` Response: ${truncateForMessage(body)}` : '';
	switch (status) {
		case 401:
			return `FreeLLMAPI rejected the API key (HTTP 401) at ${url}. Run "FreeLLMAPI: Set API Key" with the unified key shown in the FreeLLMAPI dashboard.`;
		case 403:
			return `FreeLLMAPI refused the request (HTTP 403) at ${url}. Inference accepts the unified key or a client-profile key; the usage endpoint only accepts the unified key.${suffix}`;
		case 404:
			return `FreeLLMAPI returned HTTP 404 for ${url}. Check that "freellmapi.baseUrl" includes the version path (usually http://127.0.0.1:3001/v1) and that the selected model exists.${suffix}`;
		case 422:
			return `FreeLLMAPI could not satisfy the request (HTTP 422).${suffix}`;
		case 429:
			return `FreeLLMAPI exhausted every available model for this request (HTTP 429). Wait for a quota window to reset, or add provider keys in the FreeLLMAPI dashboard.${suffix}`;
		default:
			if (status >= 500) {
				return `FreeLLMAPI returned HTTP ${status} at ${url}. The gateway or the upstream provider failed.${suffix}`;
			}
			return `FreeLLMAPI returned HTTP ${status} at ${url}.${suffix}`;
	}
}

export function wrapApiError(
	err: unknown,
	context: { url: string; baseUrl: string; requestBody?: unknown }
): Error {
	if (err instanceof Error && err.name === 'AbortError') {
		return err;
	}

	const details = extractErrorDetails(err);
	const responseBody = details.responseBody ?? '';
	const status = details.statusCode;

	if (status !== undefined) {
		const wrapped = new Error(formatHttpError(status, details.url ?? context.url, responseBody), {
			cause: err instanceof Error ? err : undefined,
		});
		return Object.assign(wrapped, { ...details, requestBody: context.requestBody });
	}

	if (isConnectionFailure(err)) {
		const wrapped = new Error(formatUnreachable(context.baseUrl, err), {
			cause: err instanceof Error ? err : undefined,
		});
		return Object.assign(wrapped, details);
	}

	if (isTimeoutFailure(err)) {
		const wrapped = new Error(
			`FreeLLMAPI did not respond in time at ${details.url ?? context.url}. The gateway may still be starting, or an upstream provider is slow.`,
			{ cause: err instanceof Error ? err : undefined }
		);
		return Object.assign(wrapped, details);
	}

	const baseMessage = err instanceof Error ? err.message : String(err);
	const parts = [baseMessage];
	if (responseBody) {
		parts.push(`Response: ${truncateForMessage(responseBody)}`);
	}
	if (details.url) {
		parts.push(`URL: ${details.url}`);
	}
	const wrapped = new Error(parts.join(' — '), { cause: err instanceof Error ? err : undefined });
	return Object.assign(wrapped, { ...details, requestBody: context.requestBody });
}
