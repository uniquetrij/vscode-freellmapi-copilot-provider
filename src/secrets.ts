import type * as vscode from 'vscode';

const SECRET_KEY = 'freellmapi.apiKey';

export async function getApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
	const stored = await secrets.get(SECRET_KEY);
	const trimmed = stored?.trim();
	return trimmed ? trimmed : undefined;
}

export async function setApiKey(secrets: vscode.SecretStorage, apiKey: string): Promise<void> {
	const trimmed = apiKey.trim();
	if (!trimmed) {
		await clearApiKey(secrets);
		return;
	}
	await secrets.store(SECRET_KEY, trimmed);
}

export async function clearApiKey(secrets: vscode.SecretStorage): Promise<void> {
	await secrets.delete(SECRET_KEY);
}
