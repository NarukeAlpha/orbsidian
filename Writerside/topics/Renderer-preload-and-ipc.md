# Renderer, preload, and IPC

This page explains frontend-side behavior and how secure communication is handled between renderer windows and the main process.

## Security model

All windows use:

- `contextIsolation: true`
- `nodeIntegration: false`
- preload script with explicit API exposure

Renderer code never imports Node APIs directly. Instead, it calls `window.orbsidian.*` methods provided by `src/preload/preload.ts`.

## Preload API surface

`preload.ts` exposes three namespaces:

| Namespace | Used by | Main purpose |
|---|---|---|
| `orb` | `orb.ts` | Capture commands, state updates, cancel flow, mic permissions, activity window open |
| `wizard` | `wizard.ts` | Config defaults, probes, runtime setup, model downloads, OpenCode verify, save config |
| `activity` | `activity.ts` | Pull event rows and subscribe to updates |

Each listener registration returns an unsubscribe function to avoid leak-prone global listeners.

## Orb renderer behavior (`orb.ts`)

The orb renderer owns browser-side audio capture logic:

- Requests microphone permission through preload API.
- Captures mono stream with echo/noise suppression.
- Uses `ScriptProcessorNode` to accumulate PCM chunks.
- Detects speech via RMS threshold (`>= 0.015`).
- Auto-stops when silence threshold expires.
- Downsamples to 16kHz and encodes WAV in browser.
- Sends base64 WAV payload to main process.

### Orb visual state

State events (`ui:state`) update:

- status text label
- queue depth label
- orb color class by state
- rotating animation for active states

The orb button itself is bound to cancellation semantics while busy.

## Wizard renderer behavior (`wizard.ts`)

Wizard UI is stateful and validates dependencies progressively:

- Loads defaults and inferred runtime paths.
- Runs runtime precheck on initialization.
- Supports one-click auto runtime setup.
- Probes Obsidian CLI and Whisper binary.
- Verifies OpenCode health + model availability.
- Saves normalized config to main process.

Two readiness gates control save flow:

- `runtimeReady`
- `opencodeReady`

This is why save can be blocked with actionable error messages instead of silently failing later.

## Activity renderer behavior (`activity.ts`)

The activity page is intentionally simple:

- Pull latest events (`listEvents(500)`).
- Render rows in descending order.
- Subscribe to `activity:updated` and refresh.
- Show full payload JSON as cell tooltip.

It is a debugging and observability console, not a full analytics UI.

## IPC contract examples

| Channel | Direction | Payload shape |
|---|---|---|
| `capture:result` | renderer -> main | `{audioBase64, hasSpeech, durationMs, mode}` |
| `ui:state` | main -> renderer | `{state, label, queueDepth}` |
| `wizard:precheck-runtime` | renderer -> main | path hints for whisper/python/qwen/runtime script |
| `wizard:runtime-progress` | main -> renderer | `{stage, message}` |
| `activity:list` | renderer -> main | limit number -> event rows |

## Adding a new UI capability safely

<procedure title="Add a new renderer-to-main feature" id="add-a-new-renderer-to-main-feature">
    <step>
        <p>Add a new <code>ipcMain.handle(...)</code> endpoint in <code>src/main/main.ts</code>.</p>
    </step>
    <step>
        <p>Expose the handler through <code>src/preload/preload.ts</code> under an existing namespace or a new one.</p>
    </step>
    <step>
        <p>Use the preload method from renderer code; do not call Electron APIs directly from renderer modules.</p>
    </step>
    <step>
        <p>If the feature emits events, mirror the subscribe/unsubscribe pattern already used by orb and activity APIs.</p>
    </step>
</procedure>

<seealso>
    <category ref="related">
        <a href="Main-process-deep-dive.md"/>
        <a href="Setup-wizard-and-runtime-bootstrap.md"/>
        <a href="Testing-and-validation.md"/>
    </category>
</seealso>
