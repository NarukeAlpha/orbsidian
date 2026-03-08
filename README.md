# Orbsidian (v1)

Voice-first desktop app for Obsidian with local STT/TTS and OpenCode agent sessions.

Bit of an update, the vision is clear but the executionw as very underwhelming. 
Ill continue to itterate with agents and find a sweetspot in terms of steering the models 
in the direction I feel comfortalbe with. 

Also starting to believe all these md's supposedly for human consumption or even agent consumption
are just useless? a lot to read for very little reward. 

Pending tasks:

- [ ] refactor code
- make it more efficient
- use effect in ts
- clean up electron app
- add physical chat optional

- [ ] redo configuration
- it should be both more persistant and more deterministic
- it should assume more during install but be configurable after

- [ ] redo electron window code specfically
- the file where electron is written is a mess

- [ ] implement tests for models / python script
- find if we can wrap the models usage without python in ts or go or just something not python
- be more clear of model usage.


Below is the 5.3 codex description of the project, not written manually. 

## What it does

- Global hotkey opens a floating orb and starts listening.
- Speech is transcribed locally with `whisper.cpp`.
- Transcript is sent to a persistent OpenCode session for agentic note actions.
- Agent uses Obsidian CLI first; app falls back to direct vault file ops when needed.
- Optional local TTS reads back status and note content.
- Full activity and command logs are stored in local SQLite.

## Stack

- Electron + TypeScript
- SQLite (`sql.js`)
- OpenCode SDK (`@opencode-ai/sdk`)
- Local STT: `whisper.cpp`
- Local TTS: `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` through `runtime/qwen_tts.py`

## Prerequisites

- Node.js 20+
- Obsidian installed, running, CLI enabled
- `whisper.cpp` binary available on your system
- Python environment for TTS with:
  - `qwen-tts`
  - `soundfile`
  - `torch`
- OpenCode CLI installed (`opencode` on PATH)
  - Orbsidian starts a managed OpenCode sidecar on `http://127.0.0.1:44096`

## Install and run

```bash
npm install
npm run start
```

Open setup/config again anytime:

```bash
npm run config
```

Packaged app command-line reopen:

```bash
orbsidian config
```

On first run, complete the setup wizard:

1. Select vault path and Obsidian CLI command.
2. Run **Auto Setup Voice Runtime**.
   - Clones and builds `ggml-org/whisper.cpp`
   - Downloads whisper model (`ggml-base.en.bin`)
   - Creates a Python virtual environment
   - Installs TTS dependencies (`torch`, `qwen-tts`, `soundfile`)
   - Downloads `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`
3. Configure OpenCode endpoint and verify connectivity.
4. Save and start.

## Verify local voice models

After runtime setup is complete, run the smoke test to confirm STT/TTS models are present and can run inference:

```bash
npm run test:models
```

If your runtime lives in custom locations, see env overrides in `Test/README.md`.

## Hotkeys (default)

- Listen toggle: `Cmd/Ctrl+Shift+Space`
- TTS skip chunk: `Cmd/Ctrl+Shift+]`
- TTS interrupt: `Cmd/Ctrl+Shift+\`

## Build installers

```bash
npm run dist
```

Targets:

- macOS: `dmg`
- Windows: `nsis`

## Codebase docs (Writerside)

Thorough codebase documentation is in `Writerside/`.

- Start page: `Writerside/topics/Overview.md`
- TOC: `Writerside/orbsidian.tree`
- Module config: `Writerside/writerside.cfg`
- GitHub Pages workflow: `.github/workflows/build-docs.yml`
