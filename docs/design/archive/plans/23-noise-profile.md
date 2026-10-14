# 23 · Noise profile

Status: done 2026-10-13 (revised the same day after review). Landed: `crates/develop/src/ai/noise_profile.rs`
(`measure`, `NoiseFit::is_valid`, `ProfileStore` with `lookup` / `learn`, `fold`, `profile_at`, `blend`, `sigma_of`),
`crates/develop/src/decode/camera_meta.rs` (`camera_exif`, `clean_make`, `clean_model`),
`apps/editor/src-tauri/src/commands/noise.rs` (Tauri `noise_profile`, `camera_profile`, `learn_profile`; at most 2
`noise_profile` calls at once), `prepare_asset` returning `iso`, `make`, `model` and `noise` (meta.json gains `exif`,
old ones are backfilled from the source on their next prepare; `noise` is always sent, null when there is no current
measurement, so a stale index value is cleared), index entries gaining `noise` (old index files read as before), TS
wrappers in `lib/tauri.ts`, `suggestedAmount` / `profileEvidence` / `switchOnDenoise` / `denoiseFromAmount` /
`noiseBadge` / `isNotNeeded` in `lib/denoise.ts`, the badge row and suggested default in `DenoiseGroup.tsx` (requests
deduplicated by hash and started 250 ms after a photo is shown), `needsDenoise` in `store/collections.ts` and
`recordPhotoNoise` in `store/library.ts`.
API shapes for plans 24, 27, 28: `noiseProfile(folder, relPath, hash) → NoiseProfile { make?, model?, iso?, source:
'raw'|'processed', measured: NoiseFit, sourceSize?: [w, h], scale?, learned: CameraNoiseProfile|null (the curve before
this photo), learn: 'added'|'averaged'|'alreadyKnown'|'lowConfidence'|'outlier'|'invalid'|null, photos, channels:
[{a,b}]×3, sigma, confidence }`; `NoiseFit { channels, sigma, confidence, patches, range: [lo, hi], extrapolated, width,
height }`; `cameraProfile(make, model, iso, source) → CameraNoiseProfile { make, model, source, iso, channels, sigma,
photos, totalPhotos, agreeing, established, interpolated, distance, isos } | null` (`source` is required);
`learnProfile(make, model, iso, source, hash, fit) → { outcome, profile }` (`hash` must be a SHA-256 hex digest);
`suggestedAmount({ sigma?, iso?, source? }) → 0..100 | null`; `switchOnDenoise(suggestion)`. σ is linear, at mid-grey
(0.18), measured on the 1600 px working decode (Rust: same names, snake_case; `variance = a·mean + b` per channel in
linear Rec.2020). **Which σ:** plans 24 and 27 must key files and settings on `measured.sigma` (the photo's own fit,
cached in `noise.json` until `PROFILE_ENGINE` changes; quantise it, e.g. to 3 significant digits); the blended
`NoiseProfile.sigma` moves as other photos are learned and is only for the badge and the suggestion. **Scaling:**
`scale` is the source long edge over the analysed long edge (from `meta.json`; absent when `prepare_asset` has not
run). For white noise σ at full size ≈ `measured.sigma × scale`; real files have spatially correlated noise, so full
size σ lies between `measured.sigma` and `measured.sigma × scale` (plan 24 should calibrate where in that range on a
full-size crop). A `NoiseFit` with `confidence` 0 has no curve (σ 0): fall back to the ISO.
Deviations: (1) the flat-patch test is the high-pass (Immerkær) share of each block's plane-detrended variance, not
"low variance after a light blur" (a blurred gradient test let mid-frequency texture through); per bin the variance is
read off the lower quartile and a monotone lower envelope is applied so texture in the shadows does not pass for noise.
Confidence counts only the fitted blocks (means ≤ 0.6), is halved per two stops mid-grey lies outside the fitted range
(`extrapolated`), and a bright photo with no block under 0.6 gives no fit (confidence 0), never a zero curve.
(2) Learned profiles keep RAW and processed (JPEG/HEIC/PNG) entries apart in the same `<make>-<model>.json` (version
2): each ISO keeps its newest 16 fits and uses the component-wise median of those within 2× of the median σ once 3
agree (so one bad photo, first or not, cannot set it); invalid fits (σ 0, a zero channel, NaN or negative parameters,
empty or non-hex hash) are refused; lookups use only established entries, interpolate log-log in ISO, extrapolate at
most 2 stops (`a ∝ ISO`, `b ∝ ISO²`) with confidence halving per stop; file names need both make and model, are slugged
and capped at 80 characters (non-ASCII names become a hash), and an unparseable or other-version file is copied to
`.json.bak` before it is replaced. `suggestedAmount` has a scale per source (processed 0.7 % → 0 … 5 % → 100 of
mid-grey, RAW 1.5 % … 10 %, log scale; "Not needed" under 15; ISO fallback 400 → 0 … 25600 → 100), and "Needs
denoise" is a suggestion of 40 or more when σ is known, ISO ≥ 3200 otherwise (saved collections made from it still
store `iso: 3200`, the filter schema has no σ). (3) σ reaches the index and the collection when a photo's Denoise
group measures it (and from `noise.json` through `prepare_asset` on later scans); nothing measures photos in bulk
(plan 27's batch can call `noiseProfile`). (4) The module is under the `ai` feature like the rest of `ai/`;
`--no-default-features` still builds. (5) Switching denoise on starts from `switchOnDenoise`: Luminance at the
suggestion but at least 10, Chroma 25 above (monotone; the defaults only when nothing is known); plan 28 owns the real
Amount mapping. (6) Camera metadata is read with kamadak-exif first (headers only) and rawler only for RAW fields it
lacks; ISO 0 and 65535 count as absent and the next ISO tag is tried.
Measured (σ / 0.18): 8-bit quantisation alone 0.35 %, synthetic ISO 12800-like JPEG 2.3 % (5 % before 4:2:0 and
quality 90), ON1 sample RAWs ISO 100–200 1.1–2.1 %, ISO 800–1600 2.8–4.6 %, ISO 12800 12 %, Lisbon fixtures 1–14 %
(exports with a grain look). Not done: tuning on real high-ISO camera JPEGs (none in the repo), and a live-window
check (no screen capture; covered by unit tests of `profile_photo` and `prepare` instead).

WORKFLOW_PLAN [9](../WORKFLOW_PLAN.md#9-denoise-per-camera-sensor), [13](../WORKFLOW_PLAN.md#13-added-phases-and-decisions) (W6.0).
Size: 2 days. Depends on: nothing.

**Goal.** Measure the noise of a photo from the photo itself, learn a per-camera-and-ISO profile from the user's own
photos over time, and show a camera badge with a suggested denoise amount.

## Decisions

- Self-profile: on the decoded linear image at proxy size, find flat patches (low local variance after a light
  blur), fit `variance = a·mean + b` per channel by robust regression; result `{ a, b }[3]` plus a scalar noise
  level (σ at mid-grey) and a confidence from the patch count. Cached in the app cache as `cache/<hash>/noise.json`.
- Learned profile: `<appdata>/noise-profiles/<make>-<model>.json` with per-ISO entries `{ a, b, n }` averaged
  (running mean, outlier-rejected). A new photo from a known camera starts from the stored curve blended with its
  own fit by confidence.
- Suggested amount: a monotone map from σ to 0–100 tuned on the fixtures; ISO alone is the fallback when no profile.
- EXIF make, model and ISO come from the existing metadata path (`meta.json`); extend `prepare_asset` if ISO is absent.

## Steps

1. `crates/develop/src/ai/noise_profile.rs`: patch finder, fit, tests on synthetic Poisson-Gaussian noise (recover
   `a`, `b` within 10 %).
2. `commands/develop.rs`: `noise_profile(folderId, path, hash) -> Profile` (cached), `camera_profile(make, model, iso)`,
   `learn_profile(...)` called after each self-profile.
3. TS: wrappers; `lib/denoise.ts` `suggestedAmount(profile)`; `DenoiseGroup` shows the badge row
   ("Fujifilm X-T5 · ISO 6400 · suggests 55 · learned from 12 photos") and uses the suggestion as the default when
   denoise is switched on. The "Needs denoise" built-in collection (05) uses σ when available, ISO otherwise.

## Check

- Rust tests above; a flat ISO 200 frame yields a low σ and "Not needed"; an ISO 12800 JPEG a high one.
- Profiles file grows by one entry per new ISO and averages repeat ISOs (test with a temp app data dir).

## Docs

- `docs/DEVELOP.md` Denoise (profiles); `CLAUDE.md` caches (`noise.json`, `<appdata>/noise-profiles/`).
