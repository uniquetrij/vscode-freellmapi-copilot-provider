/**
 * Bounded store for the most recent assistant reasoning per (session, model).
 *
 * Reasoning models reached through OpenAI-compatible endpoints reject a
 * follow-up turn that omits the previous assistant turn's `reasoning_content`,
 * so `provider.ts` re-attaches it when VS Code strips thinking from history.
 * The store is bounded because the extension host outlives individual chats:
 * entry count grows with every (session, model) pair ever used.
 *
 * The bound is deliberately generous. Evicting reasoning that is still needed
 * reintroduces the 400 the cache exists to prevent, so this trades a small,
 * capped amount of memory for correctness rather than optimising aggressively.
 */
export type ReasoningCacheEntry = {
	reasoning: string;
	expiresAt: number;
};

export const DEFAULT_REASONING_CACHE_MAX_ENTRIES = 32;
export const DEFAULT_REASONING_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

export class ReasoningCache {
	private readonly entries = new Map<string, ReasoningCacheEntry>();
	private readonly maxEntries: number;
	private readonly ttlMs: number;

	constructor(maxEntries = DEFAULT_REASONING_CACHE_MAX_ENTRIES, ttlMs = DEFAULT_REASONING_CACHE_TTL_MS) {
		this.maxEntries = Math.max(1, maxEntries);
		this.ttlMs = Math.max(0, ttlMs);
	}

	get size(): number {
		return this.entries.size;
	}

	get(sessionId: string, modelId: string): string | undefined {
		const key = cacheKey(sessionId, modelId);
		const entry = this.entries.get(key);
		if (!entry) {
			return undefined;
		}
		if (entry.expiresAt <= Date.now()) {
			this.entries.delete(key);
			return undefined;
		}
		// Re-insert to refresh recency: Map iteration follows insertion order.
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.reasoning;
	}

	set(sessionId: string, modelId: string, reasoning: string): void {
		const key = cacheKey(sessionId, modelId);
		this.entries.delete(key);
		this.entries.set(key, {
			reasoning,
			expiresAt: Date.now() + this.ttlMs,
		});
		this.evict();
	}

	private evict(): void {
		const now = Date.now();
		for (const [key, entry] of this.entries) {
			if (this.entries.size <= this.maxEntries) {
				return;
			}
			if (entry.expiresAt <= now) {
				this.entries.delete(key);
			}
		}
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (oldest.done) {
				return;
			}
			this.entries.delete(oldest.value);
		}
	}
}

// NUL separator, written as an escape so no raw byte lands in the source (a
// literal NUL makes git treat the file as binary). Session ids match
// `ses_[0-9a-z]{12}[A-Za-z0-9]{14}` and model ids come from the catalog, so
// neither can contain NUL; that makes the pair unambiguous without the
// aliasing a plain `session + model` concatenation would allow.
function cacheKey(sessionId: string, modelId: string): string {
	return `${sessionId}\u0000${modelId}`;
}
