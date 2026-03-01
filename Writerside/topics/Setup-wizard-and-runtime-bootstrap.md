# Setup wizard and runtime bootstrap

This page explains first-run setup behavior and the runtime installer internals so you can troubleshoot or extend onboarding safely.

## When the wizard opens

The setup wizard opens when:

- No config file exists yet.
- Config load fails.
- App is launched with `config`, `--config`, or `-c` argument.

This logic is handled in `src/main/main.ts`.

## Wizard responsibilities

The wizard (`src/renderer/wizard.ts`) guides users through:

1. Vault and Obsidian CLI path.
2. Local STT/TTS runtime readiness.
3. Hotkey customization.
4. OpenCode connection and model selection.
5. Config save + runtime restart.

## Runtime precheck behavior

Before forcing installation, wizard runs `wizard:precheck-runtime`.

Precheck validates:

- Whisper binary resolution and executability.
- Whisper model file existence.
- Python command availability.
- Python dependency import check (`qwen_tts`, `soundfile`).
- Qwen model artifact existence.
- Runtime script (`qwen_tts.py`) existence.

Result returns normalized paths and a precise `missing[]` list used for inline status messaging.

## Auto setup workflow

Auto setup is implemented in `src/main/voice-runtime-setup.ts`.

### Stage breakdown

1. Prime known Windows tool locations into process PATH.
2. Ensure dependency `git` is available (auto-install if missing).
3. Ensure dependency `cmake` is available (auto-install if missing).
4. Detect or install Python command.
5. Clone/update `ggml-org/whisper.cpp`.
6. Configure and build whisper CLI (GPU preferred, CPU fallback).
7. Download `ggml-base.en.bin` model.
8. Create Python virtual env for TTS.
9. Install Python packages (`pip`, `torch`, `qwen-tts`, `soundfile`).
10. Download `Qwen3-TTS-Tokenizer-12Hz` and `Qwen3-TTS-12Hz-1.7B-CustomVoice`.

Progress is streamed back to the wizard via runtime and download progress IPC channels.

## Dependency installation strategy

Installer can attempt package manager installs for missing tools:

- Windows: `winget`
- macOS: `brew`
- Linux: no automatic system package install path currently

When auto install cannot complete, setup returns actionable stage-specific errors.

## Model download strategy

Whisper model is downloaded directly from Hugging Face URL.

Qwen model download uses `huggingface_hub` with fallback sequence:

- try CLI binaries (`hf`, `huggingface-cli` variants)
- fallback to Python API `snapshot_download()`

Downloads are idempotent and skip already-present artifacts.

## Save flow and runtime restart

When user clicks Save:

- wizard builds normalized config payload
- main validates required fields
- config is merged with defaults and persisted
- runtime is restarted with new config
- wizard window closes if restart succeeded

This means Save is not only persistence; it is a full runtime reconfiguration transaction.

<procedure title="First-run success checklist" id="first-run-success-checklist">
    <step>
        <p>Run auto setup and wait until runtime message reports ready.</p>
    </step>
    <step>
        <p>Test Obsidian CLI and Whisper binary from wizard buttons.</p>
    </step>
    <step>
        <p>Verify OpenCode and confirm model list populates.</p>
    </step>
    <step>
        <p>Save config and confirm orb window enters idle state.</p>
    </step>
    <step>
        <p>Run <code>npm run test:models</code> to validate local STT/TTS inference end to end.</p>
    </step>
</procedure>

<seealso>
    <category ref="related">
        <a href="Voice-runtime-services.md"/>
        <a href="Testing-and-validation.md"/>
        <a href="Troubleshooting-and-debugging.md"/>
    </category>
</seealso>
