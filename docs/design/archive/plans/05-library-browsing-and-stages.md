# 05 · Library browsing: Cull and Develop without a project

Status: done 2026-10-12, with these deviations. The folder photo store is `useLibraryStore` in `store/library.ts`, as
planned; the project side (relink, renders, the derived `files`) stays in `store/assets.ts`, which no longer scans. A
photo id in Review, Develop and the develop actions is a project asset id or a library key `${folderId}/${path}` (the
key of the plan); the components keep their `assetId` prop names and resolve either through `photoMeta` / `photoFileOf`
/ `usePhotoLookup`, so a project's Review and Develop still apply the asset's version or snapshot. Library photos are
shown once hashed (they cannot be rated before). `fillAssets` remains for the scan metadata of project assets; adding
refs is the new `addPhotos` / `addToProject`. The Library sidebar shows in Cull and Develop, not in Design (Design has
the Library tab). Collection counts and Needs denoise use the folder index (plan 23 writes ISO and the measured noise
there, so Needs denoise shows once either is known); a collection scans no folder, it takes its members from the folder indexes and prepares only
them, so a folder never opened (no index yet) shows none until it is. Plan 04's deferred New project choice (All photos, Picks only, Nothing) is in. Verified by
Vitest (route guards with a memory router, the stages, the Library tab, library drops) and a dev-log smoke (index
written then reused; rate and edit with no project; projects of all photos and of the picks; their `--dry-run` publish
plans match); the stage UI itself was not looked at (no screen capture).

WORKFLOW_PLAN [14.1](../WORKFLOW_PLAN.md#141-sidebar-and-navigation), [1.1](../WORKFLOW_PLAN.md#11-three-stages-one-top-bar)
(W2.1), [14.3](../WORKFLOW_PLAN.md#143-how-photos-are-optimised-for-a-project). Size: 2 days. Depends on: 04.

**Goal.** The sidebar lists Folders, Collections and Projects; Cull and Develop work on a folder with no project
open; a project's Design stage has a Library tab to pull photos in. This is the shell every later plan hangs off.

## Decisions

- Scanning, hashing and thumb/proxy preparation move from the book (`store/assets.ts`) to the folder. The
  path → `{hash, size, mtime, kind, width, height, orientation, iso?}` index persists in `<folder>/.photobook/index.json`
  so re-opening a folder is instant; hashing still happens lazily with the existing progress events.
- A photo anywhere in the UI is a `PhotoRef = { folder, path, hash }`; Review and Develop components take refs, not
  asset ids. A project asset is a ref plus an id. Keys for selection and UI state are `${folder}/${path}`.
- Routes: `/library/$folderId/cull`, `/library/$folderId/develop`, `/library/collection/$collectionId/{cull,develop}`,
  `/project/$id/design` (the book canvas; an `$outputId` segment is added in 13). Keys R and D keep working inside
  a project, scoped to its photos.
- Built-in collections: Picks, Edited, Needs denoise (since plan 23: the measured noise suggests 40 or more, else
  ISO ≥ 3200, both from the index; shown once some photo has either). Saved collections are plan 06.

## Steps

1. **Index.** Rust: `index.json` read/write in `commands/folders.rs` (same temp + rename), `scan_folder` emits
   entries; `prepare_asset` unchanged. TS `store/library.ts` gains `folders[id].photos`, `scan(folderId)`, hash
   progress, and the lift of `onAssetHashed` from `store/assets.ts`.
2. **PhotoRef refactor.** `components/review/ReviewMode.tsx`, `components/develop/*`, `components/filmstrip/*` take
   `PhotoRef[]`; `reviewAssets`/`setAssetDevelop` take refs (the project asset id is looked up only where a project
   is open). The filmstrip in a project maps assets to refs.
3. **Shell.** `components/shell/Sidebar.tsx` (Folders with counts, Collections, Projects) and `TopBar.tsx` gains the
   stage tabs **Cull · Develop · Design** plus the Project ▾ menu; Design is disabled with no project. Routes above in
   `router.tsx`; `/project/$id` redirects to `/project/$id/design`.
4. **Cull without a project.** The Cull route renders the existing Review over the folder's refs with the existing
   filters. Develop without a project renders `DevelopMode` over the same refs.
5. **Project filmstrip.** In Design the left panel has two tabs: *Project* (today's filmstrip) and *Library* (the
   folder grid of 06, or the plain filmstrip until then) with **Add to project** on drag or button; adding creates
   an asset `{ id: newId(), ...ref }` and waits for the hash if missing.
6. **Cleanup.** Delete the book-bound scan path from `store/assets.ts`; `fillAssets` becomes "add refs".

## Check

- Open a folder from the sidebar, rate and edit with no project; create a project and add all picks: ratings and
  edits are there. Route guards tested with component tests; `[photobook:` log shows the index written and reused.
- `pnpm typecheck`, `pnpm lint`, editor Vitest (store/assets, review, develop entry points updated).
- Publish `--dry-run` of a project built this way matches a project built the old way.

## Docs

- `README.md` (the three stages, library), `docs/DEVELOP.md` (opening Develop from the library),
  `docs/design/DESIGN_NOTES.md` (shell section rewritten), `CLAUDE.md` Layout (`components/shell`, `store/library.ts`,
  `.photobook/index.json`).

## Out of scope

Grid, multi-select, saved collections (06); compare and survey (07); batch bar (08).
