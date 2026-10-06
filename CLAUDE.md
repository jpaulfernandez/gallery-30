# Photobook

Local Tauri editor that turns a photo folder into a designed book, plus a publish CLI and a static
web viewer. User docs: `README.md`, `docs/INSTALLATION.md`, `docs/ACCOUNTS.md`, `docs/PUBLISHING.md`.
Design background: `docs/design/PRD.md`, `docs/design/IMPLEMENTATION_PLAN.md` (steps) and `docs/design/DESIGN_NOTES.md` (UI).

## Layout

- `apps/editor` (`editor`): Tauri 2 + React 19 + Vite 6 + Tailwind v4 + TanStack Router (code routes in `src/router.tsx`).
  - `src/store/book.ts` Zustand store; `src/lib/tauri.ts` typed `invoke` wrappers (one per Rust command).
  - `src-tauri/src/lib.rs` registers plugins and commands; commands live in `src-tauri/src/commands/<area>.rs`.
  - `src-tauri/src/scope.rs`: every disk path goes through `ensure_allowed` (source folder or app data dir only);
    commands taking the book `folder` require it to be exactly the open root (`ensure_source_root`).
- `apps/viewer` (`viewer`): Vite + Preact; `preact/compat` stands in for React so the shared renderer runs as-is.
- `packages/shared` (`@photobook/shared`): Zod schema, ids, book templates, migrations, fonts, renderer, layouts, publish contracts.
- `packages/publish` (`@photobook/publish`): Node CLI `photobook publish <project.json> [--dry-run] [--prune]`.
- `worker/` (`@photobook/worker`): Cloudflare Worker + D1 for likes and the download log. `wrangler.toml` is a
  template; real deployments use the git-ignored `wrangler.local.toml`.

## Commands (from the repo root)

- `pnpm install`
- `pnpm dev`: runs `tauri dev` for the editor (Vite on port 1420).
- `pnpm typecheck`: `tsc --noEmit` in every package.
- `pnpm lint`: Biome lint + format check (`pnpm format` to fix; `pnpm biome check --write .` for imports too).
- `pnpm build`: builds every package (`shared` to `dist/`, the apps with Vite).
- `pnpm --filter @photobook/shared test`: Vitest.
- `pnpm --filter @photobook/publish photobook publish <file> --dry-run`
- Rust: cargo is not on PATH in agent shells. Prefix with `source ~/.cargo/env &&`, e.g.
  `source ~/.cargo/env && cd apps/editor/src-tauri && cargo build` (or `cargo test`).

## Conventions

- The Zod schema in `packages/shared/src/schema.ts` is the source of truth. Never hand-write a type that
  duplicates it; use the inferred types (`Book`, `Page`, `PhotoElement`, ...). Schema changes bump
  `version` and add a `case` in `src/migrate.ts`. Always read files with `loadBook`/`parseBook`.
- Ids are ULIDs from `newId()` (ulidx). Never regenerate ids on reorder or duplicate-in-place;
  likes and the download log key on them.
- Frames, crops, margins, gutters and text sizes are fractions of the page, never pixels.
- Code in `packages/shared` (especially the renderer) must never import from `apps/*`.
- Workspace packages are consumed from source via the `source` export condition
  (`customConditions` in `tsconfig.base.json`, `resolve.conditions` in the Vite configs,
  `tsx --conditions=source` in the CLI), so no prebuild is needed in dev.
- Shared source uses `.js` extensions in relative imports so its `dist/` runs in Node.
- Keep `dragDropEnabled: false` on the Tauri window; native file drop breaks HTML5/dnd-kit drag.
- Project file writes go through `write_book` (temp file + rename, previous version kept as `book.photobook.json.bak`).
  Secrets never go in the project file. Assets missing on open are relinked by size + hash (`store/relink.ts`), keeping
  their ids; the rest show as Missing in the filmstrip with a Locate action when a page uses them, and are dropped
  from `book.assets` otherwise.
- Tauri commands return `Result<T, crate::error::Error>`; errors reach JS as plain strings.
- Biome formats: 2 spaces, single quotes, width 120. Run `pnpm lint` before finishing.
