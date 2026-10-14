# 41 · Technical lenses

Status: done 2026-10-13. Landed: `packages/shared/src/cull/lenses.ts` (pure, exported from the package index:
`LensSchema` `none | soft | blown | dark | any`, `LENS_THRESHOLDS` (Soft: the folder's softest 10 % by `sharpnessMax`,
rounded to whole photos and taken by rank (`FolderLensStats.soft`, keyed by path, or asset id for a project's files),
so ties at the cut never make more than the decile and a folder under five photos has no Soft; Blown: `clipHigh` > 2 % "worth a look", > 5 %
"likely blown", suppressed on a high-key frame (`medianLum` > 0.75) while `clipHigh` ≤ 25 %, and on a silhouette;
Dark: `medianLum` < 0.1, suppressed on a silhouette; silhouette: `medianLum` < 0.1 and `clipHigh` > 2 %),
`folderStats`, `lensOf`, `inLens`, `lensesIn`, `lensDetail` (short: the lens and the number, "Likely blown: 71 %
clipped"), `LENS_CAVEATS` (Soft's is CULL 4.4's verbatim; shown only on the caveat line),
`groupSharpness`) with `lenses.test.ts` on plan 38's fixtures (`reference.json` clip shares and medians, read from
disk, plus the `sharpnessMax` values `cargo test -p photobook-develop --test stats -- --nocapture` prints, since the
reference has no sharpness): the bokeh portrait is not Soft, the silhouette is neither Dark nor Blown, the high-key
frame is not Blown, the blown and dark frames are found, RAW headroom only on a blown RAW;
`CollectionFilterSchema.lens` (optional, absent reads as `'none'`, an unknown value `.catch`es to absent so the
collection survives); `FilmstripView.lens` (default `'none'`) in `store/ui.ts`; `matchesFilter` (a fourth
`FolderLensStats` argument), `viewFilter`, `sourceItems` / `libraryKeys` (`LibraryItem.lensStats`), `folderLensStats`
(cached per photos record), `lensEntry`, `matchesLens`, `statsKnown`, the built-in *Worth a look* collection
(`inLens('any')`, listed only while some photo has stats) and `collectionFilterFor` (the view's lens, else the
source's; null when both are set and differ unless the source's is `any`; Worth a look saves as `any`);
`SaveCollectionButton` resets the lens after saving (and its error names the two-lens case) in `store/collections.ts`; `visibleItems` takes the lens over the project's
files as one folder (the Design filmstrip's `filmstripOrder` passes `'none'`); `store/lenses.ts` (new:
`lensReading` / `useLensReading`); `CullFilters` (the *Lens* select with per-lens counts, the caveat line with
*RAW headroom* on Blown, a `scope` prop from `LibraryFilterBar`; the select stays when the lens leaves no photo);
`CullGrid` (the top-right badge row as one flex line: edited dot, needs-denoise badge, lens glyphs named by the
lens, the number in a `Tooltip` that describes them);
`DecideView` (header `Tag`s for the shown photo's lenses; the strip's sharpest ● and per-frame bars, and the line's
"N % of the sharpest ●"); `CullMenu` *Select the group's softer frames* (`softerFrames`: the group's listed frames
but its suggested best; selection only; off when no frame has stats). `CULL_PLAN.md` 4.4 has a dated "as built"
paragraph (the 25 % ceiling, the silhouette rule, Soft by rank). Vitest `components/cull/Lenses.test.tsx` (17; also two lenses are not one collection, and softer frames off without
stats; tooltips read by hovering), shared `collections.test.ts` (a filter without a lens, an unknown lens dropped)
and `lenses.test.ts` (Soft capped at the decile on ties): each lens over a folder; a
lens plus a flag filter composes; no Soft without folder stats; a collection saved with a lens reopens with it
(through JSON and `parseSavedCollections`); Worth a look's members, listing and saved filter; the project list's lens;
changing the lens writes nothing (the `libraries` record is the same object, the flag stays, `writeLibrary` mocked and
never called); the counts and the caveat; RAW headroom; the select with an empty list; the project scope; the cell
badges and their tooltip text; the Decide strip's mark, bars and line; the header tags; softer frames from the menu.
Deviations: the lens enum adds `'any'` (Worth a look, and a collection saved from it; not offered in the select);
`CollectionFilterSchema.lens` has no output default (absent means none) so the existing filter literals and
`toEqual`s stand; the caveat line sits under the filter bar's controls (`order-last w-full` in `CullFilters`), not
under the grid, since the grid is not this plan's beyond its badge row; with a lens on, the select counts only that
lens (the list is the lens, and the unfiltered list is not known to the fragment); the high-key suppression stops at
25 % clipped (`highKeyClipCeiling`, not in CULL 4.4) so the blown fixture (median 0.88, 71 % clipped) is still Blown;
Soft uses `Math.round` of 10 % (eight fixtures: one photo); a lens set in Cull also narrows the library's Develop strip
(the view is shared, as Edited and ISO are), and *Clear filters* clears it. Files beyond the card's list:
`store/lenses.ts` (new), `components/filmstrip/visible.ts` (lens in `visibleItems`), `LibraryFilterBar.tsx` (the
`scope` prop, `narrowed`, *Clear filters*: three lines). Checks (after the review fixes): `pnpm --filter @photobook/shared test` (1079), `pnpm --filter editor test` (1389),
`pnpm typecheck` and `pnpm lint` (exit 0; the site's one warning; `check-palette: ok`) pass; Biome is clean on every
path of this plan. Not verified: the badges and
the strip by eye in the running editor (no `tauri dev` during wave 4); the thresholds on a real folder.

CULL_PLAN [7 (41)](../../CULL_PLAN.md#41--technical-lenses), lenses in [CULL_PLAN 4.4](../../CULL_PLAN.md#44-technical-lenses), data in [CULL_PLAN 5](../../CULL_PLAN.md#5-data). Depends on: 38, 39, 40

Size: 1 day. Depends on: 38, 39.

**Goal.** Soft, Blown and Dark as lenses in the filter bar and as explanations in Decide and on hover, with the rule in
the copy: they rank, the user decides.

**Decisions.** A lens is a filter-bar field (`lens`) on `FilmstripView`, saved in collections; thresholds in one
`packages/shared/src/cull/lenses.ts` object (decile for Soft, 2 % / 5 % for Blown, 0.1 for Dark, the high-key and
silhouette suppressions). Badges are dim glyphs in the cell's top-right row next to the edited dot, with a tooltip
that gives the number and the caveat. No lens ever writes a flag; the way to reject a lens is Cmd+A, X, like any
selection.

**Steps.**
1. Shared `lenses.ts`: `lensOf(entry, folderStats)` and `folderStats(entries)` (the decile cut), with tests on the
   fixture stats.
2. Filter bar: a *Lens* select (None, Soft, Blown, Dark) with the count, the one-line caveat under the grid while a
   lens is on, and *RAW headroom* shown on Blown for RAW sources.
3. Cell badges and tooltips; the Decide strip's "sharpest ●" and the per-frame bar under each thumbnail (relative to
   the group's best); a *Worth a look* built-in collection (any lens) listed only when stats exist.
4. Right-click: *Select the group's softer frames* (everything but the suggested best).

**Check.** Vitest: the bokeh portrait fixture is not in Soft; the silhouette fixture is in neither Dark nor Blown; a
high-key fixture is not in Blown; a lens plus a flag filter composes; a collection saved with a lens reopens with it.

**Docs.** `README.md` lenses paragraph (with the caveat verbatim); `DESIGN_NOTES.md` badges.
