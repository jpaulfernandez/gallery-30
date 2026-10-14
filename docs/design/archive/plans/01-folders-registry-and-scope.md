# 01 · Folders registry and scope

Status: done 2026-10-12. Import was smoke-checked by seeding `folders.json` (the native dialog cannot be driven
from the agent shell); rename has a command and store action but no Home UI yet (the sidebar in plan 05 hosts it).

WORKFLOW_PLAN [14.1](../WORKFLOW_PLAN.md#141-sidebar-and-navigation), [14.7](../WORKFLOW_PLAN.md#147-changes-to-the-phases).
Size: 1 day. Depends on: nothing.

**Goal.** Folders are imported once and remembered, and every disk command is scoped to the set of imported folders
plus app data instead of a single open root. Nothing visible changes except a folder list on Home.

## Decisions

- Registry file `<appdata>/folders.json`: `[{ id: ULID, path, name, addedAt, lastSeen }]`, written temp-file-and-rename.
- A folder is trusted when it was picked in the native dialog (the dialog plugin adds it to the fs scope) or is in the
  registry; same rule as `set_source_root` today.
- Removing a folder from the registry leaves `<folder>/.photobook/` and `.photobook-cache/` in place.

## Steps

1. **Rust scope.** In `apps/editor/src-tauri/src/scope.rs` replace `SourceScope { root }` with `ImportedRoots { roots: Mutex<Vec<PathBuf>> }`.
   `ensure_allowed` accepts a path under any imported root or app data. Rename `ensure_source_root` to
   `ensure_imported_root(folder)`: the normalized path must equal one of the roots. `set_source_root` becomes
   `add_root(folder, trusted)`; it calls `asset_protocol_scope().allow_directory` as today. Update the module doc.
2. **Commands.** New `apps/editor/src-tauri/src/commands/folders.rs`: `list_folders`, `import_folder(path) -> Folder`
   (idempotent by canonical path; adds the root), `remove_folder(id)`, `rename_folder(id, name)`. On startup
   (`lib.rs` setup) read the registry and add every existing folder as a root so cached thumbnails keep resolving.
   Register in `commands/mod.rs` and `lib.rs`. `open_book` calls the same import so the current flow keeps working.
3. **Callers.** Every command that called `ensure_source_root` now calls `ensure_imported_root` (assets, develop,
   xmp, book, publish). Nothing else in those commands changes.
4. **TS.** `lib/tauri.ts`: `listFolders`, `importFolder`, `removeFolder`, `renameFolder`, `Folder` type.
   New `store/folders.ts` (Zustand, not undoable): `folders`, `load`, `import` (opens the dialog, then the command),
   `remove`, `rename`.
5. **Home.** `routes/home.tsx`: a *Folders* list (name, path, Remove) with **Import folder…** above the recent book.
   Opening a folder's book from the list goes through the existing `loadFromFolder`.

## Check

- Rust unit tests in `scope.rs`: two roots, a path in each passes, a sibling of either is rejected, `..` is rejected,
  `ensure_imported_root` rejects a subfolder of a root.
- A corrupt `folders.json` yields an empty registry and a `[photobook:` log line, never a crash.
- Dev-log smoke (see the memory note on verifying without screen capture): import two folders, open the book in one,
  `prepare_asset` on a file in the other succeeds, a path outside both fails with `OutOfScope`.
- `pnpm typecheck`, `pnpm lint`, `cargo test` in `apps/editor/src-tauri`.

## Docs

- `CLAUDE.md` Layout bullet on `scope.rs` (imported folders, not one root); `docs/INSTALLATION.md` if it mentions
  "open a folder" semantics.

## Out of scope

Library file (02), project files in app data (04), the sidebar (05).
