# Agent guide

## Project

VS Code extension that registers the `freellmapi` vendor as a native chat provider. It targets the proposed `chatProvider` and `languageModelThinkingPart` APIs and talks to a FreeLLMAPI gateway over its OpenAI-compatible `/v1` API.

## Commands

```powershell
npm install
npm run compile      # tsc -> build/out
npm run watch
npm run lint
npm test             # compile, then node:test on build/out/test/*.test.js
npm run package      # build/<name>-<version>+<build>.vsix
npm run install-vsix
```

Press F5 for an Extension Development Host. Packaging requires Node >= 22 (VS Code's `@vscode/vsce` requirement); the runtime itself is Node >= 20.

## Architecture

- `src/extension.ts` — activation, command handlers, status bar, auto-start, self-test.
- `src/provider.ts` — `LanguageModelChatProvider`; maps VS Code messages/tools to AI SDK shapes and back, truncates context, emits text/thinking/tool/usage parts.
- `src/freellmapiClient.ts` — lazy `ai` + `@ai-sdk/openai-compatible` streaming, debug fetch, tool input normalization.
- `src/modelCatalog.ts` — pure parsing/mapping/sorting of `GET /v1/models`.
- `src/modelRegistry.ts` — TTL cache, ETag revalidation, change events, last-known-good fallback.
- `src/catalogClient.ts` — catalog HTTP fetch shared by the registry and commands.
- `src/serverManager.ts` — gateway probe/start/stop and process-tree termination.
- `src/config.ts`, `src/urls.ts` — settings and URL normalization.
- `src/errors.ts`, `src/diagnostics.ts` — actionable HTTP errors, redaction, serialization.
- `src/secrets.ts`, `src/output.ts`, `src/buildInfo.ts`, `src/runtimeMode.ts` — storage, channels, build stamp, constants.
- `src/sessionIdentity.ts`, `src/reasoningCache.ts` — stable conversation ids and reasoning replay.

## Conventions

- Keep `modelCatalog.ts`, `urls.ts`, and the error helpers free of `vscode` value imports so they stay unit-testable.
- Do not log API keys. Use `redactHeaders` / `redactHeaderRecord`; debug request bodies still contain prompts.
- Preserve tool-call/tool-result pairs when changing truncation.
- The gateway is shared: do not auto-kill a managed server on deactivation.
- Tests live in `src/test` and compile to `build/out/test`; `npm test` uses a glob because Node's test runner does not recurse into a bare directory argument here.
