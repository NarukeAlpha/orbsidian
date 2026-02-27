# Playwright config page tests

This folder contains a small Playwright test environment for the setup/configuration page (`wizard.html`).

## What it tests

- Auto setup flow populates STT/TTS runtime fields.
- OpenCode verification loads model options.
- Saving config persists the selected provider/model pair.

The tests mock the preload API (`window.orbsidian`) so they run quickly and do not trigger real runtime installs.

## Commands

- Install browser once:
  - `npm run test:config-page:install`
- Run tests:
  - `npm run test:config-page`
- Run headed:
  - `npm run test:config-page:headed`

## Artifacts

- HTML report: `Test/playwright-report/`
- Failure artifacts: `Test/test-results/`
