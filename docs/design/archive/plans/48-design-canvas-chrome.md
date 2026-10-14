# 48 · Design canvas chrome

ODDHALLS_UI_PLAN [6 (48)](../../ODDHALLS_UI_PLAN.md#48--design-canvas-chrome), [3](../../ODDHALLS_UI_PLAN.md#3-direction-a-darkroom-not-a-cockpit) (Design). Size: 1.5 days. Depends on: 45

- Floating selection toolbar, alignment toolbar and Fix spacing as `panel-3` pills; selection handles 8 px with the
  top highlight; the page strip tiles and `+`; the inspector on Develop cards; rulers in `panel-2` with mono labels;
  the zoom HUD bottom-right as a pill ("Fit · 100 %"); the dot grid fainter; the "This page is now custom" toast on the
  new `Toast`.
- Check: snap lines, guides and the safe area keep their colours (`accent` snap, `guide` blue, `warn` safe area), and
  no accent pixel lands on a photo except the selection outline of a frame.

Status: done 2026-10-13; review fixes applied the same day. Landed: the canvas's floating pills share one look
(`canvasPill` in `components/editor/AlignToolbar.tsx`: `panel-3`, a hairline, `shadow-float`), and `ui/Button` has a
32 px `size="lg"` and a `shape="pill"` for them: the photo toolbar and the
multi-selection toolbar (`SelectionOverlay.tsx`, `lg` radius, 32 px ghost `IconButton`s with tooltips; Adjust is a
`toggle`, Merge shows ⇧⌘M), Fix spacing (under a hairline, its icon in the accent), the alignment toolbar (`Button`s
in `Tooltip`s, so a disabled one still says "select 3 or more"), the Adjust hint (a full pill), the tool group
(`Canvas.tsx`, `toggle` `IconButton`s named "Select" and "Frame", the long hint and V / F in the tooltip) and the zoom HUD bottom-right (a full pill: Fit as a `toggle`,
− and + `IconButton`s with ⌘− and ⌘=, the range, the readout "77 %" in mono). Handles 8 px (`size-2`, centred on the
frame edge), `fg` with the accent edge and `shadow-raised` (the top highlight). The dot grid is fainter (the hairline
at 50 % through `color-mix`, in the `dot-grid` utility of `styles.css`); the page keeps `shadow-stage/50 shadow-xl`.
Rulers `panel-2` with a hairline, `xs` radius, tick numbers, the drag badge and the position field in mono. Page strip
tiles `rounded-xs`, numbers in mono, the current tile `ring-2 ring-accent` 2 px out (`ring-offset-panel`), the `+`
tile a dashed hairline, the hover ⋯ on `panel-3`. Inspector: `inspectorUi` `Section` is a card (`panel-2`, `md`
radius, 8 px apart, `shadow-raised`, sentence-case `section-title`) that provides `FieldSurfaceContext` `'card'`, so
the `ui/Field` controls inside fill with `panel` (one step under the card) and their focus ring's gap is `panel-2`;
row labels `fg-2`; `inspectorUi.inputClass` is `ui/Field`'s `textFieldClass('card', { fixedHeight: false })`, one
source; in `Inspector.tsx` the hex fields are `Input`, the selects `Select`, the text size an `Input type="number"`
with its live per-keystroke preview as before, the pill switch `Switch`, Edited a
`Tag`, Reset a ghost `Button`, Grid of frames… and Save as layout… `buttonClass`, Slot ratio and Align a
`SegmentedTrack` (the sliding indicator) around their radio buttons. The canvas notices go to the one `ToastHost`:
`components/editor/Toast.tsx` keeps `showToast` / `dismissToast` / `useToastStore` (one canvas notice at a time, over
`toast.show`; the focus returns to the canvas when the toast's own button had it) and no longer renders anything, so
`Canvas.tsx` mounts no toast; `customPageNotice.ts`, `PageStrip.tsx` and `design/postActions.ts` are unchanged
callers. The check: `components/editor/canvasColors.test.tsx` (snap lines and their measures `var(--color-accent)`,
grid and margins `var(--color-guide)`, ruler guides and their ruler marks `guide` also while snapped, a post's safe
area `var(--color-warn)`, and on a rendered canvas with grid, margins and rulers on, the only accent inside the page
box is the selected frame's outline and its eight handles). Kitchen sink: a Design page
(`components/fixture/DesignSink.tsx`, `#/fixture?tab=sink&page=design`) draws the real `Canvas`, `Inspector` and
`PageStrip` on the fixture book with buttons for one or two selected frames, Adjust, snap lines, a ruler guide and
the custom-page toast; no `invoke` (`KitchenSink.test.tsx`). Also tested: Undo clicked inside `ToastHost` reverts the
move and closes the notice (`frameMove.test.ts`); `Button` `lg` and `pill` (`Button.test.tsx`).

Deviations and decisions: (1) The grid and the safe and hard margins were accent lines over the page; they are now
the guide blue (UI 2.2: the accent never sits on the picture). Snap lines, their measures and gap badges stay accent,
as the Check says, read as the selected frame's drag feedback. (2) The slot drop highlight and the background-photo
drop target in the inspector were accent over a photo; both are `fg` now. (3) The social safe area's hard-coded
`rgb(255 120 60)` is now `var(--color-warn)` (`SafeAreaGuides.tsx` in `components/design/`, three lines). (4) The
toolbars' long `title` hints became `IconButton` tooltips; the accessible names stay as they were ("Adjust photo",
"Merge frames", "Fix spacing", …); the tool group's names are now "Select" and "Frame: …" with the key in the tooltip.
(5) The text size field stays live per keystroke (an `Input type="number"`, native arrows, the range beside it
live); whether it should commit on Enter or blur like `NumberInput` is left to plan 54. (6) The dot-grid utility is shared with Home (`routes/home.tsx`), which gets the fainter grid too.
(7) The zoom range keeps the native `accent-accent` thumb (the slider is plan 46's). (8) Sections drawn by other
files through `inspectorUi` (`BookSettings`, `FrameSection`, `ShapeSection`, the design panels) take the card look;
their own controls are untouched, but `ui/Field` controls inside a `Section` take the card fill, and
`inspectorUi.inputClass` (the card fill, `panel`) also reaches `design/PostExportSheet`, `PrintExportSheet`,
`SlideshowExportSheet` (on `panel-2` dialogs, where it matches), `editor/FramePopovers` (on a `panel-3` popover, two
steps apart) and `ai/AltTextField`. `Checkbox` and `Switch` keep the `panel` ring gap inside a card. (9) Fix spacing's
icon is `text-accent!` (it overrides the ghost `Button`'s `text-fg-2`; same-property utilities otherwise sort by
name). (10) The canvas toast moved from the bottom centre of the canvas to the one toast host, bottom-left of the
window, stacked with the export toasts; it still replaces the previous canvas notice.

Checks: `pnpm typecheck`, `pnpm lint` (Biome and `check-palette: ok`), `pnpm --filter editor test` (148 files, 1395
tests, after the review fixes). In a browser on `editor-web`: the Design sink renders with no `invoke`; computed handle 8 × 8 px
with the inset highlight and an `oklch(0.8 0.11 80)` edge; the photo toolbar `oklch(0.33 0.007 75)`, 12 px radius,
hairline, float shadow, 32 px buttons; the alignment toolbar the same with 11 buttons; Fit `aria-pressed` with a full
radius; the readout "77 %" in JetBrains Mono; rulers `oklch(0.29 0.006 75)` with mono numbers; the dot at
`oklab(1 0 0 / 0.035)`; the current tile's ring `panel` 2 px then `accent` 4 px; the toast in the host
("This page is now custom", Undo, ✕). Screenshot: `docs/design/reference/kitchen-sink-48.png`. Not verified: the
Tauri window (agents cannot capture it), the drag gestures by hand (behaviour unchanged; the gesture suites pass), the
haptic tick of plan 46 (not touched), the look of the design panels inside the new cards with real outputs.
