import Module from 'node:module';
import * as path from 'node:path';

// Redirect `require('vscode')` to the stub before any compiled module loads.
// Test files import this first, so extension code runs against the stub rather
// than failing to resolve the extension-host-only module.
const stubPath = path.join(__dirname, 'vscode.js');

type Resolver = {
	_resolveFilename(request: string, parent?: unknown, isMain?: boolean, options?: unknown): string;
};

const resolver = Module as unknown as Resolver;
const originalResolveFilename = resolver._resolveFilename;

resolver._resolveFilename = (request: string, ...args: unknown[]): string => {
	if (request === 'vscode') {
		return stubPath;
	}
	return originalResolveFilename.call(resolver, request, ...args);
};
