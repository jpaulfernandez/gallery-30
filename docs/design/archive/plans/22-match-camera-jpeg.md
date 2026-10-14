# 22 · Match camera JPEG (optional)

Status: done 2026-10-13. Rust: `crates/develop/src/lutfit/` (`mod.rs`: `neutral_render` = defaults without sharpening,
display look on for RAW, CPU, 16-bit sRGB at a 1200 px working size; `sample_pair` refuses another aspect ratio, a
turned JPEG and alignment scores under 0.5, then keeps flat pixels (3×3 blur, gradient under the median clamped to
0.004–0.03, 3 % border left out), at most 200k per pair; `fit_samples` = two passes (the second with Cauchy weights at
0.03); `fit_files` with progress (2 steps per pair + 20 for the solve), cancel (error `Cancelled`) and a report per
pair; `delta_e` = CIE76 ΔE*ab, written here because `src/color` had Oklab but no ΔE helper; `align.rs`: NCC of
high-passed luma, scale ±3 % and offset ±3 % searched coarse to fine to an eighth of a pixel, then a ±3 px offset per
tile on a 4×3 grid to absorb in-camera lens corrections; `solve.rs`: 33³ lattice, the tetrahedral weights of
`Lut3d::apply`, banded normal equations, smoothness = squared second differences along each axis (zero on affine
maps) at 0.02 relative to the data, a 1e-4 pull to the identity, Jacobi-preconditioned CG on the three channels).
Not gated behind `raw`: any decodable source works, `--no-default-features` builds. Film simulation:
`decode::film_simulation` (in `camera_meta.rs`) parses the Fujifilm maker note itself through `kamadak-exif` (rawler
0.8 keeps RAF maker notes private and does not expose `FilmMode`), from a JPEG directly or from the JPEG preview a RAF
embeds; `Saturation` (0x1003) monochrome values win over `FilmMode` (0x1401), names as the camera menus show them.
Editor: `commands/luts.rs` block (`fit_lut(folder, pairs, name, job)`, `film_simulation(folder, relPath)`,
`store_fitted`; `LutInfo.fitted { simulation, camera, pairs, meanDeltaE }` in the sidecar; event `lut:fit-progress`;
cancel through `cancel_develop(job)` like Export; at most 24 pairs), `lib/tauri.ts` block, `store/luts.ts` block
(`enqueueLutFit` as a `render`-kind job, `filmSimulationOf` cached per file), `lib/develop/cameraPairs.ts`
(auto-pairing by directory + base name, case-insensitive; the suggestion picks the fitted LUT with the photo's tag and
the lowest ΔE), `components/develop/MatchCameraDialog.tsx`, and in `LookSection.tsx` a delimited block with the
*Match camera JPEG…* entry and the *Suggested: Classic Chrome (fitted)* row (plan 20 moves both into the Looks strip
and its menu). Deviation: the look preset (`<name> (fitted)`, section `look` only) is saved by the editor through
`save_preset` after the fit (presets get ULIDs minted in TS), not by `fit_lut` itself. The dialog ticks up to 8 pairs
sharing the current photo's simulation by default. Check, measured on synthetic pairs only (no sample RAF in the
repo): a known 17³ look applied to the neutral render of lisbon IMG_01/03/05, moved (scale 0.994–1.012, offsets up to
3 px) and JPEG-encoded at q92; alignment recovered within 0.002 scale and 0.75 px; fitted mean ΔE 1.21, 0.73, 0.92 on
the used pairs (2 needed; 4.4–5.7 unfitted) and 2.83 on held-out IMG_08 (4 needed). Tests: `cargo test -p
photobook-develop lutfit` (6), the film simulation tests in `camera_meta.rs` (2), `commands::luts` (4, one new),
Vitest `cameraPairs.test.ts` and `MatchCamera.test.tsx` (fit job progress/cancel/preset, suggestion row, dialog).
Review fixes (same day): the fitted look is saved with plan 20's `makeLutLook` (`look: true`, section `look` only, as
plan 20 defines a LUT look; `store/luts.ts` `saveFittedLook`), skipped when a look already names that LUT id and
replacing (same id) a preset of the same name. `solve` returns and logs the final relative residual (warning when it
stops at 600 iterations) and polls cancel before its first iteration; `align_with` / `sample_pair_with` poll cancel
between passes, tiles and stages (the 1200 px neutral render itself is one call and is polled before and after); a
cancel inside a pair ends the fit instead of leaving the pair out; repeated `(done, detail)` progress events are
dropped; per-tile offsets are searched in 0.25 px steps. The fit stays in the `render` job kind: the job store has no
CPU-only lane (documented). Film tags: `film_tag` returns `{ simulation, camera }` reading at most 128 KB per file
(JPEG head, or the RAF header plus 128 KB of its preview), only SHORT entries with count 1 count, a truncation test
feeds every prefix of a note, JPEG and RAF; the block now sits above the original `mod tests`. The editor reads tags
at most 8 at a time and only for the current photo's pair, its 8 nearest pairs and pairs the user ticks; a photo with
no pair uses its own tag; a pair whose RAW is tagged and JPEG is not is greyed out in the dialog and left out by
`fit_and_store` (edited export); reports are keyed by relative path; the dialog shows coverage and a
`role="progressbar"`. The suggestion matches `fitted.camera` when both cameras are known. The LUT sidecar's `fitted`
is read leniently (`FittedInfo::checked`: pairs 1–24, ΔE finite 0–100, strings capped at 80; an invalid record is
dropped, the sidecar kept), and `store_fitted` shares `write_canonical` with `import_into`. Docs: Adobe RGB camera
JPEGs are clipped to sRGB before the comparison. New measurements (synthetic, still no real RAF pairs in the repo):
with 2 px barrel distortion at the corners, an unsharp mask (0.6 over 3×3), ±0.008 noise, scale 1.004 and a
(1.5, −1) px shift on lisbon IMG_02/04/06 (fit) and IMG_10 (held out): alignment scores 0.90–0.92, 6–11 of 12 tiles
moved; mean ΔE 0.63, 0.67, 0.80 on the used pairs' flat pixels; held out 0.77 on flat pixels and 1.62 over every
non-border pixel (5.65 unfitted). Samples clustered in 15 % of the cube: residual 9.8e-8 (converged), coverage 0.188,
corners in range and the grey axis in order.
Not done: a check on real Fujifilm RAF + JPEG pairs and the manual app check (no screen in this session).

WORKFLOW_PLAN [4.3](../WORKFLOW_PLAN.md#43-where-the-looks-come-from-licensing) (W5.6). Size: 2 days. Depends on: 18.

**Goal.** Fit a 3D LUT from pairs of RAW and in-camera JPEG so a Fuji (or any brand's picture-profile) owner gets
their camera's film simulation as a look, licence-free; suggest it for RAF files from the film-simulation tag.

## Decisions

- Fit: develop the RAW with neutral settings to display-referred sRGB, align with the JPEG (same size, same crop;
  reject pairs whose alignment error is large), sample pixel pairs, solve a 33³ grid by least squares with a
  smoothness term (what darktable-lut-generator does); several pairs improve coverage.
- Output is an ordinary user LUT in `<appdata>/luts/` plus a look preset named after the simulation tag.
- RAF: read the film simulation tag with `rawler`'s metadata; the Looks strip shows *Suggested: Classic Chrome (fitted)*
  when a fitted look with that tag exists.

## Steps

1. `crates/develop/src/lutfit.rs`: sampling, solver, tests on a synthetic pair (apply a known LUT, fit, compare).
2. `commands/luts.rs`: `fit_lut(pairs[], name, job)` with progress; pairs chosen in a dialog from the folder
   (auto-pair by base name).
3. UI: *Match camera JPEG…* under the Looks menu; the suggestion row.

## Check

- The fitted LUT applied to the RAW is within ΔE 2 (mean) of the camera JPEG on the pairs used, and under ΔE 4 on a
  held-out pair.
