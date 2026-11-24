import type * as vscode from 'vscode';
import { matchesModelFilter, parseModelFilter } from './urls';

export type ImageInputMode = 'all' | 'auto' | 'none';

export interface CatalogModel {
	readonly id: string;
	readonly name: string;
	readonly ownedBy: string;
	readonly created: number;
	readonly contextWindow: number;
	readonly available: boolean;
	readonly executionStatus?: string;
	readonly unavailableReason?: string | null;
	readonly supportedParameters?: readonly string[];
}

export interface CatalogDisplayOptions {
	readonly maxOutputTokens: number;
	readonly imageInput: ImageInputMode;
	readonly modelFilter?: string;
	/** Defaults to false: a model the gateway cannot serve is not offered. */
	readonly showUnavailableModels?: boolean;
}

const DEFAULT_CONTEXT_WINDOW = 32_768;

/** `ctx65536-…` ids and `[ctx:65536] …` names encode a window the gateway omits from `context_window`. */
const CONTEXT_HINT_PATTERNS = [/^ctx(\d+)-/i, /\[ctx:(\d+)\]/i];

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') {
		return value;
	}
	if (value === 1 || value === '1' || value === 'true') {
		return true;
	}
	if (value === 0 || value === '0' || value === 'false') {
		return false;
	}
	return undefined;
}

export function parseContextWindowHint(text: string | undefined): number | undefined {
	if (!text) {
		return undefined;
	}
	for (const pattern of CONTEXT_HINT_PATTERNS) {
		const match = pattern.exec(text);
		if (match) {
			const value = Number(match[1]);
			if (Number.isFinite(value) && value > 0) {
				return value;
			}
		}
	}
	return undefined;
}

/**
 * Parses the OpenAI-shaped body from `GET /v1/models`. Unknown fields are
 * ignored so a newer gateway can add catalog metadata without breaking this
 * extension.
 */
export function parseModelCatalog(payload: unknown): CatalogModel[] {
	const body = asRecord(payload);
	const rows = Array.isArray(payload)
		? payload
		: Array.isArray(body?.data)
			? body.data
			: undefined;
	if (!rows) {
		throw new Error('The FreeLLMAPI model catalog response was not an OpenAI-style { object: "list", data: [...] } body.');
	}

	const seen = new Set<string>();
	const models: CatalogModel[] = [];

	for (const row of rows) {
		const record = asRecord(row);
		if (!record) {
			continue;
		}
		const id = asString(record.id);
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);

		const contextWindow = asPositiveNumber(record.context_length)
			?? asPositiveNumber(record.context_window)
			?? asPositiveNumber(record.contextWindow)
			?? parseContextWindowHint(id)
			?? parseContextWindowHint(asString(record.name))
			?? DEFAULT_CONTEXT_WINDOW;
		const supportedParameters = Array.isArray(record.supported_parameters)
			? record.supported_parameters.filter((value): value is string => typeof value === 'string')
			: undefined;

		models.push({
			id,
			name: asString(record.name) ?? id,
			ownedBy: asString(record.owned_by) ?? 'freellmapi',
			created: asPositiveNumber(record.created) ?? 0,
			contextWindow,
			available: asBoolean(record.available) ?? true,
			executionStatus: asString(record.execution_status),
			unavailableReason: typeof record.unavailable_reason === 'string' ? record.unavailable_reason : null,
			supportedParameters,
		});
	}

	return models;
}

/**
 * Router entries are assembled by FreeLLMAPI itself: `auto`, `auto-route`,
 * `fusion`, and named `auto:<profile>` fallback chains. They are matched by id
 * because the catalog cannot distinguish them otherwise — every row, router or
 * not, reports `owned_by: "freellmapi"` and `created: 0`.
 */
const ROUTER_MODEL_IDS = new Set(['auto', 'auto-route', 'fusion']);

export function isRouterModel(model: Pick<CatalogModel, 'id'>): boolean {
	return ROUTER_MODEL_IDS.has(model.id) || model.id.startsWith('auto:');
}

function statusLabel(model: CatalogModel): string {
	if (model.executionStatus === 'needsKey' || model.unavailableReason === 'no_key') {
		return 'Needs provider key';
	}
	if (model.executionStatus === 'exhausted') {
		return 'Quota exhausted';
	}
	if (model.unavailableReason === 'disabled') {
		return 'Disabled';
	}
	if (model.unavailableReason === 'no_models') {
		return 'No routable models';
	}
	if (!model.available) {
		return 'Unavailable';
	}
	return 'Ready';
}

function formatTokens(value: number): string {
	return value.toLocaleString('en-US');
}

export function catalogModelToChatInfo(
	model: CatalogModel,
	options: CatalogDisplayOptions
): vscode.LanguageModelChatInformation {
	const router = isRouterModel(model);
	const maxInputTokens = Math.max(1_024, Math.floor(model.contextWindow));
	const maxOutputTokens = Math.max(1, Math.min(Math.floor(options.maxOutputTokens), maxInputTokens));
	const toolCalling = model.supportedParameters
		? model.supportedParameters.includes('tools')
		: true;
	const imageInput = options.imageInput === 'all'
		|| (options.imageInput === 'auto' && router);
	const status = statusLabel(model);

	const tooltip = [
		`**${model.name}**`,
		'',
		`\`${model.id}\``,
		router ? 'FreeLLMAPI router' : `Provider: ${model.ownedBy}`,
		`Context: ${formatTokens(maxInputTokens)} tokens`,
		`Status: ${status}`,
		`Capabilities: ${[toolCalling ? 'tools' : undefined, imageInput ? 'images' : undefined].filter(Boolean).join(', ') || 'text only'}`,
	].join('\n');

	return {
		id: model.id,
		name: model.name,
		family: router ? 'freellmapi-router' : model.ownedBy.toLowerCase() || 'freellmapi',
		version: '1',
		tooltip,
		detail: status === 'Ready' ? (router ? 'Router' : undefined) : status,
		maxInputTokens,
		maxOutputTokens,
		capabilities: {
			toolCalling,
			imageInput,
		},
	};
}

/** Router entries first, then usable models, then everything else. */
export function sortCatalogModels(models: readonly CatalogModel[]): CatalogModel[] {
	const rank = (model: CatalogModel): number => {
		if (model.id === 'auto') {
			return 0;
		}
		if (model.id.startsWith('auto:')) {
			return 1;
		}
		if (model.id === 'fusion') {
			return 2;
		}
		if (isRouterModel(model)) {
			return 3;
		}
		return 4;
	};

	return [...models].sort((a, b) => {
		const rankDelta = rank(a) - rank(b);
		if (rankDelta !== 0) {
			return rankDelta;
		}
		if (a.available !== b.available) {
			return a.available ? -1 : 1;
		}
		return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
	});
}

export function catalogToChatInformation(
	models: readonly CatalogModel[],
	options: CatalogDisplayOptions
): vscode.LanguageModelChatInformation[] {
	const filter = parseModelFilter(options.modelFilter);
	const showUnavailable = options.showUnavailableModels ?? false;
	return sortCatalogModels(models)
		.filter((model) => showUnavailable || model.available)
		.filter((model) => matchesModelFilter(model.id, model.name, filter))
		.map((model) => catalogModelToChatInfo(model, options));
}

/**
 * Everything the picker renders. Comparing this instead of object identity lets
 * a refetch detect a real change (a model added, dropped, re-sized, or newly
 * available) while ignoring an unchanged catalog.
 */
export function catalogSignature(models: readonly vscode.LanguageModelChatInformation[]): string {
	return JSON.stringify(models.map((model) => [
		model.id,
		model.name,
		model.family,
		model.version,
		model.maxInputTokens,
		model.maxOutputTokens,
		model.detail ?? '',
		model.capabilities?.toolCalling ?? false,
		model.capabilities?.imageInput ?? false,
	]));
}
