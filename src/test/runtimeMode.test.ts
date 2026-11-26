import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeRuntimeMode, isDevelopmentMode, resolveManifestIdentity } from '../runtimeMode';

const baseManifest = {
	contributes: {
		languageModelChatProviders: [{ vendor: 'freellmapi', displayName: 'FreeLLMAPI' }],
		commands: [{ command: 'freellmapi.setApiKey' }, { command: 'freellmapi.refreshModels' }],
		configuration: {
			properties: {
				'freellmapi.baseUrl': {},
				'freellmapi.debugLogging': {},
			},
		},
	},
};

test('resolveManifestIdentity reads the release ids', () => {
	assert.deepEqual(resolveManifestIdentity(baseManifest), {
		debug: false,
		vendorId: 'freellmapi',
		commandNamespace: 'freellmapi',
		configurationNamespace: 'freellmapi',
	});
});

test('resolveManifestIdentity detects the side-by-side dev ids', () => {
	const devManifest = JSON.parse(JSON.stringify(baseManifest));
	devManifest.contributes.languageModelChatProviders[0].vendor = 'freellmapi-dev';
	devManifest.contributes.commands[0].command = 'freellmapi-dev.setApiKey';
	devManifest.contributes.configuration.properties = { 'freellmapi-dev.baseUrl': {} };

	assert.deepEqual(resolveManifestIdentity(devManifest), {
		debug: true,
		vendorId: 'freellmapi-dev',
		commandNamespace: 'freellmapi-dev',
		configurationNamespace: 'freellmapi-dev',
	});
});

test('resolveManifestIdentity trusts the marker property over unswitched ids', () => {
	assert.deepEqual(
		resolveManifestIdentity({ ...baseManifest, 'x-dev-marker-debug': true }),
		{
			debug: true,
			vendorId: 'freellmapi-dev',
			commandNamespace: 'freellmapi-dev',
			configurationNamespace: 'freellmapi-dev',
		}
	);
});

test('resolveManifestIdentity falls back to release ids for a missing manifest', () => {
	assert.deepEqual(resolveManifestIdentity(undefined), {
		debug: false,
		vendorId: 'freellmapi',
		commandNamespace: 'freellmapi',
		configurationNamespace: 'freellmapi',
	});
});

test('isDevelopmentMode follows the extension-host mode, not just the marker', () => {
	const previous = process.env.VSCODE_DEBUG;
	delete process.env.VSCODE_DEBUG;
	try {
		// ExtensionMode.Development: an F5 window badges even before the
		// manifest is marked, which is what dev cues rely on.
		initializeRuntimeMode({ extensionMode: 2, extension: { packageJSON: baseManifest } });
		assert.equal(isDevelopmentMode(), true);

		initializeRuntimeMode({ extensionMode: 1, extension: { packageJSON: baseManifest } });
		assert.equal(isDevelopmentMode(), false);
	} finally {
		if (previous === undefined) {
			delete process.env.VSCODE_DEBUG;
		} else {
			process.env.VSCODE_DEBUG = previous;
		}
	}
});
