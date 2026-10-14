# Photobook

Local Tauri editor that turns a photo folder into a designed book (Library sidebar; Cull · Develop · Design stages;
Publish), plus a publish CLI and a static web viewer. Domain terms (cull, develop, looks, outputs, library, jobs) are
explained in `docs/design/PRD.md`; UI decisions in `docs/design/DESIGN_NOTES.md`.

The editor app is named **oddhalls** (`productName`, the window title, the Home wordmark; plan 43). The repo, the
packages, the crates, the CLI and the bundle identifier `com.photobook.editor` keep the Photobook name; never change
`identifier` (it moves `<appdata>`).

## Where to look

- **Code map** (which file owns which feature, cache and data paths): `docs/CODEMAP.md`. Read the section for the area
  you are touching before changing it, and update it when you move or add a file it names.
- **Plans**: `docs/design/plans/README.md` says what is active and what is next (plan 37, then 38–56).
  `docs/design/plans/IMPLEMENTATION_PLAN_38-56.md` holds the locked decisions, waves and file ownership for 38–56.
  Finished plans in `docs/design/archive/` explain why the code is the way it is.
- **User docs**: `README.md`, `docs/INSTALLATION.md`, `docs/DEVELOP.md`, `docs/PUBLISHING.md`, `docs/ACCOUNTS.md`.
- **Engineering docs**: `docs/design/EDITING.md` (how the develop pipeline works, end to end) and
  `docs/design/DENOISING.md` (the denoise pipeline, measured results, and the Lightroom comparison).

## Packages

- `apps/editor`: Tauri 2 + React 19 + Vite 6 + Tailwind v4 + TanStack Router (code routes in `src/router.tsx`).
  Zustand stores in `src/store/`, typed `invoke` wrappers in `src/lib/tauri.ts` (one per Rust command), Rust commands
  in `src-tauri/src/commands/<area>.rs`, registered in `src-tauri/src/lib.rs` (e.g. `trash_photos` in
  `commands/photos.rs`, plan 42; `haptic` in `commands/haptic.rs`, plan 46, called only through `lib/haptic.ts`;
  `histogram` in `commands/develop/histogram.rs` and `open_map` in `commands/assets.rs`, plan 52).
- `apps/viewer`: Vite + Preact; `preact/compat` stands in for React so the shared renderer runs as-is.
- `apps/site`: static landing page (plain HTML in `public/`, no build). Deploy: `pnpm --filter site run deploy`.
- `packages/shared` (`@photobook/shared`): Zod schema, ids, templates, migrations, fonts, renderer, layouts, publish
  contracts, slideshow and AI pricing.
- `packages/publish` (`@photobook/publish`): Node CLI `photobook publish <project.json> [--dry-run] [--prune]`, also
  `render-slideshow`, `looks` and `stats <folder>` (plan 38, debug).
- `crates/develop` (`photobook-develop`): pure-Rust develop pipeline, no Tauri (see its `README.md`). The root
  `Cargo.toml` workspace holds it and `apps/editor/src-tauri`. Default features: `ai`, `raw`, `heic-imageio`.
- `worker/`: Cloudflare Worker + D1 for likes and the download log. `wrangler.toml` is a template; real deployments use
  the git-ignored `wrangler.local.toml`.

## Commands (from the repo root)

- `pnpm install`
- `pnpm dev`: `tauri dev` for the editor (Vite on port 1420).
- `pnpm typecheck`: `tsc --noEmit` in every package.
- `pnpm lint`: Biome lint + format check (`pnpm format` to fix; `pnpm biome check --write .` for imports too).
- `pnpm build`: builds every package.
- `pnpm test`: every package's tests; `pnpm --filter @photobook/shared test` for the Vitest suite alone.
- `pnpm --filter @photobook/publish photobook publish <file> --dry-run`
- **Rust: cargo is not on PATH in agent shells.** Prefix every cargo command with `source ~/.cargo/env &&`, e.g.
  `source ~/.cargo/env && cd apps/editor/src-tauri && cargo test`.
- `source ~/.cargo/env && cargo test -p photobook-develop` (GPU on; `PHOTOBOOK_FORCE_CPU=1` for the CPU path).
  `cargo check -p photobook-develop --no-default-features` must keep building. Needs cmake; the first build downloads
  ONNX Runtime.

## Invariants (never break these)

- **Disk access**: every path goes through `ensure_allowed` in `src-tauri/src/scope.rs` (an imported root or the app
  data dir). Commands taking a `folder` require exactly one imported root (`ensure_imported_root`). Folders become roots
  only through `add_root`; a project's content never makes a root. An export destination is dialog-picked per session
  and never added as a root.
- **Secrets**: the AI key lives in `<appdata>/ai.env`, is read per call, and never reaches the webview or a project
  file. Publish credentials follow the same pattern.
- **Atomic writes**: project files go through `write_project` (temp + rename, keeps `.bak`; `src-tauri/src/atomic.rs`).
  Every Rust writer in a job writes a temp file and renames it, so a cancelled job leaves no partial file.
- **Deleting photos**: the macOS Trash is the only delete. `trash_photos` (`commands/photos.rs`, plan 42) is the one
  command that removes a photo from a folder: `ensure_imported_root` plus `resolve_rel` and `resolve_in_root` per
  file, the `.xmp` sidecar rule, per-file results. It is reached only through the reject pile's dialog, never a key;
  `dropPhotos` then forgets the files (index, library, store). Never delete a photo or a sidecar any other way.
- **Schema**: `packages/shared/src/schema.ts` (Zod) is the source of truth. Use the inferred types (`Book`, `Page`,
  `PhotoElement`, ...), never hand-written duplicates. A schema change bumps `CURRENT_VERSION` (now 8) and adds a `case`
  in `packages/shared/src/migrate.ts`. Read books only with `loadBook` / `parseBook`.
- **Ids** are ULIDs from `newId()`. Never regenerate them on reorder or duplicate-in-place; likes and the download log
  key on them.
- **Develop engine**: the develop hash (SHA-256 of canonical settings JSON + engine version) keys every cache and render
  file. When any render maths changes, bump `DEVELOP_ENGINE_VERSION` (`packages/shared/src/develop/schema.ts`) and
  `ENGINE_VERSION` (`crates/develop/src/lib.rs`) together, and regenerate the fixtures:
  `UPDATE_DEVELOP_FIXTURES=1 pnpm --filter @photobook/shared test` and
  `UPDATE_GEOMETRY_FIXTURES=1 cargo test -p photobook-develop --test geometry`. The CPU path is the reference; the GPU
  must match it (`tests/gpu.rs`). The engine is `develop-engine/4` (plan 55, the one bump of plans 38–56: per-wheel
  grading luminance and the Global wheel, which run in the `develop_wheels` GPU pipeline so settings without them
  keep `/3`'s pixels byte for byte; `tests/engine_bump.rs` checks that on the ON1 samples). Preview modes (focus peak, zebra:
  `preview_modes.rs`, plan 53) are drawn over a preview's 8-bit output and stay outside the develop hash and every cache.
- **Library data** (ratings, flags, develop settings) lives in `<folder>/.photobook/library.json`, not the project.
  Write through the book store actions (they call `writePhotoFields`); read with `assetDevelop` / `assetRating` /
  `assetFlag` / `resolvedAssets` / `libraryBook` (`store/library.ts`), never straight from `book.assets[id]`. Develop
  resolves through `resolveAssetDevelop` (`packages/shared/src/library.ts`).
- **Index fields** (plans 38, 52, 56): `<folder>/.photobook/index.json` stays version 1. Capture facts and stats
  (`taken`, `make`, `model`, `lens`, `focal`, `phash`, `stats`; plan 52's `shutter`, `aperture`, `gps { lat, lon }`;
  plan 56's `palette`, five sRGB hex colours, `FACTS_VERSION` 3) are one optional set, `PhotoFacts` (`commands/assets.rs`, `lib/tauri.ts`), flattened into
  `IndexEntry`, `ScannedFile`, `AssetInfo` and `PhotoFile`. A new field goes there,
  into `facts_of` and the `cached()` backfill (bump `FACTS_VERSION` when it comes from the Exif), and into
  `PHOTO_FACT_KEYS` (`store/library.ts`), nowhere else. Stats (`crates/develop/src/stats.rs`) are not render maths: no
  engine bump. Sort by capture time with `captureTime` (`taken`, else mtime).
- **Cull groups** (plan 39): computed on the fly, never stored (`groupPhotos` in `packages/shared/src/cull/groups.ts`,
  `store/cull.ts`); only the overrides `photos[hash].cull.group` are library data, written outside undo. Cull's
  filter-bar controls live in the `components/cull/CullFilters.tsx` fragment.
- **Decide** (plan 40): flags (Keep / Reject / Undecided) are never undo steps; the pass has its own log
  (`ui.cull.decide`, `store/decide.ts`). The folder's `cull.target` / `culledAt` are library top-level fields, written
  with `patchLibrary` outside undo.
- **Lenses** (plan 41): a lens (`packages/shared/src/cull/lenses.ts`, `FilmstripView.lens` in `store/ui.ts`) only
  filters, sorts and badges from the index stats; it never writes a flag or any library field.
- **Publish surface**: `outputs`, `page.guides` and notes never reach the manifest or the fingerprint.
- **AI models**: permissive licences only (MIT, Apache-2.0, BSD), pinned with `url`, `bytes`, `sha256` in
  `crates/develop/models.toml`. Nothing is bundled.

## Conventions

- Frames, crops, margins, gutters and text sizes are fractions of the page, never pixels.
- Editor colour, radius, shadow and duration come only from the tokens in `apps/editor/src/styles.css` (plan 44);
  `pnpm lint` fails on a Tailwind palette class. Check skin changes in the `/fixture` Kitchen sink
  (`#/fixture?tab=sink`), which renders under Vite alone (`editor-web`), no Tauri.
- Editor controls come only from `apps/editor/src/components/ui` (plan 45: `Button`, `Menu`/`Menu.Context`, `Field`,
  `Toast`, `DialogShell`, …); `pnpm lint` fails on a hand-drawn `<button>` with `rounded-md border border-line`.
- `packages/shared` (especially the renderer) never imports from `apps/*`.
- Workspace packages are consumed from source via the `source` export condition (`customConditions` in
  `tsconfig.base.json`, `resolve.conditions` in the Vite configs, `tsx --conditions=source` in the CLI), so no prebuild
  is needed in dev. Shared source uses `.js` extensions in relative imports so its `dist/` runs in Node.
- Keep `dragDropEnabled: false` on the Tauri window; native file drop breaks HTML5/dnd-kit drag.
- Native shell (plan 43): `user-select: none` everywhere except `input, textarea, [contenteditable], .selectable`;
  `data-tauri-drag-region` only on a top bar itself, never its controls; scroll containers use the `scrollbar`
  utility. The native menu bar (`src-tauri/src/menu.rs`, `set_text_focus`) owns the accelerators only with
  `VITE_PHOTOBOOK_NATIVE_MENU=1`, until the owner checks that no key fires twice (removal steps in plan 49's Status).
- Motion and polish (plan 49): durations only through the `--dur-*` tokens (zero under reduced motion, checked by
  `KitchenSink.test.tsx`); every icon-only button has a `Tooltip` (`components/ui/iconButtons.test.ts`); empty states
  use `ui/EmptyState`.
- Tauri commands return `Result<T, crate::error::Error>`; errors reach JS as plain strings. Add the matching wrapper in
  `src/lib/tauri.ts`.
- Long work runs as a job (`enqueue` in `src/store/jobs.ts`), never inline. Lanes: GPU (renders + denoise), publish,
  exports (2).
- Biome: 2 spaces, single quotes, width 120. Run `pnpm lint` and `pnpm typecheck` before finishing.
- A finished plan gets a `Status:` line under its title and moves to `docs/design/archive/plans/`.

## Working rules

Adapted from Karpathy's guidelines for LLM coding. Caution over speed.

1. **Think before coding.** State assumptions. If the request has two readings, name them and pick one, or ask when
   the readings lead to different work. If a simpler approach exists, say so before building the asked one.
2. **Simplicity first.** No features beyond what was asked. No abstractions for single-use code. No configurability
   nobody asked for. No error handling for impossible cases. If 200 lines could be 50, write 50.
3. **Surgical changes.** Touch only what the task needs. Match existing style. Do not refactor or "improve" adjacent
   code. Remove imports, variables and functions that your change made unused; leave pre-existing dead code alone
   unless asked.
4. **Goal-driven execution.** Turn the task into a check before starting: a failing test, a typecheck, a command whose
   output proves it. For multi-step work, state the plan with one check per step. Done means the check passed.

## Orchestration (main session only)

> If you are a subagent, ignore this section and follow your own instructions.

The main session plans, delegates, integrates and decides. It does not do token-heavy work itself.

| Work                                      | Delegate to                            | Model  |
| ----------------------------------------- | -------------------------------------- | ------ |
| Finding files, symbols, call sites        | `scout` (prefer over built-in Explore) | Sonnet |
| External docs, library APIs, versions     | `doc-researcher`                       | Sonnet |
| Design, task breakdown, hard bugs         | `architect`                            | Opus   |
| Writing/changing code for one clear task  | `implementer`                          | Sonnet |
| Running tests/lint/build                  | `test-runner`                          | Sonnet |
| Reviewing the diff before calling it done | `reviewer`                             | Opus   |

### Default flow for non-trivial changes

1. `scout` to locate the code; point it at the relevant `docs/CODEMAP.md` section.
2. `architect` first when the change touches any of: the Zod schema or migrations, render maths or the engine version,
   `scope.rs` or any disk-path handling, Rust command signatures, the job queue, the publish contract, or more than
   2 files.
3. One `implementer` per task. Parallel only when tasks own different files (follow the file-ownership table in
   `IMPLEMENTATION_PLAN_38-56.md` when working on plans 38–56).
4. `test-runner` with the narrowest relevant check, then `pnpm typecheck && pnpm lint`.
5. `reviewer` on the final diff, given the original goal and the Invariants list above.
6. Fix Critical/Should-fix findings via `implementer`, then re-run `test-runner`.

### Delegation rules

- Subagents start with no history, and `scout`, `test-runner` and `doc-researcher` do not read this file. Every
  delegation includes: goal, exact file paths, constraints, the "done when" check, and any invariant from this file
  that the task touches.
- **Caveman voice both ways.** Subagents report in caveman voice (set in `.claude/agents/*.md`, rules in
  `.claude/skills/caveman/SKILL.md`). Write delegation prompts the same way: lists of goal, files, constraints and
  check, no narrative. Replies to the user follow the user's current mode (`/caveman` toggles it).
- Ask for summaries, not dumps. Do one-line fixes yourself.
- If a Sonnet worker fails the same task twice, re-plan with `architect` or do it yourself.
- Never let two implementers edit the same file at once.
- Verify claims that matter (re-run the key test) before reporting done.
