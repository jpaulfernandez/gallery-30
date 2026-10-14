# 40 · The Decide pass, target and progress

Status: done 2026-10-13 except the human check (below).
Landed: shared `FlagFilterSchema` gains `'undecided'` and `LibrarySchema` an optional top-level `cull?: { target?:
number | { share }; culledAt? }` (`LibraryCullSchema`, each field `.catch`es alone; library stays version 1; tests in
`library.test.ts`, `collections.test.ts`; review fix: a malformed `cull` as a whole, `null` included, is dropped with
`.catch` and never costs the library); `matchesFilter`, `bothFlags` (Save as collection) and the project list's
`visibleItems` know Undecided; the book store's `patchLibrary(folder, fn)` (library top level, outside undo, refused
while the library is not loaded); `ui.cull.view: 'decide'`, `ui.cull.decide?: { log: { at, before }[]; startedAt;
decisions; pauseDismissed }` and `CullCompare.back?: 'decide'` in `store/ui.ts`; `store/decide.ts` (new: the key
actions over `cullUnits`, flags written in one store update outside undo, the log, `decideProgress`, `targetCount`,
`listFolder`, `setCullTarget`, `markCulled`, `folderCulled`, `pauseDue`); `components/cull/DecideView.tsx` (new:
header progress `decided / total decided · kept of ~target`, *Target ▾* popover, the proxy fit or 1× on Space at
`stats.sharpestTile` (measured on the upright proxy before develop, so a photo whose develop geometry differs from the
default (crop, straighten, rotate, flip, Upright, Transform) zooms on the centre instead: `zoomCentre`), the group's frame strip, the end state *Culled: N kept, M rejected* with *Review
rejects…* and *Rate the keepers*, the pause nudge); `components/cull/CulledMark.tsx` (new, the sidebar ✓, one line in
`Sidebar.tsx`); `keys.ts` (Enter is `decide`, Space stays Review; `decideKeyAction`, `DECIDE_KEYS`; Keep / Reject /
Undecided words in `CULL_KEYS` and `SURVEY_KEYS`; the native menu's items read Keep / Undecided (ids unchanged) and
the Design filmstrip's flag filter *Kept only*); `CullView` (the Decide branch; `useCullSource` drops the pass on
another source); `CompareView` (Esc and a stale list go back to `compare.back`); `CullGrid` (Enter opens Decide, stars
only with `ui.cull.showStars`, hint and badge words); `CullFilters` (*Decide*, the `decided / total` fraction and the
*Stars* toggle always on Cull; 39's Group controls unchanged, still only with groups); `LibraryFilterBar` (*Kept
only*, *Undecided*); Review and Survey hints say keep / undecided, Review's flag button *Keep*. Vitest
`components/cull/DecideView.test.tsx` (23): P on a group of five is one library update (one kept, four rejected), no
undo step, advances; Shift+P keeps and steps (stays on a single photo); X steps inside the group and advances from its
last undecided frame; Shift+X; U reverts exactly the last decision, a group decision included; ← → skip without
moving the counter; `,` `.` wrap; Space to the sharpest tile and back, to the centre on an edited (rotated, cropped) photo; C into Compare and Esc back to Decide, Esc to
the grid on the unit left; D; the end state appears at zero undecided (and stamps `culledAt`) and goes when U brings
one back; Rate the keepers and Review rejects…; a target as a share computes against the list (8 photos: ~2; a
filtered list of 3: ~1); the Target popover writes the library outside undo; the pause nudge at 300 decisions and at
45 minutes in a fake clock, focus never leaves the view; the log survives a stage switch and is dropped on a source
change; keyboard parity extended (Enter, Space, every `DECIDE_KEYS` row); the filter bar's Decide, fraction and Stars;
the Undecided filter; the sidebar check and a new photo taking it away; U after a filter hid its photo leaves the
photo shown alone; reopening after a break restarts the nudge clock.
Pause rule: the nudge's clock is the pass's `startedAt`; `openDecide` restarts it (log and count kept) when the last
decision, or the start, is more than 15 minutes old (`BREAK_MS`; `lastAt` on `ui.cull.decide`), so coming back after
an hour in the grid does not show the nudge at once.
Deviations: `ui.cull.decide` holds no `ids` / `index` / `frame` (CULL 5's sketch): the photo shown is the `review`
session's current one, so Esc lands the grid on the unit left, D and a stage switch keep the photo, and the unit and
frame are derived from it; the nudge's 45 minutes count from the pass's start (kept across a stage switch, restarted after a
15-minute break), not time spent in the view only, and *Dismiss* holds for the pass (a new source starts a new pass); Enter opens Decide on the
focused photo when it is undecided (on a group cell that is the frame the cell shows), else the unit's arrival frame
(the grid's shown frame when undecided, else its first undecided frame), else the next open unit; ← → and advancing
wrap round the list so skipped units come back; Shift+X on a single photo rejects it like X; the target is per folder
and *Target ▾* is disabled for a list over several folders (a collection); `culledAt` is stamped once when a pass
ends with a folder fully decided and kept after, the ✓ is computed (set and no undecided photo), so a new photo hides
it without a write; *Review rejects…* filters the list to Rejects only until plan 42 hands in the pile
(`DecideView`'s `onReviewRejects` prop); the flag-badge labels read Kept / Rejected in the grid, Compare, Survey and
Decide; `CompareView.tsx`, `CullGrid.tsx`, `SurveyView.tsx`, `ReviewMode.tsx`, `filmstrip/visible.ts` and
`store/collections.ts` were edited beyond the card's list for the view switch, Enter, the words and the filter.
For plans 41 and 42: 41's "sharpest ●" and per-frame bars go into `DecideView`'s `FrameStrip` (the group's frames,
the shown one, `lookup`) and the header line; 42 passes `onReviewRejects` to `DecideView` from `CullView`.
Checks: `pnpm typecheck`; `pnpm --filter @photobook/shared test` (1064) and `pnpm --filter editor test` pass (1288; after the review fixes the only
failures are two `Rulers.test.tsx` View menu cases, from plan 45's in-progress `ViewMenu` restyle);
Biome clean on every path this plan touched and `check-palette: ok`; `pnpm lint` as a whole fails only on plan 45's
in-progress files (`components/ui/*`, `TopBar`, `Sidebar`, `PageStrip`, `SaveCollectionButton`, the design toasts
and `OutputMenu`), none of them this plan's. Left for plan 51: the sidebar's built-in *Picks* collection is still named
Picks (Sidebar.tsx belonged to plan 45 during this plan). `ctx.at === -1` in `nextOpenUnit` now walks every unit. Not verified: the view in the running editor (no `tauri dev`
during wave 3), the picture's 1× placement by eye. **Human check** (owner): a Decide pass over a real folder of a few
hundred photos (the lisbon fixture plus `fixtures/burst`) feels like it moves; the end state appears; U brings one back.

CULL_PLAN [7 (40)](../../CULL_PLAN.md#40--the-decide-pass-target-and-progress), vocabulary in [CULL_PLAN 4.1](../../CULL_PLAN.md#41-vocabulary), the pass in [CULL_PLAN 4.3](../../CULL_PLAN.md#43-the-decide-pass), data in [CULL_PLAN 5](../../CULL_PLAN.md#5-data). Depends on: 39

Size: 2 days. Depends on: 39, 07.

**Goal.** One view that walks the undecided photos one unit at a time with two keys, shows how far along the cull is
and against what target, and ends.

**Decisions.** `DecideView.tsx` in `components/cull/`, a sibling of Compare and Survey (same header height, same key
hint line), reusing `urlsOf` and `viewport.ts`; `ReviewMode` is untouched. The decision log (`ui.cull.decide.log`) is
the pass's own undo (U), separate from app undo, since flags are not undo steps. The target and `culledAt` are
library top-level fields; the flag filter gains *Undecided*; the UI words become Keep / Reject / Undecided everywhere
in Cull (Review and Develop keep their key hints but say Keep for P). Stars hidden behind `ui.cull.showStars`.

**Steps.**
1. Shared: `FlagFilterSchema` gains `'undecided'`; `matchesFilter` and `viewFilter`; `LibrarySchema` optional `cull`.
2. `DecideView`: units from the grid's list, the frame strip for a group, the key table of 4.3, Space to the sharpest
   tile (`stats` gives the tile index; fall back to centre), C into Compare and back, progress header, the *Target*
   popover (number or share, per folder), the "culled" end state with its two buttons, the pause nudge (a timer and a
   decision counter, dismiss remembered for the session).
3. Grid: Enter opens Decide on the focused unit (Space keeps opening Review); a *Decide* button and the progress
   fraction in the filter bar; the sidebar's folder row shows a check when `culledAt` is set and no undecided photo
   remains (cleared when a new photo arrives).
4. Rename labels: *Pick* → *Keep*, *Unflag* → *Undecided* in the filter bar, menus, key hints and README.

**Check.** Vitest: P on a group of five writes one library update (one kept, four rejected) and advances to the next
unit; Shift+P keeps and steps; X on the last undecided frame advances; U reverts exactly the last decision including a
group decision; ← → skip without changing the counter; the end state appears when undecided reaches zero and
disappears when U brings one back; target as a share computes against the list; the pause nudge fires at 300
decisions in a test clock; keyboard parity table extended with Decide. Verified by a person on a real folder of a few
hundred photos: the pass should feel like it moves.

**Docs.** `README.md` (feature bullet, Decide keys table); `DESIGN_NOTES.md` Decide view spec.
