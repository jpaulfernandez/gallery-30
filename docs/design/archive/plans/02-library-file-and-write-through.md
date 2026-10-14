# 02 · Library file and write-through

Status: done 2026-10-12

WORKFLOW_PLAN [2.2](../WORKFLOW_PLAN.md#22-where-do-edits-live-when-two-projects-share-a-folder),
[14](../WORKFLOW_PLAN.md#14-the-three-layers). Size: 2 days. Depends on: 01.

**Goal.** Ratings, flags and develop settings live in `<folder>/.photobook/library.json`, keyed by content hash, and
survive deleting the project file. The book keeps mirroring them for now (v7 schema untouched); plan 03 drops the mirror.

## Decisions

- `LibrarySchema` v1: `{ version: 1, photos: Record<hash, { rating?, flag?, develop?, versions: Record<id, { name, develop }> }> }`.
  `versions` is parsed now and used from plan 08. An `ai` slot per photo is added in plan 33.
- The library is the source of truth on open: a library entry wins over the book's fields; a book field with no
  library entry is lifted into the library (needs the folder, so it happens in `loadFromFolder`, not `migrate.ts`).
- Undo covers library edits: the book store's zundo `temporal` partializes `{ book, libraries }`.
- Writes: temp file and rename with `.bak`, like `write_book`. One app instance; no locking.

## Steps

1. **Shared.** `packages/shared/src/library.ts`: `LibrarySchema`, `Library`, `LibraryPhoto`, `LIBRARY_FILE = '.photobook/library.json'`,
   `emptyLibrary()`, `parseLibrary(json)` (throws `BookFileError`-style on mismatch), `resolveDevelop(photo, versionId?)`.
   Export from `index.ts`. Vitest: parse, round-trip, unknown version rejected.
2. **Rust.** `commands/library.rs`: `read_library(folder) -> Option<String>` (folder through `ensure_imported_root`;
   missing file is `None`; unparsable file falls back to `.bak` and logs), `write_library(folder, json)`
   (creates `.photobook/`, temp + rename, previous kept as `.bak`). Tests with a temp dir.
3. **Store.** `apps/editor/src/store/library.ts`: `libraries: Record<folderPath, Library>`, `loadLibrary(folder)`,
   `patchPhoto(folder, hash, fn)`, `save(folder)` debounced through the `autosave.ts` pattern. Lives inside the book
   store so one `temporal` covers both (or a second store whose state is fed into the same partialize; pick the
   first unless zundo makes it awkward).
4. **Write-through.** `reviewAssets`, `setAssetDevelop`, `resetAssetDevelop`, `resetDevelopSection`, `setDenoise` and
   the geometry actions (all route through `setAssetDevelop`) also write the library entry for the asset's hash.
   An asset not yet hashed keeps its field on the book until `onAssetHashed` fires, then it is lifted.
5. **Read-through.** A selector `assetDevelop(state, assetId)` returns library develop ?? book develop; the Develop
   view, `makeResolver`, `renderDeveloped`, the filmstrip edited badge and `lib/developPublish.ts` use it. Ratings
   and flags the same for the filmstrip filters and Review.
6. **Lift on open.** `loadFromFolder` loads the library, lifts book fields for hashes without an entry, saves.

## Check

- Shared and Rust tests above; editor Vitest: an edit writes the library entry; undo removes it; lift on open.
- Dev-log smoke: rate and edit three photos, quit, confirm `library.json` holds them; delete `book.photobook.json`,
  reopen the folder: the new book shows the same ratings and edits.
- Parity fixtures unchanged (`pnpm --filter @photobook/shared test`); publish `--dry-run` fingerprint unchanged for
  an edited photo.

## Docs

- `docs/DEVELOP.md` "where edits are stored"; `CLAUDE.md` caches list (`<folder>/.photobook/library.json`).

## Out of scope

Dropping the book mirror (03), versions UI (08), the AI index (33).
