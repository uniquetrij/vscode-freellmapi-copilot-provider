/**
 * Minimal `vscode` stub for unit tests.
 *
 * `register.ts` redirects `require('vscode')` here before any compiled module
 * loads. Only members the tested code can reach at runtime need to exist;
 * module-level code in the provider does not call into vscode.
 */

export class EventEmitter<T> {
	private readonly listeners = new Set<(value: T) => void>();

	readonly event = (listener: (value: T) => void): { dispose(): void } => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};

	fire(value: T): void {
		for (const listener of this.listeners) {
			listener(value);
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}

export class LanguageModelTextPart {
	constructor(readonly value: string) {}
}

export class LanguageModelThinkingPart {
	constructor(readonly value: string | string[]) {}
}

export class LanguageModelDataPart {
	constructor(readonly data: Uint8Array, readonly mimeType: string) {}
}

export class LanguageModelToolCallPart {
	constructor(readonly callId: string, readonly name: string, readonly input: object) {}
}

export class LanguageModelToolResultPart {
	constructor(readonly callId: string, readonly content: unknown[]) {}
}

export class LanguageModelPromptTsxPart {
	constructor(readonly value: unknown) {}
}

export enum LanguageModelChatMessageRole {
	User = 1,
	Assistant = 2,
}

export enum LanguageModelChatToolMode {
	Auto = 1,
	Required = 2,
}

export const LanguageModelChatMessage = {
	User(content: unknown) {
		return { role: LanguageModelChatMessageRole.User, content };
	},
	Assistant(content: unknown) {
		return { role: LanguageModelChatMessageRole.Assistant, content };
	},
};

export const window = {
	createOutputChannel(name: string) {
		return {
			name,
			info() {},
			warn() {},
			error() {},
			debug() {},
			trace() {},
			append() {},
			appendLine() {},
			replace() {},
			clear() {},
			show() {},
			hide() {},
			dispose() {},
		};
	},
};

export const workspace = {
	getConfiguration() {
		return { get: (_key: string, fallback?: unknown) => fallback };
	},
};

export const lm = {
	registerLanguageModelChatProvider() {
		return { dispose() {} };
	},
	async selectChatModels() {
		return [];
	},
};

export const commands = {
	registerCommand() {
		return { dispose() {} };
	},
	async executeCommand() {
		return undefined;
	},
};

export const env = {
	async openExternal() {
		return true;
	},
};

export const Uri = {
	parse: (value: string) => ({ toString: () => value }),
};

export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 };

export class Disposable {
	constructor(private readonly fn?: () => void) {}
	dispose(): void {
		this.fn?.();
	}
}
