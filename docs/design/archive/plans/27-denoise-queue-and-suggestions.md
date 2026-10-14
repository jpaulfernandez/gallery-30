# 27 · Denoise queue and suggestions

Status: done 2026-10-13. Landed: `lib/denoiseQueue.ts` (`planDenoiseBatch`, `startDenoiseBatch`, `enqueueDenoiseBatch(ids,
{ force })`, `queueDenoiseIfStale(id, { since })`, `useQueueDenoiseOnLeave`, `pendingDenoiseCount`, `measureNoise`),
`store/denoisePrefs.ts` (Settings → Models' denoise model and thresholds, the last per-tile timing per model, in
`localStorage` under `photobook.denoise.prefs`), `components/develop/DenoiseBatch.tsx` (the confirm, mounted in
`main.tsx`, and the batch bar slot `denoise`, order 50), `components/filmstrip/DenoiseBadge.tsx`,
`components/settings/DenoiseDefaults.tsx` (inside `ModelsPanel`); small edits to `lib/jobs/denoise.ts`
(`enqueueDenoise` takes `force` and records each finished run's timing), `lib/tauri.ts` and Rust `run_denoise`
(optional `force`: replace an intermediate already on disk), `store/collections.ts` (`needsDenoise` takes the
thresholds, default from the prefs; `noiseSignature`), `FilmstripCell`, `CullGrid` (badge), `CullMenu` (Denoise…),
`Sidebar` (the Needs denoise count follows the thresholds and new σ), `PublishPanel` (idle line), `DevelopMode` (one
hook call). Deviations: (1) the batch lives in `lib/denoiseQueue.ts`, not `lib/jobs/denoise.ts` (it needs the book,
library and UI stores; `lib/jobs/denoise.ts` stays the plain adapter, and plan 28 calls `queueDenoiseIfStale` from
there). (2) Photos with denoise on keep their own settings; only photos with it off get the defaults (Settings model,
`switchOnDenoise(suggestedAmount(profileEvidence(profile, iso)))`), written as one undo step through
`beginGesture`/`endGesture` (no new book store action). (3) Shift really re-runs: `run_denoise` gained `force`
(otherwise Rust returns the existing intermediate at once); the dialog also has a "Run again" checkbox. (4) The
estimate is ms per tile × tiles, with tiles taken as the photo's megapixels × the last run's tiles per megapixel
(the tile size is per model in Rust and not returned); no estimate before a first timed run (load and decode time are
included in the per-tile figure). (5) The settings threshold has two values: an ISO (default 3200) and a suggested
amount for measured σ (default 40, the old `NEEDS_DENOISE_AMOUNT`); saved collections made from Needs denoise store
the ISO threshold at save time. (6) The badge hides once denoise is on for the photo. (7) The sidebar count already
existed (plan 23); it now recounts on threshold and σ changes. (8) The publish dialog's new line counts queued or
running denoise jobs of the book's used photos by content hash, before Publish is pressed; while publishing the plan
09 line ("N photos still denoising") stays. Publish waiting was verified, not changed: `denoiseBeforePublish` joins
the batch's jobs through the shared dedupe key (tested). (9) Queue-on-leave queues only when the photo's denoise
settings changed while it was shown, denoise is on, nothing for the key is on disk or queued and the model is
installed; it runs in DevelopMode for editable photos (cleanup of an effect keyed on the photo id). (10) The noise
profile cache for batches is its own (`measureNoise`), separate from `DenoiseGroup.tsx`'s (left untouched for plans
24/28; Rust caches the measurement per hash, so a double request costs a cache read); plan 28 can make the group use
it. Tests: `lib/denoiseQueue.test.ts` (10 photos → 10 jobs, one running at a time, cancelling one leaves the other
nine to finish; switch-on with the Settings model and suggestion as one undo step after measuring; own settings
kept; already denoised skipped, force re-runs with `force` sent; queued and missing-model cases; estimate and timing
record; queue-on-leave function and hook; publish count; publish gate joins the batch jobs), `DenoiseBadge.test.tsx`
(ISO 6400 shows, ISO 200 does not, σ wins over ISO, hidden when on, thresholds), `DenoiseBatch.test.tsx` (confirm
count, skipped, estimate, Shift, missing model), `PublishPanel.denoise.test.tsx`. After review (same day): planning takes an `AbortSignal` (closing the confirm or changing "Run again" aborts it; no
new measurement or status read starts, `PlanAborted`); photos whose model is missing are left out (`blocked`) and the
rest still run; a photo switched on since the plan was made keeps the user's settings; the estimate sums the known
photos ("at least …, N photos not estimated") and is unknown only when no run of the models was timed; the Needs
denoise collection drops photos whose master denoise is on, `noiseSignature` tracks which photos cross the thresholds
and the open Needs denoise list (`routes/library.tsx`) follows it and the thresholds; a forced run's dedupe key ends in
`:force`; the leave hook takes its baseline only once the photo's folder library is loaded; `pendingDenoiseCount`
memoises the used hashes per book; `denoise_into_cache` writes both intermediates under `.staged` names and moves them
in only when both are complete, so a failed (forced) run never deletes a valid one. **For plan 28:** `denoiseJobKey`
(`lib/jobs/denoise.ts`) has a TODO to add `chromaMode` once `DenoiseSchema` has it (not there yet; Rust's key has it).
Editor suite 1064/1064 passed; `cargo test -p photobook-editor --lib` 159 passed. Not
done: no in-app check (no screen capture); the GPU run of a real 10-photo batch was not timed.

WORKFLOW_PLAN [5.3](../WORKFLOW_PLAN.md#53-workflow-integration) (W6.4). Size: 1 day. Depends on: 09, 08, 23.

**Goal.** Denoise many photos ahead of time from Cull or Develop, and see at a glance which photos need it.

## Decisions

- **Denoise selected** in the batch bar enqueues one denoise job per photo with the current defaults (model from
  Settings, amount from the profile suggestion); already-denoised photos are skipped unless Shift is held.
- Auto-suggest threshold in Settings → Models (default ISO 3200, or σ when a profile exists); a small badge on
  thumbnails in Cull and a *Needs denoise* count in the sidebar collection.
- Leaving a photo with changed denoise settings queues its full run (the "Needs apply" state of plan 28); this plan
  wires the enqueue, 28 the pill.

## Steps

1. `lib/jobs/denoise.ts` (09) gains a batch entry point; the batch bar button; a confirm with the count and the
   estimate (per-tile timing from the last run × tiles).
2. Badge in `FilmstripCell`/the Cull grid cell from the index ISO or the cached noise profile; the Settings threshold.
3. Publish dialog line "N photos still denoising" from the queue.

## Check

- Select 10 photos, Denoise selected: 10 jobs, one at a time, cancel one leaves the others; publish waits.
- Badge appears for ISO 6400 photos and not for ISO 200.

## Docs

- `docs/DEVELOP.md` Denoise (batch).
