# Testing and validation

The project uses Playwright for both UI behavior checks and real runtime smoke tests.

## Test suites

### Configuration page suite (mocked)

- Config file: `Test/playwright.config.ts`
- Spec file: `Test/specs/configuration-page.spec.ts`
- Test mode: fast UI tests with mocked preload API (`window.orbsidian`)

This suite validates setup page behavior without running real installers or model inference.

Covered scenarios include:

- Runtime precheck messaging and auto setup button state.
- OpenCode verification and model dropdown population.
- Config save payload correctness (including provider/model selection).

### Voice runtime smoke suite (real local runtime)

- Config file: `Test/playwright.voice-runtime.config.ts`
- Spec file: `Test/specs/voice-runtime.spec.ts`
- Test mode: serial, long-timeout, executes real local STT/TTS commands

This suite validates that local runtime can actually run inference:

- Whisper help probe and transcription smoke test.
- Python dependency probe (`qwen_tts`, `soundfile`).
- Qwen generation smoke test to produce WAV output.

## Commands

Use these commands from repo root:

```bash
npm run build
npm run test:config-page
npm run test:models
```

Additional convenience commands:

- `npm run test:config-page:headed`
- `npm run test:config-page:install`
- `npm run test:voice-runtime` (build + runtime suite)

## Runtime path overrides for smoke tests

`voice-runtime.spec.ts` can discover paths from config automatically, but environment overrides are available when needed:

- `ORBSIDIAN_CONFIG_PATH`
- `ORBSIDIAN_USER_DATA_PATH`
- `ORBSIDIAN_MODELS_ROOT`
- `ORBSIDIAN_STT_BINARY_PATH`
- `ORBSIDIAN_STT_MODEL_PATH`
- `ORBSIDIAN_TTS_PYTHON_PATH`
- `ORBSIDIAN_TTS_MODEL_PATH`
- `ORBSIDIAN_TTS_RUNTIME_SCRIPT_PATH`
- `ORBSIDIAN_TTS_SPEAKER`
- `ORBSIDIAN_TTS_LANGUAGE`
- `ORBSIDIAN_TTS_DEVICE`
- `ORBSIDIAN_TTS_TEST_TEXT`

## Artifacts and reports

Playwright outputs:

- HTML reports under `Test/playwright-report/`
- failure traces/screens/videos under `Test/test-results/`

These artifacts are useful when debugging CI-only or machine-specific failures.

## Practical validation strategy

Use this sequence before pushing larger changes:

1. `npm run build`
2. `npm run test:config-page`
3. `npm run test:models` (when touching runtime setup, STT, TTS, or model paths)

## How to add tests safely

- Extend mocked wizard tests for UI and payload behavior changes.
- Extend runtime smoke tests only when behavior truly requires real process execution.
- Keep runtime tests serial and explicit about diagnostics to avoid flaky failures.

<seealso>
    <category ref="related">
        <a href="Setup-wizard-and-runtime-bootstrap.md"/>
        <a href="Voice-runtime-services.md"/>
        <a href="Troubleshooting-and-debugging.md"/>
    </category>
</seealso>
