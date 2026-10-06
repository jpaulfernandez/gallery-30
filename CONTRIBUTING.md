# Contributing

Thanks for helping. Bug reports, platform fixes (Linux and Windows are untested) and small focused pull
requests are all welcome. For larger changes, open an issue first so we can agree on the approach.

## Setup

Follow [docs/INSTALLATION.md](docs/INSTALLATION.md), then run the editor with `pnpm dev`. To work on
the viewer alone, `pnpm --filter viewer dev` serves it at http://localhost:5173 with generated demo
books, so you need no cloud setup.

## Checks

Run these from the repository root before opening a pull request:

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm lint
```

For changes under `apps/editor/src-tauri`, also run the Rust tests:

```bash
cd apps/editor/src-tauri && cargo test
```

`pnpm format` fixes formatting; `pnpm biome check --write .` also sorts imports.

## Code conventions

- **The Zod schema in `packages/shared/src/schema.ts` is the source of truth** for the project file.
  Use its inferred types (`Book`, `Page`, `PhotoElement`, ...) instead of writing your own. A schema
  change bumps `version` and adds a migration case in `packages/shared/src/migrate.ts`. Read project
  files only through `loadBook` / `parseBook`.
- **Ids are ULIDs** from `newId()`. Never regenerate ids on reorder or duplicate-in-place; likes and the
  download log key on them.
- **Geometry is in fractions of the page**, never pixels: frames, crops, margins, gutters and text sizes.
- `packages/shared` must never import from `apps/*`. The renderer in it runs in the editor (React), the
  viewer (Preact) and the publish CLI (headless Chromium).
- Workspace packages are consumed from source through the `source` export condition, so no prebuild is
  needed in development. Shared code uses `.js` extensions in relative imports so its `dist/` runs in Node.
- Every disk path in the Tauri backend goes through `ensure_allowed` in `src-tauri/src/scope.rs`.
- **Secrets never go into the project file or the repository.** Publish credentials live in the editor's
  settings file; deployment config lives in git-ignored files (`.env.production.local`,
  `wrangler.local.toml`).
- Formatting (Biome): 2 spaces, single quotes, line width 120.

[CLAUDE.md](CLAUDE.md) has the same conventions in a form that AI coding assistants pick up
automatically.

## Design background

[docs/design/](docs/design/) has the original product requirements, the implementation plan and the
editor's UI notes. They explain why things are the way they are; where they disagree with the code, the
code wins.
