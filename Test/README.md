# Playwright setup and voice runtime tests

This folder contains a small Playwright test environment for the setup/configuration page (`wizard.html`).

## What it tests

- Auto setup flow populates STT/TTS runtime fields.
- OpenCode verification loads model options.
- Saving config persists the selected provider/model pair.
- Dedicated voice runtime smoke tests verify local STT/TTS models are installed and can serve real requests.

Configuration page specs mock the preload API (`window.orbsidian`) so they run quickly and do not trigger real runtime installs. The voice runtime smoke suite runs real local STT/TTS commands.

## Commands

- Install browser once:
  - `npm run test:config-page:install`
- Run tests:
  - `npm run test:config-page`
- Run headed:
  - `npm run test:config-page:headed`
- Run runtime verification (real STT/TTS inference):
  - `npm run test:models`
  - or `npm run test:voice-runtime` (build + runtime tests)

## Voice runtime env overrides

Use these when your runtime is installed in custom paths:

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
- `ORBSIDIAN_TTS_DEVICE` (`auto`, `cuda`, `mps`, `cpu`)
- `ORBSIDIAN_TTS_TEST_TEXT`

## Artifacts

- HTML report: `Test/playwright-report/`
- Failure artifacts: `Test/test-results/`
