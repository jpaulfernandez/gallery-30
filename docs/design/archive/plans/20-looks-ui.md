# 20 · Looks UI

Status: done 2026-10-13. Lib: `apps/editor/src/lib/develop/looks.ts` (`isLook`, `allLooks`, `BUILT_IN_LOOKS` (empty,
for plan 21: read-only presets with `builtIn`, `look: true` and a stable `builtin:` id), `applyLook`, `lookAmountOf`,
`replaceLook`, `removeLook`, `lookBase`, `chosenLookId`, `stepLookId`, `makeLook`, `makeLutLook`, `lookThumbKey`);
`DevelopPreset.look?: boolean` (TS) and `Preset.look` in `presets.rs` (written only when true). Scaling: each section
the look lists becomes `default + amount × (look − default)` over the look laid on the defaults (so applying never
depends on the photo's previous values there, and "100 then 50" equals "50" exactly); integers stay integers; a
grading wheel keeps its hue and scales its saturation; point curves move `y` towards `x` (the default at 0);
non-numeric values switch at amount > 0; the LUT strength is `look strength × amount`. Switching looks first resets the
previous look's sections (when it is known); None resets them and the LUT. Decision on `look.applied`: it is in
`DevelopLookSchema` (`{ presetId, amount 0–100 } | null`, default null) but **never hashed**: `hashableDevelop` always
strips it (the Rust mirror has no field; serde ignores it), so the parity fixtures are unchanged; XMP export/import of
our own packet drops it (values kept). `presetValues` also strips it, so no preset carries a photo's `applied`. Rust:
`render_look_thumbs` lives in its own child module `commands/develop/looks.rs` (declared at the end of `develop.rs`,
registered as `commands::develop::looks::render_look_thumbs`) to keep the shared file's edit to two lines. Deviation:
the editor sends each look's full settings (`applyLook(lookBase, look, 100)`) instead of preset objects, so the scaling
maths exists once; file names are `cache/<hash>/looks/<baseDh>-<presetKey>-<dh16>.jpg` (the plan's key plus the first
16 hex of the rendered settings' develop hash, so an edited look with the same id never shows a stale thumbnail; the
older file is deleted), last 3 bases kept; sRGB at 240 px from the cached working image resized once; event
`develop:look-thumb` per thumbnail; a newer job stops an older one between looks; an all-cached request needs no
render permit. UI: `components/develop/LooksSection.tsx` first in the panel (strip with None first and the chosen ring,
Amount only while a look is applied and locked with a reason when the look is not on this Mac, ⋯ menu: Save current as
look…, Import LUT… (saves the LUT as a look and applies it), Match camera JPEG…, Manage looks…), thumbnails asked 350 ms
after the settings settle; plan 22's suggestion row (`FittedSuggestion`) shows under the strip and its *Match camera
JPEG…* is in the ⋯ menu (opens `MatchCameraDialog`). The plan 18 picker became `LutControls` in `LookSection.tsx`
(exported; `LookSection` kept as a wrapper but no longer mounted; plan 22's block kept, its two components now exported,
and `cameraMatch={false}` hides them inside Looks), shown under a "LUT" disclosure. `store/looks.ts` (saved looks,
`findLook`, `applyLookTo`, `stepLook`, `lookNameOf`); book store `applyDevelopLook` (one undo step over the selection);
`[`/`]` in `DevelopMode` (after the brush branch, which keeps them while the brush is the tool); batch slot *Apply look…*
(order 40) with a look select and Amount; filmstrip `LookBadge` (applied look's name, else the LUT's, on hover/focus).
Looks are not filtered out of the Presets menu (left as is). Checks: 12 looks on the 1067×1600 proxy of
`fixtures/sample-trip/DSCF1000.jpg` (ignored test `looks::tests::timing_twelve_looks`, debug build, busy machine):
median 40 ms and 64 ms on two runs, the first run in the test process 212 and 489 ms (GPU start-up; the app warms the
GPU at launch), cache hit 1 ms; the editor logs `[photobook:develop] look thumbs n=… rendered=… cached=… total=…ms`.
Cache hit on reopen and pruning: `renders_once_then_hits_the_cache_and_prunes_old_bases`. Vitest: `looks.test.ts`
(scaling, parity 100→50 and other amounts, LUT strength, switch/remove, base hash, steps, makeLook),
`LooksSection.test.tsx` (strip, Amount scaling and undo, LUT look strength, `[`/`]`, thumbnail request and events, Save
as look, locked Amount, Apply look… on a selection as one undo step, badge), `schema.test.ts` (applied never hashed);
`LookSection.test.tsx` and `MatchCamera.test.tsx` updated to the new places. Not done: the GUI was not looked at (no
screen in this session). Review fixes (same day): only whole-step slider paths round to
integers (`INTEGER_PATHS`; exposure, sharpening radius, curve points and splits keep four decimals); `lookAmountOf`
returns null (Amount locked, "changed since") once a section differs from what the look wrote at its Amount
(`untouchedLookSections`, `lookIntact`); switching or removing resets only those untouched sections and clears
`applied`; a LUT chosen, its Strength, or plan 22's suggestion Apply clear `applied`; with nothing applied None/Reset
reset Effects and the LUT; Sync/Copy keep `applied` only when every section of the look is copied (`appliedAfterCopy`
through a lookup `store/looks.ts` registers); the thumbnail listener is removed when the effect ended during setup; the
request is built inside the 350 ms timer and skipped when unchanged; the cap is 256 with a readable error; thumbnails
are rendered from the crop at 240 px; a look with a missing LUT is dimmed and marked; Import LUT… reuses only a look
that is exactly that LUT; the strip is one tab stop with Left/Right; the decode holds the render permit, then each look
takes its own (`render_thumbs_into` gains a `gate`). Tests for each (`looks.test.ts`, `LooksSection.test.tsx`, Rust
`a_cropped_photo_gets_a_full_size_thumbnail_of_its_crop`); the tests read plan 21's `BUILT_IN_LOOKS` instead of assuming
none.

WORKFLOW_PLAN [4.2](../WORKFLOW_PLAN.md#42-looks-as-a-kind-of-preset) (W5.4). Size: 2 days. Depends on: 19, 08.

**Goal.** A Looks section at the top of the Develop panel: a strip of thumbnails rendered on the photo, an Amount
slider, Save current as look, Apply look on a selection.

## Decisions

- A look is a preset with `look: true` whose sections include `effects` and `look` (`DevelopPreset` in TS and
  `presets.rs`). Built-in `bw` and `fade` stay plain presets.
- Amount scales a parametric look linearly from the defaults (`value = default + amount × (preset − default)`) and is
  the LUT strength for a LUT look. To re-adjust later the schema records `look.applied: { presetId, amount } | null`;
  the written settings are the scaled values, so a missing preset only locks the slider.
- Thumbnails: one GPU pass per look on the proxy at 240 px, keyed `(hash, baseDh, presetId)` where `baseDh` hashes
  the settings without `effects`/`look`; cached in `<appdata>/cache/<hash>/looks/`, last 3 bases kept.

## Steps

1. **Lib.** `lib/develop/presets.ts`: `applyLook(settings, look, amount)`, `lookAmountOf`, `isLook`; tests.
2. **Rust.** `render_look_thumbs(folderId, path, hash, base, looks[], job)` in `commands/develop.rs` emitting one
   event per thumbnail; cache dir and pruning; `presets.rs` persists the `look` flag.
3. **UI.** `components/develop/LooksSection.tsx`: horizontal strip (name under each), None first, selected ring,
   Amount slider, ⋯ menu (Save current as look…, Import LUT…, Manage). Keyboard: `[`/`]` step through looks.
4. **Batch.** **Apply look…** mounts in the batch bar (08) with a picker and Amount; one undo step over the selection.
5. **Filmstrip.** A small look name badge on hover.

## Check

- Thumbnail strip renders in under 300 ms for 12 looks on a proxy (log timing); cache hit on reopen.
- Component tests: amount scaling, apply/undo on a selection, LUT look sets strength.
- Parity: applying a look at 100 then 50 equals direct settings at those values (Vitest).

## Docs

- `docs/DEVELOP.md` Looks; `docs/design/DESIGN_NOTES.md`.
