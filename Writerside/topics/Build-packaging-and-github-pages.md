# Build, packaging, and GitHub Pages

This page covers both application build/release flow and documentation publication flow.

## Application build pipeline

Build scripts are defined in `package.json`:

| Command | Purpose |
|---|---|
| `npm run build` | Clean + compile main/preload/renderer TypeScript + copy renderer assets |
| `npm run start` | Build then launch Electron app |
| `npm run config` | Build then launch app in config mode |
| `npm run dist` | Build then package installers via electron-builder |

`scripts/copy-assets.mjs` ensures non-TS renderer assets (`.html`, `.css`) are copied to `dist/renderer`.

## Packaging targets

`electron-builder` config in `package.json` produces:

- macOS `dmg`
- Windows `nsis`

Runtime files under `runtime/` are bundled and unpacked where needed (for Python script and sql.js wasm behavior).

## Writerside documentation module

Documentation sources are in `Writerside/`:

- `writerside.cfg` - module config
- `orbsidian.tree` - table of contents
- `topics/*.md` - content pages
- `v.list`, `c.list` - variables and see-also categories

## GitHub Pages deployment workflow

A ready-to-use workflow is included at:

- `.github/workflows/build-docs.yml`

The workflow runs three jobs:

1. **build**: build docs with `JetBrains/writerside-github-action`
2. **test**: validate `report.json` with `JetBrains/writerside-checker-action`
3. **deploy**: unzip generated site and deploy to GitHub Pages

## Required repository settings

To publish to Pages:

1. Open repository Settings -> Pages.
2. Set Source to **GitHub Actions**.
3. Push to `main` (or run workflow manually).

## Workflow parameters you may need to change

In `.github/workflows/build-docs.yml`:

- `INSTANCE`: should be `Writerside/orbsidian` unless you rename module or tree id.
- `DOCKER_VERSION`: Writerside builder version used in CI.

In `Writerside/writerside.cfg`:

- `<images ... web-path="obsidian-agentic"/>` should match your GitHub repository name for correct image URLs on Pages.

## Local docs authoring workflow

Recommended local docs loop:

1. Open project in IntelliJ IDEA with Writerside plugin.
2. Edit `Writerside/topics/*.md`.
3. Use Writerside preview/inspections.
4. Commit docs changes and let GitHub Actions publish.

## Release checklist for app + docs

- Build app: `npm run build`
- Run tests: `npm run test:config-page` and `npm run test:models`
- Build installers: `npm run dist`
- Confirm docs workflow passes and Pages URL is updated

<seealso>
    <category ref="related">
        <a href="Testing-and-validation.md"/>
        <a href="Troubleshooting-and-debugging.md"/>
    </category>
    <category ref="external">
        <a href="https://www.jetbrains.com/help/writerside/deploy-docs-to-github-pages.html">Writerside GitHub Pages guide</a>
        <a href="https://github.com/JetBrains/writerside-github-action">Writerside GitHub Action</a>
    </category>
</seealso>
