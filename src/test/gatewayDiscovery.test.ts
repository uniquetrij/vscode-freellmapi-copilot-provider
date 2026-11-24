import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
	candidateConfigPaths,
	discoverLoopbackGateway,
	parseConfiguredPort,
	type GatewayDiscoveryHost,
} from '../gatewayDiscovery';

const windowsEnv = {
	platform: 'win32' as const,
	env: {
		APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
		LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
	},
	home: 'C:\\Users\\me',
};

function host(options: {
	files?: Record<string, string>;
	directories?: Record<string, readonly string[]>;
	live?: readonly string[];
}): GatewayDiscoveryHost & { probed: string[] } {
	const probed: string[] = [];
	return {
		probed,
		async readFile(path) {
			return options.files?.[path];
		},
		async listDirectories(path) {
			return options.directories?.[path] ?? [];
		},
		async probe(origin) {
			probed.push(origin);
			return options.live?.includes(origin) ?? false;
		},
	};
}

test('parseConfiguredPort reads the desktop app port and rejects junk', () => {
	assert.equal(parseConfiguredPort('{"port":31415,"launchDashboardShown":true}'), 31415);
	assert.equal(parseConfiguredPort('{"port":"31415"}'), 31415);
	assert.equal(parseConfiguredPort('{"port":0}'), undefined);
	assert.equal(parseConfiguredPort('{"port":70000}'), undefined);
	assert.equal(parseConfiguredPort('{"launchDashboardShown":true}'), undefined);
	assert.equal(parseConfiguredPort('not json'), undefined);
	assert.equal(parseConfiguredPort(undefined), undefined);
});

test('candidateConfigPaths covers each desktop app data directory', () => {
	const windows = candidateConfigPaths(windowsEnv);
	assert.deepEqual(windows.paths, [
		join('C:\\Users\\me\\AppData\\Roaming', 'FreeLLMAPI', 'config.json'),
		join('C:\\Users\\me\\AppData\\Local', 'FreeLLMAPI', 'config.json'),
	]);
	assert.equal(windows.packageDirs, join('C:\\Users\\me\\AppData\\Local', 'Packages'));

	const mac = candidateConfigPaths({ platform: 'darwin', env: {}, home: '/Users/me' });
	assert.deepEqual(mac.paths, [join('/Users/me', 'Library', 'Application Support', 'FreeLLMAPI', 'config.json')]);

	const linux = candidateConfigPaths({
		platform: 'linux',
		env: { XDG_CONFIG_HOME: '/home/me/.config-custom' },
		home: '/home/me',
	});
	assert.deepEqual(linux.paths, [join('/home/me/.config-custom', 'FreeLLMAPI', 'config.json')]);
});

test('discoverLoopbackGateway finds the Store app port behind the MSIX redirect', async () => {
	const packages = join('C:\\Users\\me\\AppData\\Local', 'Packages');
	const msixConfig = join(
		packages,
		'TashAhmed.FreeLLMAPI_6nczed04ys4da',
		'LocalCache',
		'Roaming',
		'FreeLLMAPI',
		'config.json'
	);
	const discoveryHost = host({
		files: { [msixConfig]: '{"port":31415}' },
		directories: { [packages]: ['Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'TashAhmed.FreeLLMAPI_6nczed04ys4da'] },
		live: ['http://127.0.0.1:31415'],
	});

	const discovered = await discoverLoopbackGateway(discoveryHost, windowsEnv, 'http://127.0.0.1:3001/v1');
	assert.deepEqual(discovered, {
		origin: 'http://127.0.0.1:31415',
		baseUrl: 'http://127.0.0.1:31415/v1',
		port: 31415,
	});
	assert.deepEqual(discoveryHost.probed, ['http://127.0.0.1:31415']);
});

test('discoverLoopbackGateway keeps localhost and skips the configured port', async () => {
	const discoveryHost = host({ live: ['http://localhost:31415'] });

	const discovered = await discoverLoopbackGateway(discoveryHost, windowsEnv, 'http://localhost:3001/v1');
	assert.equal(discovered?.baseUrl, 'http://localhost:31415/v1');
	assert.deepEqual(discoveryHost.probed, ['http://localhost:31415']);
});

test('discoverLoopbackGateway returns nothing for remote hosts or silent loopback', async () => {
	const remote = host({ live: ['http://127.0.0.1:31415'] });
	assert.equal(await discoverLoopbackGateway(remote, windowsEnv, 'http://192.168.1.20:3001/v1'), undefined);
	assert.deepEqual(remote.probed, []);

	const silent = host({ live: [] });
	assert.equal(await discoverLoopbackGateway(silent, windowsEnv, 'http://127.0.0.1:3001/v1'), undefined);
	assert.deepEqual(silent.probed, ['http://127.0.0.1:31415']);
});
