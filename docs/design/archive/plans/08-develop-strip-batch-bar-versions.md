# 08 · Develop strip, batch bar, versions

Status: done 2026-10-12, with these deviations. The version Develop shows and edits is a separate, one-photo choice
(`developVersion` in the book store, `showVersion`; dropped when Develop steps away or closes) from the version a
project uses (`asset.version`, set by `setAssetVersion`, named so it is not taken for a React hook); the develop
actions read and write the shown one through `assetDevelop` / `writePhotoFields` (`editedVersion`), the mirror keeps
only the master. *Make a version* in a project also makes the project use it (WORKFLOW_PLAN 14.2). Names default to
`v2`, `v3`, … (the master counts as v1). Making, renaming, deleting and choosing are not undo steps; a version's
settings are (`mergeLibrariesForHistory` restores them). `deleteVersion` reads every registered project file, then checks the project open by then in memory; a file it
cannot read counts as using the version (refused, named "(could not be read)"). The strip filter is the Cull filter with *All flags* meaning "all but rejects" in
Develop only (the library stage, the project's Cull and the Design stage's D alike, the photo opened on always kept),
so Cull still shows rejects; the batch Sync is labelled *Sync selected…* (the panel keeps its Sync…).
Batch slots: `registerBatchSlot` in `components/develop/batchSlots.ts`. Fixed after review: pruning after a
publish keeps the renders of every edit the folder library holds for the book's photos (master and every version, both
profiles), so publishing one project no longer deletes a render another project on the folder needs (this closes the gap plan
04 noted; another project's develop snapshot can still be pruned); a photo's `developed` map never evicts the renders of edits in use (`pinnedDevelopedKeys`), so
editing a version many times keeps the photo's own render for the grid, filmstrip and canvas; batch writes count only
what changed. Not done: the Cull grid has no version badge
(only the filmstrip and the strip); a library key's versions re-render on their own only while Develop shows them
(`store/assets.ts` watches master edits); while Develop shows another version of a project photo, a background render
of that photo renders the shown one. Verified by Vitest (strip follows the filter through the library Develop route,
strip selection, batch Reset one undo step and its confirm, Sync with the selection, slots, versions store and UI,
version switch rerenders the preview) and two projects on one folder through `publish --dry-run`: only the photo whose
version differs has a different key, the other five match; the UI was not looked at.

WORKFLOW_PLAN [1.1](../WORKFLOW_PLAN.md#11-three-stages-one-top-bar) (W2.3), [2.2](../WORKFLOW_PLAN.md#22-where-do-edits-live-when-two-projects-share-a-folder),
[14.2](../WORKFLOW_PLAN.md#142-what-a-project-references-when-a-photo-is-edited). Size: 1.5 days. Depends on: 06.

**Goal.** Develop's bottom strip follows the Cull filter and selection, a batch bar acts on the selection, and a
photo can have named versions (virtual copies) that a project chooses.

## Decisions

- The strip default filter is picks and unflagged, rejects hidden, same `ui.filmstrip` state as Cull.
- The batch bar is a slot host: **Sync…** and **Reset edits** work now; **Paste** (10), **Apply look…** (20) and
  **Denoise selected** (27) mount their buttons when those plans land. Actions on the selection are one undo step.
- Versions live in the library (`photos[hash].versions`, plan 02); a project asset's `version` (plan 03) picks one.
  The master is the default; *Make a version* copies the current settings; the filmstrip and strip show a `v2` badge.

## Steps

1. **Strip.** `DevelopMode.tsx`: the strip takes the refs from the Cull filter and shows the selection; clicking a
   strip cell with Cmd/Shift edits the selection without changing the open photo.
2. **Batch bar.** `components/develop/BatchBar.tsx` above the strip: selection count, Sync… (opens `SyncDialog` with the
   selection as targets), Reset edits (confirm when more than 5), and the registered slots.
3. **Versions store.** `createVersion(ref, name?)`, `renameVersion`, `deleteVersion` (refused while a project uses it),
   `useVersion(assetId, versionId | null)`; the resolver (`resolveAssetDevelop`) already honours `version`.
4. **Versions UI.** A small strip under the Develop header: Master, v1 …, *Make a version*; inside a project the
   strip also has *Use in this project*. Editing while a version is active writes that version's settings.
5. **Renders.** Nothing to change: render names carry the develop hash, so versions never collide in
   `.photobook-cache`.

## Check

- Component tests: strip follows the filter, batch Reset is one undo step, version switch rerenders the preview.
- Two projects on one folder: one uses the master, one `v2`; publish `--dry-run` for each lists different keys for
  that photo; the other photos' keys are identical.
- `pnpm typecheck`, `pnpm lint`.

## Docs

- `docs/DEVELOP.md` (versions, batch bar), `docs/design/DESIGN_NOTES.md` Develop view.
