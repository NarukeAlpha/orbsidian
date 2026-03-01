# OpenCode and Obsidian integration

This page explains how the app talks to OpenCode, how agent output is normalized, and how note actions are executed safely in the vault.

## OpenCodeService responsibilities

`src/main/opencode.ts` encapsulates all OpenCode communication concerns:

- Connect to server with optional basic auth.
- Verify health and discover available models.
- Create and abort sessions.
- Prompt the selected agent with strict JSON schema output.
- Recover across SDK differences with fallback transport paths.

## Connection and auth

`OpenCodeService.connect()` builds the SDK client against configured `baseUrl`.

- If username/password is set, requests include `Authorization: Basic ...`.
- Otherwise default client transport is used.

Main process defaults to sidecar URL `%default_opencode_url%`.

## Health and model discovery strategy

The service is intentionally defensive because SDK/server versions may vary.

For health checks, it tries in order:

1. `client.global.health()`
2. Raw `GET /global/health`
3. `client.app.get()` as backup

For model listing, it tries:

1. SDK config providers endpoint
2. Raw providers endpoint fallback
3. Provider state endpoint to filter connected providers

This is why wizard verification can still work even when one endpoint shape changes.

## Prompt contract and schema enforcement

`promptAgent()` sends a JSON-schema constrained prompt request.

Key behavior:

- Adds `agent` id (default `build` unless reconfigured).
- Optionally pins model with `providerId/modelId`.
- Applies request timeout with `AbortController`.
- Expects response that matches `AgentEnvelope` schema.

The envelope captures action intent, fallback metadata, context changes, confirmation requirements, execution logs, and user-facing reply text.

## Parsing fallback logic

OpenCode response parsing handles several shapes:

- Direct JSON object response.
- Text content inside message parts.
- JSON extraction from mixed text output.
- Final fallback to a safe default error envelope.

This prevents orchestration crashes when output formatting is imperfect.

## Session and cancellation behavior

- Sessions are created once and reused across requests.
- Current in-flight run can be aborted by user cancellation.
- Idle expiry can end sessions automatically.

This gives a conversational feel while keeping control points explicit.

## Obsidian action execution

Agent outputs can represent note operations such as create/append/update/move/rename/open.

Execution policy:

1. Agent attempts Obsidian CLI commands (recorded in envelope command runs).
2. If CLI failed and fallback is enabled, app executes direct vault file operation.

Fallback functions in `src/main/obsidian.ts` include:

- `fallbackCreateNote`
- `fallbackAppendNote`
- `fallbackUpdateNote`
- `fallbackRenameNote`
- `fallbackMoveNote`

## Vault path safety

Fallback operations resolve final paths with vault-root checks:

- Normalize note path to forward slashes.
- Resolve absolute path under vault root.
- Reject paths that escape vault root.

This is an important safeguard against traversal-style path mistakes.

## Open note behavior

`openNoteByUri()` opens notes using `obsidian://open?vault=...&file=...` via Electron shell.

In orchestrator behavior, successful `open` intent ends the current session by design, so the next voice action starts a fresh session.

## Failure handling model

`VoiceOrchestrator.handleAgentFailure()` classifies common auth/network failures and can terminate the active session with a spoken explanation.

Non-network failures keep session alive and simply report processing error.

<seealso>
    <category ref="related">
        <a href="Architecture-and-runtime-flow.md"/>
        <a href="Main-process-deep-dive.md"/>
        <a href="Database-and-observability.md"/>
    </category>
    <category ref="external">
        <a href="https://opencode.ai/docs/server/">OpenCode server docs</a>
        <a href="https://opencode.ai/docs/sdk/">OpenCode SDK docs</a>
    </category>
</seealso>
