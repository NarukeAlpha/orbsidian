# Main process deep dive

The main process (`src/main/main.ts`) is the operational core of the app. It boots Electron, creates windows, owns the runtime services, and exposes all privileged behavior through IPC handlers.

## Startup sequence

At `app.whenReady()`, the code runs `bootstrap()`:

1. Ensure app directories exist (`config.ts`).
2. Register all IPC handlers.
3. Start and health-check managed OpenCode sidecar when possible.
4. Decide whether setup wizard should open (no config or `config` CLI arg).
5. If config exists, create orb window and initialize runtime.

If runtime initialization fails, the app shows an error box and re-opens setup.

## Single-instance behavior

The app enforces a single instance lock:

- If another process starts and passes a `config` argument, the running app opens the setup wizard.
- Otherwise, the running app focuses the orb window.

This prevents duplicate hotkey registration and duplicate runtime sessions.

## Window management

`main.ts` creates three BrowserWindow types:

- Orb window: small floating transparent window, always-on-top by default.
- Wizard window: first-run and reconfiguration UI.
- Activity window: event log table viewer.

A shared `createBaseWindow()` function enforces secure preload configuration:

- `contextIsolation: true`
- `nodeIntegration: false`
- preload script from `dist/preload/preload.js`

## Managed OpenCode sidecar

The app can start OpenCode itself on `%default_opencode_url%`:

- Reachability check via `/global/health`.
- On failure, spawn `opencode serve --hostname ... --port ...`.
- Poll for readiness with timeout.
- Capture stdout/stderr tail for diagnostics.
- On app quit, terminate process gracefully, then force-kill if needed.

This reduces first-run friction while still allowing a manually managed OpenCode server.

## Runtime initialization

`initializeRuntime(config)` constructs and wires:

- `AppDatabase`
- `OpenCodeService`
- `WhisperService`
- `TtsService`
- `VoiceOrchestrator`

Then it registers global shortcuts and emits initial `idle` state.

`restartRuntime()` is used after saving wizard config: old runtime is shut down cleanly, then rebuilt with new settings.

## Hotkey registration and behavior

Global shortcuts are configured from user config:

- listen toggle -> `orchestrator.handleListenHotkey()`
- tts skip -> `orchestrator.handleTtsSkipHotkey()`
- tts interrupt -> `orchestrator.handleTtsInterruptHotkey()`

If registration fails (for example on macOS permissions/conflicts), the app shows a warning dialog.

## Runtime precheck logic

Before full setup, `wizard:precheck-runtime` resolves and validates:

- Whisper binary path (custom, userData build location, or PATH fallback)
- Whisper model path (existing non-empty file)
- Python executable + qwen/soundfile import health
- Qwen model directory artifacts
- Runtime script path (`runtime/qwen_tts.py` packaged vs dev path)

The result includes normalized paths plus a `missing[]` list for user messaging.

## IPC surface (main-side)

The main process handles several IPC namespaces:

| Namespace | Purpose |
|---|---|
| `capture:*` | Receive speech capture results from orb renderer |
| `transaction:*` | Cancel current request/session transaction |
| `activity:*` | Open activity window and list recent events |
| `permissions:*` | Request/check microphone permission |
| `wizard:*` | Setup defaults, probes, runtime setup, model downloads, OpenCode verification, save config |

This API is exposed to renderer only through preload wrappers, not direct node access.

## Shutdown behavior

On `before-quit`:

- Global shortcuts are unregistered.
- Current request transaction is canceled.
- Orchestrator disposed.
- Managed OpenCode sidecar stopped.

This avoids orphaned background processes and stale active sessions.

## Related files for this layer

- `src/main/main.ts` - lifecycle, windows, IPC, runtime wiring
- `src/main/config.ts` - config defaults and persistence
- `src/preload/preload.ts` - renderer bridge for all IPC endpoints

<seealso>
    <category ref="related">
        <a href="Architecture-and-runtime-flow.md"/>
        <a href="Renderer-preload-and-ipc.md"/>
        <a href="Setup-wizard-and-runtime-bootstrap.md"/>
    </category>
</seealso>
