# 21 · Built-in looks

Status: done 2026-10-13. Data: `packages/shared/src/develop/looks.ts` (`BUILT_IN_LOOK_DEFS`, `BUILT_IN_LOOK_SECTIONS`
= curve, color, effects, look; `builtInLookPresetId`, `builtInLookSettings`, `formatLookList`), exported from the shared
index. Twelve looks, id = bird (lower-case), `name` the bird, `about` the description: Oriole (warm negative, 80 %),
Heron (cool negative, 80 %), Starling (chrome, 90 %), Kingfisher (slide, 75 %), Kestrel (cine print, 80 %, halation),
Rook (pushed black and white, 100 %), Magpie (bleach bypass, 85 %), Dove (faded, 80 %), Sparrow (matte, 85 %), Robin
(portrait soft, 80 %), Owl (night, 80 %, halation), Egret (high key, 80 %). Each sets a luma (and sometimes one channel)
point curve, Color (saturation, vibrance, colour mix), grading wheels, grain and vignette; no Light, White balance,
Detail or LUT, so they work on RAW and JPEG alike and never touch exposure. Decision: looks carry an `amount` (the
Amount a look starts at when picked); the editor honours it through `lookDefaultAmount` (strip click, `[`/`]`,
`applyLookTo` without an Amount, and the thumbnails, which show each look at its starting Amount); saved looks stay at
100. Editor: `BUILT_IN_LOOKS` in `lib/develop/looks.ts` maps the shared looks to read-only presets `builtin:<bird>`
(`builtIn`, `look: true`) plus `builtInLookDef`; the strip's tooltip is "Name: about". Deviation: applying a built-in
look replaces the photo's Curve and Color sections (plan 20's rule for any look that holds them), documented in
DEVELOP.md. CLI: `photobook looks [--json]` (handled before the settings load). Rust: `tests/fixtures/looks/<id>.json`
(each look at 100 % in the parity format, written by `looks.test.ts` with `UPDATE_DEVELOP_FIXTURES=1`, in a subfolder
so `parity.rs` does not read them) and two tests appended to `tests/effects.rs` (no new test binary):
`built_in_looks_parse_hash_and_render` (Rust hash equals TS, each look changes the render) and the ignored
`look_review` (env `PHOTOBOOK_LOOKS_OUT`, optional `PHOTOBOOK_LOOKS_JSON` / `PHOTOBOOK_LOOKS_FIXTURES`), which writes
`<look>-<photo>.jpg` and `none-<photo>.jpg` at 1600 px through `render_preview`. `/fixture` has a *Renderer · Looks*
tab pair (tab remembered in localStorage; the router uses hash history, so no URL fragment); `components/fixture/
LooksFixture.tsx` renders None and every look on three photos of the imported folders (defaults by name: lisbon
`IMG_01.jpg`, `IMG_11.jpg`, `portrait-01.jpg`; choice remembered) one at a time through `render_develop_preview`, with
Before and an Amount select (starting Amount / 100 %). Portrait fixture: `fixtures/portrait/portrait-01.jpg`
(1600×2000), synthetic, drawn by `scripts/make-portrait-fixture.py` (numpy + Pillow, fixed seed, byte-reproducible),
CC0 1.0; nothing downloaded. It is stylised, not photo-real (a lit ellipsoid face, hair, eyes, lips, a blue shirt,
bokeh with bright discs for halation); a real CC0 portrait photo would still be better for skin. Visual review: the
Tauri window could not be driven here, so the set was rendered with `look_review` on lisbon IMG_01, IMG_11, IMG_04 and
the portrait at each look's starting Amount (settings from the editor's own `applyLook`) and at 100 %, and inspected
as contact sheets: /private/tmp/claude-501/-Users-polaris-projects-photobook/b60be4b3-2592-42f4-8fbc-7012baac04f9/scratchpad/plan21/sheet-default-*.jpg and /private/tmp/claude-501/-Users-polaris-projects-photobook/b60be4b3-2592-42f4-8fbc-7012baac04f9/scratchpad/plan21/sheet-full-*.jpg (single renders in /private/tmp/claude-501/-Users-polaris-projects-photobook/b60be4b3-2592-42f4-8fbc-7012baac04f9/scratchpad/plan21/review/ and
/private/tmp/claude-501/-Users-polaris-projects-photobook/b60be4b3-2592-42f4-8fbc-7012baac04f9/scratchpad/plan21/review-full/). Tuning from that review: grain cut to a half or a third everywhere (the first pass, 10–45, was far
too coarse at proxy size: amplitude is 0.12 × amount of the range), halation thresholds raised (Kestrel 85, Owl 80) so
daylight whites do not turn pink, Rook's red/orange luminance lift removed (skin went white), Kingfisher vibrance 25 →
20. The `/fixture` Looks tab was checked in Vitest (`LooksFixture.test.tsx`, mocked render) and in the browser without
Tauri (renders, explains that the folders cannot load), not in the window. Tests: shared `looks.test.ts` (10–12 looks,
unique bird ids and names, no film brand (word list), parses with `DevelopSchema.partial()` and no key dropped, every
value in range, curves monotone, Amounts 1–100, halation on exactly Kestrel and Owl, the CLI list snapshot, fixtures);
editor `builtInLooks.test.ts` (preset ids, Amount 0 keeps an untouched photo's develop hash, in range at every Amount,
starting Amounts); `cargo test -p photobook-develop --test effects --test parity` pass. Failing in others' code at the
time: editor `store/denoise.test.ts` and `DenoiseGroup.test.tsx` (`chromaMode`, plan 24) and publish `publish.test.ts`
(`locked` in `site.json`). Review fixes: the batch *Apply look…* Amount follows the chosen look's starting Amount
until the slider is moved (a remembered Amount belongs to the remembered look), and both Amount sliders reset to the
starting Amount on double-click (tests in `LooksSection.test.tsx`); the `/fixture` tabs are plain buttons with
`aria-pressed`; a render dropped for a newer job is retried twice, then shown as skipped; Before alt text says "<look>,
before"; renders no cell shows are revoked when a slot or the Amount mode changes; `fixtures/portrait/README.md`
(CC0, command, Pillow 12.3.0 / numpy 2.5.0); each look at its starting Amount is written by the editor's
`builtInLooks.test.ts` to `crates/develop/tests/fixtures/looks/start/` and `effects.rs` checks Rust's canonical string
and hash; `packages/publish/src/looks.test.ts` runs `photobook looks` and `--json`; the brand list adds instax, leica,
hasselblad and drops gold and delta; CLAUDE.md Layout names the looks data, the command and the portrait fixture.

WORKFLOW_PLAN [4.3](../WORKFLOW_PLAN.md#43-where-the-looks-come-from-licensing) (W5.5). Size: 1.5 days. Depends on: 20.

**Goal.** Ten to twelve parametric looks we author, named descriptively or by the chosen taxonomy, never by a film
brand, tuned on the lisbon fixtures and a portrait set, with a gallery page for visual review.

## Decisions

- Looks are data in `packages/shared/src/develop/looks.ts` (so the CLI can list them) with `id`, `name`, `about`
  and a partial `DevelopSettings`; the editor merges them into the preset list as read-only.
- Starting set: Warm negative, Cool negative, Chrome, Slide, Cine print, Pushed black and white, Bleach bypass, Faded,
  Portrait soft, Night, Matte, High key. These are the *descriptions* (kept in `about`); the user-facing names follow
  the bird taxonomy (README *Names*), one bird per look, chosen for the look's character (a pushed black and white
  as *Rook*, a cool negative as *Heron*, and so on); ids are the bird names, lower-case, and never change after release.
- A portrait fixture is needed (DEVELOP_PLAN's known gap); add one under a permissive licence or shoot one.

## Steps

1. Author each look: curve, colour mix, grading, grain, vignette (halation on two of them), with `amount` defaults.
2. `/fixture` route: a *Looks* tab rendering every look on three fixtures at proxy size through the real pipeline,
   with the name and a before toggle. This needs the Tauri window; note in the status how it was reviewed.
3. A Vitest that every look parses, has a unique id, and leaves the develop hash of an untouched photo unchanged
   when applied at amount 0.

## Check

- Visual review in the window (or screenshots attached to the status); every look within the slider ranges.
