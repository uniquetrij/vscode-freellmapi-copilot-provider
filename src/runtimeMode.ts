import * as fs from 'fs';
import * as path from 'path';

/**
 * Runtime identity for the extension.
 *
 * A debug build can run side by side with an installed release:
 * `scripts/dev-marker.js` suffixes every contributed id in `package.json` with
 * `-dev`, and this module reads the ids from the manifest VS Code actually
 * loaded instead of hard-coding them. The committed manifest therefore stays
 * on the release ids.
 *
 * Kept free of `vscode` value imports so it stays unit-testable.
 */

const DEBUG_MARKER_PROPERTY = 'x-dev-marker-debug';
export const DEV_SUFFIX = '-dev';
/** Visual badge for dev builds; `scripts/dev-marker.js` writes the same text into titles. */
export const DEV_BADGE = '🐞 ';

export const BASE_VENDOR_ID = 'freellmapi';
export const DEBUG_VENDOR_ID = `${BASE_VENDOR_ID}${DEV_SUFFIX}`;
export const BASE_NAMESPACE = 'freellmapi';
export const DEBUG_NAMESPACE = `${BASE_NAMESPACE}${DEV_SUFFIX}`;
export const BASE_CONFIGURATION_NAMESPACE = BASE_NAMESPACE;
export const DEBUG_CONFIGURATION_NAMESPACE = DEBUG_NAMESPACE;

// Stable contributed ids used to recover the namespace from a manifest.
const COMMAND_PROBE_SUFFIX = '.setApiKey';
const CONFIGURATION_PROBE_SUFFIX = '.baseUrl';

// `vscode.ExtensionMode.Development`, kept numeric so this module needs no
// `vscode` import.
const EXTENSION_MODE_DEVELOPMENT = 2;

export interface ExtensionLike {
	readonly extensionMode: number;
	readonly extension: { readonly packageJSON: unknown };
}

export interface RuntimeIdentity {
	readonly debug: boolean;
	readonly vendorId: string;
	readonly commandNamespace: string;
	readonly configurationNamespace: string;
}

let identity: RuntimeIdentity | undefined;
let extensionHostDevelopmentMode = false;

export function initializeRuntimeMode(context: ExtensionLike): void {
	extensionHostDevelopmentMode = context.extensionMode === EXTENSION_MODE_DEVELOPMENT;
	identity = resolveManifestIdentity(context.extension.packageJSON);
}

export function getRuntimeIdentity(): RuntimeIdentity {
	identity ??= resolveManifestIdentity(readManifestFromDisk());
	return identity;
}

export function getVendorId(): string {
	return getRuntimeIdentity().vendorId;
}

/**
 * Full setting id for a suffix, so a message names the setting the loaded
 * manifest actually contributes (`freellmapi-dev.baseUrl` in a dev build).
 */
export function getSettingName(suffix: string): string {
	return `${getRuntimeIdentity().configurationNamespace}.${suffix}`;
}

/** True when the loaded manifest is the side-by-side dev flavor written by `scripts/dev-marker.js`. */
export function isDebugManifest(): boolean {
	return getRuntimeIdentity().debug;
}

/**
 * True in the Extension Development Host (F5) or when the manifest is marked.
 * This drives visual/behavioral dev cues without requiring a manifest change.
 */
export function isDevelopmentMode(): boolean {
	return extensionHostDevelopmentMode || process.env.VSCODE_DEBUG === '1' || isDebugManifest();
}

export function resolveManifestIdentity(pkg: unknown): RuntimeIdentity {
	const manifest = pkg && typeof pkg === 'object' ? (pkg as any) : undefined;

	const providers = manifest?.contributes?.languageModelChatProviders;
	const vendorId = collectStrings(
		Array.isArray(providers) ? providers.map((provider: any) => provider?.vendor) : []
	)[0];

	const commands = manifest?.contributes?.commands;
	const commandNamespace = collectStrings(
		Array.isArray(commands) ? commands.map((command: any) => command?.command) : []
	)
		.filter((id) => id.endsWith(COMMAND_PROBE_SUFFIX))
		.map((id) => id.slice(0, -COMMAND_PROBE_SUFFIX.length))
		.find((namespace) => namespace.length > 0);

	const properties = manifest?.contributes?.configuration?.properties;
	const configurationNamespace = (properties && typeof properties === 'object' ? Object.keys(properties) : [])
		.filter((key) => key.endsWith(CONFIGURATION_PROBE_SUFFIX))
		.map((key) => key.slice(0, -CONFIGURATION_PROBE_SUFFIX.length))
		.find((namespace) => namespace.length > 0);

	const debug =
		manifest?.[DEBUG_MARKER_PROPERTY] === true ||
		hasDevSuffix(vendorId) ||
		hasDevSuffix(commandNamespace) ||
		hasDevSuffix(configurationNamespace);

	return {
		debug,
		vendorId: resolveId(vendorId, debug, BASE_VENDOR_ID),
		commandNamespace: resolveId(commandNamespace, debug, BASE_NAMESPACE),
		configurationNamespace: resolveId(configurationNamespace, debug, BASE_NAMESPACE),
	};
}

function resolveId(value: string | undefined, debug: boolean, fallback: string): string {
	if (!value) {
		return debug ? `${fallback}${DEV_SUFFIX}` : fallback;
	}
	return debug ? toDev(value) : toBase(value);
}

function hasDevSuffix(value: string | undefined): boolean {
	return typeof value === 'string' && value.endsWith(DEV_SUFFIX);
}

function toDev(value: string): string {
	return value.endsWith(DEV_SUFFIX) ? value : `${value}${DEV_SUFFIX}`;
}

function toBase(value: string): string {
	return value.endsWith(DEV_SUFFIX) ? value.slice(0, -DEV_SUFFIX.length) : value;
}

function readManifestFromDisk(): unknown {
	try {
		// Compiled output lives in build/out, so the manifest is two levels up.
		return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
	} catch {
		return undefined;
	}
}

function collectStrings(values: readonly unknown[]): string[] {
	return values.filter((value): value is string => typeof value === 'string');
}
