import * as vscode from 'vscode';

let outputChannel: vscode.LogOutputChannel | undefined;
let serverChannel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.LogOutputChannel {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel('FreeLLMAPI', { log: true });
	}
	return outputChannel;
}

/**
 * Raw stdout/stderr from a server this extension spawned. A plain output
 * channel preserves the process output verbatim (ANSI and all), which is far
 * more useful than a log channel's severity prefixing when a startup fails.
 */
export function getServerOutputChannel(): vscode.OutputChannel {
	if (!serverChannel) {
		serverChannel = vscode.window.createOutputChannel('FreeLLMAPI Server');
	}
	return serverChannel;
}
