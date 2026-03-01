# Troubleshooting and debugging

This page is a practical runbook for common issues when developing or running the app.

## Quick diagnostics first

Start with these commands:

```bash
npm run build
npm run test:config-page
npm run test:models
```

Then open Activity window from orb UI to inspect latest timeline events.

## Common issues

| Symptom | Likely cause | Where to inspect |
|---|---|---|
| OpenCode verification fails | Sidecar not running, wrong URL, auth mismatch | `src/main/main.ts` sidecar start logic, `src/main/opencode.ts` health/model fallbacks |
| Whisper probe fails | Binary path invalid, CLI missing from PATH, build not completed | `src/main/whisper-path.ts`, wizard runtime precheck output |
| STT does not transcribe | Missing model path or runtime command failure | `src/main/stt.ts`, activity events for `stt_error` |
| TTS generation fails | Python path bad, deps missing, model dir invalid | `src/main/tts.ts`, `runtime/qwen_tts.py`, runtime precheck missing list |
| Global hotkeys not working | Shortcut conflict or OS permissions | hotkey warning dialog in main process, macOS Accessibility permissions |
| Save in wizard fails | Runtime not ready or OpenCode verify did not pass | `src/renderer/wizard.ts` readiness gates |
| No events in Activity panel | Database not initialized or no session created yet | `src/main/db.ts`, `activity:list` IPC handler |

## OpenCode-specific checks

- Confirm sidecar health endpoint responds: `%default_opencode_url%/global/health`
- Confirm wizard Base URL matches actual server host/port.
- If auth enabled, confirm username/password pair is correct.
- Check activity log for `agent_failure` and `agent_error` messages.

## Whisper-specific checks

- Verify binary can execute `-h`.
- Verify model file exists and is non-empty.
- For Windows, confirm `.exe` path resolution or auto setup output path.
- If GPU mode is forced, switch to `auto` or `cpu` for diagnosis.

## TTS-specific checks

- Verify Python executable runs `--version`.
- Verify dependency import: `python -c "import qwen_tts, soundfile"`
- Confirm model directory contains artifacts (`.safetensors`, tokenizer files).
- Confirm runtime script path points to `qwen_tts.py` in packaged or dev location.

## Fallback behavior debugging

If CLI actions fail but fallback is enabled, inspect:

- request events for `fallback_used` or `fallback_failed`
- command_runs rows with `stage='app_fallback'`

If fallback also fails, error usually points to vault path, missing source file, or invalid target path.

## Session behavior debugging

- Unexpected session ending after open-note is expected by design.
- Session expiry after inactivity is controlled by `idleSessionExpiryMs`.
- Confirmation not accepted can happen if utterance does not match yes/no regex patterns.

## Collecting a useful bug report

<procedure title="Capture actionable diagnostics" id="capture-actionable-diagnostics">
    <step>
        <p>Record the exact user action and timestamp.</p>
    </step>
    <step>
        <p>Copy relevant Activity rows (type, message, payload tooltip).</p>
    </step>
    <step>
        <p>Run the failing command directly if possible (whisper help, python import, runtime tests).</p>
    </step>
    <step>
        <p>Attach environment overrides used during testing and current config values (excluding secrets).</p>
    </step>
    <step>
        <p>Include OS, hardware mode (GPU/CPU), and whether app is packaged or running from source.</p>
    </step>
</procedure>

<seealso>
    <category ref="related">
        <a href="Setup-wizard-and-runtime-bootstrap.md"/>
        <a href="Testing-and-validation.md"/>
        <a href="Database-and-observability.md"/>
    </category>
</seealso>
