# Codebase map

This page gives you a practical map of where logic lives so you can jump to the right file quickly.

## Source layout

```text
src/
  main/       # Electron main process, orchestration, services, persistence
  preload/    # Secure bridge API exposed to renderer windows
  renderer/   # Orb UI, setup wizard UI, activity log UI
runtime/      # Python runtime script used by Qwen TTS
scripts/      # Build-time utility scripts
Test/         # Playwright tests (UI + voice runtime smoke tests)
Writerside/   # Documentation module (this documentation)
```

## Directory-by-directory breakdown

| Path | Responsibility | Key files |
|---|---|---|
| `src/main/` | App lifecycle, windows, IPC, orchestration, OpenCode client, Obsidian operations, STT/TTS, DB | `main.ts`, `orchestrator.ts`, `opencode.ts`, `db.ts` |
| `src/preload/` | Controlled IPC wrappers for renderer windows | `preload.ts` |
| `src/renderer/` | Frontend logic for orb, setup wizard, and activity panel | `orb.ts`, `wizard.ts`, `activity.ts` |
| `runtime/` | Python bridge script that loads and runs Qwen TTS | `qwen_tts.py` |
| `scripts/` | Asset copy helper used during TypeScript build | `copy-assets.mjs` |
| `Test/` | Browser-level and runtime smoke validation | `specs/configuration-page.spec.ts`, `specs/voice-runtime.spec.ts` |
| `Writerside/` | Writerside config, TOC, topics, and publishing setup | `writerside.cfg`, `orbsidian.tree`, `topics/*.md` |

## Build output map

The build process compiles TypeScript to `dist/`:

- `src/main/**/*.ts` -> `dist/main/**`
- `src/preload/**/*.ts` -> `dist/preload/**`
- `src/renderer/**/*.ts` -> `dist/renderer/**`
- renderer HTML/CSS assets are copied into `dist/renderer/**` by `scripts/copy-assets.mjs`

## Runtime data locations

At runtime, Electron writes to `app.getPath("userData")` (platform-specific):

- `config.json` - persisted app config
- `data/orbsidian.sqlite` - local SQLite activity database
- `models/whisper/ggml-base.en.bin` - Whisper model
- `models/qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice/` - Qwen model directory
- `tools/whisper.cpp/` - cloned/build whisper.cpp repository
- `tools/qwen-tts-venv/` - Python virtual environment used for TTS

## Fast orientation by feature

- Listening and audio capture UI: `src/renderer/orb.ts`
- STT integration: `src/main/stt.ts`
- OpenCode prompt + schema handling: `src/main/opencode.ts`
- Obsidian CLI fallback ops: `src/main/obsidian.ts`
- TTS generation + playback: `src/main/tts.ts` and `runtime/qwen_tts.py`
- Runtime setup automation: `src/main/voice-runtime-setup.ts`
- Wizard behavior: `src/renderer/wizard.ts`
- Database schema and writes: `src/main/db.ts`

<procedure title="First code reading pass" id="first-code-reading-pass">
    <step>
        <p>Read <code>src/main/main.ts</code> to understand app startup, IPC registration, and runtime initialization boundaries.</p>
    </step>
    <step>
        <p>Read <code>src/main/orchestrator.ts</code> to understand request lifecycle, queueing, confirmation, and session expiration behavior.</p>
    </step>
    <step>
        <p>Read service files next (<code>stt.ts</code>, <code>tts.ts</code>, <code>opencode.ts</code>, <code>obsidian.ts</code>, <code>db.ts</code>) for integration details.</p>
    </step>
    <step>
        <p>Then read renderer files (<code>orb.ts</code>, <code>wizard.ts</code>, <code>activity.ts</code>) to connect UX behavior to IPC contracts.</p>
    </step>
</procedure>

<seealso>
    <category ref="related">
        <a href="Architecture-and-runtime-flow.md"/>
        <a href="Renderer-preload-and-ipc.md"/>
        <a href="Setup-wizard-and-runtime-bootstrap.md"/>
    </category>
</seealso>
