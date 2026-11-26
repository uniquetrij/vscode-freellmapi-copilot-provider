# Agent guide

## Project

VS Code extension that registers the `freellmapi` vendor as a native chat provider. It targets the Language Model Chat Provider API (stable since VS Code 1.104), optionally uses the proposed `languageModelThinkingPart` API for native reasoning, and talks to a FreeLLMAPI gateway over its OpenAI-compatible `/v1` API.

## Commands

```powershell
npm install
npm run compile      # tsc -> build/out
npm run watch
npm run lint
npm test             # compile, then node:test on build/out/test/*.test.js
npm run package      # build/<name>-<version>+<build>.vsix
npm run install-vsix
npm run dev:host     # isolated VS Code instance (own profile + agent host)
npm run dev:host:stop
npm run dev:host:status
npm run dev:host:logs
```

Press F5 to attach to an isolated Extension Development Host. The Copilot agent host that feeds the chat model picker runs once per VS Code instance, so a debug window inside the normal instance can never offer the dev provider while a normal window is connected; `Dev Host: Start` therefore launches a separate instance with its own `--user-data-dir` (`%LOCALAPPDATA%\freellmapi-dev-host`). That task marks `package.json` with side-by-side `-dev` ids (`freellmapi-dev`, `freellmapi-chat-provider-dev`) and compiles, and `Dev Host: Stop` closes the instance and unmarks the manifest. `npm run package` also unmarks before reading the manifest. Use **Run Extension (In-Window EDH)** only for extension-host debugging that does not need the picker.

Packaging requires Node >= 22 (VS Code's `@vscode/vsce` requirement); the runtime itself is Node >= 20.

## Architecture

- `src/extension.ts` — activation, command handlers, status bar, auto-start, self-test.
- `src/provider.ts` — `LanguageModelChatProvider`; maps VS Code messages/tools to AI SDK shapes and back, truncates context, emits text/thinking/tool/usage parts.
- `src/freellmapiClient.ts` — lazy `ai` + `@ai-sdk/openai-compatible` streaming, debug fetch, tool input normalization.
- `src/modelCatalog.ts` — pure parsing/mapping/sorting of `GET /v1/models`.
- `src/modelRegistry.ts` — TTL cache, ETag revalidation, change events, last-known-good fallback, persisted catalog replay.
- `src/catalogCache.ts` — validation of the catalog persisted in `globalState` (gateway identity, model shape).
- `src/catalogClient.ts` — catalog HTTP fetch shared by the registry and commands.
- `src/serverManager.ts` — gateway probe/start/stop and process-tree termination.
- `src/gatewayDiscovery.ts`, `src/desktopKey.ts` — desktop app port discovery and loopback-only unified-key import (`/api/auth/desktop-session` → `/api/settings/api-key`).
- `src/config.ts`, `src/urls.ts` — settings and URL normalization.
- `src/errors.ts`, `src/diagnostics.ts` — actionable HTTP errors, redaction, serialization.
- `src/secrets.ts`, `src/output.ts`, `src/buildInfo.ts`, `src/runtimeMode.ts` — storage, channels, build stamp, manifest-derived vendor/command/configuration ids (release vs `-dev`).
- `scripts/dev_host/isolated-host.js` — starts/stops the separate debug instance (own `--user-data-dir`, so its own agent host and chat picker) and marks/unmarks the debug identity around it.
- `src/sessionIdentity.ts`, `src/reasoningCache.ts` — stable conversation ids and reasoning replay.

## Conventions

- Keep `modelCatalog.ts`, `catalogCache.ts`, `urls.ts`, `gatewayDiscovery.ts`, `desktopKey.ts`, `runtimeMode.ts`, and the error helpers free of `vscode` value imports so they stay unit-testable.
- Never hard-code `freellmapi` for a vendor, command, or setting id. Read them from `getVendorId()` / `getRuntimeIdentity()` so the `-dev` manifest written by `scripts/dev-marker.js` is honored; a cached literal would keep the release ids in a dev build.
- `activationEvents` must not contain `*`. `onStartupFinished` covers the status bar and gateway probe, and the provider/command events cover first use.
- Activation registers the provider before the gateway probe and answers the first model-list request from the persisted catalog; VS Code snapshots a provider's models when it launches a chat session (during window restore), so `provideLanguageModelChatInformation` must never block on HTTP when a cached list exists. Keep that ordering when editing `extension.ts`.
- Do not log API keys. Use `redactHeaders` / `redactHeaderRecord`; debug request bodies still contain prompts.
- Dev visual cues (output channel name, chat model-picker labels, and the reply prefix) come from `isDevelopmentMode()` + `DEV_BADGE` and are applied at the presentation boundary. Do not bake a badge into a mapped model in `modelCatalog.ts`: that array is persisted to `globalState`, so the label would outlive the debug session. Any badge added to a reply is scrubbed with `stripDevBadge` when the history is mapped back to AI SDK messages, so the gateway never sees it.
- Preserve tool-call/tool-result pairs when changing truncation.
- The gateway is shared: do not auto-kill a managed server on deactivation.
- Tests live in `src/test` and compile to `build/out/test`; `npm test` uses a glob because Node's test runner does not recurse into a bare directory argument here. Test files that import modules calling into the `vscode` API must `import './support/register'` first; it redirects `require('vscode')` to the stub in `src/test/support/vscode.ts`.
