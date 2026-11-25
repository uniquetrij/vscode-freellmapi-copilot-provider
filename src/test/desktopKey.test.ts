import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchDesktopUnifiedKey, type DesktopKeyFetch } from '../desktopKey';

interface Call {
	readonly url: string;
	readonly method?: string;
	readonly headers?: Record<string, string>;
}

interface Route {
	readonly status: number;
	readonly body?: unknown;
	readonly throws?: boolean;
}

const KEY = `freellmapi-${'a'.repeat(48)}`;
const SESSION_URL = 'http://127.0.0.1:31415/api/auth/desktop-session';
const KEY_URL = 'http://127.0.0.1:31415/api/settings/api-key';

function recordingFetch(routes: Record<string, Route>, calls: Call[]): DesktopKeyFetch {
	return async (url, init) => {
		calls.push({ url, method: init.method, headers: init.headers });
		const route = routes[url];
		if (!route) {
			throw new Error(`unexpected request: ${url}`);
		}
		if (route.throws) {
			throw new Error('connection refused');
		}
		return {
			ok: route.status >= 200 && route.status < 300,
			status: route.status,
			async json() {
				return route.body;
			},
		};
	};
}

test('fetchDesktopUnifiedKey adopts the desktop app key over loopback', async () => {
	const calls: Call[] = [];
	const fetchImpl = recordingFetch(
		{
			[SESSION_URL]: { status: 200, body: { token: 'session-token' } },
			[KEY_URL]: { status: 200, body: { apiKey: KEY } },
		},
		calls
	);

	const result = await fetchDesktopUnifiedKey('http://127.0.0.1:31415/v1', { fetchImpl });

	assert.deepEqual(result, { apiKey: KEY, origin: 'http://127.0.0.1:31415' });
	assert.equal(calls.length, 2);
	assert.equal(calls[0].method, 'POST');
	assert.equal(calls[1].headers?.authorization, 'Bearer session-token');
});

test('fetchDesktopUnifiedKey leaves non-loopback gateways alone', async () => {
	const calls: Call[] = [];
	const fetchImpl = recordingFetch({}, calls);

	assert.equal(await fetchDesktopUnifiedKey('https://gateway.example.test/v1', { fetchImpl }), undefined);
	assert.equal(await fetchDesktopUnifiedKey('http://192.168.1.10:3001/v1', { fetchImpl }), undefined);
	assert.deepEqual(calls, []);
});

test('fetchDesktopUnifiedKey stops when the gateway is not the desktop app', async () => {
	const calls: Call[] = [];
	const fetchImpl = recordingFetch({ [SESSION_URL]: { status: 403 } }, calls);

	assert.equal(await fetchDesktopUnifiedKey('http://localhost:3001/v1', { fetchImpl }), undefined);
	assert.deepEqual(calls.map((call) => call.url), ['http://localhost:3001/api/auth/desktop-session']);
});

test('fetchDesktopUnifiedKey ignores unusable session or key responses', async () => {
	const missingToken = recordingFetch(
		{ [SESSION_URL]: { status: 200, body: { token: '   ' } } },
		[]
	);
	assert.equal(await fetchDesktopUnifiedKey('http://127.0.0.1:31415/v1', { fetchImpl: missingToken }), undefined);

	const rejectedKey = recordingFetch(
		{
			[SESSION_URL]: { status: 200, body: { token: 'session-token' } },
			[KEY_URL]: { status: 401, body: { error: 'Authentication required' } },
		},
		[]
	);
	assert.equal(await fetchDesktopUnifiedKey('http://127.0.0.1:31415/v1', { fetchImpl: rejectedKey }), undefined);

	const malformedKey = recordingFetch(
		{
			[SESSION_URL]: { status: 200, body: { token: 'session-token' } },
			[KEY_URL]: { status: 200, body: { apiKey: 'not-a-unified-key' } },
		},
		[]
	);
	assert.equal(await fetchDesktopUnifiedKey('http://127.0.0.1:31415/v1', { fetchImpl: malformedKey }), undefined);
});

test('fetchDesktopUnifiedKey swallows transport failures', async () => {
	const fetchImpl = recordingFetch({ [SESSION_URL]: { status: 0, throws: true } }, []);

	assert.equal(await fetchDesktopUnifiedKey('http://127.0.0.1:31415/v1', { fetchImpl }), undefined);
});
