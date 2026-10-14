# 47 · Cull, Compare, Survey skin

ODDHALLS_UI_PLAN [6 (47)](../../ODDHALLS_UI_PLAN.md#47--cull-compare-survey), [3](../../ODDHALLS_UI_PLAN.md#3-direction-a-darkroom-not-a-cockpit) (Cull), [4.4](../../ODDHALLS_UI_PLAN.md#44-delight-with-restraint); IMPLEMENTATION_PLAN_38-56 [section 7](IMPLEMENTATION_PLAN_38-56.md#7-waits-and-motion-where-each-row-lands) (the per-cell underline and "23 of 58"; the opening stagger and blur-up). Size: 1.5 days. Depends on: 45, 40

- Grid cells (radius, hover lift, white selection ring with a check, the sliding accent focus ring as one element),
  the star pop and flag stamp, the reject dim, the thumbnail blur-up, the floating batch pill, the filter bar without
  its border, Compare's zoom segmented control and captions, Survey's tile removal with view transitions.
- Check: 500 cells at 60 fps while arrowing (the focus ring is one element, so no cell re-renders); the batch pill
  never covers the last row (grid bottom padding grows while it shows); selection and focus read apart at a glance in
  the sink's "Cull" page.

Status: done 2026-10-13. Landed: the Cull grid cells (`CullCell` in `components/cull/CullGrid.tsx`: 4 px radius, the
empty `panel` cell while a thumbnail prepares, a 1 px hover lift with a faint ring, the white `fg` selection ring with a
check disc beside the flag, the reject dim over `base`, the 8 px blur-up on load, the star pop and keep stamp only when
they change (`useChanged`, reset when the cell takes another photo or Stars flips), the blur-up skipped for a thumbnail
the browser already has, the opening stagger (`cell-in` delayed by `--stagger`, 60 ms, times the cell's index `--i` less
the first cell drawn, `--first` on the grid, capped at 24, while the grid carries `data-opening`; once per new list, and
only when it opens at the top), the one sliding accent `FocusRing` per grid (no `focused` prop on a cell any more, so
arrowing re-renders no cell; the focused cell is the listbox's `aria-activedescendant`; the ring jumps without its
transition when the columns or the width change), the batch underline (`WorkLine` over `batchWork(jobs)` in the new
`components/cull/marks.tsx`, with `SelectCheck`, `FlagStamp`, `tileRings`, `dimClass`), and Cull's floating batch pill
(`CullPill`: count with the ring and "23 of 58", Export…, Denoise…, ⋯ with the grid's context menu items
(`CullMenuItems`) on the selection, Clear) on the new `components/ui/Pill.tsx` (`Pill`, `PillCount`, `PillDivider`,
`PILL_CLEARANCE`), which Develop's `BatchBar` now uses too (its behaviour unchanged); the grid's end padding grows by
`PILL_CLEARANCE` while the pill shows and the focused row is kept above it. No accent on a photo: the edited dot and the
all-decided group badge are `fg`, the open group's bar `fg-2`. `CullMenu` is on `Menu.Context` + `MenuItem`.
`CullFilters` is on `Button` (toggle), `Select`, `ui/Popover` with a `Segmented` for the spacing; following plan 51 (the
bar's own *Decide* and decided / total), the fragment no longer renders *Decide* or the fraction, only Stars, the Group
toggle and menu and the Lens select and caveat (props unchanged, self-contained). Compare: the zoom is `Segmented`,
captions under each picture, the keys' pane carries the accent ring outside its edge. Survey: `withViewTransition`
(`document.startViewTransition` feature-detected, a cut otherwise; `ready`'s rejection caught; the survey state updated
at once so a second X before the transition's update still acts on the next photo; the flag write and the survey list
stay inside the update: outside it the list would redraw before the old snapshot, and a flag written first re-renders
the view and puts the old list back for the next key), tiles named per photo with the `survey-tile` view-transition
class, CSS in `styles.css` (the removed tile shrinks, the group moves over `base`). Decide, the reject pile and the
loupe's chrome (`ReviewMode.tsx`) are on the primitives (`Button`, `Input`, `Select`, `Checkbox`, `Tag`, `ui/Popover`);
thumbnail strips' current tile and the loupe's stars are `fg`. Tokens: `--stagger` (zero under reduced motion),
keyframes `star-pop`, `flag-stamp`, `cell-in`, `tile-out`. `scripts/check-palette.mjs` no longer exempts
`components/cull/`. The kitchen sink has a Cull page (`components/fixture/CullSink.tsx`, `#/fixture?tab=sink&page=cull`;
`docs/design/reference/kitchen-sink-47.png`): its live grid is `CullGrid keys={false}` (a new prop; the sink moves the
focus with its own arrow handler, so no key writes a library), and `/fixture` is routed only when `import.meta.env.DEV`
(`router.tsx`). Tests: the 500-cell arrowing test (a render counter on `useChanged`, which only `CullCell` calls, stays
at 0 while the one ring moves; a positive control counts a selection), the pill padding test (the content height grows
by `PILL_CLEARANCE` with a selection and shrinks back; the pill has Export, Denoise and ⋯, no Keep), the selection
check, the stagger (from the first cell drawn, none for a list opened scrolled down), Stars not popping on the toggle,
Survey with and without a view transition and with a deferred one; existing tests changed only their selectors
(`data-focused` to `aria-activedescendant`, `radio` to `button`, `.disabled` to `aria-disabled` on menu items, the
fragment's Decide to the filter bar's).

Deviations: (1) the filter bar's border is plan 51's file (`LibraryFilterBar.tsx`) and was not touched. (2) *Add to
project* stays in the filter bar (`routes/library.tsx`'s `AddSelectedButton`), not in the pill: the grid does not know
its source and the route is not this plan's. (3) Review: the pill's Keep and Reject were dropped (not in the plan's
pill). (4) `ui/Pill` gained `w-max`: an absolute box at `left: 50%` shrank to half its parent and spilled its content
(Develop's pill had the same latent overflow). (5) Thumbnail tiles that are buttons (the Decide and loupe strips, the
loupe's stars and step arrows, a group cell's `+N` badge) stay plain `<button>`s with token classes; they are pictures
or glyphs, not chrome buttons. Not verified: 60 fps with 500 real thumbnails in the Tauri window (the render counter
proves no cell re-renders; the window cannot be captured), the view transition's animation by eye (in the browser it ran
and finished, but the pane was hidden, so it was skipped), WebKit's support of `view-transition-class` (without it the
default crossfade runs). The reference screenshot predates the review fixes: its pills still show Keep and Reject. A new
capture failed because the Browser pane was hidden. After the fixes the live sink was checked by script: the pill holds
Export 2…, Denoise…, More actions and Clear, and the sink's arrows move the focus.