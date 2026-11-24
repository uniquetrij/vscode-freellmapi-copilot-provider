export const DEFAULT_BASE_URL = 'http://127.0.0.1:3001/v1';
export const DEFAULT_SERVER_PORT = 3001;
/** Port the FreeLLMAPI desktop app binds by default (`config.json` → `port`). */
export const DESKTOP_DEFAULT_PORT = 31415;

/**
 * Accepts what users actually type ("localhost:3001", "http://host:3001/api/")
 * and returns a canonical `${origin}${path}/v1` base URL.
 */
export function normalizeBaseUrl(value: string | undefined): string {
	const raw = value?.trim() || DEFAULT_BASE_URL;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;

	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new Error(`Invalid FreeLLMAPI base URL: "${raw}". Use a URL such as ${DEFAULT_BASE_URL}.`);
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`FreeLLMAPI base URL must use http or https, not "${url.protocol}".`);
	}

	url.hash = '';
	url.search = '';
	const pathname = url.pathname.replace(/\/+$/, '');
	const withVersion = /\/v\d+$/i.test(pathname) ? pathname : `${pathname}/v1`;
	return `${url.origin}${withVersion}`;
}

export function originFromBaseUrl(value: string | undefined): string {
	return new URL(normalizeBaseUrl(value)).origin;
}

export function modelsUrl(baseUrl: string): string {
	return `${normalizeBaseUrl(baseUrl)}/models`;
}

export function chatCompletionsUrl(baseUrl: string): string {
	return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

export function usageUrl(baseUrl: string): string {
	return `${normalizeBaseUrl(baseUrl)}/usage`;
}

export function pingUrl(baseUrl: string): string {
	return `${originFromBaseUrl(baseUrl)}/api/ping`;
}

export function dashboardUrl(baseUrl: string): string {
	return originFromBaseUrl(baseUrl);
}

/**
 * True for `localhost`, `127.0.0.0/8` and `::1`. Auto-detection only probes
 * loopback so a configured remote gateway is never second-guessed.
 */
export function isLoopbackBaseUrl(value: string | undefined): boolean {
	let hostname: string;
	try {
		hostname = new URL(normalizeBaseUrl(value)).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (hostname === 'localhost' || hostname === '[::1]') {
		return true;
	}
	return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Comma-separated glob patterns. A pattern without `*` or `?` is treated as a
 * substring match so "claude" behaves the way users expect.
 */
export function parseModelFilter(value: string | undefined): RegExp[] {
	const patterns = (value ?? '')
		.split(',')
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern.length > 0);

	return patterns.map((pattern) => {
		const effective = /[*?]/.test(pattern) ? pattern : `*${pattern}*`;
		const source = effective
			.split('')
			.map((char) => {
				if (char === '*') {
					return '.*';
				}
				if (char === '?') {
					return '.';
				}
				return char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
			})
			.join('');
		return new RegExp(`^${source}$`, 'i');
	});
}

export function matchesModelFilter(id: string, name: string, patterns: readonly RegExp[]): boolean {
	if (patterns.length === 0) {
		return true;
	}
	return patterns.some((pattern) => pattern.test(id) || pattern.test(name));
}
