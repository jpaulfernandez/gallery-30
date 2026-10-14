# 39 · Groups in the grid

Status: done 2026-10-13 except the human check (below).
Landed: `packages/shared/src/cull/groups.ts` (`groupPhotos`, `suggestedBest`, `GroupSettings`,
`DEFAULT_GROUP_SETTINGS`, `groupSettingsFor('tighter' | 'normal' | 'looser')` halving or doubling both gaps; the
section 6 algorithm and score; exported from the package index) with `groups.test.ts` (burst-fixture shape, gaps, rig
change, hash jump, re-shoot merge, overrides, no `taken`, numeric name order, spacing, the suggested best, the library
round trip, 10 000 entries under 50 ms best of three); `LibraryPhotoCullSchema` and `photos[hash].cull?: { group?:
'solo' | ULID }` in `packages/shared/src/library.ts` (optional; a malformed `group` alone is dropped, `.catch` on the
field; library stays version 1); `isEmptyPhoto` in `store/library.ts` keeps an entry whose `cull.group` is set; `ui.cull.grouped` (true),
`showStars` (false) and `expanded` (null) in `store/ui.ts`; `store/cull.ts` (`cullGroups` / `useGroups`, `cullUnits`,
`shownFrame`, `groupCounts`, `setGrouped`, `expandGroup`, `mergeSelected` / `canMerge` / `mergeTargets`,
`splitGroup` / `canSplit`, `detach`, `ungroup`, `useCullStore` with the spacing and the `,` / `.` frame per group;
overrides through `patchPhoto` inside `withoutHistory`; the cached groups are keyed on the photos and the override
values, so a rating or a flag does not regroup; `useCullStageMark`, called by `CullStage`, so `CullFilters` shows
only on the Cull stage); `CullGrid` lays the list out as units (group cell with the
stacked edge and the `+N · k✓ r✕` badge in three colours, the group open in place on whole rows with a left accent
bar), arrows move by cell, auto-advance goes to the next cell, G / `,` `.` / Cmd+G in `keys.ts` (`expand`, `frame`,
`selectGroup`, README rows in `CULL_KEYS`); `components/cull/CullFilters.tsx` (Group toggle and ▾ menu: Grouping
Tighter · Normal · Looser, Merge selected, Split group, Ungroup, the known limits), rendered by `LibraryFilterBar`;
`openCompare(group)` and `openSurvey(lookup, groupFrames)` in `openViews.ts` (C: the shown frame against the best, N:
the group's frames; `CompareView` and `SurveyView` unchanged); `CullMenu` Merge into one group, Split group here,
Detach; the Cull grid well, the Compare picture area and the Survey tile area on `bg-surround` (plan 44's token);
`scripts/make-burst-fixture.py` writing the git-ignored `fixtures/burst/` (generated once here; an approximate
DCT hash in numpy puts the re-shoot 0 to 4 bits from the burst). Vitest `components/cull/CullGroups.test.tsx`: a
filter matching two of five frames shows a group cell of two; Cmd+A under a filter selects photos and Cmd+G the
group; G keeps the focus, and a scrolled grid keeps its offset (250 px) through opening and closing; `,` `.` wrap and the stepped frame is remembered; P flags the shown frame and
advances a cell; search finds a frame inside a collapsed group; C and N on a group; merge, split and detach write
the library outside undo and the groups survive a library write and read; a flag leaves the cached groups as they
are, an override does not; a one-frame side of a split is `'solo'`; the Group toggle is absent without a Cull stage
(Develop, the Design Library tab) and present with one; the filter-bar toggle and menu.
Deviations: each camera and lens keeps its own open burst (and re-shoot chain), so a second camera firing mid-burst
does not split it (section 6 read literally splits the fixture's burst in two); `useGroups(ids)` takes the Cull list,
not a source key, and groups each listed photo's whole folder (a project list groups the project's files), so a
filter never changes a group; a group's id is its merge ULID or else its first frame's id; a photo without a phash
is never grouped by the maths; Split splits before the focused (or right-clicked) frame and gives each side of two
frames or more a new ULID (a side of one is `'solo'`), Ungroup and Detach write `'solo'`, Merge takes the selection plus the whole groups it touches; `CullFilters`
needs no props and shows only on the Cull stage (`CullView.tsx` gained the one `useCullStageMark()` call) while
the list has groups; section 6 step 2 of CULL_PLAN now says so (per camera and lens); the Stars toggle itself is plan 40's
(`showStars` added, not wired); `openViews.ts` and three test fixtures' `cull` literals were edited beyond the card's
list (the entry from a group lives there, and `CullState` gained required fields). Checks: `pnpm typecheck`,
`pnpm lint` (with `check-palette`, after plan 44's sweep of `components/cull/`), `pnpm --filter @photobook/shared
test` (1061) and `pnpm --filter editor test` (1267) pass (one `DenoiseGroup.test.tsx` case failed once under load
while plan 44 edited `DenoiseGroup.tsx`, then passed alone and on a full rerun). Left for later plans: a collapsed
cell looks fully selected when only its hidden frames are selected (a partial cue, 47); Split and Detach on a
collapsed cell act on its shown frame with no hint of which (the menu, 52); detaching a group's first frame changes
the group's id (so an open-in-place group closes). Not verified: the grid in the running editor (no `tauri dev` during wave 2), the stacked
edge and badge by eye, `groupPhotos` on real Exif and hashes. **Human check** (owner): import `fixtures/lisbon-demo`
and `fixtures/burst` (`python3 scripts/make-burst-fixture.py`), open Cull: the burst is one cell of eleven with
DSCF2005 shown, IMG_0001 on its own, no lisbon scenes merged, and the suggested best is defensible.

CULL_PLAN [7 (39)](../../CULL_PLAN.md#39--groups-in-the-grid), groups in [CULL_PLAN 4.2](../../CULL_PLAN.md#42-groups), the algorithm in [CULL_PLAN 6](../../CULL_PLAN.md#6-grouping-algorithm), data in [CULL_PLAN 5](../../CULL_PLAN.md#5-data). Depends on: 38

Size: 2 days. Depends on: 38, 06.

**Goal.** Bursts and re-shots are one cell each, expandable in place, with a suggested best, and nothing grouped is ever
hidden from filters, search or counts.

**Decisions.** The algorithm of section 6, in `packages/shared/src/cull/groups.ts` (`groupPhotos`, `suggestedBest`,
`GroupSettings` defaults). Overrides are library data (`photos[hash].cull.group`), written through `patchPhoto` outside
undo like `ai`. The grid's row model is a list of units (a photo or a group), built with the virtualiser from the
filtered ids; a group whose frames are only partly in the filter shows the matching ones. Keys: `G` expand / collapse,
`,` `.` step the shown frame, `Cmd+G` select the group; the group's badge click expands too.

**Steps.**
1. Shared `groups.ts` with tests on synthetic entries (gaps, rig change, hash jump, re-shoot merge, overrides, no
   `taken`).
2. `store/cull.ts` (new): `useGroups(sourceKey)` memoised over the folder's index entries and overrides; `setGrouped`,
   `expandGroup`, `splitGroup`, `mergeSelected`, `detach`.
3. `CullGrid`: unit rows, the group cell (stacked edge, `+N`, decided counts), expansion in place (the frames take the
   group's row(s), with a left accent bar), the keys, Cmd+A over photos; selection stays photo-keyed.
4. Filter bar: *Group* toggle with a menu (tighter / looser, *Merge selected*, *Split group*, *Ungroup*); counts stay
   photo counts.
5. Compare (C) on a collapsed group opens the shown frame against the suggested best; Survey (N) on a group surveys
   its frames.
6. Right-click menu items: Merge into one group, Split, Detach.

**Check.** Vitest: a filter that matches two of five frames shows a group cell of two; Cmd+A under a filter selects
photos, not groups; expanding keeps the scroll and the focus; `,` `.` wrap inside the group; overrides survive a
restart (library round trip); the Lightroom case (search matches a frame inside a collapsed group) finds it. A grouped
real folder (the lisbon fixture plus a burst fixture) is looked at by a person before the plan is marked done.

**Docs.** `README.md` Cull keys; `DESIGN_NOTES.md` group cell spec.
