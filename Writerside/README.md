# Writerside module

This directory contains the codebase documentation in Writerside format.

## Important files

- `writerside.cfg` - module config
- `orbsidian.tree` - table of contents and start page
- `topics/*.md` - documentation content
- `v.list` - reusable variables
- `c.list` - see-also category definitions

## GitHub Pages publishing

Publishing is automated by `.github/workflows/build-docs.yml`.

If you rename the repository, update:

1. `Writerside/writerside.cfg` -> `<images ... web-path="..."/>`
2. `.github/workflows/build-docs.yml` -> `INSTANCE` only if module or tree id changes

## Local editing

Use IntelliJ IDEA with the Writerside plugin for the best authoring experience (preview, inspections, TOC tools).
