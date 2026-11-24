/**
 * Native reasoning parts come from the proposed `languageModelThinkingPart`
 * API. The Marketplace build ships without the `enabledApiProposals`
 * declaration that grants it, and a future VS Code could start guarding the
 * class with a throwing getter, so every access here tolerates the class being
 * absent, unreadable, or unusable.
 *
 * Kept free of `vscode` imports so it stays unit-testable.
 */

export interface ThinkingPartLike {
	readonly value: string;
}

export type ThinkingPartConstructor = new (value: string) => ThinkingPartLike;

export interface ThinkingReporterOptions {
	/** The `vscode` module, or any object that may expose the proposed class. */
	readonly api: unknown;
	/** Emits a native thinking part. */
	readonly report: (part: ThinkingPartLike) => void;
	/** Emits the same content as plain text once native parts are unusable. */
	readonly fallback: (text: string) => void;
	/** Called at most once, with the reason native parts cannot be used. */
	readonly onUnavailable?: (reason: string) => void;
}

export function resolveThinkingPartConstructor(api: unknown): ThinkingPartConstructor | undefined {
	try {
		const candidate = (api as { LanguageModelThinkingPart?: unknown } | null | undefined)
			?.LanguageModelThinkingPart;
		return typeof candidate === 'function' ? (candidate as ThinkingPartConstructor) : undefined;
	} catch {
		// VS Code guards proposed APIs by throwing from the property access.
		return undefined;
	}
}

/**
 * Returns a sink for reasoning deltas that prefers native thinking parts and
 * degrades to `fallback` for good once they cannot be used, so a reasoning
 * model keeps answering instead of failing the request.
 */
export function createThinkingReporter(options: ThinkingReporterOptions): (delta: string) => void {
	let ctor: ThinkingPartConstructor | undefined;
	let resolved = false;
	let notify = options.onUnavailable;

	const disable = (reason: string): void => {
		ctor = undefined;
		notify?.(reason);
		notify = undefined;
	};

	return (delta: string) => {
		if (!resolved) {
			resolved = true;
			ctor = resolveThinkingPartConstructor(options.api);
			if (!ctor) {
				disable('the proposed languageModelThinkingPart API is not available');
			}
		}
		if (ctor) {
			try {
				options.report(new ctor(delta));
				return;
			} catch (error) {
				disable(error instanceof Error ? error.message : String(error));
			}
		}
		options.fallback(delta);
	};
}
