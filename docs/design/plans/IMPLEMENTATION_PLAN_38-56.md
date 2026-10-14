# Implementation plan: cull workflow and the oddhalls UI (plans 38–56)

Oct 13, 2026. The schedule, file ownership, cross-plan interfaces and verification gates for the nineteen session
plans written in three design documents:

| Document | Plans | What it decides |
| --- | --- | --- |
| [CULL_PLAN.md](../CULL_PLAN.md) | 38–42 | The cull workflow: capture time and stats in the index, groups, the Decide pass, lenses, the reject pile and the Trash |
| [ODDHALLS_UI_PLAN.md](../ODDHALLS_UI_PLAN.md) | 43–49 | The skin: the Tauri artifacts and the native shell, tokens v2, primitives, the slider, Cull and Design chrome, polish |
| [ODDHALLS_LAYOUT_PLAN.md](../ODDHALLS_LAYOUT_PLAN.md) | 50–56 | The layouts: Home, the three panes, Cull's mouse and Photo pane, assist overlays, Develop Basic ⇄ Advanced, grading wheels, masks and sorts, the Design chooser |

Those documents are the contracts: each plan's goal, decisions, steps, Check and Docs lists live there and are not
repeated here. This document adds what the three were written without: one dependency graph across all nineteen,
the order they run in with up to four agents in one working tree, who owns which file, the interfaces that must be
agreed before plans run side by side, and the gates each wave passes. It follows the pattern that ran plans 01–36
([README.md](README.md), *How to run a plan*; the archived plans' Status lines).

Status: written Oct 13, 2026; every plan done and archived by Oct 14, 2026 (49,
[archive/plans/49-delight-and-polish.md](../archive/plans/49-delight-and-polish.md), whose Status line collects the owner's checklist). Plan 37 (tiled full render) is outside this plan and compatible with
it (Rust only, no engine bump); it can run in any wave.

---

## 1. Decisions to lock before wave 1

The open questions of the two oddhalls documents, consolidated, plus the ones this plan adds. Each is a one-line
answer so no agent re-litigates it.

| Decision | Locked answer | Source |
| --- | --- | --- |
| Accent | Brass `oklch(0.80 0.11 80)`; never on a photo except the Looks tile ring and a frame's selection outline | UI 2.2, 7 |
| Light theme | No; the surround preference (Black · Charcoal · Mid grey) instead | UI 7 |
| Wordmark | `oddhalls`, lowercase, Instrument Serif italic; `productName` and the window title change in 43; the repo, package and crate names do not | UI 7, 43 |
| Bundle identifier | `com.photobook.editor` stays; renaming moves app data and is its own later plan | UI 43 |
| Native menu bar | Owns the accelerators, behind `PHOTOBOOK_NATIVE_MENU` (a Vite env flag) for one session; the flag is removed in 49 once no key fires twice | UI 43 |
| Haptics | On by default, Settings → Appearance switch, no-op without Force Touch and under reduced motion | UI 4.3 |
| Slider thumb | Needle; knob kept only on the gradient tracks if the needle proves hard to read there (46 decides on the kitchen sink) | UI 7 |
| Basic ⇄ Advanced | One global switch, per machine; per-card ▸ expands in place | Layout 8 |
| Histogram | RGB over luminance, one Rust command, cached per develop hash | Layout 8 |
| Old linear masks | Untouched; only the drag convention changes, plus Invert on every row | Layout 4.4, 8 |
| Place | Coordinates until an offline geocoder plan exists | Layout 8 |
| Review (the loupe) | Becomes the *One* view of Cull's view switch; the route and `ui.cull.view: 'review'` stay, only the label changes | Layout 8 |
| **Engine bump** | One bump, to `develop-engine/4`, at the end of 55 (per-wheel luminance); no other plan in 38–56 changes render maths. Focus peak and zebra (53) are preview-only shader modes outside the develop hash | this plan |
| **Cull skin after cull behaviour** | 47 restyles the grid once 39 and 40 have changed its structure (unit rows, group cells, Decide), not before | this plan |
| **Filter controls as one fragment** | 39, 40 and 41 put their filter-bar controls (Group, Lens, Decide, progress) in `components/cull/CullFilters.tsx`; 51 re-parents that fragment into the sidebar's Filters section instead of rewriting it | this plan |
| **Context menus** | 43 cancels the browser menu everywhere and extends the sidebar's existing one to folders and projects; the Develop strip and page strip menus wait for the `Menu` primitive and land in 45; Cull's in 52, the mask's in 56 | this plan |
| **The kitchen sink runs without Tauri** | The `/fixture` Kitchen sink tab (44) must render under Vite alone (`editor-web` in `.claude/launch.json`, port 1420) with no `invoke` on mount, so agents can verify tokens, primitives and states in a browser; the Tauri window itself cannot be captured by an agent (the earlier runs verified it through the `[photobook:` dev-log lines only) | this plan |
| **Stats in `prepare` must not slow the scan** | 38 measures `prepare` on the lisbon fixture before and after; above +20 ms a photo, stats move to a second pass over the cached proxy inside the same job | this plan |

---

## 2. Dependencies, revised

The source documents state each plan's dependencies on its own track. Running three tracks in one tree adds edges
where two plans change the same component. Added edges are marked **+**.

| Plan | Depends on | Why the added edges |
| --- | --- | --- |
| 38 Index: capture time and stats | — | |
| 39 Groups in the grid | 38 | |
| 40 Decide pass | 39 | |
| 41 Technical lenses | 38, 39, **+40** | The Decide strip's "sharpest ●" and per-frame bars draw into `DecideView` |
| 42 Reject pile and Trash | 40 | |
| 43 Native shell and Tauri artifacts | — | |
| 44 Tokens v2 | 43 | Both rewrite the base layer of `styles.css` |
| 45 Primitives and the shell | 44 | |
| 46 Slider v2 and the Develop panel | 45 | |
| 47 Cull, Compare, Survey skin | 45, **+40** | Restyle the final grid (unit rows, group cells, Decide) once |
| 48 Design canvas chrome | 45 | |
| 49 Delight and polish | 46, 47, 48, **+56** | The screenshot set and the accessibility sweep cover the finished layouts |
| 50 Home | 44, 45, **+40** | The folder rows show kept / undecided / culled ✓ from plan 40's library fields |
| 51 Shell panes | 45, **+46** | 46 owns the Develop header ⋯ menu and the cards; 51 moves Looks, History and Versions to the left pane after that |
| 52 Cull mouse and Photo pane | 38, 45, **+47, +39, +42** | The right-click menu lists the group items (39) and *Move to Trash…* through the pile (42); it edits the grid after 47 |
| 53 Assist overlays and Group by | 41, 52 | |
| 54 Develop Basic ⇄ Advanced | 46, **+51** | The seven cards are laid out after Looks has left the right pane |
| 55 Color grading wheels | 54 (19 done) | The one engine bump |
| 56 Masks, sorts, the chooser | 43, 52, **+51** | The Cull sorts live in 51's Filters section; the palette extends `prepare` after 52's EXIF fields |

Already done and assumed: 01–36 (archived), in particular 06/07 (grid, Compare, Survey), 08 (strip, batch bar,
versions), 09 (jobs), 11 (export presets, for the chooser), 14 (posts, for the carousel), 18–21 (looks, LUTs),
23–28 (denoise rows), 29–31 (canvas gestures, guides, rulers).

---

## 3. The schedule

Eight waves. Plans in one wave run side by side, one agent each, in the one working tree; a wave starts when every
plan of the previous wave it depends on has passed its gate (section 8). Sizes are the source documents' for 38–42
and 50–56 and estimates for 43–49 (the UI plan gives none).

| Wave | Plans (size in days) | Tracks | Shared files to watch |
| --- | --- | --- | --- |
| 1 | **38** (1.5) ∥ **43** (2) | Cull, Skin | none |
| 2 | **39** (2) ∥ **44** (1.5) | Cull, Skin | `store/ui.ts` (39 adds `ui.cull` fields; 44 adds `ui.surround`) |
| 3 | **40** (2) ∥ **45** (2.5) | Cull, Skin | `LibraryFilterBar.tsx` (40 renders `CullFilters`; 45 restyles the bar around it), `store/ui.ts` |
| 4 | **41** (1) ∥ **42** (1.5) ∥ **46** (2) ∥ **48** (1.5) | Cull ×2, Skin ×2 | `lib.rs` and `lib/tauri.ts` (42 `trash_photos`, 46 `haptic`: additive); `components/editor/` (46 touches only the guide-flash call site; 48 owns the rest) |
| 5 | **47** (1.5) ∥ **50** (1) ∥ **51** (1) | Skin, Layout ×2 | `LibraryFilterBar.tsx` and `Sidebar.tsx` belong to 51; 47 owns `components/cull/*`; 50 owns `routes/home.tsx` |
| 6 | **52** (2) ∥ **54** (2) | Layout ×2 | `commands/assets.rs` (52 only); `components/develop/` (54 only) |
| 7 | **53** (1.5) ∥ **55** (1.5) ∥ **56** (2) | Layout ×3 | `commands/assets.rs` (56 palette); `components/develop/` (55 `EffectsSection`, 56 `MaskTools` and `MaskOverlay`: disjoint files); shared `develop/schema.ts` (55 only) |
| 8 | **49** (1.5) | Skin | everything, polish only |

Critical path: 38 → 39 → 40 → 42 → 47 → 52 → 56 → 49, about 14.5 days of agent time; the skin chain
43 → 44 → 45 → 46 → 51 → 54 → 55 → 49 is about 13.5. With four agents the whole programme is roughly three to four
weeks of sessions, two with the parallelism above.

**Agent pattern** (the one that ran 11–36): one Opus implementer per plan, then one Sonnet read-only reviewer with
the plan's Check list and the source section as its brief, then the ranked findings sent back to the same
implementer with SendMessage, then the gate. Resuming after a cutoff is a SendMessage to the same agent. Agents never
change git state, never run `pnpm dev` or `tauri dev` while others run, and run Biome only on their own paths.

**Plan files.** At the start of its session the implementer creates `plans/NN-<slug>.md` from the source section
(copied verbatim, the heading in the archived plans' form, a *Depends on* line from section 2 here, and a *Status:*
line added when done), so the index and the archive keep working as they do for 01–37:

```
38-index-capture-time-and-stats.md   43-native-shell-and-tauri-artifacts.md   50-home.md
39-cull-groups.md                    44-tokens-v2.md                          51-shell-panes.md
40-decide-pass.md                    45-primitives-and-shell.md               52-cull-mouse-and-photo-pane.md
41-technical-lenses.md               46-slider-v2-and-develop-panel.md        53-cull-assist-overlays-and-group-by.md
42-reject-pile-and-trash.md          47-cull-compare-survey-skin.md           54-develop-basic-advanced.md
                                     48-design-canvas-chrome.md               55-color-grading-wheels.md
                                     49-delight-and-polish.md                 56-masks-and-storytelling-sorts.md
```

---

## 4. Cross-plan interfaces

What two plans in different waves or tracks must agree on. The first plan named fixes the interface; the others use
it as found and extend it additively.

**Index fields** (38, then 52, then 56). One optional-field pattern on `IndexEntry` (Rust `commands/folders.rs`, TS
`lib/tauri.ts`) and `Meta` / `AssetInfo` (`commands/assets.rs`): 38 adds `taken`, `make`, `model`, `lens`, `focal`,
`phash`, `stats { sharpness, sharpnessMax, motion, clipHigh, clipLow, medianLum }` (and `sharpestTile`, the index of
the max tile, which 40's Space-to-100 % needs); 52 adds `shutter`, `aperture`, `gps { lat, lon }`; 56 adds `palette`
(five Oklab colours as hex). The index and the library stay at version 1. 38 writes the backfill once: `cached()`
recomputes any missing field from the cached `proxy.jpg` and the EXIF, so 52 and 56 only add fields to the same
function. `scan_folder`'s `apply_index` copies every optional field onto an unchanged file.

**Tokens** (44). Exactly the names of UI 2.2 and 2.3: `stage`, `stage-mid`, `surround` (the photo wells'
background, set by the surround preference; added by 44's review), `canvas`, `panel`, `panel-2`, `panel-3`,
`hairline`, `line`, `fg`, `fg-2`, `fg-muted`, `accent`, `accent-ink`, `accent-soft`, `danger`, `warn`, `ok`,
`guide`, `pick`; `--radius-xs|sm|md|lg|pill`; `--shadow-raised`, `--shadow-float`, `--highlight-top`; `--ease-out`,
`--dur-fast|base|slow`; utilities `section-title`, `tag`, `scrollbar`. Every plan after 44 uses only these;
`scripts/check-palette.mjs` runs in `pnpm lint` and fails on a Tailwind palette class or `text-white` /
`bg-black/*` in `apps/editor/src`.

**Primitives** (45) in `apps/editor/src/components/ui/`: `Button` (`variant: primary | soft | ghost | danger |
toggle`, `size: sm | md`, `icon`), `IconButton`, `Segmented`, `Field`, `Input`, `NumberInput`, `Select`, `Checkbox`,
`Switch`, `Menu` + `MenuItem` (also the context-menu host: `Menu.Context` anchored at a point), `Popover`, `Tooltip`
(`shortcut`), `Toast` (one host in `main.tsx` replacing the four export toasts' bespoke stacks over time), `Tag`,
`ProgressRing`, `DialogShell` (moved from `components/develop/`; the old path re-exports until 49 removes it). Later
plans import from `components/ui` and never write `rounded-md border border-line` on a button again (the palette
script greps for it).

**`CullFilters`** (39, 40, 41 → 51). `components/cull/CullFilters.tsx` renders the Group toggle and menu (39),
Decide and the progress fraction (40), the Lens select and its caveat line (41) from `ui.cull` and the view; the
filter bar renders it in waves 2–4; 51 moves it into the sidebar's Filters section and leaves search, the view
switch, zoom, progress, Decide and the clear chip in the bar (Layout 3).

**`ui.cull`** (39, 40, 52). 39 adds `grouped`, `showStars`, `expanded`; 40 adds `view: 'decide'` and `decide`; 52
adds nothing to `view` (One = `'review'`, Two = `'compare'`) and adds `zoom` (the one zoom: columns in Grid,
Fit · 1× · 2× · 4× in One and Two, mapped onto the existing `columns` and the linked viewport). The flag filter's
`'undecided'` value is 40's (`FlagFilterSchema` in shared). The lens is 41's `lens` on `FilmstripView` and in
`CollectionFilterSchema`.

**Library fields** (39, 40). `photos[hash].cull?: { group?: 'solo' | ULID }` (39) and top-level
`cull?: { target?: number | { share: number }; culledAt?: string }` (40), both optional in `LibrarySchema`, written
through `patchPhoto` and a new `patchLibrary` outside undo, as `ai` is.

**Commands** (additive registrations in `lib.rs`, wrappers in `lib/tauri.ts`): `trash_photos` (42,
`commands/photos.rs`), `haptic` (46, `commands/haptic.rs`, `objc2-app-kit` in the editor crate only),
`histogram` (52, `commands/develop/histogram.rs`, 3 × 256 bins from the cached proxy of a develop hash),
`set_text_focus` and the native menu (43, `menu.rs`). Each is behind `ensure_allowed` where it takes a path.

**Haptics** (46 → 48, 54, 55). `lib/haptic.ts` exports `tick(kind: 'alignment' | 'levelChange' | 'generic')`, rate
limited and gated by Settings and reduced motion. 46 wires the slider detent, the canvas snap (one call at plan 30's
guide-flash site), straighten 0° and zoom Fit / 100 %; 55 adds the harmony-lock angle snaps; nothing else calls it.

**Pane state** (51). `ui.panes[stage] = { left, right, strip }`, per machine like `loadCullColumns`; `Tab` and
`Shift+Tab` toggle them; every stage's layout reads it. 50's Home and 52's Photo pane mount inside it.

**Motion** (44 → all). Durations and easing only through the tokens; `prefers-reduced-motion` sets the durations to
0 at the token level, so no component checks it twice. `view-transition` (47 Survey) and `linear()` springs (46)
are feature-detected and fall back to cuts.

---

## 5. Working rules

`docs/design/plans/RULES.md` is written at the start of wave 1 with these lines and handed to every agent:

1. Never run `git stash`, `checkout`, `reset`, `clean` or `commit`; the user commits. Never `pnpm dev` or `tauri dev`
   while another agent runs; verify in a browser through `editor-web` (Vite only) or with tests.
2. Edit only the files your plan owns (section 6); in a shared file make additive edits, re-read it before each
   edit, and never reformat beyond your change. Biome runs with explicit paths (`pnpm biome check --write <paths>`).
3. `cargo test -p photobook-develop --lib` or `--test <name>`, and `cargo test --lib` in `src-tauri`, never the
   whole workspace; never build a scratch copy of the tree; `target/` is shared, so do not delete it.
4. No engine bump outside 55; no `UPDATE_*_FIXTURES` outside 55; never change `identifier` in `tauri.conf.json`.
5. New colour, radius, shadow or duration only through the tokens (44+); new controls only from `components/ui`
   (45+); `pnpm lint` includes the palette script and must pass before the Status line is written.
6. Ratings, flags and cull decisions are not undo steps (plans 02/06); Decide has its own log (40). Do not add them
   to the undo stack.
7. Every Rust writer in a job writes a temp file and renames it; `trash_photos` refuses any path that is not under
   an imported root.
8. Finish by writing the plan file's Status line (what landed, deviations, what was not verified) and the dated line
   in DESIGN_NOTES the plan names; nothing is done without it.

---

## 6. Plan cards

One card per plan: the source section, what the plan owns (files it may rewrite), what it touches additively, the
interface it fixes or consumes, and the checks this plan adds to the source's Check list. The source section holds
the steps and the full Check.

### Wave 1

**38 · Index: capture time and photo stats** — CULL 7 (38), data in CULL 5. Size 1.5.
Owns: `crates/develop/src/stats.rs` (new), `crates/develop/src/decode/camera_meta.rs` (`taken`, `lens`, `focal`,
`serial`), `commands/assets.rs` (`Meta`, `AssetInfo`, `prepare`, `cached` backfill), `commands/folders.rs`
`IndexEntry`, `lib/tauri.ts` `IndexEntry`, the prepare patch in `store/library.ts`, `libraryKeys` sort
(`store/collections.ts`), the Design filmstrip sort, a `photobook stats <folder>` subcommand in `packages/publish`.
Fixes: the index-field pattern and the backfill (section 4). Adds: `image_hasher` (MIT / Apache-2.0) to the develop
crate behind no feature (pure Rust); the fixture photos under `crates/develop/tests/fixtures/stats/` (sharp,
defocused, panned, bokeh portrait, blown, dark, silhouette, high-key: synthetic, generated by a script in
`scripts/`, so 41 and 53 share them). Added checks: `prepare` timing on the lisbon fixture before and after (the
+20 ms rule of section 1); `cargo check -p photobook-develop --no-default-features`.

**43 · Native shell and the Tauri artifacts** — UI 1 (the audit), 4.3, 6 (43). Size 2.
Owns: `tauri.conf.json` (product name, title, overlay title bar, theme, traffic-light position), `index.html`
title, `main.tsx` (the `contextmenu`, `dragstart` and reload guards), the base layer of `styles.css` (selection,
drag, overscroll; 44 takes over the file after), `src-tauri/src/menu.rs` (new, the native menu behind the flag) and
`set_text_focus`, the `scrollbar` audit of every `overflow-*` container (recorded in the plan file), the Design
canvas scroll box (`Canvas.tsx` overflow rule and whole-pixel content box), the Home wordmark line in
`routes/home.tsx`, the sidebar context menu extended to folders and projects (`Sidebar.tsx`, existing `Popover`).
Does not: build the Develop strip, page strip or Cull menus (45, 52). Added checks: the kitchen sink is not yet
there, so 43's check runs in a browser for the CSS rules (a selection cannot be started outside a text field) and
by the dev log for the menu (`[photobook:menu]` lines on each item, one per press). The release `.app` check (no
Inspect Element) is a build the user runs by hand; record it as unverified in the Status line if not.

### Wave 2

**39 · Groups in the grid** — CULL 4.2, 6, 7 (39). Size 2.
Owns: `packages/shared/src/cull/groups.ts` (new, `groupPhotos`, `suggestedBest`, `GroupSettings`), `store/cull.ts`
(new), `components/cull/CullGrid.tsx` (unit rows, group cell, expansion), `components/cull/keys.ts` (G, `,` `.`,
Cmd+G), `components/cull/CullFilters.tsx` (new: the Group toggle and menu), the right-click group items are 52's.
Touches: `store/ui.ts` (`ui.cull.grouped | showStars | expanded`), `packages/shared/src/library.ts`
(`photos[hash].cull.group`), `CompareView` and `SurveyView` entry from a group, `CullMenu.tsx` (Merge, Split,
Detach). Added checks: a burst fixture folder (`scripts/make-burst-fixture.py`: one scene, twelve frames with
subsecond `taken`, two of them re-shot after 20 s, one from a second camera) that the Vitest grouping test and the
human check both use; `groupPhotos` on 10 000 synthetic entries under 50 ms.

**44 · Tokens v2** — UI 2.2, 2.3, 6 (44). Size 1.5.
Owns: `styles.css` `@theme` and utilities, `scripts/check-palette.mjs` and its `pnpm lint` hook (root
`package.json`), the semantic replacement of the palette classes across `apps/editor/src` (the one plan allowed to
touch every file, for class names only), `ui.surround` in `store/ui.ts` and Settings → Appearance
(`routes/settings.tsx`), the `/fixture` Kitchen sink tab (`components/fixture/KitchenSink.tsx`, no `invoke` on
mount). Fixes: the token names (section 4). Added checks: the sink renders at `http://localhost:1420/fixture` under
`editor-web`; the agent screenshots it there for the review; the stage swatch's computed colour has zero chroma.

### Wave 3

**40 · The Decide pass, target and progress** — CULL 4.1, 4.3, 7 (40). Size 2.
Owns: `components/cull/DecideView.tsx` (new), `CullFilters.tsx` (Decide, progress), the key table in `keys.ts`,
the Keep / Reject / Undecided relabelling across Cull (`CullMenu`, filter bar labels, hints, README), the folder
row's check in `Sidebar.tsx` (one line). Touches: `store/ui.ts` (`view: 'decide'`, `decide`), shared
`FlagFilterSchema` (`'undecided'`), `matchesFilter`, `LibrarySchema` top-level `cull`, `store/library.ts`
(`patchLibrary`), `CullView.tsx` (the view switch). Consumes: 38's `sharpestTile` for Space. Added checks: the
decision log survives a stage switch and is dropped on a source change; the pause nudge never steals focus.

**45 · Primitives and the shell** — UI 4.1, 3 (Shell, Library sidebar), 6 (45). Size 2.5.
Owns: `components/ui/*` (new), `DialogShell` move, the Toast host in `main.tsx`, the shell migration: `TopBar.tsx`,
`StageTabs.tsx` (sliding segmented control), `ProjectMenu.tsx`, `ViewMenu.tsx`, the document drop-down, `Sidebar.tsx`
(rows, counts in mono, the current row's accent bar), `LibraryFilterBar.tsx` (restyle around `CullFilters`),
`JobsBar.tsx` (the progress ring pill), `routes/home.tsx` and `routes/settings.tsx` (controls only; 50 re-lays Home),
the Develop strip and page strip context menus on `Menu.Context`, the "Saved" fade in the top bar (Layout 6). Each
primitive: a Vitest for states and keys, a kitchen-sink entry. Fixes: the primitive API (section 4). Added checks:
every menu in the app opens on Enter, Space and ArrowDown, closes on Escape and returns focus (one shared test
helper); the sink's Shell page screenshot matches UI 3.

### Wave 4

**41 · Technical lenses** — CULL 4.4, 7 (41). Size 1.
Owns: `packages/shared/src/cull/lenses.ts` (new), the Lens select and caveat in `CullFilters.tsx`, the cell badges
and tooltips in `CullGrid.tsx` (the top-right badge row only), the Decide strip's sharpness marks in
`DecideView.tsx` (additive), the *Worth a look* collection in `store/collections.ts`, *Select the group's softer
frames* in `CullMenu.tsx`. Touches: `store/ui.ts` (`lens` on `FilmstripView`), `CollectionFilterSchema`. Consumes
38's stats fixtures. Added check: the lens never writes a flag (a test asserts no library write on lens change).

**42 · The reject pile and the Trash** — CULL 4.5, 7 (42). Size 1.5.
Owns: `src-tauri/src/commands/photos.rs` (new, `trash_photos`), `store/library.ts` `dropPhotos`,
`components/cull/RejectPileView.tsx` (new), the dialog and toast, the entry points (`ProjectMenu.tsx` one item,
`CullMenu.tsx` one item, the Decide end state's button in `DecideView.tsx`, additive). Touches: `lib.rs`,
`lib/tauri.ts`, `capabilities/default.json` if the dialog needs anything (it should not). Added checks: the Rust
test moves into a temp directory's Trash only when `trash` supports it in CI, else asserts the refusal paths; the
dialog's count is the full pile with a filter active (Vitest); the human check (a copy of a real folder, one file put
back from the Trash) is the user's and is listed in section 8.

**46 · Slider v2 and the Develop panel** — UI 4.2, 4.3, 3 (Develop), 6 (46). Size 2.
Owns: `components/develop/Slider.tsx` internals and test, `src-tauri/src/commands/haptic.rs` (new),
`lib/haptic.ts` (new), `DevelopPanel.tsx` (cards, sentence-case titles, per-card reset in the title row, the header
⋯ `Menu`), `BatchBar.tsx` and `VersionStrip.tsx` as floating pills, `LooksSection.tsx` tiles, the split before/after
handle on the picture (`DevelopMode.tsx`, additive), the render-progress dot in the header. Touches: one call site in
`components/editor/` (the guide flash of plan 30) for `tick('alignment')`; `routes/settings.tsx` (the Haptics
switch); `lib.rs`, `lib/tauri.ts`. Fixes: `lib/haptic.ts`. Added checks: the needle on the temperature and hue
tracks is judged on the sink (section 1, slider thumb); the Option+wheel gate has a test that a plain wheel event
leaves the value alone.

**48 · Design canvas chrome** — UI 3 (Design), 6 (48). Size 1.5.
Owns: `components/editor/` chrome: `SelectionOverlay.tsx` (handles), the floating toolbar, `AlignToolbar.tsx`,
Fix spacing, `PageStrip.tsx` tiles, `Inspector.tsx` and `inspectorUi.tsx` on the Develop cards, `Rulers.tsx` colours
and mono labels, the zoom HUD pill, the dot grid, `Toast.tsx` onto the `ui/Toast`. Does not touch `gestures.ts`,
`snap.ts`, `frameMove.ts`, `frameResize.ts` or `pageGuides.ts` (behaviour). Added check: a test that the snap-line,
guide and safe-area colours resolve to `accent`, `guide` and `warn`.

### Wave 5

**47 · Cull, Compare, Survey skin** — UI 3 (Cull), 4.4, 6 (47). Size 1.5.
Owns: `components/cull/*` looks: `CullGrid.tsx` cells (radius, hover lift, the white selection ring and check, the
one sliding accent focus ring, the star pop, flag stamp, reject dim, thumbnail blur-up, the mass-work underline of
Layout 6, the opening stagger), the floating batch pill (`BatchBar` of Cull, shared with Develop's from 46 as
`ui/Pill`), `CompareView.tsx` (zoom segmented control, captions), `SurveyView.tsx` (tile removal with
`view-transition`), `DecideView.tsx` and `RejectPileView.tsx` restyled onto the primitives, the review loupe's chrome
(`components/review/ReviewMode.tsx`). Does not change keys or behaviour. Added checks: the 500-cell arrowing test
asserts no cell re-render (a render counter in the test); the batch pill's bottom padding on the grid.

**50 · Home** — Layout 1, 7 (50). Size 1.
Owns: `routes/home.tsx` (Start row, cover cards, folder rows, See all, the empty state), a `ProjectCover`
component (the first page through the shared renderer at 160 px, cached as a data URL per project id + modified
time), the folder row's cull state (reads the index counts and 40's `culledAt`). Touches: `store/projects.ts` (last
edited, page count in the registry listing, additive). Added checks: a folder marked missing shows no buttons; the
cover render of a project with no pages shows the empty paper, not an error.

**51 · Shell panes** — Layout 2, 3 (left pane), 4.3, 7 (51). Size 1.
Owns: `ui.panes` in `store/ui.ts`, the Tab / Shift+Tab keys (`useEditorShortcuts.ts`, `keys.ts`, `DevelopMode.tsx`,
one handler each), the Filters section in `Sidebar.tsx` (re-parents `CullFilters` plus flag, stars, Edited, ISO ≥,
Sort), `LibraryFilterBar.tsx` reduced to search, view switch, zoom, progress, Decide and the clear chip, the Develop
left pane (`components/develop/DevelopLeftPane.tsx`, new: Looks + Amount, LUTs, Presets, History, Versions as chips;
`LooksSection` and `VersionStrip` move there, their files unchanged), History (reads the book store's undo entries
filtered to the shown asset, no new storage). Added checks: the hidden-pane state is per stage and per machine; the
Develop keys (`[` `]`, Cmd+Shift+C / V) still reach their actions with the left pane hidden.

### Wave 6

**52 · Cull mouse and the Photo pane** — Layout 3 (view switch, mouse grammar, right pane), 7 (52). Size 2.
Owns: the view switch and the one zoom in `LibraryFilterBar.tsx` (Grid · One · Two) and `store/ui.ts`
(`ui.cull.zoom`), double-click and marquee in `CullGrid.tsx`, the right-click menu (`components/cull/CullContextMenu.tsx`,
new, on `Menu.Context`: Keep · Reject · Undecided · Develop this photo · Compare with best · Add to project · Export…
· Group: merge / split / detach · Reveal in Finder · Move to Trash… which opens 42's pile), the Photo pane
(`components/cull/PhotoPane.tsx`, new: Histogram, File, Camera, Signals, In projects; the multi-select summary),
`commands/develop/histogram.rs` (new) and its cache under `cache/<hash>/histogram-<dh>.json`, `shutter`, `aperture`,
`gps` in `camera_meta.rs`, `assets.rs`, `folders.rs`, `lib/tauri.ts`. Added checks: the histogram command is
`ensure_allowed`-scoped and returns within 20 ms from the cache (test); the "map ▸" link opens Apple Maps through a
small Rust command (`open_map(lat, lon)`, the same pattern as `reveal_export`: the webview has no shell or opener
access and gets none).

**54 · Develop Basic ⇄ Advanced** — Layout 4.1, 4.5, 4.6, 7 (54). Size 2.
Owns: `DevelopPanel.tsx` (the seven cards in order: Crop, Light, Color, Detail, Sharpen & denoise, Effects, Masks;
the global Basic ⇄ Advanced switch per machine; in-place ▸ expansion; `·edited` tags), the section files it
re-cuts (`TransformSection` → the Crop card, `WhiteBalanceControls` + the Light rows → Light, `CurveEditor` with the
presets as chips: Linear · Soft S · Strong S · Matte · Faded · Reverse S, as point sets in
`packages/shared/src/develop/curvePresets.ts`, new), the header's Before | After split button (Flip · Split · Side
by side, `Y`) with the side-by-side mode on the linked viewport, *Apply to all ▾* in the batch pill (the Light &
Color subset, the Sync dialog, Apply look). Touches: `store/ui.ts` (`ui.develop.advanced`), `batchSlots.ts`
(one slot). Does not change any render maths (curve presets are points, hashed like a drawn curve). Added checks:
every control reachable in Advanced is reachable from Basic through a ▸ (a test walks the card manifest); a photo
with an advanced edit shows the tag in Basic.

### Wave 7

**53 · Cull assist overlays and Group by** — Layout 3 (Two at once, Groupings), 7 (53). Size 1.5.
Owns: the *Assist* ▾ menu in `CompareView.tsx` and the overlays as one component used by One, Two and Decide
(`components/cull/AssistOverlays.tsx`, new: focus peak, zebra, composition cycle with O, sharpness bars), the
preview shader modes in `crates/develop/src/gpu/` (`PreviewMode::FocusPeak | Zebra`, a view-only pass after the
develop output, never part of the develop hash or the full render; CPU fallback for `PHOTOBOOK_FORCE_CPU=1`),
`render_develop_preview`'s mode argument in `commands/develop.rs` and `lib/tauri.ts`, *Group by* dividers in
`CullGrid.tsx` (Hour, Day, Camera, Lens, Place) from `packages/shared/src/cull/groupBy.ts` (new; 56 reuses it in
Design). Added checks: a parity test that the preview with a mode equals the plain preview with the overlay applied
on the CPU; the overlays write no flag; the full render ignores the mode.

**55 · Color grading wheels** — Layout 4.2, 7 (55). Size 1.5.
Owns: `components/develop/GradingWheel.tsx` (new), the harmony lock (`lib/develop/harmony.ts`, new, pure: the
angle constraints per harmony, what a drag writes), the presets in `packages/shared/src/develop/grading.ts` (new),
`EffectsSection.tsx` (wheels in Basic, Global and luminance in Advanced), the schema (`GradingWheelSchema.luminance`
default 0, `GradingSchema.harmony` optional, both no-ops when absent), the maths in `crates/develop/src/ops/`
(luminance offset per wheel, CPU then GPU, verified in `tests/gpu.rs`), and **the engine bump** to
`develop-engine/4` in both places with the parity fixtures regenerated (`UPDATE_DEVELOP_FIXTURES=1`,
`UPDATE_GEOMETRY_FIXTURES=1`) and the fixture renders under `crates/develop/tests/fixtures/` re-reviewed. Added
checks: a settings file with no `harmony` and `luminance` 0 renders byte-identical to engine 3 on the ON1 samples
(so the bump changes nothing but the hash); the harmony lock is UI state and does not appear in the canonical
settings unless set; `cargo check --no-default-features`.

**56 · Masks, storytelling sorts and the chooser** — Layout 4.4, 5, 7 (56). Size 2.
Owns: `MaskTools.tsx` (the linear drag convention, the rotate handle with the mono angle badge, Shift 15°),
`MaskOverlay.tsx` (the handle glyph shared with radial), the mask right-click menu (`Menu.Context`) and Delete /
Backspace with one undo step, Invert on every mask row (`MasksSection.tsx`, one toggle), the palette in `prepare`
(`crates/develop/src/stats.rs` `palette`, k-means in Oklab on the 240 px thumb; `assets.rs`, `folders.rs`,
`lib/tauri.ts` `palette`), the sorts (colour, luminance, aspect, warmth) in `packages/shared/src/cull/sorts.ts`
(new) used by the Design filmstrip (`Filmstrip.tsx`, `LibraryPanel.tsx`: Sort by ▾, Group by ▾ dividers via
53's `groupBy.ts`) and by 51's Filters section, the "What's next" chooser (`components/design/NextChooser.tsx`,
new: a sheet on `DialogShell` over the canvas on first open of a project with only the book, and under New…; the
five cards call the existing export, post and book paths; the carousel's *one photo per frame* fill in
`store/outputs.ts`). Added checks: a drag from bottom to top makes a mask full at the press (Vitest on the component
written); an old project's masks render unchanged (parity fixture untouched); the chooser never appears when
`outputs` is non-empty or after Skip for that project (per machine).

### Wave 8

**49 · Delight and polish pass** — UI 4.4, 6 (49); Layout 6. Size 1.5.
Owns: the stage crossfade (`router.tsx` route transitions, the picture element kept across Cull → Develop), the
before/after crossfade, the job toast's completion beat (`ui/Toast`, `JobsBar`), the check draw, the denoise sweep
in the loupe (`DenoiseLoupe.tsx`), empty states in Instrument Serif, custom cursors (`public/cursors/`), tooltips
with shortcuts on every icon button, the accessibility and reduced-motion sweeps, removal of the native-menu flag
and of the `components/develop/DialogShell` re-export, the site screenshot set
(`node apps/site/scripts/optimize-images.mjs`). Added checks: an automated sweep lists every `IconButton` without a
`Tooltip` (test); with reduced motion every token duration is 0 (test on computed styles in the sink).

---

## 7. Waits and motion: where each row lands

Layout 6 (the animation vocabulary) names no plan. Assignment:

| Row | Plan |
| --- | --- |
| Instant work, no progress under 300 ms | 46 (the slider path) |
| Short work: the pulsing accent dot on the control that asked | 46 (Develop header), 46 (Looks tile) |
| A job: the progress ring, the 400 ms check hold | 45 (`ProgressRing`, jobs pill), 49 (the completion beat) |
| Many of something: the per-cell underline and "23 of 58" in the pill | 47 (cells), 46 (Develop pill) |
| Opening: counts count up, cells appear with a 60 ms stagger, blur-up | 47, 45 (sidebar counts) |
| Saving: "Saved" fades in for 1.2 s; "Not saved" stays red | 45 |
| Done: the check's 160 ms stroke | 49 |
| Denoise: the sweeping split line | 49 |

---

## 8. Gates

**Per plan** (before the Status line): the source's Check list; `pnpm typecheck`; `pnpm lint` (with the palette
script from 44 on); `pnpm --filter @photobook/shared test` and `pnpm --filter editor test`; `cargo test --lib` in
the crate(s) changed plus the named `--test` suites the plan touches (`gpu`, `parity`, `effects` for 53 and 55);
`cargo check -p photobook-develop --no-default-features` when the develop crate changed (38, 53, 55, 56); the
kitchen sink screenshot in the browser for every skin plan (44–49) attached to the review.

**Per wave**: the full Vitest suites green, both crates' `--lib` tests green, the fixture suites named above, and a
startup smoke of the editor through the dev log (`[photobook:` lines, as in the earlier runs), since the Tauri window
cannot be captured. The reviewer of the wave's last plan also runs the shared-file diff (section 3's column) and
confirms each shared file still has one owner's intent.

**Final** (after 49): everything above, `--no-default-features`, `pnpm build`, the publish CLI's tests, the `.app`
build by the user for the release checks of 43.

**The human checklist** (the owner, a real folder; the agents cannot do these and the Status lines say so):

- 39: a grouped real folder (the lisbon fixture plus the burst fixture) looks right: no burst split, no two scenes
  merged, the suggested best is defensible.
- 40: a Decide pass over a few hundred photos feels like it moves; the end state appears; U brings one back.
- 42: rejects of a *copy* of a folder go to the Trash and one comes back from the Trash into the grid after a rescan.
- 43: traffic lights in the top bar, the window drags from it, no selection anywhere, Cmd+Z in a text field undoes
  typing, right-click shows ours or nothing, the release `.app` has no Inspect Element.
- 46: the detent clicks once per crossing on a Force Touch trackpad; the needle is readable on the hue track.
- 52 and 54: used for a day each before the next wave starts (Layout 7).
- 55: the bump's cost: every cached render re-renders once on open; the ON1 samples look identical.
- 49: the site screenshots.

---

## 9. Docs updated by this programme

- `CLAUDE.md`: the index fields (38, 52, 56), `components/ui` and the tokens (44, 45), `components/cull/` additions
  (39–42, 52, 53), the commands `trash_photos`, `haptic`, `histogram` and the native menu, the rule that the Trash is
  the only delete (42), the `/fixture` Kitchen sink (44), the engine `develop-engine/4` (55), the product name (43).
- `README.md`: the Cull keys and the Decide table (40), groups (39), lenses with the caveat verbatim (41), *Deleting
  photos* (42), the name and the screenshots (43, 49), Basic ⇄ Advanced and the wheels (54, 55).
- `docs/design/DESIGN_NOTES.md`: a dated line per plan (the plan files name them); a note at the top that the skin
  plan wins on looks (UI preamble).
- `docs/design/plans/README.md`: rows 38–56 in the table with these dependencies, the *Order and parallel tracks*
  section extended with section 3's waves, finished plans moved to `archive/plans/`.
- The three source documents: a *Status* line each when their plans are archived.
- `docs/DEVELOP.md` (54, 55), `docs/INSTALLATION.md` (43, the name), `apps/site` copy and screenshots (49).

---

## 10. Risks

| Risk | Where | Mitigation |
| --- | --- | --- |
| The native menu fires a shortcut twice, or swallows one in a text field | 43 | The flag; the dev-log line per item; `set_text_focus`; the flag removed only in 49 after a session of use |
| `user-select: none` on everything breaks a text field or the caption textarea | 43 | The `input, textarea, [contenteditable], .selectable` opt-in; a test that every `Input` and `TextEditor` matches it |
| The overlay title bar's drag region eats clicks on the top bar's controls | 43 | `data-tauri-drag-region` on the bar only, not its children; check Project ▾ and the stage tabs by hand |
| `prepare` gets slower and the first scan of a big folder feels worse | 38 | The +20 ms rule (section 1); stats on the 8-bit proxy already in memory; the backfill runs inside the existing prepare job, never as a scan |
| `CullGrid.tsx` is rewritten by six plans | 39 → 40 → 41 → 47 → 52 → 53 | Strictly serial by wave; the unit-row model (39) is the structure everyone else styles or extends; 47 changes no behaviour |
| The engine bump invalidates every cached render and the parity fixtures | 55 | One bump, last in the Develop chain; the byte-identical test for untouched settings; the fixtures regenerated once |
| The palette replacement (44) touches ninety files at once | 44 | Class names only, by script, reviewed as one diff; no file in wave 2's other plan (39) shares those lines |
| `view-transition` or `linear()` unsupported in the shipped WKWebView | 46, 47 | Feature-detect; fall back to a cut and to `ease-out`; reduced motion covers both anyway |
| Haptics need a new Objective-C dependency in the editor crate | 46 | `objc2-app-kit` only in `src-tauri`, behind `#[cfg(target_os = "macos")]`; the develop crate is untouched |
| The Trash command is the first destructive command on photos | 42 | `ensure_imported_root` + `resolve_rel` per file, the `..` and out-of-root tests, the sidecar rule, per-file results, no key binding |
| Agents cannot see the window | all | The kitchen sink in a browser (44+), the dev log, Vitest with render counters, and the human checklist |

---

## 11. Out of scope

Plan 37 (runs independently), faces and eyes, the "Rate the keepers" survey, AI explanations per group, a light
theme, the identifier rename, offline reverse geocoding, a second visual signal for grouping, and Photobook Cloud
(all named as later work in the source documents).
