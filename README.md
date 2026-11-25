# FreeLLMAPI for VS Code

[![Marketplace](https://vsmarketplacebadges.dev/version/uniquetrij.freellmapi-chat-provider.svg?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=uniquetrij.freellmapi-chat-provider)
[![Installs](https://vsmarketplacebadges.dev/installs/uniquetrij.freellmapi-chat-provider.svg?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=uniquetrij.freellmapi-chat-provider)
[![Release](https://img.shields.io/github/v/release/uniquetrij/vscode-freellmapi-copilot-provider?style=flat-square&logo=github)](https://github.com/uniquetrij/vscode-freellmapi-copilot-provider/releases/latest)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.104%2B-007ACC?style=flat-square&logo=visualstudiocode)](https://code.visualstudio.com)
[![License: MIT](https://img.shields.io/github/license/uniquetrij/vscode-freellmapi-copilot-provider?style=flat-square)](LICENSE)

Use [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) as a native chat provider in VS Code. The extension exposes the gateway's OpenAI-compatible model catalog in the Chat model picker, streams responses (including reasoning), forwards tool calls, and can start or stop a local FreeLLMAPI checkout.

FreeLLMAPI is a self-hosted router that spreads requests across free-tier providers and fails over when a provider is unavailable. This extension talks to its `/v1` API; it does not bundle the gateway or any provider credentials.

## Install

From the [Marketplace](https://marketplace.visualstudio.com/items?itemName=uniquetrij.freellmapi-chat-provider), or:

```powershell
code --install-extension uniquetrij.freellmapi-chat-provider
```

That build uses only stable APIs, so the Marketplace accepts it; the trade-off is that reasoning arrives as plain text.

**Native reasoning** needs the proposed `languageModelThinkingPart` API, so it ships as a VSIX attached to the [latest release](https://github.com/uniquetrij/vscode-freellmapi-copilot-provider/releases/latest):

```powershell
code --install-extension .\freellmapi-chat-provider-<version>+<build>.vsix --force
```

Either way, reload the window after installing. See **Reasoning arrives as normal text** if the picker stays empty or reasoning is not collapsible.

## Features

- **Native model picker** — every model in `GET /v1/models` is listed, including models that currently need a provider key, are disabled, or have exhausted their quota. Status is shown in the picker detail and tooltip.
- **Streaming chat** — text, reasoning (`reasoning_content`), usage, and tool calls stream into VS Code Chat.
- **Tool calling** — VS Code tools are converted to the OpenAI tool schema; tool names are sanitized and mapped back to the original names.
- **Sticky routing** — a stable `x-session-id` per conversation lets FreeLLMAPI keep provider affinity and replay reasoning; every request also carries an `x-request-id` for gateway logs.
- **Context management** — the configured output budget is reserved first, then older messages are dropped until the prompt fits the rest of the model's context window, preserving tool-call/result pairs.
- **Server management** — start, stop, restart, and probe a local gateway. A checkout is auto-detected, or you can supply an explicit command.
- **Usage report** — reads `GET /v1/usage` and breaks down requests/tokens by platform and key.
- **Diagnostics** — connection check, self-test, status bar health indicator, and separate extension/server output channels. Debug logging redacts credential headers.
- **Configurable endpoint** — localhost by default; point it at Docker, a LAN host, or a remote deployment.

## Requirements

- VS Code **1.104 or newer**. `LanguageModelChatProvider` is stable there, so the extension needs no proposed APIs; only native reasoning rendering depends on one (see **Reasoning arrives as normal text** below).
- A running FreeLLMAPI gateway (default `http://127.0.0.1:3001/v1`). The desktop app from the Microsoft Store serves it on `http://127.0.0.1:31415/v1`; the extension finds that port automatically when the configured URL does not answer.
- A FreeLLMAPI API key. The **unified** key works for chat and usage; profile keys work for chat but return HTTP 403 from `/v1/usage`.

## Quick start

1. Start FreeLLMAPI yourself, or run **FreeLLMAPI: Start Server** after setting `freellmapi.server.path` to a checkout.
2. Run **FreeLLMAPI: Set API Key** and paste the unified key from the FreeLLMAPI dashboard (desktop app: tray icon → **Copy Key**). It is stored in VS Code SecretStorage.
3. Open the Chat model picker and choose a FreeLLMAPI model. `auto` lets the router pick the best available model; `fusion` and `auto:<profile>` use the gateway's other routing entries.
4. Optional: run **FreeLLMAPI: Self Test** to verify streaming and tool calling end to end.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `freellmapi.baseUrl` | `http://127.0.0.1:3001/v1` | OpenAI-compatible base URL. A scheme is added when omitted and `/v1` is appended unless the path already ends in `/vN`. |
| `freellmapi.autoDetectBaseUrl` | `true` | When the configured URL is on this machine but nothing answers, probe the desktop app's port (from its `config.json`, 31415 by default) and `3001`, then use whichever answers for the session. Remote URLs are never probed. |
| `freellmapi.modelCacheTtlMinutes` | `5` | Catalog cache lifetime. `0` refetches on every request. |
| `freellmapi.modelFilter` | empty | Comma-separated globs matched against model ids and names, for example `auto*,claude*,gpt-*`. Plain text is a substring match. Empty shows everything. |
| `freellmapi.showUnavailableModels` | `false` | Also list models the gateway cannot serve right now (`Needs provider key`, `Disabled`, `Quota exhausted`). Off keeps the picker to usable models; a full catalog can run to hundreds of entries. |
| `freellmapi.maxOutputTokens` | `8192` | Requested output budget, clamped to the model's input window. |
| `freellmapi.imageInput` | `all` | `all`, `auto` (router models only), or `none`. The catalog does not publish per-model vision support, so this is a heuristic. |
| `freellmapi.debugLogging` | `false` | Log redacted HTTP requests/responses to the FreeLLMAPI output channel. Request bodies include prompts. |
| `freellmapi.statusBar.enabled` | `true` | Show the model/server status bar item. |
| `freellmapi.healthCheckIntervalSeconds` | `30` | Health probe interval (minimum 10). |
| `freellmapi.server.autoStart` | `false` | Start the gateway on activation when it is unreachable. Machine-scoped. |
| `freellmapi.server.path` | empty | FreeLLMAPI checkout or deployment directory. Empty uses the first workspace folder. Machine-scoped. |
| `freellmapi.server.startCommand` | empty | Explicit start command, run in `server.path`. Empty auto-detects. Machine-scoped. |
| `freellmapi.server.stopCommand` | empty | Explicit stop command (for example `docker compose down`). Machine-scoped. |
| `freellmapi.server.startTimeoutSeconds` | `60` | How long to wait for the gateway to answer after starting. Machine-scoped. |

## Commands

| Command | Purpose |
| --- | --- |
| **FreeLLMAPI: Set API Key** | Validate the key against `/v1/models` and save it to SecretStorage. |
| **FreeLLMAPI: Clear API Key** | Remove the stored key and empty the model picker. |
| **FreeLLMAPI: Set Base URL** | Change and normalize the gateway URL. |
| **FreeLLMAPI: Refresh Model List** | Refetch the catalog and notify VS Code. |
| **FreeLLMAPI: Check Connection** | Probe the server, key, and catalog with actionable errors. |
| **FreeLLMAPI: Self Test** | Send a tool-calling prompt, execute the tool, and stream a follow-up. |
| **FreeLLMAPI: Show Usage** | Read `/v1/usage` and show totals plus platform/key breakdowns. |
| **FreeLLMAPI: Start Server** | Start a managed gateway process. |
| **FreeLLMAPI: Stop Server** | Run `stopCommand` and/or terminate the process this extension started. |
| **FreeLLMAPI: Restart Server** | Stop, then start. |
| **FreeLLMAPI: Show Status** | Quick pick with health, key, model count, and actions. |
| **FreeLLMAPI: Show Logs** | Open the extension log. |
| **FreeLLMAPI: Show Server Logs** | Open captured gateway stdout/stderr. |
| **FreeLLMAPI: Open Dashboard** | Open the gateway origin in the browser. |

The status bar item shows `no key`, `offline`, loading, `no models`, or ready. Click it for **Show Status**.

## Model statuses

The picker shows the gateway's state rather than hiding entries:

| Detail | Meaning |
| --- | --- |
| `Router` | `auto`, `fusion`, or `auto:<profile>` entry managed by FreeLLMAPI. |
| `Needs provider key` | A provider key for this model is missing in the FreeLLMAPI dashboard. |
| `Quota exhausted` | The provider's free quota is exhausted for now. |
| `Disabled` | The model is disabled in FreeLLMAPI. |
| `No routable models` | The router entry has no usable upstream model. |
| `Unavailable` | The gateway reports the model as unavailable for another reason. |
| *no detail* | Ready to use. |

Because the catalog changes as keys are added and quotas reset, use **Refresh Model List** or wait for the cache TTL/revalidation timer.

## Server management

With no `startCommand`, **Start Server** looks in `server.path` (or the first workspace folder) for:

1. `server/dist/index.js` → `node "server/dist/index.js"`
2. `dist/index.js` → `node "dist/index.js"`
3. `server/package.json` or a `server` workspace → `npm run dev -w server`
4. a root `dev:server` script, then a root `dev` script
5. `docker compose up -d` when a Compose file exists (last resort; the container is not a tracked child process)

When the detected command is Node/npm, the port from `freellmapi.baseUrl` is passed as `PORT`. A locally started server is **left running** when VS Code shuts down because it may serve other windows and clients; use **Stop Server** explicitly. On Windows the tracked process tree is terminated with `taskkill /T /F`; on POSIX the process group receives `SIGTERM` then `SIGKILL`.

For Docker or a remote gateway, disable `server.autoStart` and manage it outside VS Code.

## Troubleshooting

**The provider does not appear in the model picker**

- Confirm VS Code 1.104+; the extension only uses stable APIs in the Marketplace build.
- Run **Developer: Reload Window**, then **FreeLLMAPI: Show Logs**.
- **F5 is not enough for the model picker.** An Extension Development Host is a separate window that shares neither the chat session nor the agent-host model list, so models it loads never reach the chat you are using. Install into the main window instead: `npm run install-vsix` (or `code --install-extension build\<name>.vsix`), then reload.
- The log line `VS Code requested the model list (N model(s) returned).` proves the workbench resolved the provider. If it never appears, the extension is not running in that window at all.
- A provider with no API key intentionally returns an empty model list, because FreeLLMAPI requires a bearer token even for `GET /v1/models`. Run **FreeLLMAPI: Set API Key** with the unified `freellmapi-...` key from the dashboard; the log line names the dashboard URL.

**`FreeLLMAPI is not reachable`**

- Start the gateway or run **FreeLLMAPI: Start Server**.
- The desktop app (Microsoft Store / installer) serves the API on port `31415` and stores the port in `%APPDATA%\FreeLLMAPI\config.json`; the Docker image and `npm run dev` use `3001`. Leave `freellmapi.baseUrl` alone and the extension adopts the port that answers, or run **FreeLLMAPI: Set Base URL** with `http://127.0.0.1:31415/v1` to pin it.
- Check `freellmapi.baseUrl`. `/api/ping` is probed first; if a reverse proxy does not route it, the extension falls back to `/v1/models`.

**HTTP 401 / 403**

- 401 means the key was rejected: run **Set API Key** with the unified key.
- 403 on **Show Usage** usually means a profile key was used. Chat can still work with that key.

**HTTP 404**

- The base URL probably lacks `/v1` or points at the dashboard instead of the API. The normalizer appends `/v1` only when the path does not already end in `/vN`.

**HTTP 422 or 429**

- 422 usually means the router could not satisfy the request, often because no vision-capable model was available for an image attachment. Try `freellmapi.imageInput: "none"` or a specific vision model.
- 429 means FreeLLMAPI exhausted every available model for that request. Wait for quotas to reset or add provider keys in the dashboard.

**No response / empty model output**

The extension emits a visible fallback part when the gateway returns no content, and logs the request id. Compare the request id with the FreeLLMAPI server logs (`x-request-id`).

**Reasoning arrives as normal text**

Reasoning is streamed through `LanguageModelThinkingPart`, which is still a proposed API. The Marketplace build therefore ships without it and renders reasoning as plain text; the log explains this once per session (`Reasoning is streamed as plain text: …`). Install the full VSIX from the matching GitHub Release to get native collapsible reasoning in a development build. A future stable VS Code release will make this switch unnecessary.

## Privacy

The extension sends prompts, tool schemas, and tool results only to the configured `freellmapi.baseUrl`. The API key is stored with VS Code SecretStorage and sent as a bearer token. Debug logging redacts `authorization`, `x-api-key`, `x-goog-api-key`, `x-proxy-token`, `cookie`, and `set-cookie` headers, but request bodies (including prompt text) are logged locally when `freellmapi.debugLogging` is enabled.

## Development

```powershell
npm install
npm run compile              # tsc -> build/out
npm run watch                # incremental compile
npm run lint
npm test                     # compile + node:test (URLs, catalog, client, reasoning parts)
npm run package              # build/<name>-<version>+<build>.vsix           (full)
npm run package:marketplace  # build/<name>-<version>+<build>-marketplace.vsix (gallery-safe)
npm run install-vsix         # installs the newest full VSIX
```

Press <kbd>F5</kbd> to launch an Extension Development Host. Debug builds are marked and reported in the log; packaging stamps `build/out/buildInfo.json` and a `+<build>` version suffix without changing the committed version.

Two artifacts come from the same sources:

| Variant | Command | `enabledApiProposals` | Reason |
| --- | --- | --- | --- |
| full | `npm run package` | `languageModelThinkingPart` | Native collapsible reasoning. Sideloaded from a GitHub Release; VS Code on stable logs that the proposal is unavailable and the extension degrades to plain text. |
| marketplace | `npm run package:marketplace` | stripped | The gallery rejects any package that declares proposed APIs. |

`install-vsix` prefers the full build by default; pass `--marketplace` to install the gallery variant and confirm that reasoning falls back.

If the development host opens and closes after about a second, check the Run and Debug view for a session that is still marked active (the floating debug toolbar stays visible with no host window). VS Code closes the new host as soon as that stale session terminates, so press <kbd>Ctrl</kbd>+<kbd>F2</kbd> (Stop) in the main window, close any leftover `[Extension Development Host]` windows, and press <kbd>F5</kbd> again. The `Extension Development Host` window created by a working launch is attached to the debug session; stopping the session closes it.

The source is split into small modules:

- `extension.ts` — activation, commands, status bar, self-test.
- `provider.ts` — VS Code ↔ AI SDK message/tool mapping and streaming.
- `freellmapiClient.ts` — `@ai-sdk/openai-compatible` streaming and debug fetch.
- `modelCatalog.ts` / `modelRegistry.ts` / `catalogClient.ts` — catalog parsing, caching, ETag revalidation.
- `serverManager.ts` — gateway process lifecycle.
- `config.ts`, `urls.ts`, `errors.ts`, `diagnostics.ts`, `secrets.ts`, `output.ts` — settings, normalization, errors, redaction, storage, logging.
- `thinkingParts.ts` — resolves `LanguageModelThinkingPart` at runtime and degrades reasoning to text when the proposal is unavailable.

## Publishing

Publishing runs through **OIDC trusted publishing**: the publisher `uniquetrij` (created at <https://marketplace.visualstudio.com/manage>, matching the manifest's `publisher` field) has a Trusted Publishing policy that trusts this repository's `.github/workflows/publish.yml`. GitHub mints a short-lived token for that workflow, so no Personal Access Token is stored in the repo or on any machine.

Release checklist:

```powershell
npm test
npm run version:bump                  # bump from conventional commits + prepend CHANGELOG section
git add package.json CHANGELOG.md
git commit -m "chore(release): v<version>"
git tag -a v<version> -m "v<version>"
git push --follow-tags
gh workflow run publish.yml           # or Actions -> Publish -> Run workflow
```

The **Publish** workflow runs the tests, builds the gallery variant, re-reads `extension/package.json` out of the archive to prove no proposed APIs remain, uploads it with `vsce publish --oidc`, then builds the full VSIX and attaches it to the `v<version>` GitHub Release. That release asset is how users who want native reasoning sideload the full build.

A freshly uploaded version sits in **Verifying** on the publisher's manage page while the Marketplace scans it (minutes to a few hours for a new publisher). Until that clears, `https://marketplace.visualstudio.com/items?itemName=uniquetrij.freellmapi-chat-provider` returns 404 and `code --install-extension uniquetrij.freellmapi-chat-provider` reports "not found", even though the upload succeeded.

Local publishing still works with a Personal Access Token if the workflow is unavailable:

```powershell
$env:VSCE_PAT = "<token with Marketplace -> Manage scope>"
npm run publish:marketplace           # bump + build + verify + upload
npm run publish:marketplace -- --dry-run --no-bump   # verify without uploading
```

A PAT needs an Azure DevOps organization to mint, which is exactly the setup trusted publishing avoids.

## Limitations

- `/v1/models` does not advertise per-model vision support, so `imageInput` is a global heuristic rather than a capability read from the gateway.
- `/v1/models` requires the unified key: it answers `401` without one, so the picker stays empty until **FreeLLMAPI: Set API Key** succeeds. Only `/api/ping` is reachable unauthenticated (which is what gateway auto-detection probes).
- The extension does not implement its own failover; it relies on FreeLLMAPI's router and reports the gateway's final errors.
- Token counts are estimated from characters, not a tokenizer.
- Usage requires the unified key and the gateway's `/v1/usage` endpoint.
- Auto-detection understands the documented FreeLLMAPI checkout layout, not arbitrary deployments; use `server.startCommand` for anything else.

## License

MIT. FreeLLMAPI is a separate project by its own authors; see [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi).
