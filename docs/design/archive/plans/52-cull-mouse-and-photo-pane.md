# 52 · Cull mouse and the Photo pane

ODDHALLS_LAYOUT_PLAN [7 (52)](../../ODDHALLS_LAYOUT_PLAN.md#7-plans), [3](../../ODDHALLS_LAYOUT_PLAN.md#3-cull) (the view switch, the mouse grammar, the right pane), [8](../../ODDHALLS_LAYOUT_PLAN.md#8-open-questions) (decisions); IMPLEMENTATION_PLAN_38-56 [section 1](IMPLEMENTATION_PLAN_38-56.md#1-decisions-to-lock-before-wave-1) (Histogram, Place, Review), [section 4](IMPLEMENTATION_PLAN_38-56.md#4-cross-plan-interfaces) ("Index fields", "`ui.cull`", "Commands", "Pane state") and the wave 6 card. Size: 2 days. Depends on: 38, 45, 47, 39, 42

The Layout plan's section 7 has a table row for 52 and no step list of its own; the steps and the Check below are
copied from the sections it names (Layout 3, 8, the section 7 row) and the implementation plan's card.

**Cull mouse and right pane**: double-click to One, the right-click menu, the Photo pane (histogram command, File,
Camera with `shutter`/`aperture`/`gps` in the index, Signals, In projects), the view switch and the one zoom.

- **Centre: one gallery, three views, one zoom.** The view switch sits in the filter bar as a segmented control:
  *Grid* (all), *One* (the loupe, today's Review in place), *Two* (Compare, plan 07). The zoom slider is one control
  for all three: in Grid it is the column count (J / K), in One and Two it is Fit · 1× · 2× · 4× (the linked viewport
  of plan 07). Survey (N) and Decide (Enter, plan 40) stay as views you enter from the grid and leave with Esc; they
  are not in the switch because they are passes, not ways of looking.
- **Mouse grammar** (the owner's two asks, plus the rest so it is one table):

  | Gesture | Grid | One / Two |
  | --- | --- | --- |
  | Click | select (Shift range, Cmd toggle) | focus the pane |
  | Double-click | open **One** on this photo (was: nothing; Space / Enter keep working) | zoom to 1× at the point, again to fit |
  | Right-click | menu: **Keep · Reject · Undecided · Develop this photo · Compare with best · Add to project · Export… · Group: merge / split / detach · Reveal in Finder · Move to Trash…** (the last through the reject pile only, plan 42) | same menu |
  | Drag | marquee select | pan at > fit |

  *Develop this photo* goes to the Develop stage on it (D does the same); the stage keeps the Cull selection.
- **Right pane: Photo.** Sentence-case cards (skin plan):
  1. **Histogram**: RGB over luminance, 80 px, from the proxy (a Rust command `histogram(hash, dh)` returning 3 × 256
     bins, cached per develop hash; the same card is reused in Develop).
  2. **File**: name, pixel size, file size, format, the Keep / Reject state and the stars (editable here too).
  3. **Camera**: make, model, lens, focal length, shutter, aperture, ISO, taken, and location when GPS exists (a small
     "map ▸" that opens Apple Maps). Plan 38 adds `taken`, `lens`, `focal`; this plan adds `shutter`, `aperture`,
     `gps` to `meta.json` and the index (all optional, library stays v1).
  4. **Signals** (only when stats exist): sharpest tile, blown share, median luminance, with the plan-41 caveat in a
     tooltip.
  5. **In projects**: which projects place this photo (from the registry), each a link.

  With several photos selected the pane shows the count and what they share (same camera, date range) and the batch
  actions; with none, it says "Select a photo".
- Decisions (Layout 8): Histogram: RGB over luminance, like Lightroom and Capture One; a toggle is not needed.
  Reverse geocoding offline? Coordinates now; an offline place index is its own plan. Where does Review (the loupe)
  go? It becomes the *One* view of the Cull switch; the route stays.

Implementation plan card. Owns: the view switch and the one zoom in `LibraryFilterBar.tsx` (Grid · One · Two) and
`store/ui.ts` (`ui.cull.zoom`), double-click and marquee in `CullGrid.tsx`, the right-click menu
(`components/cull/CullContextMenu.tsx`, new, on `Menu.Context`: Keep · Reject · Undecided · Develop this photo ·
Compare with best · Add to project · Export… · Group: merge / split / detach · Reveal in Finder · Move to Trash… which
opens 42's pile), the Photo pane (`components/cull/PhotoPane.tsx`, new: Histogram, File, Camera, Signals, In projects;
the multi-select summary), `commands/develop/histogram.rs` (new) and its cache under
`cache/<hash>/histogram-<dh>.json`, `shutter`, `aperture`, `gps` in `camera_meta.rs`, `assets.rs`, `folders.rs`,
`lib/tauri.ts`. Interfaces: 52 adds `shutter`, `aperture`, `gps { lat, lon }` to the index's `PhotoFacts` (the index
and the library stay at version 1; `cached()` backfills them); `ui.cull` gains `zoom` only (One = `'review'`, Two =
`'compare'`), mapped onto `columns` in Grid and the linked viewport in One and Two; the Photo pane mounts in 51's
right pane.

- Check: the histogram command is `ensure_allowed`-scoped and returns within 20 ms from the cache (test); the
  "map ▸" link opens Apple Maps through a small Rust command (`open_map(lat, lon)`, the same pattern as
  `reveal_export`: the webview has no shell or opener access and gets none); double-click opens One, the right-click
  menu lists the items above and leaves text fields their system menu, a marquee selects, and no menu item writes a
  flag except through the store actions (never an undo step); a folder scanned before gains `shutter`, `aperture` and
  `gps` on its next prepare without a rescan; the pane shows "Select a photo" with none and the shared facts with
  several. Each plan's Check includes a person using it on a real folder; 52 is one that changes daily habits and
  should be used for a day before the next plan starts (Layout 7, the owner's).

**Docs.** `CLAUDE.md` index fields and the commands line (`histogram`, `open_map`); `docs/CODEMAP.md`;
`docs/design/DESIGN_NOTES.md` a dated line.

Status: done 2026-10-14. Landed: `shutter` (seconds), `aperture` and `gps { lat, lon }` in `camera_meta.rs`
(`ExposureTime`, `FNumber`, the GPS IFD in degrees, minutes, seconds signed by the ref tags; rawler's `exposure_time`,
`fnumber`, `gps` for RAWs; `Gps::valid` drops `0, 0` and out-of-range values), in `PhotoFacts` / `facts_of`
(`commands/assets.rs`, `FACTS_VERSION` 2, so `cached()` reads the Exif again once), `lib/tauri.ts` and
`PHOTO_FACT_KEYS`; the index and the library stay version 1. `histogram(hash, developHash?)`
(`commands/develop/histogram.rs`, a sibling of `looks.rs`): 256 bins of red, green, blue and Rec. 709 luma from
`cache/<hash>/proxy.jpg` or `proxy-<renderKey>.jpg` (the develop hash, `-p3` for Display P3), never the source,
cached as `histogram.json` / `histogram-<renderKey>.json` (temp + rename), both paths through `ensure_allowed`, run in
`spawn_blocking`; the develop pruning removes a histogram with its develop hash (`develop_hash_of`), and `prepare`
drops `histogram.json` whenever it writes `proxy.jpg` anew (`forget_plain`, all three proxy writers). `open_map(lat,
lon)` (`commands/assets.rs`): `open -b com.apple.Maps https://maps.apple.com/?ll=…&q=…` with the two numbers only,
validated. `ui.cull.zoom` (`'fit' | 1 | 2 | 4`, per machine under `photobook.ui.cullZoom`); `useLinkedViewport` reads
and writes it, so One, Two and the bar share one zoom. `CullViewBar` in `LibraryFilterBar.tsx` (Cull stages): Grid ·
One · Two on `Segmented` (One = `'review'`, Two = `openCompare`, off under two photos; Survey and Decide leave none
pressed) and the zoom (Grid: a range over the columns, right = bigger cells; One / Two: Fit · 1× · 2× · 4×).
`CullGrid`: double-click opens One (as before), a marquee from any press past 4 px (`cellsInRect`; Shift or Cmd adds;
the click ending it is swallowed). `CullContextMenu.tsx` (on `Menu.Context`, `useCullContextMenu` keeps the plan 43
guard; it acts on the selection as the list shows it, never on a photo the filter hides): Keep · Reject · Undecided
(`reviewAssets`, not undo steps) · Develop this photo · Compare with best (`openCompare` with `groupFirst` and `back`:
the group's suggested best, else its next frame; `bestOf` decides when it is on) · Add to project (a project open, library keys) · Export… · Merge /
Split / Detach (`CullGroupItems`, exported from `CullMenu.tsx`) · Reveal in Finder (`revealExport` on the photo's
path) · Move to Trash… (`openRejectPile` only), then `CullMenuItems` with `context` (copy, paste, reset, describe,
denoise, softer frames); on grid cells, One and both Two panes. `CompareView.tsx`: `ViewportPicture` and
`usePictureSource` (out of `ComparePane`), `OnePicture` (One's picture in `ReviewMode` in place); a click focuses, a
double-click zooms to 1× at the point and back to fit, a drag pans. `ReviewMode`: the in-place region is "One: name".
`PhotoPane.tsx` mounted as Cull's right pane in both Cull routes: Histogram (`HistogramSvg`, luminance under the
three channels in `danger` / `ok` / `guide` with the screen blend; the empty `stage` box while it loads; a session
cache of 64), File (name, size, bytes, format, Keep / Reject, stars), Camera (camera, lens, focal · shutter · aperture
· ISO, taken, place with *map ▸*), Signals (sharpest tile, blown, median; the lens caveats on an ⓘ tooltip), In
projects (links, from `placedInProjects`, which gained `ids`; 250 ms after the photo settles); several selected: the
count, kept / rejected, the shared camera, the date range, Keep, Reject, Export…, Clear. Kitchen sink → Cull: the live
pane beside the live grid (synthetic facts, no invoke) and a synthetic histogram. Tests: `camera_meta`
`shutter_aperture_and_gps`; `assets.rs` `plan_52_fields_backfill_once_and_reach_the_facts`, `map_url_takes_a_position_only`;
`histogram.rs` (counts, the cached read under 20 ms with the proxy gone (50 ms in a debug build, so a loaded machine
does not flake it), `forget_plain`, the developed key, the out-of-scope refusal and bad keys); `libraryStages.test.ts` (an index from plan 38 gains the three fields on the next prepare, no rescan);
`CullMouse.test.tsx` (double-click, `cellsInRect`, the marquee, the menu's order, flags outside undo, Reveal, Move to
Trash… only opens the pile, a text field keeps the system menu, One and Two menus, the selection a filter hides,
`bestOf`, `openCompare` with `groupFirst` and `back`, the switch, the zoom mapping and its persistence); `PhotoPane.test.tsx`; `CompareSurvey.test.tsx` moved to double-click.
Deviations: the Layout plan has no step list for 52 (the steps above are its sections 3, 8 and the card).
Decision (review, 2026-10-14; the owner's sign-off deferred to the day of use): with no selection the pane shows the
focused photo (the one the keys act on; the grid always has one), so "Select a photo" shows only with no focus. `ReviewMode` changed beyond its label: in place its picture is `OnePicture`, so the one
zoom, the double-click and the menu work in One. Compare's header keeps its own zoom control, bound to the same
`ui.cull.zoom`. The grid zoom is a native range input (no slider primitive in `components/ui`; Develop's `Slider` is
plan 54's). Signals show the raw sharpest-tile number, not a group-relative one. An edited photo's histogram is of its
developed proxy once rendered, of `proxy.jpg` until then. One has no zoom keys of its own (Compare keeps K / J / F).
Not verified: the running Tauri editor (no `tauri dev`), Apple Maps opening, the menu and pane on a real folder, and
the owner's day of use (Layout 7). Follow-ups: plan 53 draws its overlays on `ViewportPicture` (One and Two) and adds
to the Signals card; plan 49 may drop Compare's header zoom in favour of the bar's.
