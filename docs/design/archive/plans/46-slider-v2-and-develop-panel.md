# 46 · Slider v2 and the Develop panel

ODDHALLS_UI_PLAN [6 (46)](../../ODDHALLS_UI_PLAN.md#46--slider-v2-and-the-develop-panel), [4.2](../../ODDHALLS_UI_PLAN.md#42-the-slider), [4.3](../../ODDHALLS_UI_PLAN.md#43-tactility-that-only-a-native-app-can-do), [3](../../ODDHALLS_UI_PLAN.md#3-direction-a-darkroom-not-a-cockpit) (Develop); IMPLEMENTATION_PLAN_38-56 [section 7](IMPLEMENTATION_PLAN_38-56.md#7-waits-and-motion-where-each-row-lands) (the slider path, the Develop header and Looks tile dot, the Develop pill). Size: 2 days. Depends on: 45

- The slider from 4.2 (`Slider.tsx` internals; `Slider.test.tsx` extended for the detent, the wheel gate and the
  per-row edited dot).
- The haptic command (`src-tauri/src/commands/haptic.rs`, `lib/tauri.ts` wrapper, `lib/haptic.ts` with the rate limit
  and a `prefers-reduced-motion` / Settings off switch) wired to the slider detent and the canvas snaps (plan 30's
  guide flash site), straighten 0°, zoom Fit / 100 %.
- Develop panel: cards per section (`panel-2`, 8 px radius, 8 px gaps), sentence-case titles, the per-card reset
  moves into the title row as a ghost icon, the panel header's wrapping row becomes a `Menu` (Presets, Sync…, Copy,
  Paste, Reset all) beside the Edited tag so it never overflows; the versions row and batch bar become floating pills;
  the Looks strip tiles restyled; a split before/after handle on the picture.
- Check: a drag from the row's label moves the value; the detent clicks once per crossing; Option+wheel nudges and a
  plain wheel scrolls; reduced motion disables the spring and the haptic; the render-progress dot shows during a
  slow drag (forced with `PHOTOBOOK_FORCE_CPU=1`).


Status: done 2026-10-13. Landed: `components/develop/Slider.tsx` internals (the props, values, steps, keys and undo
unchanged): the 4 px pill track with the default-to-needle fill, the needle (4 × 16 px, `fg`, a 1 px `stage` ring;
6 × 18 px on hover and while dragging; the accent while the track has the keyboard focus), ticks at the default,
halfway to each end and the ends, the whole row as the drag surface (a press on the track jumps to the pointer once it
moves, a press on the label or the readout drags from the current value; pointer capture only starts with the drag, so
a click on the readout still types), the detent (`DETENT` = 1.5 % of the range: a drag inside it holds the default,
Shift skips it; one `tick('alignment')` and a 1.15× bump of the needle per crossing; a key or wheel nudge landing on or
passing the default ticks too), Option + wheel (native non-passive listener; Shift ×10; a plain wheel is left to the
panel), the reset spring (`linear()` feature-detected, else `var(--ease-out)`, over `--dur-slow`) with the readout
counting through two intermediate values, and the 4 px accent dot on a row off its default. Haptics:
`src-tauri/src/commands/haptic.rs` (`haptic(kind)`, `NSHapticFeedbackManager::defaultPerformer` through
`objc2-app-kit` 0.3 with `NSHapticFeedback`, a `cfg(target_os = "macos")` dependency of the editor crate only; `Ok`
everywhere), the `haptic` wrapper in `lib/tauri.ts`, `lib/haptic.ts` (`tick(kind: 'alignment' | 'levelChange' |
'generic')`, 80 ms rate limit, off with `ui.haptics` or `prefers-reduced-motion`, nothing outside Tauri), the
**Settings key `ui.haptics`** (`UiPrefs.haptics`, localStorage `photobook.ui.haptics`, default on) and its Switch in
Settings → Appearance (`HapticsSwitch`). Wired: the slider detent (straighten 0° is the Angle slider's detent), the
canvas snap (one call in `setSnapGuides`, `components/editor/snap.ts`, when guides appear: drags, resizes and the
nudge flash), and the canvas zoom reaching Fit or reaching or passing 100 % (a `useUiStore` subscription in
`lib/haptic.ts`, so no zoom control was touched). Develop panel: `PanelCard.tsx` (cards `panel-2`, 8 px radius, 8 px
apart; sentence-case title row that toggles; the reset as a ghost icon with the old `Reset <title>` name) for Looks,
Basic, Curve, Color, Transform, Detail, Effects and Masks; the header is one row (Develop, the Edited `Tag`, the render
dot, Presets, a ⋯ `Menu` "More actions" with Sync…, Copy, Copy…, Paste, Reset all). `renderProgress.tsx`: `usePreview`
marks a render pending until the render for the newest settings lands; `useRenderSlow` shows the pulsing `RenderDot`
only after 300 ms, in the header and on the Looks tile that asked. `BatchBar` is a `panel-3` pill over the foot of the
picture that slides up with a selection (inert without one) and counts the selection's jobs ("1 of 3",
`useBatchProgress`); `VersionStrip` is a pill at the top of the picture (dimmed while there is only Master); both hide
while the crop tool or the guides are open. Looks tiles: 4 px radius, the name under them in `fg-2`, the chosen one
the accent ring offset on `panel-2`. The split before / after handle (`SplitHandle` in `DevelopMode.tsx`): a grip at
the picture's left edge drags out a split showing the original proxy left of the line (view only: no store write, no
undo step); arrows move it, a release at the edge, a double-click, Delete or Escape close it. Crop, Before / After and
Proof are `toggle` buttons. The kitchen sink's Primitives page has a Slider block (`SliderSink`).

Needle or knob (implementation plan section 1): **needle everywhere**. On the sink the needle reads on the
temperature, tint, red-hue and blue-saturation tracks, including at the grey middle of temperature and tint, thanks to
the `stage` ring and its 16 px height over the 4 px track; no knob is kept
(`docs/design/reference/kitchen-sink-46.png`).

Deviations: (1) Presets stays its own menu button beside the ⋯ menu instead of an item inside it: it is itself a menu
(built-in and saved lists, delete confirms, two dialogs) and `Menu` has no submenus; the header still never wraps.
(2) `store/ui.ts` gained the `haptics` pref (four additive lines) for the per-machine switch "like `ui.surround`".
(3) The canvas-snap call sits in `setSnapGuides` (the one place every snap shows its guides, the nudge flash
included) rather than in `frameActions.ts`'s `flashGuides`, so drags tick too. (4) The zoom tick is a store
subscription in `lib/haptic.ts`, so plan 48's zoom HUD was not touched. (5) The ⋯ trigger is named "More actions"
(a name starting with "Develop " collided with the strip's `Develop <file>` buttons in `developStage.test.tsx`).
(6) Shift drags skip the detent so values near the default stay reachable by dragging; keys and typing reach every
value as before. (7) The PresetsMenu and Looks ⋯ triggers use `buttonClass` (ghost) and the Presets panel opens to the
left so it is not clipped by the panel.

Checks: `pnpm typecheck` clean; `pnpm lint` clean (`check-palette: ok`); `pnpm --filter editor test` 1398 of 1398
after the review fixes (before them, 1385 of 1386 with plan 41's `components/cull/Lenses.test.tsx` failing, since fixed
there); `cargo test --lib` in
`src-tauri` 213 passed, 2 ignored (`commands::haptic` tests: the kinds parse, every kind returns `Ok`); `cargo check`
clean. Check list: a drag from the row's label moves the value (`Slider.test.tsx`, and in the browser on the sink);
the detent clicks once per crossing (`Slider.test.tsx` counts `tick` calls; the feel on a Force Touch trackpad is the
owner's check); Option + wheel nudges and a plain wheel leaves the value and the scroll alone (`Slider.test.tsx`, and
in the browser); reduced motion disables the haptic (`haptic.test.ts`) and the spring (the token durations are 0, so
`Slider` skips the countdown and the transition); the render dot shows after 300 ms of a pending render and goes when
it lands (`DevelopMode.test.tsx` with a held render). Not verified: the Tauri window (agents cannot capture it), so the
real slow drag with `PHOTOBOOK_FORCE_CPU=1`, the haptic on a Force Touch trackpad, the `linear()` spring and the split
handle in WKWebView, and the pills over a real photo are the owner's checks.

Review fixes (same day): (1) the detent writes the default itself (`onChange(def)`, not snapped to the step), so an
off-grid default (raw Temperature's as-shot position) lands on it and the edited dot goes out; key and wheel nudges
click at the default snapped to the grid (`Slider.test.tsx`, a 40.4 default with step 1). (2) The dev raw-preview path
settles the render dot when the backend drops the newest job. (3) The zoom tick fires only for a person's zoom:
`store/ui.ts` marks `setZoom` and `stepZoom` (`zoomedByUser()`), so a store reset to Fit on opening or closing a book is
silent (`haptic.test.ts`); the subscription is dropped on a hot reload (`import.meta.hot.dispose`; a module-level flag
would not survive the module running again). (4) The split closes when Develop steps to another photo and is off
while the geometry is edited (crop, angle, rotation, flips, Upright, Transform): the original is the uncropped proxy
and drawing it through the geometry is not cheap, so the halves would not line up. (5) The ⋯ menu has the shared
keyboard check (`expectMenuKeys` in `lightroomEntryPoints.test.tsx`). (6) The render dot pulses with `pulse-dot`
(`styles.css`: a keyframes rule over three `--dur-slow`, still under reduced motion) instead of Tailwind's
`animate-pulse`.

Owner feel-check: the Angle slider's detent band (1.5 % of its 90° range, ±1.35° around 0°) on a trackpad.

