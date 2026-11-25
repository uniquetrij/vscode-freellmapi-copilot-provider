import * as vscode from 'vscode';
import { CATALOG_CACHE_STORAGE_KEY, createCatalogCacheEntry, readCatalogCache } from './catalogCache';
import { getConfig } from './config';
import { fetchModelCatalog } from './catalogClient';
import { wrapApiError } from './errors';
import { catalogSignature, catalogToChatInformation } from './modelCatalog';
import { getOutputChannel } from './output';
import { getApiKey } from './secrets';
import { dashboardUrl, modelsUrl } from './urls';

const MODEL_REVALIDATE_MIN_INTERVAL_MS = 30 * 60_000;

export class ModelRegistry {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private cachedAtMs: number | undefined;
	private cachedModels: vscode.LanguageModelChatInformation[] | undefined;
	private cachedEtags = new Map<string, string>();
	private inFlightModels: Promise<vscode.LanguageModelChatInformation[]> | undefined;
	private revalidationTimer: NodeJS.Timeout | undefined;
	private warnedMissingKey = false;
	/** True while the list is only the copy replayed from storage. */
	private replayed = false;

	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly storage?: vscode.Memento
	) {
		this.replayStoredCatalog();
	}

	/**
	 * VS Code asks a provider for its models while the window is still
	 * restoring, and the chat harness keeps the answer it gets at that moment
	 * for the whole session. Answering from the last catalog on disk keeps that
	 * first answer non-empty even when the gateway has not replied yet.
	 */
	private replayStoredCatalog(): void {
		if (!this.storage) {
			return;
		}
		let baseUrl: string;
		try {
			baseUrl = getConfig().baseUrl;
		} catch {
			return;
		}
		const stored = readCatalogCache<vscode.LanguageModelChatInformation>(
			this.storage.get<unknown>(CATALOG_CACHE_STORAGE_KEY),
			baseUrl
		);
		if (!stored) {
			return;
		}
		this.cachedModels = stored.models as vscode.LanguageModelChatInformation[];
		// Left undefined so the next request still revalidates against the gateway.
		this.cachedAtMs = undefined;
		this.replayed = true;
	}

	private storeCatalog(baseUrl: string, cachedAtMs: number, models: readonly vscode.LanguageModelChatInformation[]): void {
		if (!this.storage) {
			return;
		}
		const value = models.length > 0
			? createCatalogCacheEntry(baseUrl, cachedAtMs, models)
			: undefined;
		void Promise.resolve(this.storage.update(CATALOG_CACHE_STORAGE_KEY, value)).catch(() => undefined);
	}

	invalidate(): void {
		this.cachedAtMs = undefined;
		this.cachedModels = undefined;
		this.cachedEtags.clear();
		this.warnedMissingKey = false;
		this.replayed = false;
		void Promise.resolve(this.storage?.update(CATALOG_CACHE_STORAGE_KEY, undefined)).catch(
			() => undefined
		);
		this._onDidChange.fire();
	}

	dispose(): void {
		if (this.revalidationTimer) {
			clearInterval(this.revalidationTimer);
			this.revalidationTimer = undefined;
		}
		this._onDidChange.dispose();
	}

	getCachedModels(): vscode.LanguageModelChatInformation[] {
		return this.cachedModels ?? [];
	}

	hasCachedCatalog(): boolean {
		return this.cachedModels !== undefined && !this.replayed;
	}

	hasReplayedCatalog(): boolean {
		return this.replayed;
	}

	async getModels(options: { force?: boolean } = {}): Promise<vscode.LanguageModelChatInformation[]> {
		const ttlMs = this.resolveTtlMs();
		const now = Date.now();
		if (!options.force && this.cachedModels && this.cachedAtMs !== undefined) {
			if (now - this.cachedAtMs < ttlMs) {
				return this.cachedModels;
			}
		}

		// Activation, a configuration change, and an explicit refresh can overlap;
		// they share one catalog fetch instead of each issuing its own.
		if (this.inFlightModels) {
			return this.inFlightModels;
		}

		const pending = this.loadModels(ttlMs, now);
		this.inFlightModels = pending;
		try {
			return await pending;
		} finally {
			if (this.inFlightModels === pending) {
				this.inFlightModels = undefined;
			}
		}
	}

	private resolveTtlMs(): number {
		return Math.max(0, getConfig().modelCacheTtlMinutes) * 60_000;
	}

	private async loadModels(ttlMs: number, now: number): Promise<vscode.LanguageModelChatInformation[]> {
		const output = getOutputChannel();
		const config = getConfig();
		const apiKey = await getApiKey(this.secrets);

		if (!apiKey) {
			if (!this.warnedMissingKey) {
				this.warnedMissingKey = true;
				output.warn(
					'No FreeLLMAPI API key is configured, so the model picker is empty. ' +
					`Run "FreeLLMAPI: Set API Key" with the unified key from ${dashboardUrl(config.baseUrl)}.`
				);
			}
			this.cachedModels = [];
			this.cachedAtMs = now;
			this.cachedEtags.clear();
			this.replayed = false;
			this.storeCatalog(config.baseUrl, now, []);
			return this.cachedModels;
		}

		const previousSignature = this.cachedModels ? catalogSignature(this.cachedModels) : undefined;
		const etag = this.cachedModels && this.cachedModels.length > 0
			? this.cachedEtags.get(config.baseUrl)
			: undefined;
		const url = modelsUrl(config.baseUrl);

		try {
			const result = await fetchModelCatalog(config.baseUrl, apiKey, { etag });

			if (result.status === 304) {
				if (!this.cachedModels || this.cachedModels.length === 0) {
					throw new Error(`FreeLLMAPI reported no model catalog change, but nothing is cached (${url}).`);
				}
				this.cachedAtMs = now;
				this.replayed = false;
				this.storeCatalog(config.baseUrl, now, this.cachedModels);
				return this.cachedModels;
			}

			if (!result.ok) {
				throw wrapApiError(
					Object.assign(new Error(`HTTP ${result.status}`), {
						statusCode: result.status,
						responseBody: result.body,
						url,
					}),
					{ url, baseUrl: config.baseUrl }
				);
			}

			if (result.etag) {
				this.cachedEtags.set(config.baseUrl, result.etag);
			} else {
				this.cachedEtags.delete(config.baseUrl);
			}

			const models = catalogToChatInformation(result.models, {
				maxOutputTokens: config.maxOutputTokens,
				imageInput: config.imageInput,
				modelFilter: config.modelFilter,
				showUnavailableModels: config.showUnavailableModels,
			});

			this.cachedModels = models;
			this.cachedAtMs = now;
			this.warnedMissingKey = false;
			this.replayed = false;
			this.storeCatalog(config.baseUrl, now, models);

			const available = result.models.filter((model) => model.available).length;
			const hidden = result.models.length - available;
			output.info(
				`Loaded ${models.length} model(s) from ${url} (${available} currently usable${
					!config.showUnavailableModels && hidden > 0
						? `; ${hidden} unavailable hidden by "freellmapi.showUnavailableModels"`
						: ''
				}).`
			);

			// VS Code caches whatever list a provider last returned and only asks
			// again when the provider says it changed, so a long-lived host needs
			// this signal or a dropped/unavailable model stays pickable.
			if (previousSignature !== undefined && previousSignature !== catalogSignature(models)) {
				this._onDidChange.fire();
			}

			this.ensureRevalidation(ttlMs);
			return models;
		} catch (err) {
			if (this.cachedModels) {
				if (ttlMs > 0) {
					this.cachedAtMs = now;
				}
				output.warn(
					`Failed to refresh the FreeLLMAPI model catalog; keeping the last known list. ${
						err instanceof Error ? err.message : String(err)
					}`
				);
				return this.cachedModels;
			}
			throw err;
		}
	}

	/**
	 * VS Code keeps the list a provider returned until the provider reports a
	 * change. Revalidate on a slow timer; an unchanged catalog costs one
	 * conditional round trip when the gateway supports ETags.
	 */
	private ensureRevalidation(ttlMs: number): void {
		if (this.revalidationTimer) {
			return;
		}

		const intervalMs = Math.max(ttlMs, MODEL_REVALIDATE_MIN_INTERVAL_MS);
		this.revalidationTimer = setInterval(() => {
			void this.getModels().catch(() => undefined);
		}, intervalMs);
		this.revalidationTimer.unref();
	}
}
