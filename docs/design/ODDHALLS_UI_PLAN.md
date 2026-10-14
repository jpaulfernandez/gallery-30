# oddhalls: UI/UX research and skin plan

Oct 13, 2026 · The photo editor (Cull · Develop · Design) is now officially **oddhalls**. This document is the design
research and the plan for its skin: what the chrome looks like, how it feels under the hands, and the native
(Tauri) polish that separates a web page in a window from an app. It does not change what the stages do; the
workflow plans ([plans/README.md](plans/README.md)) and [DESIGN_NOTES.md](DESIGN_NOTES.md) stay the record of
behaviour. Where this document and DESIGN_NOTES disagree on looks, this one wins once its plans land.

Brief, in the owner's words: not a Lightroom clone in looks and feel, but familiar in how it is used; rethink the
colours (a good colour for photography); the buttons feel "Lightroom"; the window has Tauri artifacts (text and
elements can be dragged and highlighted, Inspect Element shows up, scrollbars appear at random); and the work should
feel delightful and tactile.

Status: plans 43–48 done Oct 13, 2026 and archived in [archive/plans/](archive/plans/); plan 49 done Oct 14, 2026
([archive/plans/49-delight-and-polish.md](archive/plans/49-delight-and-polish.md)) except the owner's checks it lists (the native-menu
flag's removal after a session of use, the site screenshots, the checks of 43 and 46 only a real window can show).

---

## 1. Where we are: an audit of the current skin

Read from `apps/editor/src/styles.css`, `components/editor/inspectorUi.tsx`, `components/develop/Slider.tsx`,
`components/shell/*` and the class names across `components/`.

**Tokens** (`@theme` in `styles.css`): `canvas #1a1a1a`, `stage #0d0d0d`, `panel #222`, `panel-2 #262626`,
`line #333`, `fg #e5e5e5`, `fg-muted #8a8a8a`, `accent #4f8cff`. Inter 13 px, Fraunces and JetBrains Mono loaded but
barely used. One utility `label` (11 px uppercase, 0.04 em tracking, muted).

**Why it reads as Lightroom.** Every one of these is a Lightroom (and generic Adobe) tell, and together they are the
whole recipe:

| Current | Lightroom does the same | Effect |
| --- | --- | --- |
| Pure neutral greys in four steps, 1 px `#333` borders between every region, no shadows | Yes (its panels are `#2a2a2a`-ish with hairline splits) | A cockpit: everything is a box with a border |
| Cool blue accent `#4f8cff` for selection, focus and the primary button | Yes (Lightroom's accent is a desaturated blue, Figma's and macOS's too) | Says "software"; the only colour in the UI is a colour no photo wants near it |
| Uppercase tracked section labels, chevron-collapsible panels on the right | Yes (BASIC, TONE CURVE, …) | The strongest single tell |
| Outlined buttons: `rounded-md border border-line bg-panel-2 … hover:border-accent` | Yes (Lightroom's buttons are outlined and light up on hover) | "Feels Lightroom", as the brief says |
| Slider: label left, value right, thin 3 px track under them, 12 px round thumb | Yes, almost pixel for pixel | The thing you touch most feels borrowed |
| Segmented tabs: 1 px outlined group, the active item filled `bg-line` | Close | Static, no motion |
| Hard-coded palette colours in 160+ places (`text-red-400` ×42, `text-white` ×28, `text-amber-300` ×23, `bg-black/60` ×21, …) | n/a | No semantic layer, so a re-skin is a find-and-replace across 90 files |

**What is good and stays.** The layout grammar (library left, picture centre, adjustments right, strip under the
picture), the key map (P / X / 1–5 / R / `\` / Space / Esc, J / K for grid size), slider semantics (drag anywhere
on the track, Shift for fine, double-click resets, click the readout to type), one undo step per gesture, the batch
bar, the versions row, the floating toolbar beside a selection, smart guides with labelled measures. These are the
"familiar in use" the brief asks for; Lightroom users keep their muscle memory and nothing here needs to change.

**The Tauri artifacts, traced.**

1. *Dragging and highlighting elements.* `body { user-select: none }` is set, but WebKit still lets a press-and-drag
   that starts on an `<img>` or on text inside a form control start a selection or a native image drag (the ghost
   image that follows the pointer). 24 of 26 `<img>` already carry `draggable={false}`; the one without is the dev
   fixture. What is missing is `-webkit-user-drag: none` on images and SVG in the editor (the shared renderer has it,
   `renderer/renderer.css:34`, the editor chrome does not), a document-level `dragstart` guard, and `::selection`
   styling, so a stray selection is at least invisible. There is also no `-webkit-touch-callout` / `-webkit-user-select`
   on the overlays (the Develop crop and mask layers set `select-none` individually; the canvas and strips rely on the
   body rule, which inputs and textareas override and then leak out of on a drag that leaves them).
2. *Inspect Element.* WKWebView's default right-click menu (Reload, Inspect Element). Nothing in `main.tsx` cancels
   `contextmenu`, so every region without its own menu shows the browser's. Inspect Element exists only in debug
   builds (Tauri 2 ships devtools with `debug_assertions`; the `devtools` Cargo feature is off, so a release `.app` has
   no inspector), but the Reload item and the browser look remain in release.
3. *Random horizontal and vertical scrollbars.* macOS overlay scrollbars flash whenever a wheel or trackpad event
   reaches an `overflow: auto` box whose content is even one pixel taller or wider than the box, and a scroll on a
   non-scrolling region bubbles to the nearest scrolling ancestor. The Design canvas is the worst case: its scroll
   area (`Canvas.tsx:341`, `absolute inset-0 overflow-auto`) holds a `min-h-full min-w-full` grid whose fractional
   size rounds past the box at some zooms, so a two-finger scroll over a page that already fits flashes both bars. The
   Develop panel header wraps at 320 px and can overflow horizontally; the jobs list's `<pre>` is `overflow-auto`;
   33 other `overflow-*` containers each can flash. Nothing sets `overscroll-behavior`, so the rubber-band bounce is
   on everywhere, which is the "elements move when I scroll" feeling.

These are all fixable in CSS and one Rust config change; plan 43 below.

---

## 2. Research

### 2.1 What the comparable tools do

Looked at through Mobbin (screens cited below) and from use. The question was: which tools feel like serious
photo tools without looking like Lightroom, and what do they share?

- **Monochrome chrome, one signature hue, used rarely.** Apple Photos, VSCO, Halide, Darkroom and Magnific all keep
  the chrome black-and-white and spend one colour on state (Halide's yellow readouts, Apple's white-on-black
  "Done", VSCO's white). Lightroom, Capture One and Luminar are the ones that colour the chrome (blue, orange,
  purple gradients). Monochrome chrome is also the right thing for colour judgement: nothing chromatic near the
  picture.
  [Apple Photos adjust](https://mobbin.com/screens/0dc105f4-8259-4396-bb88-979b3c4d9a66),
  [VSCO](https://mobbin.com/screens/b208c542-e805-4627-9834-943c48316df4),
  [Halide Mark III](https://mobbin.com/screens/276e40f6-8086-46bb-8308-48cbcbbab8cd),
  [Magnific editor](https://mobbin.com/screens/ca68500c-3771-4149-9abd-4af1b2a074f1).
- **Values live in tactile fields, not on hairline tracks.** Higgsfield's colour grading puts every number in an
  inset field with a faint tick scale and a needle you drag: it reads as hardware, and the number is always
  legible. Halide draws tick rulers under each control with the value in a monospace readout. Apple Photos and Ghost
  use a tick scrubber for rotation. This is the strongest "familiar but not Lightroom" move for sliders.
  [Higgsfield color grading](https://mobbin.com/screens/0db62c86-63ce-4493-98e2-15ed348a3178),
  [Higgsfield, B&W](https://mobbin.com/screens/343c9c0e-bf8f-4193-b50f-bd0403b61f1e),
  [Halide quick edit](https://mobbin.com/screens/298d9809-7e34-4cb6-9c07-4a0fa712c8ba),
  [Ghost rotation ticks](https://mobbin.com/screens/df8f285d-343a-40b7-8050-b4d4e987c0da).
- **Floating pills instead of docked bars.** Krea's tool pill at the bottom, Cosmos's "4 selected · Subcollection ·
  Organize · Remove · Done" pill, Magnific's bottom-centre tool pill, Leonardo's zoom pill. A floating pill over the
  work says "the picture is the room, the tools are visitors"; a docked bar says "panel".
  [Krea](https://mobbin.com/screens/b55a031a-39e5-4150-b48d-16b86a67625e),
  [Cosmos select bar](https://mobbin.com/screens/ca5fc71d-56ce-4486-934a-586bbbefa500),
  [Leonardo upscaler](https://mobbin.com/screens/705397a7-62de-43c5-a9f2-f56d6b7c511f).
- **Stacked cards, not bordered panels.** Shopify's image editor and Air's edit mode stack collapsible cards on the
  right with a value step between card and background and no borders. Soft surfaces, not rulings.
  [Shopify image editor](https://mobbin.com/screens/2078ac36-63df-403b-882e-197f16cde21a),
  [Air edit mode](https://mobbin.com/screens/3ebc9914-ca36-4a3d-b7f7-a883cbb2ecc0).
- **Physicality sells.** (Not Boring) Camera goes all the way to rendered dials; Halide's film strip and tick rulers
  go half way. We stop at "half way": real materials in the controls (inset wells, needles, ticks, detents), no
  skeuomorphic hardware.
  [(Not Boring) Camera](https://mobbin.com/screens/4b1b9fbe-07b0-436e-b562-43115ea049aa).
- **Selection is white, focus is the accent.** Apple Photos, Google Photos and Halide all mark selected photos with
  a white or light ring and a check; none use a saturated ring on top of a photograph.
  [Apple Photos select](https://mobbin.com/screens/d55c8518-c10c-4dc4-a83b-5da9531f741b),
  [Halide library](https://mobbin.com/screens/3f90a143-22c4-4b41-ab96-f1ad7f43e334).
- **Before/after as a split, not a flip.** Leonardo, Magnific and Customer.io use a draggable split line; Lightroom's
  `\` flip stays as the keyboard form.
  [Magnific before/after](https://mobbin.com/screens/7c7bc934-cd19-47fe-bb01-ac526f39e1d0).

### 2.2 A good colour for photography

Two different questions hide in "a good colour": the surround, and the accent.

**The surround must be neutral.** Anything with a hue next to the picture shifts how its colours and white balance
read (simultaneous contrast). ISO 3664 and every colour-managed tool put a neutral grey around the image; the
disagreement is only about how dark. So: the Develop picture well, the Cull grid background and the Compare panes
stay *achromatic* (chroma 0). The chrome around them (sidebar, top bar, panels) may carry a trace of warmth,
because it is further from the picture and because it is what gives oddhalls a temperature of its own, but it has to
be a trace: OKLCH chroma 0.004–0.008, which the eye reads as "charcoal, not gunmetal" without reading as brown.

A **surround preference** (Settings → Appearance → Surround: Black · Charcoal · Mid grey) is cheap and what serious
users expect: mid grey (L* 50) is the print-matching surround, black is the screen-viewing one.

**The accent: brass, not blue.** Blue is Lightroom, Figma, macOS and every SaaS. Orange is Capture One. The candidate
that is warm, photographic in heritage (darkroom safelight, brass lens mounts, old halls), low enough in chroma not to
fight a photo, and high in contrast on charcoal, is a desaturated gold:

| Role | OKLCH | ≈ hex | Notes |
| --- | --- | --- | --- |
| `accent` (brass) | `oklch(0.80 0.11 80)` | `#d9b36b` | Focus rings, the current item, progress, Publish, the edited dot |
| `accent-ink` | `oklch(0.22 0.02 80)` | `#241d0f` | Text on an accent fill |
| `accent-soft` | accent at 14 % alpha | | Pressed toggles, the current chip's wash |

Two alternatives were considered and are kept here so the choice is explicit: *sage* `oklch(0.75 0.09 160)` (calm,
collides with nothing, but reads clinical and has no story) and *safelight coral* `oklch(0.72 0.14 30)` (the best
story, but it collides with reject and delete). Brass is recommended. One rule makes any of them safe: **the accent
never sits on the picture.** Crop, guides, masks and snap lines over a photo use white, black and the guide blue
(see tokens); the accent lives in the chrome.

**Semantic colours**, so the 160 hard-coded ones go away:

| Token | OKLCH | ≈ hex | Used for |
| --- | --- | --- | --- |
| `danger` | `oklch(0.66 0.19 25)` | `#e0564a` | Reject, delete, failed jobs, a save error |
| `warn` | `oklch(0.75 0.15 55)` | `#e2924a` | Over a limit, missing tool, custom page; always with an icon and a sentence, never colour alone |
| `ok` | `oklch(0.74 0.12 150)` | `#6fbf8a` | Saved, published, done |
| `guide` | `oklch(0.78 0.10 230)` | `#5fb7e8` | Ruler guides, safe area, the one blue that stays, because it must differ from snap lines |
| `pick` | `fg` (white) | | The pick flag |

**Surfaces** (dark only; a light theme is not in scope, see *Open questions*):

| Token | OKLCH | ≈ hex | Notes |
| --- | --- | --- | --- |
| `stage` | `oklch(0.17 0 0)` | `#0f0f0f` | Achromatic. Picture wells, Cull grid, Compare, Survey |
| `stage-mid` | `oklch(0.56 0 0)` | `#7a7a7a` | The mid-grey surround option |
| `canvas` | `oklch(0.22 0.004 75)` | `#1b1a18` | The Design desk behind the page (keeps the dot grid, fainter) |
| `panel` | `oklch(0.25 0.006 75)` | `#232120` | Sidebar, inspector, Develop panel |
| `panel-2` | `oklch(0.29 0.006 75)` | `#2b2927` | Top bar, cards inside panels, inputs |
| `panel-3` | `oklch(0.33 0.007 75)` | `#343230` | Popovers, menus, floating pills |
| `hairline` | white 7 % | | Where a line is still needed (inside cards) |
| `line` | white 12 % | | Input borders, the only outer border left |
| `fg` | `oklch(0.93 0.005 75)` | `#ece9e4` | Warm off-white, not `#e5e5e5` |
| `fg-2` | `oklch(0.72 0.006 75)` | `#aba7a1` | Labels |
| `fg-muted` | `oklch(0.58 0.006 75)` | `#827e78` | Hints, counts, disabled |

Contrast: `fg` on `panel` is 12.6 : 1, `fg-2` on `panel` 6.4 : 1, `fg-muted` on `panel` 3.6 : 1 (hints only, never
for controls), `accent-ink` on `accent` 9.8 : 1. Every interactive label uses `fg` or `fg-2`.

### 2.3 Type, radius, elevation, motion

- **Type.** Inter stays for the chrome at 13 px (12 px in dense rows, 11 px only for tags). Section titles become
  **sentence case, 12 px, medium weight, `fg-2`**, tracked normally: dropping the uppercase is the single cheapest
  de-Lightroom move. Every numeric readout (slider values, counts, sizes, zoom, ruler badges) is **JetBrains Mono 12 px
  tabular**, which is what makes Halide's readouts feel instrumented. The wordmark and the empty states use
  **Instrument Serif italic** (already shipped in `packages/shared/fonts/`): "oddhalls" lowercase, nothing else in
  serif, so it stays a signature and not a theme.
- **Radius.** `xs 4`, `sm 6`, `md 8`, `lg 12`, `pill 999`. Lightroom is 0–3 px; Apple is 6–10. Buttons 6, cards 8,
  pills and the floating toolbars 12 or full, thumbnails 4.
- **Elevation.** Regions are separated by a value step, not a border: `stage → panel → panel-2 → panel-3` is four
  steps of about +0.04 L. Raised things get a 1 px inner highlight on top (`inset 0 1px 0 rgba(255,255,255,.04)`) and
  floating things a hairline plus `0 8px 24px -8px rgb(0 0 0 / .6)`. The 1 px `#333` borders between the shell's
  regions go; a 1 px `hairline` stays only between the top bar and the body, and under the strip.
- **Motion.** Three durations, `fast 120 ms` (hover, press), `base 200 ms` (segment indicator, toggles, chips),
  `slow 320 ms` (sheets, toasts, stage change), one easing `cubic-bezier(.2, .8, .2, 1)` for enters and `ease-in`
  for exits; a spring (`linear()` keyframes) only for the slider reset and the rating pop. Everything honours
  `prefers-reduced-motion` (durations to 0, the crossfades to cuts), which the slideshow preview already does.

---

## 3. Direction: "a darkroom, not a cockpit"

One sentence to design against: **the picture is the room; the controls are instruments you pick up, with weight,
detents and a click, and put down again.**

What that means in each region:

- **Shell.** The window chrome is continuous: a transparent, overlaid macOS title bar with the traffic lights
  sitting in our top bar, which is a drag region. The top bar is `panel-2` with no border below it other than the
  hairline. The stage tabs (Cull · Develop · Design) are a segmented control whose indicator **slides** between
  them; the current stage is `fg` on the indicator, the others `fg-2`. The Project ▾ menu, the document drop-down
  and View ▾ become one menu style (`panel-3`, hairline, shadow, 6 px radius, 28 px rows with the shortcut in mono at
  the right). The jobs pill bottom-right becomes a small progress ring with the count.
- **Library sidebar.** `panel`, no right border. Sections titled in sentence case; rows 26 px with the count in mono
  `fg-muted`; the current row gets a `panel-3` fill with the left 2 px in `accent`. Hover is a 6 % white wash.
- **Cull.** Grid on `stage`. A cell is the thumbnail with 4 px radius; hover lifts it by a 1 px translate and a 6 %
  white border; **selected** = 2 px `fg` ring plus a check badge; **focused** (what the keys act on) = 2 px `accent`
  ring 2 px out, and the ring *moves* between cells (one absolutely positioned element animated with `base`) instead
  of appearing on each. Stars fill with a 120 ms pop; the pick flag stamps (scale .6 → 1); a reject dims the cell over
  200 ms. The batch bar becomes a **floating pill** at the bottom centre ("12 selected · Add to project · Export ·
  Denoise · ⋯ · Clear"), `panel-3`, `lg` radius, shadow, slides up when the selection is non-empty. The filter bar
  stays docked but loses its border.
- **Develop.** The picture well is `stage`; the panel is `panel`, cards for each section in `panel-2` with 8 px
  radius and 8 px gaps, a sentence-case title row that toggles the card. **Sliders** are the centre of the redesign
  (section 4.2). The versions row and the batch bar follow the same pill treatment as Cull. Before/After gets a split
  handle on the picture (drag) besides the `\` flip. Looks strip tiles are 4 px radius with the name under them and the
  chosen one carrying the accent ring (the one place the accent touches a picture, because the picture there is ours).
- **Design.** Canvas on `canvas` with a fainter dot grid; the page keeps its paper shadow. The floating toolbar beside
  the selection is `panel-3` + hairline + shadow, `lg` radius, 32 px icon buttons. The inspector uses the Develop
  cards. The page strip tiles get 4 px radius and the current one the accent ring; the `+` tile a dashed hairline.
  Rulers go `panel-2` with mono labels.
- **Dialogs and sheets.** One `DialogShell` for all of them (Export, Sync, Describe, the three export sheets): `panel-2`
  on a 60 % `stage` scrim, `lg` radius, title 15 px medium, body 13, footer with the primary on the right. Sheets enter
  with a 320 ms fade + 8 px rise.
- **Copy.** Sentence case everywhere, no uppercase tracking, verbs on buttons ("Add 12 to project", not "Add"),
  numbers in mono.

---

## 4. Components

### 4.1 Buttons and controls

| Variant | Look | Used for |
| --- | --- | --- |
| **primary** | `accent` fill, `accent-ink` text, 28 px, `sm` radius, medium weight; hover +4 % L; active −4 % L and `translateY(0.5px)` | Publish, Export, the one action per dialog |
| **soft** (default) | white 6 % fill, no border, `fg` text; hover 10 %, active 4 % | Nearly every button that is outlined today |
| **ghost** | no fill; hover 6 % | Icon buttons, menu triggers, Clear, Cancel |
| **danger** | `danger` text, hover `danger` 12 % fill; a `danger` fill only inside a confirm | Delete, Reset edits of n photos |
| **toggle** | soft; **on** = `accent-soft` fill + `accent` text (Crop, Before/After, Proof, Adjust) | Replaces "accent border when on" |

Focus is always `0 0 0 2px panel, 0 0 0 4px accent` (ring with a gap), never a border colour change. Disabled is
40 % opacity, no hover. Every button has a press state; a button without one is the cheapest way to feel like a web
page.

**Segmented control**: a `panel` track with `md` radius and 2 px padding; the indicator is a `panel-3` pill with the
top highlight that slides (`base`) under the active item; items 12 px medium. Used for the stage tabs, Edit | Preview,
Fit · 1× · 2× · 4×, the colour-band toolbar, file format pickers.

**Inputs**: `panel-2` fill, `line` border, `sm` radius, 26 px; focus swaps the border for the focus ring. Numeric
fields are mono and right-aligned with the unit in `fg-muted`.

**Menus and popovers**: `panel-3`, hairline, shadow, 6 px radius, 2 px inset padding, 28 px rows, shortcut in mono
right, a 1 px hairline separator with 4 px margins, danger rows in `danger`.

**Tooltips**: `panel-3`, 11 px, with the shortcut in mono; shown after 600 ms on hover, at once on focus.

**Toasts**: bottom-left stack, `panel-3`, hairline, `md` radius, slide up 8 px + fade, 6 s unless hovered; a job toast
carries a 16 px progress ring.

**Tags and badges**: 10 px mono uppercase is allowed here only (file-size and `v2` tags, "Edited", "In the book").

### 4.2 The slider

The control that decides whether Develop feels like ours. Spec (replaces the inside of `components/develop/Slider.tsx`;
the props, keys and undo behaviour stay):

- **Row**: 24 px. Label in `fg-2` 12 px on the left; readout in mono 12 px `fg` on the right, a `ghost` button that
  turns into the inline field on click (unchanged). The whole row is the drag surface, not only the track.
- **Track**: 4 px tall, `pill` radius, white 14 %; the fill from the default value to the thumb in `fg` 70 % (or the
  gradient track for temperature, tint and hue, at 70 % saturation so it does not glow). On hover and during a drag the
  track reveals **tick marks**: at the default value, at ±50 % of the range and at the ends, 1 px `fg` 25 %, fading in
  over `fast`.
- **Thumb**: a **needle**, 4 × 16 px with a 2 px radius in `fg`, a 1 px `stage` outline so it reads on the gradient
  tracks; it widens to 6 × 18 px on hover and while dragging (`fast`), and takes the accent while the track is
  keyboard-focused. The round 12 px knob is the Lightroom and iOS tell; the needle is the instrument one (Higgsfield,
  Halide).
- **Detent**: within 1.5 % of the range from the default value the thumb snaps to it, with a 60 ms 1.15× scale bump
  and a haptic tick (4.3). Leaving the detent needs the same 1.5 % of travel, so it feels like a notch, not a magnet.
- **Reset**: double-click (unchanged) animates the thumb back with the spring (`slow`), and the readout counts down
  through two intermediate frames.
- **Wheel**: Option + wheel over a row nudges by `step` (Shift ×10); a plain wheel scrolls the panel. Lightroom's
  plain-wheel nudging is the number one accidental-edit complaint, so it stays gated.
- **Edited state**: a row whose value differs from its default shows a 4 px `accent` dot before the label (today the
  panel shows one "Edited" tag per panel; the per-row dot is what makes "what did I touch" scannable).
- **Keyboard**: unchanged (arrows, Shift, Page keys, Delete resets, Enter edits).

### 4.3 Tactility that only a native app can do

- **Haptics.** A Rust command `haptic(kind)` on `NSHapticFeedbackManager` (`objc2-app-kit`; `alignment`, `level-change`,
  `generic`), a no-op off macOS and on a non-Force-Touch trackpad, rate-limited to one tick per 80 ms. Fired on: a
  slider detent; a frame snapping to a guide, margin or equal-spacing match on the Design canvas (the guide already
  flashes, now it also clicks); the straighten angle crossing 0°; the zoom hitting Fit and 100 %; the crop ratio
  snapping to a preset. This is the single most "it is an app" feature available and costs about 40 lines of Rust.
- **Native title bar and menu.** `titleBarStyle: Overlay` + `hiddenTitle` so the traffic lights sit in our top bar
  (`data-tauri-drag-region` on it, 78 px left inset), `theme: Dark` so the native menus and sheets match. A native
  menu bar (File, Edit, View, Photo, Window, Help) whose items show the app's shortcuts; see plan 43 for how the
  shortcuts route so nothing fires twice.
- **Cursors.** A small set of custom cursors (crop corner, rotate, pan hand, guide drag) at 2× in `public/cursors/`.
- **Pressure.** Nothing (Force click is unreliable in WKWebView); noted so it is not asked again.

### 4.4 Delight, with restraint

The rule: a flourish is allowed once per gesture, lasts under 320 ms, and never delays the next action.

- **Thumbnails** blur-up from the 240 px thumb to the proxy (`filter: blur(8px)` → 0 over `base`), and a cell that
  finishes hashing fades its badge in.
- **Stage change** (Cull → Develop → Design): the picture stays put and the panels crossfade (`slow`); the stage
  indicator slides. Today it is a hard route swap.
- **Rating and flags**: stars pop (scale 1 → 1.25 → 1 over 160 ms), the pick flag stamps, a reject dims. In Survey,
  the removed tile shrinks to nothing and the grid reflows with `view-transition`s.
- **Before/After**: `\` crossfades over 120 ms instead of cutting; the split handle drags.
- **Render progress**: while a Develop drag outruns the GPU, a 6 px `accent` dot in the header pulses (today there is
  nothing, so a slow render reads as a broken slider).
- **Publish and export**: the job toast's progress ring completes, holds for 400 ms with a check, then "Saved" and
  Reveal in Finder.
- **Empty states**: one line in Instrument Serif italic ("No folders yet.") with the action beneath, instead of 11 px
  muted text.
- **Sound**: none. Mac apps are silent; haptics carry the feel.

---

## 5. What stays familiar (do not touch)

A Lightroom, Capture One or Darktable user must sit down and work without reading anything:

- Regions: library/filmstrip left or below, picture centre, adjustments right, module (stage) switch at the top.
- Keys: P / X / U, 1–5 and 0, R crop, `\` before/after, D develop, G grid, C compare, N survey, Space loupe, Esc back,
  J / K grid size, Cmd+arrow and Shift+arrow nudges, Cmd while dragging to skip snapping.
- Slider semantics: drag the track, Shift fine, double-click reset, click the number to type, arrows nudge.
- Panel order in Develop: White balance, Light, Curve, Color, Detail, Effects, Transform, Masks, Looks: the same order
  of operations every tool uses.
- Collapsible sections, one open at a time is *not* enforced (keep free collapse).
- Copy / Paste / Sync settings, presets, versions, the XMP sidecar round-trip.

---

## 6. Plans

Session-sized, in the style of `docs/design/plans/`; numbers continue after the cull plans (38–42). Each is done when
its *Check* passes, `pnpm typecheck`, `pnpm lint` and the Vitest suites are green, and DESIGN_NOTES carries a dated
line. Order matters for the first three; 46–49 can run in parallel once 45 lands.

### 43 · Native shell and the Tauri artifacts

Rename to oddhalls, fix the three artifacts, make the window native.

- `tauri.conf.json`: `productName` "oddhalls", window `title` "oddhalls", `titleBarStyle: "Overlay"`, `hiddenTitle:
  true`, `theme: "Dark"`, `trafficLightPosition` to sit on the 44 px bar. **Keep `identifier`** `com.photobook.editor`:
  changing it moves `<appdata>` (projects, caches, models, the registry) to a new directory. A rename of the
  identifier is its own later plan with a one-time move of the old directory. `index.html` title, the Vite dev title
  and the Home wordmark change now; `README`, docs and the site when the product is announced.
- `styles.css` base layer: `* { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none }` with
  `input, textarea, [contenteditable], .selectable { -webkit-user-select: text; user-select: text }`;
  `img, svg, canvas { -webkit-user-drag: none; pointer-events: … unchanged }`; `::selection` inside chrome
  transparent, inside text fields `accent-soft`; `html, body { overscroll-behavior: none }`; every scroll container
  `overscroll-behavior: contain`.
- `main.tsx`: a `contextmenu` listener that cancels the default unless the target is a text field or has
  `data-native-menu`; a `dragstart` listener that cancels any drag not started by dnd-kit (dnd-kit uses pointer events,
  so simply cancelling all native `dragstart` is correct; `dragDropEnabled: false` stays on the window). A `keydown`
  guard for Cmd+R / Cmd+Shift+R / F5 in release builds (WKWebView reloads on them).
- Custom context menus where the browser one showed: the Develop strip (Make a version, Copy settings, Paste,
  Reveal in Finder), the Design canvas (the floating toolbar's actions), the page strip, the sidebar rows (already
  there for collections; add folders and projects).
- Scrollbars: a `scrollbar` utility (8 px, thumb white 18 % `pill`, track transparent, thumb only while the
  container is hovered, `scrollbar-gutter: stable` on panels) applied to every list; `[&::-webkit-scrollbar]:hidden`
  on strips that scroll by wheel or drag only. The Design canvas scroll area switches to `overflow: hidden` while the
  page fits and `overflow: auto` only past fit; its content box is floored to whole pixels. Audit the 33
  `overflow-*` containers in one pass and record each decision in the plan's PR.
- Native menu bar (`tauri::menu`): File (New project, Open project file, Save as, Close project, Import folder,
  Export…), Edit (Undo, Redo, Cut, Copy, Paste, Select all, Copy settings, Paste settings), View (Show grid, rulers,
  safe area, Zoom to fit, 100 %, stage switches), Photo (Pick, Reject, Unflag, ratings, Make a version, Develop,
  Reveal in Finder), Window, Help. Items carry accelerators; **the native menu owns them** and emits one event per
  item (`menu:<id>`) that the webview dispatches to the same action functions the keydown handlers call today, and
  those keydown handlers drop the combos the menu owns. Text fields keep native Edit behaviour because Edit's
  items use the predefined `MenuItem::undo/redo/cut/copy/paste/select_all` for the system responders when a text field
  is focused (the webview reports focus state through a small `set_text_focus` command). Behind a flag for one session
  so the two paths can be compared.
- Check: no selection highlight can be made anywhere outside a text field; right-click shows our menu or nothing;
  a two-finger scroll over a fitted page shows no scrollbar; no region bounces; traffic lights sit in the top bar and
  the window drags from it; Cmd+Z in a text field undoes typing, outside it undoes the book; the release `.app` has
  no Inspect Element (already true, now verified in the Check).

### 44 · Tokens v2

The colour, type, radius, elevation and motion system from section 2, as `@theme` tokens, and the hard-coded
palette colours replaced.

- `styles.css`: the token table in 2.2 and 2.3 (OKLCH with hex fallbacks via `@supports`), `--radius-*`,
  `--shadow-raised`, `--shadow-float`, `--highlight-top`, `--ease-out`, `--dur-fast|base|slow`, the `scrollbar`
  utility, `label` becomes sentence case (rename to `section-title`; keep `tag` for the 10 px mono uppercase).
- Surround preference: `ui.surround` (`black | charcoal | mid`, per machine) sets `--color-stage` on `:root`;
  Settings → Appearance; the Develop well, Cull, Compare and Survey read it.
- Replace every `text-red-*`, `text-amber-*`, `text-emerald-*`, `bg-sky-*`, `text-white`, `bg-black/*` and `bg-white/*`
  in `apps/editor/src` with the semantic tokens (`danger`, `warn`, `ok`, `guide`, `fg`, `stage/60`, `fg/6`). A Biome
  `noRestrictedImports` cannot catch class names; add a tiny `scripts/check-palette.mjs` that greps for the Tailwind
  palette and runs in `pnpm lint`.
- `/fixture` gains a **Kitchen sink** tab: every token swatch with its contrast ratio, the type scale, radii, the
  elevation steps, and every primitive from plan 45 in every state (used for review screenshots and the visual
  regression tests to come).
- Check: `scripts/check-palette.mjs` passes; the kitchen sink renders every token; no pixel of the stage has a hue;
  contrast ratios on the sink match the table.

### 45 · Primitives and the shell

`apps/editor/src/components/ui/`: `Button` (variants from 4.1, `size: sm | md`, `icon`), `IconButton`, `Segmented`
(sliding indicator, `aria-pressed`, keyboard arrows), `Field`, `Input`, `NumberInput` (mono, unit, wheel with Option),
`Select`, `Checkbox`, `Switch`, `Menu` and `MenuItem` (one implementation for Project ▾, the document drop-down, View ▾,
the Cull menu, the Presets menu, the sidebar context menus), `Popover`, `Tooltip` (with `shortcut`), `Toast`, `Tag`,
`ProgressRing`, `DialogShell` (replacing `components/develop/DialogShell.tsx` and the three export sheets' bespoke
shells). Then the shell migrates: top bar, stage tabs, Project ▾, sidebar, filter bar, jobs pill, Home, Settings.

- Each primitive has a Vitest test for its states and keys, and a kitchen-sink entry.
- No component outside `ui/` writes `rounded-md border border-line …` any more; a Biome rule is not possible, so the
  palette script also greps for `border-line bg-panel-2` on a `<button`.
- Check: the shell screenshots on the sink's "Shell" page match the direction in section 3; Tab order and focus rings
  unchanged or better; every menu opens on Enter, Space and ArrowDown, closes on Escape and returns focus.

### 46 · Slider v2 and the Develop panel

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

### 47 · Cull, Compare, Survey

- Grid cells (radius, hover lift, white selection ring with a check, the sliding accent focus ring as one element),
  the star pop and flag stamp, the reject dim, the thumbnail blur-up, the floating batch pill, the filter bar without
  its border, Compare's zoom segmented control and captions, Survey's tile removal with view transitions.
- Check: 500 cells at 60 fps while arrowing (the focus ring is one element, so no cell re-renders); the batch pill
  never covers the last row (grid bottom padding grows while it shows); selection and focus read apart at a glance in
  the sink's "Cull" page.

### 48 · Design canvas chrome

- Floating selection toolbar, alignment toolbar and Fix spacing as `panel-3` pills; selection handles 8 px with the
  top highlight; the page strip tiles and `+`; the inspector on Develop cards; rulers in `panel-2` with mono labels;
  the zoom HUD bottom-right as a pill ("Fit · 100 %"); the dot grid fainter; the "This page is now custom" toast on the
  new `Toast`.
- Check: snap lines, guides and the safe area keep their colours (`accent` snap, `guide` blue, `warn` safe area), and
  no accent pixel lands on a photo except the selection outline of a frame.

### 49 · Delight and polish pass

- Stage crossfade, before/after crossfade, the job toast's completion beat, empty states in Instrument Serif, custom
  cursors, the Home page wordmark, the tooltips with shortcuts on every icon button, an accessibility sweep (every
  control reachable, every ring visible, contrast on the sink), a reduced-motion sweep, and a screenshot set of every
  stage for the site.
- Check: with reduced motion on, nothing animates and nothing is missing; with it off, no animation exceeds 320 ms;
  the site's screenshots are regenerated (`node apps/site/scripts/optimize-images.mjs`).

---

## 7. Open questions (decide before plan 44)

| Question | Recommendation | Why |
| --- | --- | --- |
| Accent | Brass `oklch(0.80 0.11 80)` | Section 2.2; sage and coral are the fallbacks |
| Light theme | Not now; the surround preference instead | A light chrome needs a second token set and a second round of contrast work; photographers run dark |
| Wordmark casing | `oddhalls`, lowercase, Instrument Serif italic | Reads as a place, not a product; the bird taxonomy stays on looks and templates |
| Bundle identifier | Keep `com.photobook.editor` until a migration plan exists | Changing it moves app data |
| Native menu owns shortcuts | Yes, behind a flag for one session | Needed for Cmd+Z in text fields and for the menu to be truthful; the risk is double firing, which the flag lets us check |
| Haptics default | On, with a Settings switch | Silent on machines without Force Touch |
| Slider thumb | Needle, not knob | The one visual that reads "instrument" on every reference; keep the knob only on the gradient tracks if the needle proves hard to see there |

---

## 8. Reference screens

Cited above and kept here for the plans. All on Mobbin; image links expire, the screen links do not.

- Magnific editor: https://mobbin.com/screens/ca68500c-3771-4149-9abd-4af1b2a074f1
- Magnific before/after split: https://mobbin.com/screens/7c7bc934-cd19-47fe-bb01-ac526f39e1d0
- Higgsfield colour grading (tactile value fields): https://mobbin.com/screens/0db62c86-63ce-4493-98e2-15ed348a3178 and https://mobbin.com/screens/343c9c0e-bf8f-4193-b50f-bd0403b61f1e
- Halide Mark III (tick rulers, mono readouts, yellow accent): https://mobbin.com/screens/276e40f6-8086-46bb-8308-48cbcbbab8cd and https://mobbin.com/screens/298d9809-7e34-4cb6-9c07-4a0fa712c8ba
- Halide library (white selection): https://mobbin.com/screens/3f90a143-22c4-4b41-ab96-f1ad7f43e334
- Apple Photos adjust (tick scrubber, circular tools): https://mobbin.com/screens/0dc105f4-8259-4396-bb88-979b3c4d9a66
- Apple Photos selection: https://mobbin.com/screens/d55c8518-c10c-4dc4-a83b-5da9531f741b
- VSCO adjust: https://mobbin.com/screens/b208c542-e805-4627-9834-943c48316df4
- (Not Boring) Camera (physical dials, the far end of the scale): https://mobbin.com/screens/4b1b9fbe-07b0-436e-b562-43115ea049aa
- Ghost rotation ticks: https://mobbin.com/screens/df8f285d-343a-40b7-8050-b4d4e987c0da
- Krea floating tool pill: https://mobbin.com/screens/b55a031a-39e5-4150-b48d-16b86a67625e
- Cosmos floating selection bar: https://mobbin.com/screens/ca5fc71d-56ce-4486-934a-586bbbefa500
- Leonardo before/after and zoom pill: https://mobbin.com/screens/705397a7-62de-43c5-a9f2-f56d6b7c511f
- Shopify stacked cards: https://mobbin.com/screens/2078ac36-63df-403b-882e-197f16cde21a
- Air edit mode cards: https://mobbin.com/screens/3ebc9914-ca36-4a3d-b7f7-a883cbb2ecc0
- Visual Electric adjustments (a light take, for contrast): https://mobbin.com/screens/b4020498-30e7-400d-b0ab-ea4051dbb9c0
- Weavy Levels node (histogram treatment): https://mobbin.com/screens/7e514be3-4a5b-4366-872a-b9b7ecdc2b28
- Kit mini-sliders above the picture: https://mobbin.com/screens/df8408f6-861f-4b84-b88f-410687feae8c
