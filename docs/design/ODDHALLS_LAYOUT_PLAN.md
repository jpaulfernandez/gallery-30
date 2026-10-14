# oddhalls: stage layouts

Oct 13, 2026 · Companion to [ODDHALLS_UI_PLAN.md](ODDHALLS_UI_PLAN.md) (the skin). This document is the *layout*:
what each screen holds, where, and what is hidden until asked for. The goal in the owner's words: pro tools, but a
layout that is not pro or overwhelming. The rule that follows from it, used for every decision below:

> **One job per region, one job per level.** The centre is the work. The right pane holds the tools for *this* stage
> and shows the basic set first; advanced controls are one click deeper and remembered. The left pane is context
> (what you are working on, what you can pick from). Anything that is not needed for the next decision is not on
> screen.

It is written against the cull research ([CULL_PLAN.md](CULL_PLAN.md), plans 38–42) so nothing here conflicts with
it; where this document names a cull feature, the cull plan owns the behaviour and this one only places it.

Status: plans 50–56 done Oct 13–14, 2026 and archived in [archive/plans/](archive/plans/) (50, 51, 52, 53, 54, 55,
56); the days of use of 52 and 54, the ON1 and re-render checks of 55 and the real-folder use of 53 and 56 are the
owner's, collected in [plan 49's Status](archive/plans/49-delight-and-polish.md).

---

## 1. Home

What you see when the app opens, instead of the current title plus two lists.

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  oddhalls                                                       Settings  ·  Help    │
│                                                                                       │
│  Start                                                                                │
│  [ ▢ Open a folder… ]   [ + New project… ]   [ ⤓ Open project file… ]                 │
│                                                                                       │
│  Recent projects                                                            See all  │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                                         │
│  │ cover  │ │ cover  │ │ cover  │ │ cover  │   title · 24 pages · edited 2 d ago     │
│  └────────┘ └────────┘ └────────┘ └────────┘                                         │
│                                                                                       │
│  Recent folders                                                             See all  │
│  ▢ Lisbon 2026          612 photos · 58 kept · culled ✓        Cull  Develop         │
│  ▢ Studio tests          84 photos · 12 undecided              Cull  Develop         │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **Start row** first, three actions, the first one primary. A folder is the way in for Cull and Develop; a project is
  the way in for Design. The New project dialog is unchanged (title, page size, folder, what to add).
- **Recent projects** as cover cards (the first page rendered by the shared renderer at ~160 px, like Weavy and
  Riverside do with a frame) with title, page count and when it was last edited; the ⋯ menu holds Rename, Reveal,
  Delete. Four most recent, *See all* expands in place.
- **Recent folders** as rows (not cards: a folder has no cover) with the count, the cull state from the index
  (kept / undecided / culled ✓, plan 40) and two buttons that open the folder in that stage. A missing folder shows
  the red *Missing* and no buttons.
- **Empty state**: the Start row and one serif line, "Open a folder to start culling, or make a project to design."
- What goes: the "Photobook" title and tagline, the stacked lists, the dot grid. The wordmark is small, top-left.

References: [Riverside](https://mobbin.com/screens/6b8d37c6-06f4-4dc5-91ef-0012ed598168) (action cards over a
projects grid), [Weavy](https://mobbin.com/screens/a37af3e8-294a-4052-a30c-dd784e8350fe),
[MagicPath](https://mobbin.com/screens/77bb103c-dca2-4181-b1b3-a60d7cd0f96b) (a card's ⋯ menu).

---

## 2. The shell, every stage

```
┌ ● ● ●  Project ▾ / Lisbon 2026        [ Cull | Develop | Design ]         ↶ ↷  Saved  ⚙ ┐
├──────────┬────────────────────────────────────────────────────────┬────────────────────┤
│  LEFT    │                      CENTRE                            │       RIGHT        │
│ context  │                      the work                          │  this stage's tools│
│ 220 px   │                                                        │  300 px            │
│ hideable │                                                        │  hideable          │
├──────────┴────────────────────────────────────────────────────────┴────────────────────┤
│  strip / page strip (stage-specific), 96 px, hideable                                   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- Three panes and a strip in every stage, so the eye learns one map. `Tab` hides both panes (the picture takes the
  window, the Lightroom key); `Shift+Tab` hides the strip too; the state is per stage and per machine.
- The **right pane is always the tools for the stage** (Cull: decide and inspect; Develop: adjust; Design: inspect
  the selection). The **left pane is always context** (Cull: Library and filters; Develop: Looks and history; Design:
  project photos, library, layouts). Nothing moves between stages.
- The top bar is the skin plan's (overlay title bar, sliding segmented stage tabs). The document drop-down of Design
  stays beside the tabs only in Design.

---

## 3. Cull

The cull plan decides *how* culling works (Keep / Reject / Undecided, groups, the Decide pass, lenses, the reject
pile). This section places those things and adds what the owner asked for: a right pane with the photo's information,
two photos at once with helpers, and double-click and right-click behaviour.

```
┌ Library ───────┬ All ▾  ·  ⊞ grid  ▭ one  ⫿ two  ·  zoom ──●──  ·  142/600 decided  [Decide] ┬ Photo ───────────────┐
│ Folders        │                                                                              │ ▁▂▅▇▆▃▁ histogram   │
│  ▸ Lisbon 2026 │   ▢ ▢ ▢ ▢ ▢                                                                  │ DSC_0412.ARW        │
│  ▸ Studio      │   ▢ ▢ ▢ ▢ ▢        the grid (plan 06), groups as stacks (plan 39)            │ 6000 × 4000 · 24 MB │
│ Collections    │   ▢ ▢ ▢ ▢ ▢                                                                  │ Keep ✓  ★★★☆☆       │
│  Keepers  58   │                                                                              │ ─────────────────── │
│  Undecided 142 │                                                                              │ Canon EOS R6        │
│  Soft · Blown  │                                                                              │ RF 50mm f/1.2       │
│ Filters        │                                                                              │ 1/250 · f/2 · ISO 800│
│  Flag  Stars   │                                                                              │ 2026-09-14 18:42    │
│  Group ▾ Lens ▾│                                                                              │ Lisbon, PT (map ▸)  │
│  Sort ▾        │                                                                              │ ─────────────────── │
│ Projects       │                                                                              │ sharpest ● 0.82     │
│  ● Lisbon book │                                                                              │ highlights 1.2 %    │
├────────────────┴──────────────────────────────────────────────────────────────────────────────┴─────────────────────┤
│  12 selected · Keep · Reject · Add to project · Export · ⋯                            (floating pill, skin plan)   │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Centre: one gallery, three views, one zoom.** The view switch sits in the filter bar as a segmented control:
*Grid* (all), *One* (the loupe, today's Review in place), *Two* (Compare, plan 07). The zoom slider is one control for
all three: in Grid it is the column count (J / K), in One and Two it is Fit · 1× · 2× · 4× (the linked viewport of
plan 07). Survey (N) and Decide (Enter, plan 40) stay as views you enter from the grid and leave with Esc; they are
not in the switch because they are passes, not ways of looking.

**Mouse grammar** (the owner's two asks, plus the rest so it is one table):

| Gesture | Grid | One / Two |
| --- | --- | --- |
| Click | select (Shift range, Cmd toggle) | focus the pane |
| Double-click | open **One** on this photo (was: nothing; Space / Enter keep working) | zoom to 1× at the point, again to fit |
| Right-click | menu: **Keep · Reject · Undecided · Develop this photo · Compare with best · Add to project · Export… · Group: merge / split / detach · Reveal in Finder · Move to Trash…** (the last through the reject pile only, plan 42) | same menu |
| Drag | marquee select | pan at > fit |

*Develop this photo* goes to the Develop stage on it (D does the same); the stage keeps the Cull selection.

**Two at once, with helpers.** Compare (plan 07) gains an *Assist* ▾ menu in its header with overlays drawn over
both panes, each a toggle with a key, all off by default, remembered:

| Overlay | Key | What it draws | Source |
| --- | --- | --- | --- |
| **Focus peak** | F | edges above a local-contrast threshold in `accent` at 60 % | Laplacian magnitude on the proxy (plan 38's stats already compute tile sharpness; this is the per-pixel map at proxy size), in the GPU preview shader as a mode |
| **Zebra** | Z | diagonal stripes over pixels with any channel ≥ 250 (and ≤ 5 as a second, dimmer set) | the `clipHigh` test of plan 41 per pixel |
| **Composition** | O (cycle) | thirds · golden ratio · phi spiral · centre cross · diagonals, in white 50 % | same drawing as the crop grid, cycle like Lightroom's O |
| **Sharpness bars** | always in Two | a bar under each pane: this frame's `sharpnessMax` against the group's best | plan 41 |

The overlays also work in One (the loupe) and in the Decide pass, since they are the same picture component. They
never write a flag (the cull plan's rule).

**Right pane: Photo.** Sentence-case cards (skin plan):

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

**Left pane: Library and filters.** The sidebar as today (Folders, Collections, Projects) plus a **Filters** section
between Collections and Projects that takes over the filter bar's controls: flag, stars, *Edited*, *ISO ≥*, *Group*
(plan 39), *Lens* (plan 41), *Sort* (time, name, rating, sharpness, and the colour and luminance sorts of section 5).
The filter bar above the grid keeps only search, the view switch, the zoom, the progress fraction, *Decide* and the
clear-filters chip, so it stops being a row of eleven controls. The **target** ("Keep about 60") lives in the Decide
header as plan 40 says and is echoed in the sidebar's folder row.

**Groupings** to decide better, as *Group by* in the Filters section: *Bursts* (plan 39's groups, the default),
*Hour* (by `taken`), *Day*, *Camera*, *Lens*, *Place* (GPS clusters of 500 m when present). A grouping draws a
labelled divider row in the grid (the date, the lens, the place name from reverse geocoding when offline data is
available, else the coordinates), collapsible; bursts stay stacked cells inside it. Only *Bursts* changes cells; the
others only add dividers, so the cull plan's group model is untouched.

---

## 4. Develop

```
┌ Looks ─────────┬ DSC_0412 · 3 / 58 · 6000×4000 · In the book   [Crop R] [Before|After \ ▾] [Proof] ┬ Adjust ─── Basic ⇄ Advanced ┐
│ ▢ ▢ ▢ ▢        │                                                                                  │ ▸ Crop                      │
│ ▢ ▢ ▢ ▢ looks  │                                                                                  │ ▾ Light                     │
│ Amount ───●──  │                          the picture, on `stage`                                 │   Exposure   ───┼───  +0.30 │
│ LUTs ▾         │                                                                                  │   Contrast   ───┼───    0   │
│ Presets ▾      │                                                                                  │   Highlights ───┼───  −40   │
│ ───────────    │                                                                                  │   Shadows    ───┼───  +25   │
│ History        │                                                                                  │   Whites     ───┼───    0   │
│  Exposure +0.3 │                                                                                  │   Blacks     ───┼───    0   │
│  Look: Wren    │                                                                                  │   [ Curve ▸ ]               │
│  Crop 4:5      │                                                                                  │ ▾ Color                     │
│ ───────────    │                                                                                  │   Temperature · Tint        │
│ Versions       │                                                                                  │   Vibrance · Saturation     │
│  Master  v2 ●  │                                                                                  │   [ Color mix ▸ ]           │
│                ├──────────────────────────────────────────────────────────────────────────────────┤ ▸ Detail                    │
│                │  12 selected · Apply to all · Sync… · Paste · Reset    (floating pill)           │ ▸ Sharpen & denoise          │
│                │  ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢   the strip (plan 08)                              │ ▸ Effects                   │
└────────────────┴──────────────────────────────────────────────────────────────────────────────────┴ ▸ Masks ────────────────────┘
```

### 4.1 Right pane: Adjust, in the owner's order, with Basic ⇄ Advanced

A segmented switch in the pane header, remembered per machine. **Basic** shows the rows below; **Advanced** shows the
same cards with the extra controls expanded inline. Every "▸" button in Basic opens that advanced control *in place*
(the card grows), so Basic is never a dead end and Advanced is never required. An advanced control that is edited
shows in Basic as a `·edited` tag on its button, so nothing is hidden that changes the picture.

| # | Card | Basic | Advanced adds | Today it is |
| --- | --- | --- | --- | --- |
| 1 | **Crop** | the crop tool (R), ratio presets, straighten | Upright (auto · level · guided), perspective, flips, *Keep inside* | `TransformSection` (was fourth) |
| 2 | **Light** | Exposure, Contrast, Highlights, Shadows, Whites, Blacks | **Curve ▸**: the point curve with **presets**: *Linear · Soft S · Strong S · Matte (lifted blacks) · Faded (lifted blacks, pulled whites) · Reverse S*, as chips above the editor; the parametric sliders and splits under it | `Basic` (Light) + `Curve` |
| 3 | **Color** | Temperature, Tint, Vibrance, Saturation | **Color mix ▸**: the eight bands with the Hue · Sat · Lum tabs | `Basic` (White balance) + `Color` |
| 4 | **Detail** | Texture, Clarity, Dehaze | nothing | `DetailSection` first half |
| 5 | **Sharpen & denoise** | Sharpening amount, **AI denoise** (the plan-27/28 picker and amount) | Radius, Detail, Masking; the chroma filter strength (plan 24) | `DetailSection` second half + denoise |
| 6 | **Effects** | **Color grading** (section 4.2), Vignette, Halation, Grain amount | grain size and roughness, vignette midpoint, feather and roundness, halation threshold and radius, grading Blending and Balance | `EffectsSection` |
| 7 | **Masks** | the mask list and the tool strip | per-mask advanced (range sliders of luminance and colour masks, AI refine prompts) | `MasksSection` |

Card order is fixed (crop before tone before colour before detail before effects before masks is the order of
operations and what every tool uses). Looks and presets leave the pane for the left pane (4.3). The header's six
buttons (Presets, Sync…, Copy, Copy…, Paste, Reset all) become one ⋯ menu beside the Basic ⇄ Advanced switch; Copy
and Paste keep their keys.

### 4.2 Color grading as wheels, with harmony lock

Replaces the hue + saturation sliders per wheel.

- Three **wheels** (Shadows · Midtones · Highlights), 88 px each in a row, a fourth smaller *Global* in Advanced. A
  wheel is a hue ring with a saturation radius: drag the dot (angle = hue, distance = saturation, the schema's
  `GradingWheel { hue, saturation }` unchanged), Shift constrains the hue, Alt the saturation, double-click resets;
  the hue and saturation numbers sit under each wheel in mono and are editable. The luminance offset per wheel is a
  thin slider under the number in Advanced (schema addition, default 0, engine bump with plan 19's).
- **Harmony lock** ▾ above the wheels: *Free · Monochromatic · Complementary · Split complementary · Triadic ·
  Tetradic · Analogous*. With a lock on, the three wheels' hues are tied by the harmony's angles (complementary:
  shadows = highlights + 180°, midtones free; triadic: 120° apart; analogous: ±30°; tetradic: 90°; monochromatic:
  one hue, saturation free); dragging any wheel turns the others with it, and the lock draws the tied angles as thin
  spokes on each ring. The lock is UI state saved with the settings (`grading.harmony`, optional, so old files load)
  and does not change the maths: it only decides what a drag writes.
- **Presets** as chips under the wheels: *Teal & orange · Warm/cool split · Bleach · Golden · Moody blue · Pastel*
  (hue/sat triples with Blending and Balance), authored like the built-in looks and listed in
  `packages/shared/src/develop/grading.ts`.

### 4.3 Left pane: Looks, LUTs, presets, history, versions

- **Looks** at the top as the strip is today (plan 20) with Amount; **LUTs** (plan 18) as a row under it; **Presets**
  (the user's) as a list with Save current as preset…. The pane is the "pick a starting point" side; the right pane
  is "adjust".
- **History**: the undo stack of this photo as rows (Exposure +0.30, Look: Wren, Crop 4:5); click one to jump back
  (the Lightroom history panel, which users ask for first when they come from it). Reads the book store's undo
  history filtered to this asset; no new storage.
- **Versions** (plan 08's row) moves here as chips under History; *Use in this project* stays with it.

### 4.4 Masks: the two bugs and the handle

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

### 4.5 Before and after, side by side

The header's **Before | After** button becomes a split button: click = the `\` flip; the ▾ offers *Flip (\)*, *Split
(drag the line)*, *Side by side (Y)*. Side by side shows the before on the left and the after on the right at the
same zoom and point (the linked viewport from Compare, plan 07); the strip and panels stay. The split mode draws the
draggable line of plan 46. Before is the master or the version's base, as today.

### 4.6 Apply to all

The batch pill (plan 08) gains **Apply to all ▾** as its first action: *Apply Light & Color to all n* (the basic
sections only, one click, the common case) · *Apply these sections…* (the Sync dialog, which already exists) ·
*Apply look to all*. With nothing selected the pill reads "Select photos in the strip to apply to several" and
*Apply to all in the strip* applies to every photo the strip shows. One undo step, one job per render as today.

---

## 5. Design: "what is next?"

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

---

## 6. Loading, waiting and saving: the animation vocabulary

One vocabulary for everything that takes time, so a user learns it once. Durations and easing are the skin plan's.

| Kind of wait | Where | What moves | Rule |
| --- | --- | --- | --- |
| **Instant work** (< 300 ms: a slider render) | the picture | nothing; the picture updates | never show progress for under 300 ms |
| **Short work** (0.3–3 s: a proxy render, a look thumb) | on the thing | a 6 px `accent` dot pulses on the control that asked (Develop header, the Looks tile) | no spinner on the picture; the old frame stays until the new one lands, then crossfades 120 ms |
| **A job** (denoise, export, publish, slideshow) | the jobs pill, a toast, the cell | the **progress ring** (16 px, `accent`, `fg` 12 % track) with the count; the ring completes, holds 400 ms with a check, then the toast says what landed | one ring per job, never a bar; a cancelled ring unwinds |
| **Many of something** (mass export, Describe photos, Denoise selected) | the grid or strip | each cell gets a thin `accent` underline that fills as its item finishes, and the batch pill shows the ring and "23 of 58" | the user can keep working; the pill's ring is the only global signal |
| **Opening** (a folder scan, hashing) | the sidebar row and the grid | the row's count counts up in mono; cells appear in order with a 60 ms stagger and the thumbnail blur-up | no skeleton rectangles; empty cells are `panel` with no icon |
| **Saving** | the top bar | "Saved" fades in for 1.2 s after a write, then fades to nothing; a failed save stays as a red "Not saved" with the reason on hover | never a modal, never a spinner |
| **Done** | wherever | the check (a 160 ms draw of the stroke) | one check per job, then it leaves |

Denoise gets one extra: while the model runs, the loupe (plan 28) shows the noisy and the clean half with the
dividing line sweeping once from left to right as the result arrives, so the wait reads as the work being done.

---

## 7. Plans

Continue after the skin plans (43–49). Each is one session in the format of `plans/README.md`.

| # | Plan | Depends on | Size |
| --- | --- | --- | --- |
| 50 | **Home**: Start row, project cover cards, folder rows with cull state, empty state | 44, 45 | 1 |
| 51 | **Shell panes**: left/right/strip hide keys per stage, pane contents moved (Filters section, Looks to the left in Develop), the Develop header ⋯ menu | 45 | 1 |
| 52 | **Cull mouse and right pane**: double-click to One, the right-click menu, the Photo pane (histogram command, File, Camera with `shutter`/`aperture`/`gps` in the index, Signals, In projects), the view switch and the one zoom | 38, 45 | 2 |
| 53 | **Cull assist overlays**: focus peak and zebra as preview shader modes, composition overlays, sharpness bars; *Group by* dividers (hour, day, camera, lens, place) | 41, 52 | 1.5 |
| 54 | **Develop Basic ⇄ Advanced**: the seven cards in order, in-place expansion, curve presets, the edited tags, Apply to all, before/after side by side | 46 | 2 |
| 55 | **Color grading wheels**: the wheel control, harmony lock (`grading.harmony`), presets, per-wheel luminance (engine bump) | 54, 19 | 1.5 |
| 56 | **Masks and storytelling sorts**: linear direction fix, rotate handle, mask right-click and Delete; palette in `prepare`, colour/luminance/aspect/warmth sorts and group dividers in Design and Cull; the "What's next" chooser | 43, 52 | 2 |

Each plan's Check includes a person using it on a real folder; 52 and 54 are the ones that change daily habits and
should be used for a day before the next plan starts.

---

## 8. Open questions

| Question | Recommendation |
| --- | --- |
| Does Basic ⇄ Advanced apply per card or globally? | Globally, with per-card ▸ expansion in Basic; a per-card mode is more state than it is worth |
| Histogram: luminance or RGB? | RGB over luminance, like Lightroom and Capture One; a toggle is not needed |
| Linear mask fix for old masks? | Leave stored masks alone; only the drag changes |
| Reverse geocoding offline? | Coordinates now; an offline place index is its own plan |
| Where does Review (the loupe) go? | It becomes the *One* view of the Cull switch; the route stays |
