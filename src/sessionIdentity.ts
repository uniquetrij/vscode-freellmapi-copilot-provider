import { createHash } from 'crypto';
import * as vscode from 'vscode';

export const DEFAULT_SESSION_CACHE_MAX_ENTRIES = 64;

export interface ConversationSession {
	readonly id: string;
	readonly createdAt: number;
}

/**
 * Bounded most-recently-used map of conversation fingerprint to session id.
 * Entries are insertion-ordered, so re-inserting on read makes the first key
 * the least recently used one.
 */
export class ConversationSessionStore {
	private readonly entries = new Map<string, ConversationSession>();

	constructor(
		private readonly mint: () => string,
		private readonly maxEntries = DEFAULT_SESSION_CACHE_MAX_ENTRIES
	) {}

	get(fingerprint: string): ConversationSession {
		const existing = this.entries.get(fingerprint);
		if (!existing) {
			return this.renew(fingerprint);
		}
		this.entries.delete(fingerprint);
		this.entries.set(fingerprint, existing);
		return existing;
	}

	renew(fingerprint: string): ConversationSession {
		const session: ConversationSession = { id: this.mint(), createdAt: Date.now() };
		this.entries.delete(fingerprint);
		this.entries.set(fingerprint, session);
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (oldest.done) {
				break;
			}
			this.entries.delete(oldest.value);
		}
		return session;
	}

	clear(): void {
		this.entries.clear();
	}
}

/** FreeLLMAPI only uses the value as a session key; any stable string works. */
export function createSessionId(): string {
	return `ses_${createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 24)}`;
}

/**
 * Identifies a conversation by its earliest text-bearing user message, which is
 * the only part of the request that stays constant as the chat grows — VS Code
 * hands the provider no chat id. Undefined means the request carries no text to
 * key on, so the caller must not cache the session it mints.
 */
export function conversationFingerprint(
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): string | undefined {
	const seed = firstUserText(messages);
	if (seed === undefined) {
		return undefined;
	}
	return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

function firstUserText(messages: readonly vscode.LanguageModelChatRequestMessage[]): string | undefined {
	for (const message of messages) {
		if (message.role !== vscode.LanguageModelChatMessageRole.User) {
			continue;
		}
		const text = message.content
			.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
			.map((part) => part.value.trim())
			.filter((value) => value.length > 0)
			.join('\n');
		if (text.length > 0) {
			return text;
		}
	}
	return undefined;
}
