# 54 · Develop Basic ⇄ Advanced

ODDHALLS_LAYOUT_PLAN [7 (54)](../../ODDHALLS_LAYOUT_PLAN.md#7-plans), [4.1](../../ODDHALLS_LAYOUT_PLAN.md#41-right-pane-adjust-in-the-owners-order-with-basic--advanced), [4.5](../../ODDHALLS_LAYOUT_PLAN.md#45-before-and-after-side-by-side), [4.6](../../ODDHALLS_LAYOUT_PLAN.md#46-apply-to-all), [8](../../ODDHALLS_LAYOUT_PLAN.md#8-open-questions) (per card or global); IMPLEMENTATION_PLAN_38-56 [section 1](IMPLEMENTATION_PLAN_38-56.md#1-decisions-to-lock-before-wave-1) (Basic ⇄ Advanced), [section 4](IMPLEMENTATION_PLAN_38-56.md#4-cross-plan-interfaces) ("Haptics", "Pane state") and the wave 6 card. Size: 2 days. Depends on: 46, 51

The Layout plan's section 7 has a table row for 54 and no step list of its own; the steps and the Check below are
copied from the sections it names (Layout 4.1, 4.5, 4.6, the section 7 row, the section 8 answer) and the
implementation plan's card.

| 54 | **Develop Basic ⇄ Advanced**: the seven cards in order, in-place expansion, curve presets, the edited tags, Apply to all, before/after side by side | 46 | 2 |

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

Section 8, *Does Basic ⇄ Advanced apply per card or globally?* Globally, with per-card ▸ expansion in Basic; a
per-card mode is more state than it is worth.

Implementation plan card. Layout 4.1, 4.5, 4.6, 7 (54). Size 2.
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

- Check: every control reachable in Advanced is reachable from Basic through a ▸ (a test walks the card manifest); a
  photo with an advanced edit shows the `·edited` tag in Basic; the switch is global and per machine (never in the
  project file); curve presets are plain points in the existing curve field (no schema change, no render maths
  change, the develop hash of a preset equals that of the same curve drawn); `Y` cycles the Before | After modes and
  never fires in a text field; the Develop keys (`[` `]`, Cmd+Shift+C / V, Tab) are unchanged; *Apply to all* is one
  undo step; a person uses it on a real folder for a day (Layout 7) before plan 55 starts.

Status: done 2026-10-14 (the owner's day of use pending; archive after it). Landed: `DevelopPanel` is seven cards in
the order of operations, Crop, Light, Color, Detail, Sharpen & denoise, Effects, Masks (Light and Color open), under
one **Basic ⇄ Advanced** `Segmented` in the header beside the ⋯ menu: the per-machine pref `ui.developAdvanced`
(`UiPrefs`, localStorage `photobook.ui.developAdvanced`, default Basic, kept by `reset()`, never in the project).
`CardMore.tsx` draws a card's ▸ part: in Basic a ghost row (chevron, label, the accent `·edited` `Tag` while a control
behind it is off its default) that opens in place and stays open while stepping photos (the panel's state, through
`CardViewProvider`); in Advanced the part is open with its label as a section title. The **card manifest**
(`components/develop/developCards.ts`, `DEVELOP_CARDS`): per card `{ id, title, basic: CardControl[], more: CardMore[] }`,
a control is `{ role, name }` (its ARIA role and accessible name), a ▸ part is `{ id: '<card>.<part>', label,
controls, edited(settings) }`; the components read their labels and `edited` tests from it (`cardMore(id)`). Parts:
`crop.transform` (Upright & transform: the former Transform section whole), `light.curve` (Curve: the presets, the
point curve, the parametric sliders and splits), `color.mix` (Color mix), `sharpen.more` (Radius, Detail, Masking),
`effects.grading` (Blending, Balance), `effects.vignette` (Midpoint, Feather, Roundness), `effects.halation`
(Threshold, Radius), `effects.grain` (Size, Roughness), `masks.component` (the selected luminance, colour or AI
component's range, Refine and depth range; `componentAdvancedEdited`; in Basic a mask row whose component has such an
edit carries the `·edited` tag too, selected or not); Detail has none. Plan 55 registers the grading
wheels in `effects` (basic) and anything it adds behind a ▸ (the per-wheel luminance, the Global wheel) as a part.
Re-cuts, every control's behaviour unchanged: `TransformSection` is the Crop card (the crop tool's button, R, and a
summary line "4:5 · 1.2° · flipped"; its reset is `resetGeometry`, i.e. `createDevelop().geometry`: crop, angle,
rotation, flips, Upright and the Transform in one step); Light (the six
rows) and Color (`WhiteBalanceControls`, Vibrance, Saturation) are inline in `DevelopPanel` (resets: light + curve;
white balance + color); `DetailSection` is Texture, Clarity, Dehaze (its reset those three) and `SharpenSection` (same
file) is Sharpening and the Denoise group (its reset: sharpening and denoise off, one step; the Alt mask gesture
kept); `EffectsSection` has a ▸ per group; `MasksSection` puts a component's range / Refine behind `masks.component`,
and making a luminance or colour range mask (or adding one to a mask) opens that ▸. **Curve presets**:
`packages/shared/src/develop/curvePresets.ts` (`CURVE_PRESETS` Linear · Soft S · Strong S · Matte · Faded · Reverse
S as point lists, `curvePresetPoints`, `matchCurvePreset`, `withCurvePreset`; Vitest: valid, sorted, monotone, the
hash of a preset equals the same curve drawn); `CurveEditor` shows them as pill `toggle` chips above the editor and a
chip writes the shown channel's points through `onChange` (one undo step, the matching chip pressed). No schema, no
render maths, no engine or fixture change. **Before | After** (`DevelopMode.tsx`): a split button (the click is the
flip, `\`, from any mode, again to off; ▾ `Menu` Flip · Split · Side by side), `CompareMode` / `nextCompareMode`:
`Y` cycles off → side by side → split → flip → off (the window handler: not in a text field, a dialog, an open menu or
the crop tool); one mode at a time. Side by side belongs to its photo like the split: stepping away or Reset all
closes it. `SideBySide.tsx` (keyed by photo, so a step starts at Fit): before (the original proxy) left, after (the
live render, else the developed proxy) right, one local `ViewportState` for both panes with the pure helpers of
`components/cull/viewport.ts` (`placement`, `zoomTo`, `clampCenter`; imported, not edited; Cull's saved zoom is not
touched): a click zooms both to 1× at the point and back to Fit, a drag pans both; view only. **Apply to all ▾** (`BatchBar.tsx`, slot `apply-all`, order
0; `BatchContext.all` added in `batchSlots.ts`): *Apply Light & Color to all n* (`syncDevelop` with `basic`, `curve`,
`color`), *Apply these sections…* (`openSyncDialog`), *Apply look to all n* (`applyLookTo` with the photo's look and
Amount; off without a look). With nothing selected and more than one photo in the strip the pill stays up with
"Select photos in the strip to apply to several" and only *Apply to all in the strip ▾* (every other photo of the
strip); a one-photo strip keeps 46's hidden pill. Kitchen sink: Primitives → *Develop cards*
(`components/fixture/DevelopSink.tsx`: the real `DevelopPanel` twice, Basic and Advanced, on synthetic settings over
the fixture book, no `invoke`; it puts the book store and its undo history back on leave; `DevelopPanel`'s `advanced` prop forces one side), `docs/design/reference/kitchen-sink-54.png`.

Number fields (plan 48's open question for Develop): unchanged and recorded: a slider's readout (the Kelvin one too)
commits on Enter or blur and Escape cancels; the crop tool's custom aspect on Enter or *Custom*. Never per keystroke,
so a typed value is one undo step and one render.

Deviations: (1) the switch is `ui.developAdvanced` (a pref like `ui.surround` / `ui.haptics`), not `ui.develop.advanced`:
`ui.develop` is the Develop session (null while closed). (2) White balance is on the Color card, as Layout 4.1's
table and sketch put it (the card's wording "`WhiteBalanceControls` + the Light rows → Light" read the other way).
(3) The Crop card's Basic is the crop tool's button and summary: the ratio presets, straighten, rotate and the flips
stay in the crop tool's panel (it replaces the cards while open), so the flips are not under the ▸; *Keep inside* is
the existing Constrain Crop, under the ▸. (4) The Denoise group keeps its own *Advanced* disclosure (plan 28, file not
re-cut) in both modes; the manifest lists the group's switch as basic. So the chroma filter strength (Colour, plan 24)
and the colour source sit in that disclosure, not behind the Sharpen ▸ as Layout 4.1's table puts them. (5) *Apply Light & Color* copies the whole
Light and Color cards (light, curve, white balance, color with the mix), the sync sections they map to. (6) The batch
pill now shows without a selection when the strip holds more than one photo (Layout 4.6), with only Apply to all; 46's
"out of the way without a selection" holds for a one-photo strip. (7) Split keeps 46's rule (off with any geometry
edit); side by side is allowed with geometry (two panes, nothing to line up); side by side hides the mask tools and
the structure overlay while it shows. (8) `\` and the button's click flip from any mode (leaving side by side or the
split, one mode at a time). (9) The ▸ row is a ghost `Button` (`sm`, full width) from `components/ui`; `IconButton`
is icon-only and not a drop-in for a labelled row with a tag.

Checks: `pnpm typecheck` clean; `pnpm lint` clean (`check-palette: ok`; one pre-existing warning in
`apps/site/public/index.html`); `pnpm --filter @photobook/shared test` 1084 of 1084; `pnpm --filter editor test` 1469 of
1469. Check list: every control reachable in Advanced is reachable from Basic through a ▸ (`developCards.test.tsx`:
walks the manifest card by card and ▸ by ▸, and compares every control of Basic with every ▸ opened against
Advanced); an advanced edit shows `·edited` in Basic (same file, every part; `DetailSection.test.tsx`,
`TransformSection.test.tsx`, `DevelopMode.test.tsx`); the switch is global and per machine, never in the project
(`developCards.test.tsx`); curve presets are plain points with the drawn curve's hash (`curvePresets.test.ts`) and one
undo step (`DevelopMode.test.tsx`); `Y` cycles and never fires in a text field, side by side zooms both panes, nothing
reaches undo (`DevelopMode.test.tsx`); Apply to all is one undo step (`BatchBar.test.tsx`); `[` `]`, Cmd+Shift+C / V
and Tab unchanged (`DevelopLeftPane.test.tsx`, `copyPaste.test.tsx`, `Panes.test.tsx` pass as before). Seen in the
browser on the kitchen sink under `editor-web`: both panels, the ▸ opening in place, the `·edited` tags, a preset chip
updating both panels. Not verified: the Tauri window (agents cannot capture it), so side by side over a real photo
and render, the split button's look in the header, and the pill over a real strip are the owner's checks, with the
day of use on a real folder (Layout 7) before plan 55.

Review fixes (same day): (1) `SideBySide` holds its own viewport state instead of `useLinkedViewport` (which now
writes plan 52's `ui.cull.zoom`); (2) keyed by photo; (3) side by side closes on stepping away and on Reset all;
(4) `Y` and `\` do nothing (no `preventDefault`) while a menu has the focus; (5) the Before / After click flips from
split or side by side instead of switching off; (6) a mask row carries `·edited` in Basic; (7) the ▸ row is a ghost
`Button`; (8) `DevelopSink` restores the undo history; (9) the deviations above. Tests: `DevelopMode.test.tsx` (menu
keys, the click flips, stepping and Reset all close side by side), `developCards.test.tsx` (the mask row tag).
Checks after the fixes: `npx vitest run src/components/develop src/components/fixture` 351 of 351; `pnpm typecheck`
clean; `pnpm lint` clean; `pnpm --filter editor test` 1470 of 1470.
