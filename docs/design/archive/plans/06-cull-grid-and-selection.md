# 06 · Cull grid, multi-select, collections

Status: done 2026-10-12, with these deviations. Selection keys are the photo ids of the list on screen: library keys
`${folderId}/${path}` in the library stages, project asset ids in `/project/$id/cull` (so a project version or snapshot
still applies there); the selection is pruned to the list whenever it changes. The grid's focus is the `review`
session's current photo and `ui.cull.view` is `'grid' | 'review'` (plan 07 adds its views there); `ui.cull` also holds
`columns` (persisted per machine) and `scrollTop`. Ratings and flags are not undo steps in this code base
(`reviewAssets`, plans 02/03), so a batch is one store update and one library write but adds no undo step; the test
checks that. The library filter bar stays on `ui.libraryView` (plan 05); the project's Cull uses `ui.filmstrip` (shared
with Design's Project tab, where *Hide used* means on a page) and the Design filmstrip ignores Edited and ISO. Saved
collections are a third `LibrarySource` kind (`saved`) under `/library/collection/$collectionId/…`; the filter's schema
is `CollectionFilterSchema` in `packages/shared` and Rust checks only id and name. *ISO ≥* is wired but hidden until an
index knows ISO (plan 23); `dateRange` is in the schema and the matcher with no UI. Project Cull is reached from
Project ▾ → Cull its photos; D there opens Develop over it. After review: a saved filter is the source's condition
and the view's at once (the stricter flag, picks with rejects refuses to save; search words of both, and a search now
matches names containing every word, in the library and project views); `collections.json` entries this version
cannot parse, and unknown fields, are written back untouched (Rust copies the file aside when it drops an entry, and
the editor refuses to write after a failed read); the grid remounts per source (`CullStage`) and its scroll restore
finishes once rows are measured even when the saved offset is out of reach. Not done: the Design stage's Library tab keeps its own
3-column grid. Verified by Vitest (grid selection, sort-change ranges, Cmd+A under a filter, batch rating, Space/Esc
scroll, key parity with Review, collections store and restart, routes) and `cargo test`; the UI was not looked at.

WORKFLOW_PLAN [1.1](../WORKFLOW_PLAN.md#11-three-stages-one-top-bar) (W2.2). Size: 1.5 days. Depends on: 05.

**Goal.** Cull is a full-window grid with zoom, multi-select and batch rating, and a filter can be saved as a
collection. The one-photo Review stays one key away.

## Decisions

- `ui.selection: { keys: string[]; anchor: string | null }` keyed by `${folder}/${path}`; shared by Cull and Develop
  (plan 08) and by paste (10), looks (20), denoise (27), export (11).
- Saved collections live in `<appdata>/collections.json`: `{ id, name, filter: { folders?, flag, minRating, edited?, iso?, query, dateRange? } }`.
  They are filters, never copies.

## Steps

1. **Grid.** `components/cull/CullGrid.tsx` built on `filmstrip/visible.ts` virtualisation: 3–8 columns (`ui.cull.columns`),
   J/K and Cmd+−/+ zoom, cell = thumb + rating stars + flag + edited badge + filename on hover. Space or Enter opens
   `ReviewMode` on the current photo; Esc returns to the grid at the same scroll position.
2. **Selection.** Click, Shift+click (range from anchor in the current sort), Cmd+click (toggle), Cmd+A, Esc clears;
   arrows move the focus, Shift+arrows extend. Selection count in the filter bar.
3. **Batch rating and flag.** Keys 0–5, P, X, U act on the selection (or the focused photo when nothing is selected),
   one undo step through `reviewAssets` (already batched).
4. **Filters and sort.** Reuse `ui.filmstrip` filters (query, flag, minRating, sort) as the Cull filter bar; add
   *Edited* and *ISO ≥* when the index has ISO. `hideUsed` appears only inside a project.
5. **Collections.** Rust `read_collections`/`write_collections`; `store/collections.ts`; **Save as collection…** in the
   filter bar; the sidebar lists saved ones under the built-ins; Rename and Delete in a context menu.
6. **Project context.** Inside a project the Cull route (`/project/$id/cull`) shows the project's photos with the same
   grid; **Add selected to project** appears when browsing a folder while a project is open.

## Check

- Component tests: range select across a sort change, Cmd+A respects the filter, batch rating is one undo step,
  Space opens Review at the focused photo and Esc restores scroll.
- Keyboard parity table with `ReviewMode` (every key Review handles works on the grid) checked by a test.
- A saved collection reopens with the same filter after a restart.

## Docs

- `README.md` keys table; `docs/design/DESIGN_NOTES.md` Cull section.

## Out of scope

Compare and survey (07); batch actions beyond rating (08, 10, 20, 27).
