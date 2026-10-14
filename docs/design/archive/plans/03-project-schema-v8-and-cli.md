# 03 · Project schema v8, migration, CLI resolution

Status: done 2026-10-12. The editor keeps the rating/flag/develop mirror in memory (undo relies on it) and strips it in
TS when saving (`bookForDisk`), not in the Rust `write_book`; the `social` output declares `frames` (default `[]`) so
the dangling-id check has something to check; `asset.alt` and the full `BriefSchema` shape (plan 34) were added too.

WORKFLOW_PLAN [1.3](../WORKFLOW_PLAN.md#13-how-displays-fit-the-schema), [11.2](../WORKFLOW_PLAN.md#112-proposal),
[12.6](../WORKFLOW_PLAN.md#126-schema), [14.2](../WORKFLOW_PLAN.md#142-what-a-project-references-when-a-photo-is-edited),
[14.6](../WORKFLOW_PLAN.md#146-migration-from-todays-files). Size: 2 days. Depends on: 02.

**Goal.** One schema bump carries every field the workflow needs, so no later plan touches `version` again. The
project references photos by hash and folder; the CLI resolves edits through the library.

## Decisions

- Book v8 fields:
  - `folders: Record<id, { path: string }>` replaces `sourceFolder`.
  - `assets[id]`: `path`, `hash` (still optional in the schema: scans hash lazily; plan 05 guarantees it before a
    photo joins a project), `folder` (id into `folders`), `version?`, `publishedDh?`, `developSnapshot?`; `rating`,
    `flag`, `develop` stay optional and are documented as legacy (lifted into the library on open, stripped on save).
  - `outputs: z.array(OutputSchema).default([])` with `OutputSchema` a discriminated union on `kind`; only the
    `social` and `print` variants are declared now (plans 14, 15 fill them in), both minimal `{ id, name, createdAt, kind }`.
  - `captions: z.object({ brief: BriefSchema.optional() }).default({})`.
  - `PageSchema.guides: z.array(z.object({ axis: z.enum(['x','y']), value: z.number() })).default([])`.
  - The field is `outputs` (decided, README *Names*); the source plan's `displays` is not used anywhere.
- Resolution order everywhere: `developSnapshot` → library (master or `version`) → legacy `develop` → unedited.
- The book file location does not move in this plan (still `<folder>/book.photobook.json`); plan 04 moves it.

## Steps

1. **Schema.** `packages/shared/src/schema.ts`: fields above; `CURRENT_VERSION = 8`; docs on each field; the
   dangling-id refinement also checks `outputs[].frames` and every `folder` id. `book.ts` `createEmptyBook({ title, folders })`.
2. **Migration.** `migrate.ts` case 7 → 8: `sourceFolder` → one folder entry (`newId()`), every asset gets that
   `folder`; `outputs: []`, `captions: {}`, `guides: []` on pages. Pure. Vitest with a v7 fixture, plus "v8 parses
   unchanged" and "develop hash of a migrated asset unchanged".
3. **Shared resolution.** `packages/shared/src/library.ts` gains `resolveAssetDevelop(asset, library?)` implementing the
   order above. Used by the editor and the CLI.
4. **CLI.** `packages/publish/src/freeze.ts` and `paths.ts`: asset path = `folders[asset.folder].path` joined with
   `asset.path` (a relative folder path is relative to the project file); read each folder's `library.json` once;
   `images.ts`/`pages.ts` consume the resolved develop. Fingerprint unchanged (it hashes the resolved settings).
   `fixtures/make.ts` emits v8. `publish.test.ts`, `pages.test.ts` updated.
5. **Editor.** `store/book.ts`: `loadFromFolder` migrates, lifts legacy fields into the library (02), and `write_book`
   strips `rating/flag/develop` from the saved JSON. `store/assets.ts`, `relink.ts`, `developPublish.ts`, the resolver
   and `preview/resolve.ts` read through `resolveAssetDevelop`. The `folder` id replaces `book.sourceFolder` in every
   command call (one folder for now).
6. **Viewer and worker.** Confirm neither reads the project file (they consume the manifest); no change expected.

## Check

- Vitest: migration, parity fixtures unchanged, publish fixtures; `pnpm typecheck`, `pnpm lint`.
- `pnpm --filter @photobook/publish photobook publish <v7 project> --dry-run` after the editor migrated it: same keys
  as before the migration for edited photos.
- Open a v7 book in the editor: saves as v8, the saved file has no `rating/flag/develop`, reopening shows the edits.

## Docs

- `CLAUDE.md` Conventions ("The book `version` is 8"); `docs/PUBLISHING.md` on folders in the project file.

## Out of scope

Projects in app data and Home (04), outputs UI (13), captions UI (34), guides UI (31).
