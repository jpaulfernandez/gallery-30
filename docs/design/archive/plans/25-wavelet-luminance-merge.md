# 25 · Frequency-aware luminance merge

Status: done 2026-10-13 (revised the same day after review). Landed: `crates/develop/src/ai/merge.rs` (`LEVELS` 3,
`MERGE = "wavelet"`, `COARSE_RAMP` 0.1, `BandWeights` with `for_luminance` / `uniform` / `levels`, `mirror`, `smooth`,
`decompose`, `reconstruct`, `add_correction`, `merge_l`); `ai/denoise.rs` `finish` takes L from `merge::merge_l` (a/b
still per pixel through `blend_lab`) and the key gains `\nmerge:wavelet`. Where it runs: in the denoise intermediate
(`denoise::finish`, after the tiles are blended), the only place the flat merge ran; nothing at render time changed,
and with the whole image there no tile halo is needed (reach 2 px each side for one level, 14 px for three).
Decisions and deviations: (1) The decomposition is linear, so only `D = L_in − L_out` is decomposed and
`L = L_out + Σ (1 − w_k)·d_k(D) + (1 − w_res)·residual(D)`, stopping after the last level whose weight is not 1.
(2) After review the coarse bands and the residual ramp in (`min(1, t / 0.1)`) instead of jumping to the model's at any
`t > 0`, so the merge is continuous at 0 (one level from Luminance 10 up, three below); Luminance 100 and 0 stay bit
for bit the old flat blend (`assert_eq` against it in `tests/denoise.rs`, so PSNR there is unchanged). (3) A non-finite
`L_out` value takes `L_in`'s before the filters (test). (4) No WGSL: a port was written and matched the CPU (0 levels
apart) but took 64–78 ms at 24 MP against 53 ms on the CPU (110 ms for three levels; release, M3 Pro), mostly the
planes' upload and readback, and nothing renders the merge interactively, so it was removed with its `finish_with`
plumbing. (5) Memory: up to five extra f32 planes at once during the merge (L_in, L_out, the filter's three), about
0.5 GB at 24 MP transient on top of the Oklab buffer; none at Luminance 100 (relevant to plan 26). (6) No
`DENOISE_ENGINE` bump: the intermediate changes only for 0 < Luminance < 100, and `merge:wavelet` gives every
intermediate a new key (all existing ones are recomputed once). The editor's cached proxy/thumb renders record the
denoise key and are redone once the new intermediate exists, but full-size renders and exports are keyed by the develop
hash only and keep the flat-merge pixels until a setting changes; no engine bump for that either, because nothing has
been released and plan 19's `develop-engine/3` bump already invalidated every earlier render, so only renders made
since then from this unreleased tree are affected. (7) No UI change; one paragraph in docs/DEVELOP.md. Measured:
band-energy and continuity unit tests (Luminance 1 % changes L_in by at most 0.12·max|D|, 0.1 % by 0.012·max|D|);
synthetic fixture with a perfect "model" at Luminance 50: PSNR 32.8 vs 31.8 dB flat (model colour), 30.9 vs 30.4 dB
(filter). Grain on a real ISO 6400 camera JPEG (a Fujifilm X100VI photo from the user's library, not in the repo;
σ 3.4 % of mid-grey; `iso6400_grain_crop_compare`, NAFNet, filter colour at 75, no sharpening): what Luminance 50
leaves on top of the model's result is 0.44–0.46 of the input's noise in RMS (flat blend 0.5); of that, the finest band
is 94–95 % of the flat blend's (grain; slightly less because the à trous bands overlap) and the coarse bands 50–52 %
(blotches), e.g. crop 1 finest / coarse / total 0.00742 / 0.00090 / 0.00783 vs flat 0.00783 / 0.00181 / 0.00868. Crop
compares (panels: JPEG, flat 50, wavelet 50, model 100) in
`/private/tmp/claude-501/-Users-polaris-projects-photobook/b60be4b3-2592-42f4-8fbc-7012baac04f9/scratchpad/p25/crop-{1,2,3}.jpg`
and at 200 % `crop-{1,2,3}-2x.jpg`: grain visible at 50 in both blends, the model at 100 smooth, the wavelet panel with
less mottling than the flat one. Plan 28's Amount mapping may want to allow for the slightly lower grain at equal
slider values. Not done: a live-window check (no screen capture; the editor calls the same `finish`).

WORKFLOW_PLAN [5.1](../WORKFLOW_PLAN.md#51-what-exists-and-what-the-split-idea-means) (W6.2). Size: 1 day. Depends on: 24.

**Goal.** Replace the flat `L = lerp(L_in, L_out, luminance)` with a wavelet blend that keeps the input's finest
band scaled by the Luminance slider and takes the model's low and mid bands, so grain survives at moderate settings.

## Decisions

- À trous (B3 spline) decomposition, 3 levels, on L only; level 0 (finest) = `lerp(in, out, luminance)`, levels 1–2
  and the residual = model output when `luminance > 0`, input otherwise; `luminance = 100` reproduces today's result.
- The intermediate key already includes `luminance`; add a `merge: 'wavelet'` constant to the key so cached flat
  merges are not reused.

## Steps

1. `crates/develop/src/ai/merge.rs`: decomposition, blend, reconstruction; tests (perfect reconstruction at
   luminance 0 and 100, band energies).
2. CPU and WGSL; parity test.
3. No UI change.

## Check

- Grain retention visible at Luminance 50 on the ISO 6400 fixture (crop compare); PSNR at 100 unchanged.
