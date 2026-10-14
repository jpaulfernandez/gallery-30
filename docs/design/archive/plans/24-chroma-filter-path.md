# 24 · Classical chroma denoise path

Status: done 2026-10-13, revised after review the same day. Landed: `DenoiseSchema.chromaMode: 'filter' | 'model'`
(default `filter`; Rust `settings::ChromaMode`), `crates/develop/src/ops/noise.rs` (CPU reference: `noise_planes`,
`planes_from_cells`, `chroma_coefficients`, `tone_floors`, `eps_tone`, `apply_row`, `chroma_filter_image`,
`chroma_sigma`, `NoiseParams`/`NoiseKey`), the pass first in the CPU chain (`cpu/mod.rs`, cached in `PrePasses` via
`Needs.noise`), `crates/develop/src/gpu/noise.rs` + `gpu/shaders/noise.wgsl` (coarse cells, then the joint-upsampling
pass per render tile into a tile-sized texture the chain starts from through `start_image`, binding 20, while its
guides read the unfiltered input), mask `noise` (`LOCAL_NOISE`, `LocalBlend::noise_at`, CPU and WGSL),
`ImageMeta.noise_sigma`, `ai/denoise.rs` filter mode (intermediate keeps the input a/b; `DENOISE_ENGINE` `denoise/2`;
key `…\nfilter\n…` or `…\nmodel:<chroma>\n…`), editor wiring (`commands/noise.rs` `ensure_record` with at most two
measurements at once and one per photo, `filter_sigma` with the ISO fallback below `MIN_LEARN_CONFIDENCE`,
`photo_filter_sigma`; `commands/develop.rs` `developer_for` re-decodes when `noise.json` changes, `decode_input` /
`decode_full_input` attach σ, cached proxies record their σ and are redone when it changes or the measurement failed,
`preview_denoise_crop` applies the filter at the full image's radius), the Advanced › Colour Filter / Model control
in `DenoiseGroup.tsx`, the mask Noise slider enabled in `MasksSection.tsx`, tests (`ops::noise` unit tests incl.
shadows, `tests/noise.rs` CPU-vs-GPU incl. the 1/2 and 1/4 grids on a 1601 px image whole and tiled, `tests/denoise.rs`
both modes and `iso12800_crop_compare`, editor σ/caching/measurement tests, `chromaMode.test.ts`, the
`denoise-model-colour` parity fixture) and docs (`docs/DEVELOP.md`, `crates/develop/README.md`).
Migration trade-off: every photo that already has denoise on switches to the filter's colour (the new default), and
its intermediate (keyed `denoise/1` and with the Colour value) is no longer reused, so it needs one full model run
again (Apply, or the queue / Publish run it); until then it renders from the source with the filter as preview.
Deviations: (1) the filter is applied at render time, not baked into the intermediate, so the Colour slider never
waits for or invalidates the model run; the key gains `chromaMode` (and drops the Colour value in filter mode) but not
the radius (σ is read per render from `noise.json`). (2) The plain guided filter on a/b lost 4.4 dB to the model's
colour on the synthetic fixture, so it filters the chroma ratios `a/max(L,0.1)`, `b/max(L,0.1)` with a fit test (a
window's residual against the 25th-percentile residual of its lightness band, 8 bands, `FIT_K` 3) and an ε that grows
below mid-grey like read noise in L (review fix: one global median floor switched the filter off in the shadows).
(3) On the GPU the coarse coefficients are solved by the same CPU code from read-back cells (about 1 ms for a
preview); only the cells and the per-pixel pass are WGSL. (4) The subsampled GPU path (coarse grid at 1/2 and 1/4 with
partial edge cells) was untested in the first version; it is now covered, and the pass's GPU memory is one tile
(≤ 64 MB) instead of a full-size texture. (5) `chromaMode` is left out of the develop hash at its default, so no
existing hash changed; plan 19's `develop-engine/3` bump invalidates every cached render anyway. Full renders in
`<source>/.photobook-cache/develop/` are keyed by the develop hash only, so a `PROFILE_ENGINE` bump that changes a
photo's σ does not redo them until its settings change (cached proxies and Developers are redone). (6) Added
`chromaMode: 'filter'` to Denoise literals in other plans' tests (DenoiseBadge, denoiseQueue, developPublish.denoise,
jobs/adapters, jobs/export, store/denoise). `lib/jobs/denoise.ts` `denoiseJobKey` must key on `chromaMode` and drop
`chroma` in filter mode: left to plan 28.
Measured (M3 Pro, release): synthetic fixture (σ 0.05, 25.5 dB noisy) NAFNet + model colour 31.29 dB, NAFNet + filter
31.92 dB (a/b RMS 0.0111 → 0.0085; 32.02 dB before the shadow fix); filter alone on the light-noise variant 36.92 →
38.32 dB; read-noise shadows (Y ≈ 0.02) keep 18.0 % of their chroma noise against 17.3 % in the mid-tones (29.0 %
before the fix). Colour slider at 1600 × 1067: 14–16 ms per frame on the CPU (8 ms without the filter), 5–16 ms on
the GPU (3–7 ms without; other builds were running), first frame 46 ms CPU; 0.34 s for the whole filter on 24 MP on
the CPU. ISO 12800 camera-like JPEG (ON1 Sample 3.NEF developed with defaults, quality 90, σ 12.3 % of mid-grey), crop
compares (panels: JPEG, NAFNet model colour, NAFNet + filter, filter alone) in
`/private/tmp/claude-501/-Users-polaris-projects-photobook/b60be4b3-2592-42f4-8fbc-7012baac04f9/scratchpad/p24/crop-{1,2,3}.jpg`:
no desaturated patches in either mode; low-frequency chroma (Oklab C after an 8 px blur) JPEG / model / filter
0.0094 / 0.0084 / 0.0080, 0.0096 / 0.0082 / 0.0089, 0.0201 / 0.0194 / 0.0193: neither washes colour out
systematically on this file and they look alike by eye. Default kept at `filter`: better on the synthetic PSNR,
equal on the real file, and interactive. Not done: a real out-of-camera ISO 12800 JPEG (none on this machine; the
RAW-derived JPEG stands in), and a live-window check (covered by editor unit tests).

WORKFLOW_PLAN [5.1](../WORKFLOW_PLAN.md#51-what-exists-and-what-the-split-idea-means) (W6.1). Size: 2 days. Depends on: 23.

**Goal.** Chroma noise is removed by a guided filter on Oklab a/b at quarter resolution, guided by the denoised L,
instead of the model's over-smoothed colour; the model keeps luminance. The mask-level `noise` slider becomes real.

## Decisions

- `DenoiseSchema.chromaMode: 'filter' | 'model'` defaulting to `'filter'`; the Colour slider blends the filtered
  a/b in; `'model'` keeps today's behaviour. The intermediate key gains `chromaMode` and the filter radius (from the
  noise profile σ), so old intermediates are not reused and need no deletion.
- Filter: the existing guided filter in `local/` at quarter resolution, guide = denoised L (or input L in preview
  before the model ran), radius and epsilon from σ; upsampled with the guide (joint upsampling) to avoid colour
  bleeding at edges.
- Mask `noise` slider: the same filter applied locally at preview speed on the GPU, luminance only through the
  guided filter too (weaker), no model involvement; enabled in `MasksSection`.

## Steps

1. `crates/develop/src/ai/denoise.rs`: the chroma stage split out; `chroma_filter(ab, guide_l, sigma)`; key fields.
2. GPU: a joint-upsampling pass; CPU reference; parity test.
3. Mask `noise`: op in `ops/detail.rs` or a new `ops/noise.rs`, CPU and WGSL, wired to the mask pipeline.
4. TS: schema field, `DenoiseGroup` Advanced shows *Colour: Filter / Model*; mask slider enabled.
5. Fixtures: the synthetic denoise PSNR test runs both modes.

## Check

- PSNR on the synthetic fixture not worse than today; the ISO 12800 JPEG shows no desaturated patches (crop compare
  images attached to the status).
- Preview with the Colour slider moves without waiting for the model (log timing).
- `cargo test`, CPU and GPU.

## Docs

- `docs/DEVELOP.md` Denoise; `crates/develop/README.md`.
