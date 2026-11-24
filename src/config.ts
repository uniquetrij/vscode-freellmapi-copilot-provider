import * as vscode from 'vscode';
import type { ImageInputMode } from './modelCatalog';
import { CONFIGURATION_NAMESPACE } from './runtimeMode';
import { DEFAULT_BASE_URL, normalizeBaseUrl } from './urls';

export interface FreeLlmApiConfig {
	readonly rawBaseUrl: string;
	readonly baseUrl: string;
	readonly modelCacheTtlMinutes: number;
	readonly modelFilter: string;
	readonly maxOutputTokens: number;
	readonly imageInput: ImageInputMode;
	readonly debugLogging: boolean;
	readonly statusBarEnabled: boolean;
	readonly healthCheckIntervalSeconds: number;
	readonly autoDetectBaseUrl: boolean;
	readonly showUnavailableModels: boolean;
}

export interface FreeLlmApiServerConfig {
	readonly autoStart: boolean;
	readonly path: string;
	readonly startCommand: string;
	readonly stopCommand: string;
	readonly startTimeoutSeconds: number;
}

function configuration(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(CONFIGURATION_NAMESPACE);
}

let baseUrlOverride: string | undefined;

/**
 * Session-scoped base URL adopted by gateway auto-detection so a discovered
 * port works without rewriting the user's settings first.
 */
export function setBaseUrlOverride(value: string | undefined): void {
	baseUrlOverride = value ? normalizeBaseUrl(value) : undefined;
}

export function getBaseUrlOverride(): string | undefined {
	return baseUrlOverride;
}

function clampNumber(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, parsed));
}

export function getConfig(): FreeLlmApiConfig {
	const config = configuration();
	const configuredBaseUrl = config.get<string>('baseUrl', DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
	const rawBaseUrl = baseUrlOverride ?? configuredBaseUrl;
	const imageInput = config.get<string>('imageInput', 'all');
	return {
		rawBaseUrl,
		baseUrl: normalizeBaseUrl(rawBaseUrl),
		modelCacheTtlMinutes: clampNumber(config.get<number>('modelCacheTtlMinutes', 5), 5, 0),
		modelFilter: config.get<string>('modelFilter', ''),
		maxOutputTokens: clampNumber(config.get<number>('maxOutputTokens', 8_192), 8_192, 1),
		imageInput: imageInput === 'auto' || imageInput === 'none' ? imageInput : 'all',
		debugLogging: config.get<boolean>('debugLogging', false),
		statusBarEnabled: config.get<boolean>('statusBar.enabled', true),
		healthCheckIntervalSeconds: clampNumber(config.get<number>('healthCheckIntervalSeconds', 30), 30, 10),
		autoDetectBaseUrl: config.get<boolean>('autoDetectBaseUrl', true),
		showUnavailableModels: config.get<boolean>('showUnavailableModels', false),
	};
}

export function getServerConfig(): FreeLlmApiServerConfig {
	const config = configuration();
	return {
		autoStart: config.get<boolean>('server.autoStart', false),
		path: config.get<string>('server.path', '').trim(),
		startCommand: config.get<string>('server.startCommand', '').trim(),
		stopCommand: config.get<string>('server.stopCommand', '').trim(),
		startTimeoutSeconds: clampNumber(config.get<number>('server.startTimeoutSeconds', 60), 60, 5, 600),
	};
}
