# 56 · Masks, storytelling sorts and the chooser

ODDHALLS_LAYOUT_PLAN [7 (56)](../../ODDHALLS_LAYOUT_PLAN.md#7-plans), [4.4](../../ODDHALLS_LAYOUT_PLAN.md#44-masks-the-two-bugs-and-the-handle) (masks), [5](../../ODDHALLS_LAYOUT_PLAN.md#5-design-what-is-next) (the chooser, sort and group for storytelling), [3](../../ODDHALLS_LAYOUT_PLAN.md#3-cull) (the Filters section's Sort), [8](../../ODDHALLS_LAYOUT_PLAN.md#8-open-questions) (decisions); IMPLEMENTATION_PLAN_38-56 [section 1](IMPLEMENTATION_PLAN_38-56.md#1-decisions-to-lock-before-wave-1) (Old linear masks, Context menus), [section 4](IMPLEMENTATION_PLAN_38-56.md#4-cross-plan-interfaces) ("Index fields", "Primitives") and the wave 7 card. Size: 2 days. Depends on: 43, 52, 51

The Layout plan's section 7 has a table row for 56 and no step list of its own; the steps and the Check below are
copied from the sections it names (Layout 4.4, 5, 3, 8, the section 7 row) and the implementation plan's card.

**Masks and storytelling sorts**: linear direction fix, rotate handle, mask right-click and Delete; palette in
`prepare`, colour/luminance/aspect/warmth sorts and group dividers in Design and Cull; the "What's next" chooser.

### Masks (Layout 4.4)

- **Linear gradient direction.** Today a drag from `(x0, y0)` to `(x, y)` writes `from = start`, `to = end`, and
  `rasterise_linear` is 0 at `from` and 1 at `to` (smoothstep along from → to). So a drag from the bottom up makes a
  mask that is full at the *top*, where the drag ended, which is what the owner saw and the opposite of the
  Lightroom and Capture One convention: the effect is strongest where you press and fades toward where you release
  (you start on the sky and pull down into the land). Fix in `MaskTools.tsx` only: a new linear component stores
  `from = end, to = start` (full at the press, fading toward the release); the end-handle labels follow. Existing
  masks are untouched (their stored points already describe their render), and the rasteriser does not change. Add
  an **Invert** toggle to every mask row (`component.invert` exists for `mode`; expose it) for the other case.
- **Rotate handle.** Linear: a third handle on the 50 % line, 24 px past its end, that rotates `from` and `to` about
  their midpoint (Shift snaps to 15°). Radial already has a rotate handle; make it the same glyph and distance so the
  two tools match, and show the angle in a mono badge while rotating.
- **Right-click on a mask.** The browser menu shows because nothing cancels `contextmenu` (skin plan 43 fixes the
  default everywhere). Here: a mask component under the pointer gets **Delete · Duplicate · Invert · Rename · Add to
  this mask ▸ (subtract / intersect) · Convert to…** and Delete / Backspace on a focused component deletes it with
  one undo step.
- Decision (Layout 8): Linear mask fix for old masks? Leave stored masks alone; only the drag changes.

### Design: "what is next?" (Layout 5)

Opening the Design stage with a project that has no document beyond the book, or pressing **New…** in the document
drop-down, shows a **chooser** over the canvas instead of a blank page:

```
┌ What's next for 58 keepers? ──────────────────────────────────────────────────────────────┐
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐    │
│  │ ⤓ Export     │ │ ⤓ Export for │ │ ▦ Carousel   │ │ ▤ Photobook  │ │ ▣ Social post│    │
│  │ full quality │ │ social       │ │ 4:5 frames   │ │ pages from   │ │ 4:5 · 3:2 ·  │    │
│  │ JPEG 100 %   │ │ 2048 px sRGB │ │ one per photo│ │ templates    │ │ 9:16 · 1:1   │    │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘    │
│  Also: Print · Slideshow · Describe photos (AI)                                 Skip    │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Export full quality** and **Export for social**: the two export presets (plan 11) on the keepers, with the Export
  dialog pre-filled; one click goes straight to the destination picker.
- **Carousel**: a social post (plan 14) at 4:5 with one frame per keeper, filled in book order (the photo fit inside
  the frame on the post's background), ready to export as `01.jpg …`. New: a *one photo per frame* fill when making
  a post from a selection.
- **Photobook**: the book, auto-laid from templates (today's New project "Add all photos").
- **Social post**: the network picker of plan 14 with the ratio shown first (4:5, 3:2, 9:16, 1:1), network second.
- The chooser is a sheet, not a route; *Skip* goes to the blank book, and the same cards live under **New…** forever.

**Sort and group for storytelling.** The Design left pane's Project tab (the filmstrip) and the Library tab gain
*Sort by* ▾: time · name · rating · **colour** (dominant hue, then lightness: a 5-colour palette per photo computed in
`prepare` from the 240 px thumb, k-means in Oklab, stored in `meta.json` and the index as `palette`) · **luminance**
(median, plan 38) · **aspect** (portrait, square, landscape) · **warmth** (mean b* of Oklab). And *Group by* ▾:
*Day · Place · Camera · Colour family · Aspect*, drawn as labelled dividers in the strip, so a book can be built by
picking from "the blue evening ones" or "the portrait-orientation ones" without filters. The same two menus appear in
Cull's Filters section (section 3). Place uses GPS (`gps` from this plan) and shows coordinates until a later plan
adds offline reverse geocoding.

From Layout 3: the Filters section's *Sort* (time, name, rating, sharpness, and the colour and luminance sorts of
section 5).

Implementation plan card. Owns: `MaskTools.tsx` (the linear drag convention, the rotate handle with the mono angle
badge, Shift 15°), `MaskOverlay.tsx` (the handle glyph shared with radial), the mask right-click menu
(`Menu.Context`) and Delete / Backspace with one undo step, Invert on every mask row (`MasksSection.tsx`, one
toggle), the palette in `prepare` (`crates/develop/src/stats.rs` `palette`, k-means in Oklab on the 240 px thumb;
`assets.rs`, `folders.rs`, `lib/tauri.ts` `palette`), the sorts (colour, luminance, aspect, warmth) in
`packages/shared/src/cull/sorts.ts` (new) used by the Design filmstrip (`Filmstrip.tsx`, `LibraryPanel.tsx`: Sort by
▾, Group by ▾ dividers via 53's `groupBy.ts`) and by 51's Filters section, the "What's next" chooser
(`components/design/NextChooser.tsx`, new: a sheet on `DialogShell` over the canvas on first open of a project with
only the book, and under New…; the five cards call the existing export, post and book paths; the carousel's *one
photo per frame* fill in `store/outputs.ts`). Interfaces: 56 adds `palette` (five Oklab colours as hex) to the index's
`PhotoFacts` with a `FACTS_VERSION` bump (the index and the library stay at version 1; `cached()` backfills it).

- Check: a drag from bottom to top makes a mask full at the press (Vitest on the component written); an old
  project's masks render unchanged (parity fixture untouched); the chooser never appears when `outputs` is non-empty
  or after Skip for that project (per machine); `prepare` stays within the +20 ms rule with the palette (measured on
  the lisbon fixture); `cargo check -p photobook-develop --no-default-features` builds. Each plan's Check includes a
  person using it on a real folder (Layout 7, the owner's).

**Docs.** `CLAUDE.md` index fields (`palette`); `docs/CODEMAP.md` (sorts, `NextChooser`, palette);
`docs/design/DESIGN_NOTES.md` a dated line.

Status: done 2026-10-14 (the owner's real-folder use pending). Landed: **masks**: `MaskTools.tsx` stores a new linear
gradient as `from` = the release, `to` = the press (the rasteriser is 1 at `to`: full at the press), with the end
handles titled; a rotate handle on the linear's 50 % line (half the gradient's length plus 24 px, kept inside the box)
turns both ends about their midpoint on screen, Shift snaps the direction to 15°; the radial's rotate drag snaps with
Shift too; both show the mono angle badge (`AngleBadge`) while turning and draw the same glyph (`RotateHandle`,
`ROTATE_GAP` 24, `HANDLE_R` in `MaskOverlay.tsx`). Old masks keep their points (no schema, no maths change;
`--test parity` 4/4 green). `MaskMenu.tsx`: `MaskContextMenu` on `Menu.Context` (Delete ⌫ · Duplicate · Invert ✓ ·
Rename… · Add to this mask ▸ · Convert to…), on the mask rows, the component rows and the picture under an active tool;
every item one undo step. *Inv* toggle on every mask row (`mask.invert`). Delete / Backspace on a selected mask without
a component removes it (one undo step; never from a text field, a slider or a menu); a selected component stays
`DevelopMode`'s. **Palette**: `stats::palette` (five `#rrggbb`, largest cluster first; k-means++ from a fixed xorshift
seed and at most 12 Lloyd passes in Oklab over the image box-averaged in linear light to 240 px; pure Rust, no feature),
in `prepare` from the proxy pixels with the stats (`ProxyFacts`), in `PhotoFacts` / `facts_of` / `Meta`, backfilled by
`cached()` from `proxy.jpg` (`FACTS_VERSION` 3), `IndexEntry` (`folders.rs` test), `lib/tauri.ts`, `PHOTO_FACT_KEYS`,
the Vitest prepare-patch test. **Timing** (`prepare_timing_lisbon`, release, best of three, 16 photos, M-series with
other agents building): before 72.8 / 76.5 ms a photo, after 72.9 / 71.1 / 70.9 ms, inside the noise, far under +20 ms;
`palette` alone is about 4.3 ms on a 960 × 640 fixture frame (`--test stats -- --nocapture`, release). **Sorts**:
`packages/shared/src/cull/sorts.ts` (`storyComparator`, `PHOTO_SORTS`: time · name · rating · sharpness · colour ·
luminance · aspect · warmth; `storyGroups`: day, place, camera through 53's `groupBy`, colour family and aspect here);
`FilmstripSort` is `PhotoSort`; `visibleItems` and `libraryKeys` sort through it (ties by capture time); Design's
Project tab has Sort by ▾ and Group by ▾ (`FilmstripView.groupBy`) with divider rows (`itemSections`, `gridRows`,
`GroupDivider`), the Library tab Group by ▾ with the same rows, the sidebar's Filters Sort lists every sort; review
order follows the sections. **Chooser**: `components/design/NextChooser.tsx` on `DialogShell`, mounted by
`routes/book.tsx`; opens by itself when `outputs` is empty and the project is not marked seen on this machine
(`photobook.design.chooserSeen.<projectId>`); New… in `OutputMenu.tsx` opens it; cards: Export full quality / Export
for social (the Export dialog on the keepers with the built-in preset chosen), Carousel (`addPhotoPost` in
`store/outputs.ts`: a 4:5 post, one frame per keeper in book order, the photo fit inside by `photoDropFrame`, new ids
from `newId()`, capped at the network's 20), Photobook, Social post (ratio first, then plan 14's networks); Also: Print ·
Slideshow · Describe photos (AI); Skip. **Group by ▾**: done (53's `groupBy.ts` was there). Kitchen sink: the
Primitives page's Develop block has the mask tools over a stand-in picture (linear and radial, no `invoke`), the Design
page a "Show the What's next chooser" button; `docs/design/reference/kitchen-sink-56.png` (the linear mask, rotate
handle and right-click menu) and `kitchen-sink-56-chooser.png`. Checks: the Check list above (Vitest: a drag from
bottom to top is full at the press, in `MaskTools.test.tsx`; the chooser's first open, Skip and non-empty `outputs`, in
`OutputMenu.test.tsx`; `--test parity`; the timing; `--no-default-features`), `pnpm typecheck`, `pnpm lint`,
`pnpm --filter editor test` (1513), `cargo test -p photobook-develop --lib`, `--test stats`, `--test parity`,
`cargo test --lib` and `cargo check` in `src-tauri`. `pnpm --filter @photobook/shared test` has one failure that is
plan 55's (`parity.test.ts` "grading-wheels.json", its fixture in progress); `sorts.test.ts` is green. Deviations:
Convert to… is linear ⇄ radial only (disabled with a reason on other kinds); Add to this mask ▸ offers Subtract and
Intersect with the five drawing and range tools (AI masks stay in the section's own Add menus); Rename is a field in the
menu; the picture's right-click works while a tool is active (idle, the tools layer takes no events) and targets the
selected mask or component rather than hit-testing; the palette is computed from the proxy pixels box-averaged to
240 px rather than from the 256 px `thumb.jpg`; warmth is the mean Oklab b of the five palette colours (unweighted), not
of every pixel; colour sorts by eight hue families plus neutral, then lightness; every surface lists all eight sorts
(the Cull and Design views share `FilmstripView.sort`); Design's Group by lives in the Project and Library tabs, Cull
keeps 53's; New… now opens the chooser (the drop-down's kind and network lists moved into it); any choice, not only
Skip, marks the chooser seen, and Escape is Skip; Photobook goes to the book with the Layouts tab open (no auto-layout
path exists, and the plan allows no new one); the export cards leave the user to press Export (then the destination
picker). Not verified: the running Tauri window and a real folder (the owner's), a real pointer drag of the rotate
handle (Vitest and the sink only), the export cards end to end (the dialog needs Tauri). Review fixes (same day): Skip and Escape go to the book
only when the chooser opened by itself; from New… they just close it (test on a post); `useMemo` for the keepers'
capture order; the mask Delete / Backspace listener returns while a dialog is open (`dialogOpen()`, test) and
`DevelopMode`'s component delete also skips a key from a menu; Shift snaps the radial's on-screen angle (stored angle
plus the straighten turn, stored back in frame terms) and its badge shows the on-screen angle; Rename stores the
trimmed name.
