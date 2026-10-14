# 28 · Denoise UX

Status: done 2026-10-13. Landed: `components/develop/DenoiseGroup.tsx` rebuilt (row with the switch and the state pill;
the plan 23 badge, or "Not needed at ISO 200" folded while off when the suggestion is under 15; **Amount**; the
first-run model card with size, licence and one Download button; **Preview at 100 %** and **Apply · ~14 s**; the job's
progress row; **Advanced** with a value summary, Luminance, Colour, Sharpen, Colour from Filter / Model, the per-photo
model select marked "(default)" from Settings → Models, and Reset), `components/develop/DenoiseLoupe.tsx` (mounted by
`DevelopImage` in place of the old crop marker), `useDenoise.ts` (`denoisePhase` / `phaseLabel` state machine, shared
in-flight `denoiseStatus` calls, the estimate from plan 27's timing, `CROP_PREVIEW_DEBOUNCE_MS = 600` with the first
crop rendered at once, `noteSwitchOn` and the gate log), `lib/denoise.ts` (`colourForAmount`, `colourFollows`,
`amountPatch`, `resetAdvancedPatch`, `advancedTouched`, `estimateLabel`, `notNeededLabel`; `denoiseFromAmount` uses the
mapping), `lib/jobs/denoise.ts` (`denoiseJobKey` gains the colour mode: the TODO is done), `lib/denoiseQueue.ts`
(`markNeedsApply` / `shownNeedsApply`; leaving a photo whose group read *Needs apply* queues it), Settings → Models'
"Default model" (`DenoiseDefaults.tsx`), `DevelopMode.tsx` (loupe mount, `CropMarker` removed), docs
(`docs/DEVELOP.md` Denoise section and AI models, `docs/design/DESIGN_NOTES.md` Denoise group and loupe). Tests:
`DenoiseGroup.test.tsx` rewritten (mapping, Advanced survival and Reset, default model, pill states including Colour
with the filter staying *Applied*, estimate, download card, Apply/Cancel/failure, folded state), `DenoiseLoupe.test.tsx`
(first crop at once, 600 ms debounce, no render while a slider is held, gate log, missing model, hold for before,
Before / After key, drag pins on release, arrow keys, split handle, close), `useDenoise.test.ts` (`denoisePhase`
walk), `lib/denoise.test.ts` (mapping), `denoiseQueue.test.ts` (leave with *Needs apply*), `adapters.test.ts`
(`denoiseJobKey` and the colour mode), `DenoisePick.test.tsx` updated for the loupe; plan 27's dedupe and publish
tests pass unchanged. Deviations: (1) `SplitHandles` is the tone curve's region handles, not a before/after split, so
the loupe has its own split handle (`role="slider"`, drag, arrow keys, double-click to centre). (2) Colour "updates
immediately" on the live picture around the loupe (the chroma filter runs at render time and a Colour change keeps
the run, so the pill stays *Applied*); inside the loupe Colour waits for the 600 ms debounce like the rest, because
`preview_denoise_crop` runs the model on every call and plan 25 is changing Rust denoise now (a crop-level model cache
in Rust would make it instant). (3) `denoiseJobKey` mirrors Rust's `denoise_key`: `chromaMode` is in it and Colour only
with the model colour, so runs that differ only in Colour with the filter are one job. (4) The fold uses the "Not
needed" line (suggestion under 15, the badge's own word), not Settings → Models' Needs denoise thresholds (ISO 3200 /
amount 40), which still drive the badge and collection; a photo between the two shows the group unfolded. (5) Whether
Colour follows Amount is read off the values (`chroma === min(100, luminance + 25)`), with no extra state, so it
survives sessions and undo; moving Colour back onto the mapping by hand makes it follow again. Advanced › Luminance is
the Amount itself. (6) Leaving queues on *Needs apply* shown (not only on settings changed while shown, plan 27), so a
photo switched on in an earlier session and never applied is queued when you step past it. (7) The Settings model is
now the default for the group's switch too (it was the batch's only), labelled "Default model". (8) The loupe drag
moves the window with the pointer and pins the point (one crop) on release; hold is 200 ms without moving; arrow keys
nudge the point; Before / After (\\) also shows before; clicking the picture elsewhere still moves it. Gate: not
measured (no way to drive the window from an agent). Instrumented: switching on logs `[photobook:denoise] switched on`
and the first denoised crop after it `[photobook:denoise] first crop preview {"ms":…,"request":…}` (`ms` from switch-on,
`request` the crop call alone; later crops log `crop preview {"ms":…}`, and Rust logs `[photobook:develop] denoise crop
… decode=…ms run=…ms`). To check: `pnpm dev`, open an ISO 6400 photo in Develop with NAFNet installed, turn Denoise on
without touching anything else, and read `ms` (pass at ≤ 2000); the model download of a truly new user is outside the
2 s. After review (same day): the loupe's split stays within 2–98 % and its handle stays mounted (transparent while
before shows whole, keeping focus), and dragging it no longer holds the crop back; the denoised crop is asked for
first and the untouched one only after it is back (one full decode on a cold photo); only a switch-on renders at once,
the loupe opening, a photo change or a new point wait `CROP_PREVIEW_SETTLE_MS` (200 ms; stepping through 20 photos
asks for the last one only), settings changes 600 ms; a switch-on is forgotten when the loupe closes or after 10 s;
the pill holds its last state until the status after a run lands (no *Needs apply* flash) and reads *Checking…* rather
than unmounting; a cancelled run is not re-queued on leave until its settings change (`dismissNeedsApply`) and a failed
one never is; the group's job is also found by its dedupe key (`activeJobByDedupe` in `store/jobs.ts`), so a library
key's run of the same file and settings shows; `aria-live` is on the pill and the status line; Escape closes the loupe
(DevelopMode); the fold waits for the measurement and says "Not needed (clean at ISO 6400)" when σ is clean but the ISO
high; one model list (`DENOISE_MODEL_CHOICES`) serves the group and Settings → Models. Plan 25's wavelet merge keeps
about 95 % of fine grain where the old flat blend did not at the same slider value; the Amount mapping is left
unchanged on purpose: Amount is the blend strength, the suggestion scale is set on σ (not on how the blend looks), the
merge only makes a given value look less smoothed, and retuning without a real high-ISO camera check would be a guess
that also changes what every saved Luminance means. Editor suite 1203/1203; `pnpm typecheck` clean.

WORKFLOW_PLAN [10](../WORKFLOW_PLAN.md#10-denoise-ui-and-ux), [13](../WORKFLOW_PLAN.md#13-added-phases-and-decisions) (W6.5).
Size: 2 days. Depends on: 27, 24.

**Goal.** One slider in front, a live loupe on the picture, advanced controls behind a disclosure, and Apply as a
state rather than a chore. A new user at ISO 6400 gets a clean preview within 2 s of switching denoise on and
publishes without ever pressing Apply.

## Decisions

- **Amount** sets Luminance; Colour follows `min(100, amount + 25)` until Advanced changes it; Sharpen stays at its
  default. The schema is unchanged; Amount is a UI mapping in `lib/denoise.ts`.
- The loupe: switching on opens a 100 % window pinned to a draggable point (`ui.denoise.center` exists) with the
  `SplitHandles` split and press-and-hold for before. The 512 px crop preview (`preview_denoise_crop`) re-runs when
  the sliders settle (600 ms debounce); with the chroma filter path the colour half updates immediately.
- State pill on the group row: *Applied*, *Needs apply*, *Running 37 %*; the Apply button shows the estimate.
  Leaving the photo with *Needs apply* enqueues the full run (27).
- Model choice moves to Settings → Models as the default, with a per-photo override under Advanced; the first-run
  download card stays with the size and one button.
- Photos below the threshold show the group collapsed with "Not needed at ISO 200".

## Steps

1. `DenoiseGroup.tsx` rebuilt around the proposal layout; `useDenoise.ts` gains the debounce and the state machine;
   the badge row from 23.
2. `components/develop/DenoiseLoupe.tsx` over the preview canvas; drag to move, split handle, hold for before.
3. Settings → Models: default model and the ISO/σ threshold.
4. Tests: `DenoiseGroup.test.tsx` rewritten (amount mapping, pill states, collapsed state), loupe test for the
   debounce and the before hold.

## Check

- The gate above, checked with log timestamps from switch-on to the first crop preview.
- Advanced values survive Amount changes once touched; reset returns to the mapping.

## Docs

- `docs/DEVELOP.md` Denoise section rewritten; `docs/design/DESIGN_NOTES.md`.
