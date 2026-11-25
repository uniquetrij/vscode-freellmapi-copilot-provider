# Changelog

## 0.2.2 - 2026-11-25

**docs:** Remove the retired Marketplace badges from the README; shields.io discontinued the `visual-studio-marketplace` version, installs, and rating endpoints.

## 0.2.1 - 2026-11-25

_No user-facing changes._

## 0.2.0 - 2026-11-25

### Features

- prepare a Marketplace-safe build alongside the full VSIX (fe2acf1)
  The Marketplace rejects any package that declares proposed APIs, so the
  extension now degrades reasoning instead of requiring one:

  - resolve LanguageModelThinkingPart at runtime and stream reasoning as plain
    text (with a one-time log) when the proposal is unavailable
  - trim enabledApiProposals to languageModelThinkingPart; chatProvider has been
    stable since VS Code 1.104
  - add 'npm run package:marketplace', which strips enabledApiProposals from the
    packaged manifest and leaves the release version untouched
  - add 'npm run publish:marketplace' to bump, build, verify the produced archive
    is proposal-free, and upload it
  - document both artifacts and the maintainer release checklist

## 0.1.0 — 2026-11-24

Initial release.

- Native FreeLLMAPI chat provider for the VS Code Chat model picker.
- Streaming text, reasoning, usage, and tool calls over the OpenAI-compatible API.
- Full model catalog with router entries and `Needs provider key` / `Quota exhausted` / `Disabled` status details.
- Stable per-conversation session ids, reasoning replay cache, request ids, and truncation.
- Commands for API key, base URL, model refresh, connection check, self-test, usage, status, logs, dashboard, and server lifecycle.
- Managed local gateway start/stop with checkout auto-detection and configurable commands.
- Status bar health indicator, optional auto-start, and raw debug logging with credential redaction.
- Gateway auto-detection for loopback base URLs, so the desktop app's `31415` port works without editing settings.
- Only `auto`, `auto-route`, `fusion`, and `auto:<profile>` are treated as router entries; every catalog row reports `owned_by: "freellmapi"` and `created: 0`, so real models are no longer mislabelled as routers.
- Context windows the gateway leaves null are recovered from its own `ctx65536-…` id / `[ctx:65536] …` name hints.
- `freellmapi.showUnavailableModels` (default off) keeps the picker to models the gateway can serve; a full catalog can exceed 300 entries.
- Activates on `onLanguageModelChatProvider:freellmapi` so VS Code can resolve the model list even before startup work completes.
- Logs the first model-list resolve, so an empty picker can be diagnosed as "VS Code never asked" versus "no models returned".
- `LanguageModelThinkingPart` is resolved at runtime: reasoning renders natively where the proposal exists and falls back to plain text (with a one-time log) where it does not, instead of throwing.
- Two packaging variants: the full VSIX keeps `languageModelThinkingPart` for sideloading, while `npm run package:marketplace` strips it so the Marketplace accepts the upload.
