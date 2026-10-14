# 53 · Cull assist overlays and Group by

ODDHALLS_LAYOUT_PLAN [7 (53)](../../ODDHALLS_LAYOUT_PLAN.md#7-plans), [3](../../ODDHALLS_LAYOUT_PLAN.md#3-cull) (Two at once, with helpers; Groupings), [8](../../ODDHALLS_LAYOUT_PLAN.md#8-open-questions) (decisions); IMPLEMENTATION_PLAN_38-56 [section 1](../../plans/IMPLEMENTATION_PLAN_38-56.md#1-decisions-to-lock-before-wave-1) (Engine bump, Place), [section 4](../../plans/IMPLEMENTATION_PLAN_38-56.md#4-cross-plan-interfaces) ("Index fields", "`ui.cull`", "Pane state") and the wave 7 card. Size: 1.5 days. Depends on: 41, 52

The Layout plan's section 7 has a table row for 53 and no step list of its own; the steps and the Check below are
copied from the sections it names (Layout 3, 8, the section 7 row) and the implementation plan's card.

**Cull assist overlays**: focus peak and zebra as preview shader modes, composition overlays, sharpness bars;
*Group by* dividers (hour, day, camera, lens, place).

- **Two at once, with helpers.** Compare (plan 07) gains an *Assist* ▾ menu in its header with overlays drawn over
  both panes, each a toggle with a key, all off by default, remembered:

  | Overlay | Key | What it draws | Source |
  | --- | --- | --- | --- |
  | **Focus peak** | F | edges above a local-contrast threshold in `accent` at 60 % | Laplacian magnitude on the proxy (plan 38's stats already compute tile sharpness; this is the per-pixel map at proxy size), in the GPU preview shader as a mode |
  | **Zebra** | Z | diagonal stripes over pixels with any channel ≥ 250 (and ≤ 5 as a second, dimmer set) | the `clipHigh` test of plan 41 per pixel |
  | **Composition** | O (cycle) | thirds · golden ratio · phi spiral · centre cross · diagonals, in white 50 % | same drawing as the crop grid, cycle like Lightroom's O |
  | **Sharpness bars** | always in Two | a bar under each pane: this frame's `sharpnessMax` against the group's best | plan 41 |

  The overlays also work in One (the loupe) and in the Decide pass, since they are the same picture component. They
  never write a flag (the cull plan's rule).
- **Groupings** to decide better, as *Group by* in the Filters section: *Bursts* (plan 39's groups, the default),
  *Hour* (by `taken`), *Day*, *Camera*, *Lens*, *Place* (GPS clusters of 500 m when present). A grouping draws a
  labelled divider row in the grid (the date, the lens, the place name from reverse geocoding when offline data is
  available, else the coordinates), collapsible; bursts stay stacked cells inside it. Only *Bursts* changes cells; the
  others only add dividers, so the cull plan's group model is untouched.
- Decisions (Layout 8, implementation plan 1): Reverse geocoding offline? Coordinates now; an offline place index is
  its own plan. Engine bump: one bump, to `develop-engine/4`, at the end of 55; no other plan in 38–56 changes render
  maths. Focus peak and zebra (53) are preview-only shader modes outside the develop hash.

Implementation plan card. Owns: the *Assist* ▾ menu in `CompareView.tsx` and the overlays as one component used by
One, Two and Decide (`components/cull/AssistOverlays.tsx`, new: focus peak, zebra, composition cycle with O,
sharpness bars), the preview shader modes in `crates/develop/src/gpu/` (`PreviewMode::FocusPeak | Zebra`, a view-only
pass after the develop output, never part of the develop hash or the full render; CPU fallback for
`PHOTOBOOK_FORCE_CPU=1`), `render_develop_preview`'s mode argument in `commands/develop.rs` and `lib/tauri.ts`,
*Group by* dividers in `CullGrid.tsx` (Hour, Day, Camera, Lens, Place) from `packages/shared/src/cull/groupBy.ts`
(new; 56 reuses it in Design). Added checks: a parity test that the preview with a mode equals the plain preview with
the overlay applied on the CPU; the overlays write no flag; the full render ignores the mode.

- Check: the preview with a mode equals the plain preview with the overlay applied on the CPU (GPU against CPU within
  the `tests/gpu.rs` tolerance; `PHOTOBOOK_FORCE_CPU=1` takes the CPU path); the mode is never part of the develop
  hash, the canonical settings, a cache key or the full render (`render_develop_full` ignores it: test); the overlays
  write no flag (Assist toggles and O cycles leave the library untouched); dividers do not change the selection, the
  keys or the units (39); `cargo check -p photobook-develop --no-default-features` builds (the preview modes have no
  feature gate). Each plan's Check includes a person using it on a real folder (Layout 7, the owner's).

**Docs.** `CLAUDE.md` one line (preview modes are outside the develop hash); `docs/CODEMAP.md` (`AssistOverlays`,
`groupBy`, the preview modes); `crates/develop/README.md` (preview modes); `docs/design/DESIGN_NOTES.md` a dated line.

Status: done 2026-10-14. Landed: `crates/develop/src/preview_modes.rs` (`PreviewMode::FocusPeak | Zebra`, the CPU
reference `apply_preview_mode_cpu` in integer maths: Rec. 709 luma, 4-neighbour Laplacian ≥ 64 painted the accent at
60 %; zebra stripes 4 px wide over any channel ≥ `CLIP_HIGH` and, dimmer and the other way, every channel ≤
`CLIP_LOW`; with both, each test reads the plain pixels, focus peak is painted first and zebra over it:
`apply_preview_modes(_cpu)`; `apply_preview_mode` picks the backend like a render), the GPU pass `gpu/preview_mode.rs` +
`shaders/preview_mode.wgsl` (one `u32` per pixel up and back, the modes as bit flags, constants printed from the Rust ones; its own module, so
`engine.rs`, `kernels.rs` and the chain are untouched), `render_preview_image_with` (the preview before the encode),
no feature gate. `render_develop_preview(..., modes?: string[])` in `commands/develop.rs` (`parse_preview_modes`,
`with_modes` → `apply_preview_modes` after the develop and before the encode; never cached) and `lib/tauri.ts` (`PreviewMode`,
`modes` on `renderDevelopPreview`); `usePreview` needed nothing. `packages/shared/src/cull/groupBy.ts`
(`groupBy(entries, key: 'hour' | 'day' | 'camera' | 'lens' | 'place') → { key, label, ids }[]`, sections in
first-appearance order, ids in input order, the photos without the fact last under `MISSING_KEY` `''`; UTC getters for
the camera clock; places are 500 m clusters around their first photo labelled by coordinates; `cameraName`,
`coordinatesLabel`, `distanceM`, `GROUP_BY_KEYS`, `GROUP_BY_LABELS`). `components/cull/AssistOverlays.tsx`
(`AssistOverlays` over the picture of One (`OnePicture`), Two (`ComparePane`, through `ViewportPicture`'s new
`overlay` prop) and Decide (`DecidePicture`); `AssistMenu` in Compare's and Decide's headers; `useAssistKeys`: F, Z,
O / Shift+O through `assistKeyAction` in `keys.ts`, never in text fields, menus or dialogs; the mode JPEGs requested one
at a time with a fresh preview job each and kept as 12 in-memory blob URLs keyed by photo, settings, profile and modes,
ref-counted while an overlay shows one (`holdModeUrl`), so eviction never revokes a picture on screen;
the composition guides as SVG in `fg` at 50 %; `SharpnessBar` under each Two pane from `groupSharpness`, against the
group's sharpest, else the other pane). `ui.cull.assist` and `ui.cull.groupBy` (optional fields, per machine under
`photobook.ui.cullAssist` / `photobook.ui.cullGroupBy`). `CullGrid.tsx`: divider rows (`DIVIDER_HEIGHT` 28 px,
`rowTops` for the virtualizer, the focus ring, the restore and the marquee; up / down skip them), one divider per run
of units of a section, so the cells keep `review.ids` order (Shift ranges and One's and Two's steps agree with the
grid); a click collapses every run of a section (`ui.cull.collapsed`, per machine under `photobook.ui.cullCollapsed`,
by Group by key and section key) and moves the focus off the hidden cells (the next shown cell, else the one before; a
selection of just that photo moves with it); `GroupBySelect` mounted in `CullFilters`. Photo pane Signals: "In its group" (0.82 of the
sharpest ●). Kitchen sink → Cull: camera dividers in the live grid, the five guides and the bar on a synthetic picture
with the live *Assist* menu (`docs/design/reference/kitchen-sink-53.png`). Tests: `preview_modes` unit tests and
`--test preview_modes` (GPU equals the CPU exactly, asserted as equality, on the chart and photo fixtures at 1600
and 333 px, three settings, each mode alone and both in either order; the CPU backend gives the reference; a mode inside settings JSON never reaches the hash); `src-tauri`
`a_preview_mode_draws_over_the_plain_preview_and_never_reaches_the_full_render` (the bytes equal the plain preview plus
the CPU overlay, the small-edge path, both modes tested on the plain pixels, the full render byte-identical before and after, no file
named for a mode); `groupBy.test.ts`; `AssistOverlays.test.tsx` (keys, the cycle, the guides, Two / One / Decide
toggles request the modes and write no flag, the menu, persistence, dividers by day and camera leave the list and
units alone, the cells in list order and a Shift range across dividers selecting exactly the span shown, down skips a
divider, collapse moving the focus (after, else before) so P never flags a hidden photo, the collapsed sections
persisted, a held mode URL not revoked by eviction, `rowTops` with `cellsInRect`). Checks run:
`cargo test -p photobook-develop --lib`, `--test gpu`, `--test parity`, `--test effects`, `--test preview_modes` (also
with `PHOTOBOOK_FORCE_CPU=1`), `cargo check -p photobook-develop --no-default-features`, `cargo test --lib` and
`cargo check` in `src-tauri`, `pnpm --filter @photobook/shared test`, the Cull Vitest suites, `pnpm typecheck` for the
editor, Biome and the palette script on this plan's paths. Deviations: Compare's fit moved from F to Shift+F (the
Layout table gives F to focus peak; `COMPARE_KEYS`, the README and `CompareSurvey.test.tsx` follow); the argument is
`modes` (a list, so focus peak and zebra show together) rather than one `mode`; Group by is a select beside plan 39's
Group toggle (Bursts stays that toggle, so "No dividers" is the default rather than "Bursts"; decision of the
review, 2026-10-14: it stays so for now, and folding Bursts into one Group by control is a named follow-up on plan
49's polish list); a section whose photos are apart in the list (a sort other than time, two cameras used in turn)
gets one divider per run, never reordered cells; the grid keyboard-parity test skips the
assist keys (they need a picture); focus peak and zebra are not drawn in the kitchen sink (Rust renders them and the
sink never calls `invoke`). Not verified: the overlays in the running Tauri editor (no `tauri dev`), the look of focus
peak and zebra on real photos (the threshold 64 and the stripe width are first guesses), the latency of a mode render on
a RAW (the overlay is the RAW developed by Rust, while the picture under it may be the camera's embedded JPEG), and the
owner's use on a real folder (Layout 7). After the review fixes `pnpm typecheck` and `pnpm lint` pass (Biome sorted
the `ui.ts` import list, which 56's `PhotoSort` had left out of order); `pnpm --filter editor test` failed earlier only
on plan 55's files in progress (`EffectsSection.test.tsx`, `looks.test.ts`). Follow-ups: plan 56 reuses `groupBy`
for the Design filmstrip; a person tunes `PEAK_THRESHOLD` on real folders; plan 49 folds Bursts into Group by.
