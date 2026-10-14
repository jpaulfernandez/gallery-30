# 49 · Delight and polish pass

ODDHALLS_UI_PLAN [6 (49)](../../ODDHALLS_UI_PLAN.md#49--delight-and-polish-pass), [4.4](../../ODDHALLS_UI_PLAN.md#44-delight-with-restraint), [5](../../ODDHALLS_UI_PLAN.md#5-what-stays-familiar-do-not-touch); ODDHALLS_LAYOUT_PLAN [6](../../ODDHALLS_LAYOUT_PLAN.md#6-loading-waiting-and-saving-the-animation-vocabulary); IMPLEMENTATION_PLAN_38-56 [section 1](../../plans/IMPLEMENTATION_PLAN_38-56.md#1-decisions-to-lock-before-wave-1) (Native menu bar, Haptics, Accent), [section 4](../../plans/IMPLEMENTATION_PLAN_38-56.md#4-cross-plan-interfaces) ("Motion", "Primitives"), [section 7](../../plans/IMPLEMENTATION_PLAN_38-56.md#7-waits-and-motion-where-each-row-lands), [section 8](../../plans/IMPLEMENTATION_PLAN_38-56.md#8-gates) (the final gate, the human checklist), [section 9](../../plans/IMPLEMENTATION_PLAN_38-56.md#9-docs-updated-by-this-programme) and the wave 8 card. Size: 1.5 days. Depends on: 46, 47, 48, 56

### 49 · Delight and polish pass

- Stage crossfade, before/after crossfade, the job toast's completion beat, empty states in Instrument Serif, custom
  cursors, the Home page wordmark, the tooltips with shortcuts on every icon button, an accessibility sweep (every
  control reachable, every ring visible, contrast on the sink), a reduced-motion sweep, and a screenshot set of every
  stage for the site.
- Check: with reduced motion on, nothing animates and nothing is missing; with it off, no animation exceeds 320 ms;
  the site's screenshots are regenerated (`node apps/site/scripts/optimize-images.mjs`).

Implementation plan card. UI 4.4, 6 (49); Layout 6. Size 1.5.
Owns: the stage crossfade (`router.tsx` route transitions, the picture element kept across Cull → Develop), the
before/after crossfade, the job toast's completion beat (`ui/Toast`, `JobsBar`), the check draw, the denoise sweep
in the loupe (`DenoiseLoupe.tsx`), empty states in Instrument Serif, custom cursors (`public/cursors/`), tooltips
with shortcuts on every icon button, the accessibility and reduced-motion sweeps, removal of the native-menu flag
and of the `components/develop/DialogShell` re-export, the site screenshot set
(`node apps/site/scripts/optimize-images.mjs`). Added checks: an automated sweep lists every `IconButton` without a
`Tooltip` (test); with reduced motion every token duration is 0 (test on computed styles in the sink).

Follow-ups handed to this plan by the archived Status lines: a keyboard-only way out of the Cull grid (51), folding
Bursts into one Group by control (53), dropping Compare's duplicate header zoom (52), Versions as real chips in the
Develop left pane (51), a real bar for Settings replacing 43's floating drag strip (43, 50), the `IconButton` tooltip
sweep, the `DialogShell` re-export removal (45) and the native-menu flag (43).

Status: done 2026-10-14 except the owner's checks (below; the native-menu flag and the site screenshots are the
owner's by decision). Landed: **stage crossfade**: `lib/viewTransition.ts` (`withViewTransition`, moved from
`SurveyView.tsx`; `stageOf`, `isStageChange`, `STAGE_PICTURE`), `router.tsx` sets `router.shouldViewTransition` per
navigation in an `onBeforeNavigate` subscription, so only a stage change (Cull, Develop, Design) commits inside a view
transition (TanStack Router feature-detects `document.startViewTransition` and cuts without it; a redirect is decided
again), and `routes/projectCull.tsx` opens Develop over the project's Cull through `withViewTransition`; One's picture
(`ViewportPicture`'s new `transitionName`) and the Develop picture (`DevelopImage`) carry `view-transition-name:
stage-picture`, so the picture moves while the panels crossfade over `--dur-slow` (`::view-transition-*(root |
stage-picture)` in `styles.css`). **Before/after**: the live render fades over `--dur-fast` (`opacity-0` with
`transition-opacity` instead of `invisible`), so `\` crossfades in 120 ms. **Completion beat**: `ui/Toast` holds the last
running text and its actions' place while the ring completes and the check draws, then `beat-in` shows what landed and
its actions after `--dur-hold` (CSS only: the final text is in the document at once, and reduced motion shows it at
once); `JobsBar` shows a "Done" pill with the full ring and check when the last active job finishes with no failure,
which fades (`beat-out`) and leaves on `animationend`; its ✕ buttons and the toast's are `IconButton`s. **Check draw**:
`ProgressRing`'s check path has `pathLength="1"` and `check-draw` (`--dur-check`, 160 ms). **Denoise sweep**:
`DenoiseLoupe.tsx` covers the loupe with the noisy crop when a result arrives (keyed by the result) and a line sweeps
once from left to right over `--dur-slow`, uncovering it (`loupe-sweep`, `loupe-sweep-line`). **Empty states**:
`ui/EmptyState` (Instrument Serif italic, `fg-2`, `lg` / `md`, an action under it) on Home (`EmptyLine`), the Cull and
Develop wells (`routes/library.tsx`, `routes/projectCull.tsx`; "Scanning…" stays plain), the reject pile, the Design
filmstrip and Library tab, and the Downloads sections (`Empty`). **Cursors**: `apps/editor/public/cursors/draw.svg`,
`rotate.svg`, `pan.svg`, `panning.svg` (24 px SVG with a dark outline) through `cursor-draw | rotate | pan | panning`
utilities, each with its standard keyword after the URL: frame draw (`FrameDrawLayer`), the crop tool (rotate outside
the frame, draw with the ruler), the mask gradient tools (draw; the brush keeps its own ring), a zoomed picture in One,
Two and side by side (pan), a frame's photo in Adjust (pan / panning). **Tooltips**: `components/ui/iconButtons.test.ts`
parses every `.tsx` and fails on an icon-only `Button` (an `icon`, no label) or `<button>` (an `aria-label`, only icons
or nothing inside, not a switch) outside a `<Tooltip>`, with a positive control; the sweep wrapped 13 buttons (crop
rotate / flip, the Looks ⋯, mask colour samples, the watermark positions, the frame shapes, the page strip's add and ⋯,
the Develop and Review step arrows with ← / →, the loupe's close) and turned 4 into `IconButton`s (the layout picker's
Close with Esc, three ✕); `Tooltip` gained `className` for its wrapper. **Accessibility**: a base-layer accent outline
for any focused control without a focus style of its own (`:where(button, a[href], summary, select, [role=button],
[role=switch], [tabindex="0"]):focus-visible`), four hand-drawn switches replaced by `ui/Switch` (`BookSettings` ×2,
`ShapeSection`, `DenoiseGroup`), focus rings on the page strip's ⋯ and Decide's frame strip, and the Cull pane toggle
(below). **Reduced motion**: `--dur-check` and `--dur-hold` join the zeroed tokens; Tailwind's `--animate-spin` and
`--animate-pulse` now run on `--dur-slow`, so the spinners and pulses stop too; no component checks
`prefers-reduced-motion` except the slideshow's `TransitionPreview` (content) and `lib/haptic.ts` (the locked Haptics
decision: no tick under reduced motion; not motion); the sink's Motion section lists every `--dur-*` and `--stagger`,
and `KitchenSink.test.tsx` applies the stylesheet's tokens and its reduced-motion block (jsdom evaluates no media
query) and checks each computes to `0ms` on the sink, while `color.test.ts` checks the block itself. **Kitchen sink**:
Primitives → *Delight* (a job's beat in the real toast host, the check, an empty state, the loupe sweep, the cursors),
`docs/design/reference/kitchen-sink-49.png`.

Follow-ups done: **DialogShell re-export**: `components/develop/DialogShell.tsx` deleted, 25 importers (one test among them) moved to
`components/ui/DialogShell` (the test of the old path removed with it). **Compare's header zoom** removed
(`CompareView.tsx`; K / J / Shift+F stay; the bar's Fit title now says Shift+F); `CompareSurvey.test.tsx` renders the
bar beside the view and clicks its zoom instead (the "2× disabled without a proxy" assertion became "the bar's 2× holds
both panes at fit until the proxy arrives"). **Group by**: `GroupBySelect` is the one control (Bursts, the default · No
grouping · By hour, day, camera, lens, place); plan 39's Group toggle is gone and its ▾ options stay beside the select
while the list has groups; the store fields and the grouping are unchanged (a divider key also sets `grouped`, so
"dividers without stacking" is no longer offered). **Versions** are a card in Develop's left pane with pill chips that
wrap and the actions under them (`VersionStrip.tsx`, `DevelopLeftPane.tsx`). **Settings** has Home's bar
(`SettingsPage` in `routes/settings.tsx`: 44 px, `panel-2`, the drag region, the 78 px inset; Back, the title, the
status and Save), replacing plan 43's floating strip. **Cull pane toggle** (decision (c)): `PanesToggle` at the left of
the Cull filter bar, an `IconButton` "Hide / Show the side panes" with Tab in its tooltip (`togglePanes('cull',
'panes')`); Tab's behaviour is 51's. Docs: `README.md` unchanged (the name is there since 43; no screenshots to add),
`docs/INSTALLATION.md` names the oddhalls app, `apps/site` copy only (`llms.txt`, the `alternateName` in
`index.html`); CLAUDE.md, CODEMAP, DESIGN_NOTES, the three source documents' Status lines, the plans index.

**The native-menu flag stays** (decision (a)): its removal condition, "no key fires twice", is a session of use in the
Tauri window that nobody has run. To remove it once that check passes: (1) `apps/editor/src/main.tsx` lines 37–40:
call `void installNativeMenuBar(nativeMenuActions);` without the `import.meta.env.VITE_PHOTOBOOK_NATIVE_MENU === '1'`
guard and drop the flag from the comment; (2) the comments that name the flag: `src-tauri/src/menu.rs` line 4,
`src-tauri/src/lib.rs` line 5, `src/lib/nativeMenu.ts` line 6, `src/lib/tauri.ts` line 1877; (3) docs:
`CLAUDE.md` (Conventions, native shell), `docs/CODEMAP.md` (Native shell), a dated DESIGN_NOTES line; (4) check
`pnpm --filter editor test` (`lib/nativeMenu.test.ts` does not read the flag) and the `[photobook:menu]` dev-log line
once per press in `tauri dev`. Nothing in Rust reads the flag (the webview calls `install_native_menu`).

**The site screenshots are the owner's** (decision (b)): `apps/site/shots/` holds the Oct 6 PNGs, the same set
`public/img/` was made from, and an agent cannot capture the Tauri window, so `node apps/site/scripts/optimize-images.mjs`
was not run. To regenerate: capture each stage in the release `.app` into `apps/site/shots/` under the names the
script's `JOBS` list (`editor-selected.png`, `editor-layouts3.png`; the viewer shots are unchanged), run the script,
and update `README.md` if a screenshot goes there.

Checks: `pnpm typecheck`; `pnpm lint` (Biome, `check-palette: ok`; the one warning is the site's pre-existing
`noDescendingSpecificity`); `pnpm --filter @photobook/shared test` (1105); `pnpm --filter editor test` (1523, 160
files); `pnpm --filter @photobook/publish test` (73); `pnpm build` (every package); `source ~/.cargo/env && cargo check
-p photobook-develop --no-default-features`. In a browser on `editor-web`: the sink's tokens are 120 / 200 / 320 / 160 /
400 / 60 ms and all `0ms` with the live stylesheet's reduced-motion rules applied; the four cursor SVGs load
(`image/svg+xml`) and `.cursor-draw` computes to the URL with `crosshair`; a job run in the toast host shows the beat
(the running text fading out and the result in after the hold); `vite build` keeps the view-transition and cursor
rules. The UI plan's Check: reduced motion: nothing animates (every duration token, the spinners and pulses, the view
transitions and the beat run on the tokens) and nothing is missing (every beat ends in its end state, which is in the
document from the start); without it, no one-shot animation exceeds 320 ms (stage crossfade and loupe sweep 320,
flag stamp and cell-in 200, the check 160, the beat and star pop 120); the loops (the busy ring and spinners 960 ms a
turn, the render dot's pulse 960 ms, `animate-pulse` 1920 ms) and the opening stagger (60 ms a cell, capped at 24) are
progress, not flourishes, and the 400 ms hold is a hold; the screenshots are the owner's (above).

Not verified: the Tauri window (agents cannot capture it): the stage crossfade and the kept picture in WKWebView (the
pane's Chromium has `startViewTransition`; the code cuts where it is missing), the cursors' look and hotspots at 2× on a
Retina screen, the loupe sweep over a real denoise result, keyboard-only use of the Cull grid. A keyboard user whose
focus is in the Cull grid still cannot leave it with Tab (Tab toggles the panes there, by 51's decision); the new
toggle is a pointer's way and a focusable control, not a way out of the grid; a region-cycling key (F6) remains the
open fix if the owner wants one.

Follow-ups (not done): Next: a region-cycling key (F6) for Cull, designed with 51's Tab (decision of the review,
2026-10-14: the keyboard trap in the Cull grid stays a documented limitation of 49).

**The owner's checklist for 38–56** (from the archived Status lines and the implementation plan's section 8; a real
folder and the real window):

- 38: a CR3 or RAF (rawler's date and lens fields); the backfill cost on a large old cache.
- 39: import `fixtures/lisbon-demo` and `fixtures/burst` (`python3 scripts/make-burst-fixture.py`), open Cull: the burst
  is one cell of eleven with DSCF2005 shown, IMG_0001 alone, no lisbon scenes merged, the suggested best defensible.
- 40: a Decide pass over a few hundred photos (the lisbon fixture plus the burst) feels like it moves; the end state
  appears; U brings one back.
- 41: the lens thresholds on a real folder.
- 42: move the rejects of a *copy* of a real folder to the Trash, put one back in Finder, rescan, see it in the grid.
- 43: traffic lights in the top bar and the window dragging from it (Project ▾ and the stage tabs still click); no
  selection anywhere; right-click shows ours or nothing; no bar and no bounce on a two-finger scroll over a fitted page;
  with `VITE_PHOTOBOOK_NATIVE_MENU=1`, Cmd+Z in a text field undoes typing, the `[photobook:menu]` line logs once per
  press of every item and the plain keys (P, X, U, 0–5, D) act once; the release `.app` has no Inspect Element. Then
  remove the flag (above).
- 44–48: every swept screen by eye in the window; 47's 60 fps with 500 real thumbnails and Survey's view transition in
  WebKit; 48's drag gestures by hand.
- 46: the detent clicks once per crossing on a Force Touch trackpad; the needle is readable on the hue track; the slow
  drag with `PHOTOBOOK_FORCE_CPU=1`; the `linear()` spring and the split handle in WKWebView.
- 50: the real registry, the drag from Home's bar, the covers through the asset protocol, the counts on real folders.
- 51: the panes in the window (Tab, Shift+Tab per stage).
- 52 and 54: a day of use each (Layout 7); Apple Maps opening from the Photo pane; side by side over a real photo.
- 53: focus peak and zebra on real photos (`PEAK_THRESHOLD` 64, the stripe width), a mode render's latency on a RAW.
- 55: every cached render re-renders once on open (the engine bump); the ON1 samples look identical in the app.
- 56: masks, the sorts and the chooser on a real folder; a real drag of the rotate handle; the export cards end to end.
- 49: the site screenshots (above); the crossfade, the cursors and the loupe sweep in the window.
