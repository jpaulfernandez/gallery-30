# 26 · Denoise model evaluation

Status: done 2026-10-13, partly (hosting and Lightroom not possible here). Landed: `docs/design/DENOISE_EVAL.md`
(method, five-photo set, speed table, simulated-noise PSNR, crops, verdict per photo, recommended defaults: unchanged
w32 · 50/75/25 · `chromaMode: filter`); `scripts/models/export_scunet.py` (static shapes, no Einsum, rank ≤ 5, baked
window masks; outputs within 5e-7 of Heliosoph's) and `export_drunet.py` (new), `export_nafnet.py --weights-from-onnx`
(re-exports the pinned ailia w32), `scripts/models/README.md` (plan 26 table, hosting procedure); crate feature
`denoise-drunet` (off) with `crates/develop/src/ai/drunet.rs` (`SigmaCurve`, `sigma_plane` through the Rec.2020 → sRGB
matrix and the sRGB slope, `SigmaModel`, `DrunetEngine`, `infer_sigma`, `denoise_sigma`, five unit tests on a mocked
session); `DenoiseEngine::from_session` (any 3-channel export); ignored `p26_coreml_partitions_and_timing`,
`p26_psnr_simulated`, `p26_eval_photos` in `tests/denoise.rs`; commented-out TODO entries at the end of
`crates/develop/models.toml` (w64 with placeholder bytes/sha256; SCUNet static and DRUNet with exact bytes/sha256 of
byte-reproducible exports); a section in `crates/develop/README.md`. Licences checked on the sources: NAFNet MIT
(github.com/megvii-research/NAFNet/blob/main/LICENSE, plus BasicSR Apache-2.0), SCUNet Apache-2.0
(github.com/cszn/SCUNet/blob/main/LICENSE), KAIR MIT (github.com/cszn/KAIR/blob/master/LICENSE), DPIR MIT
(github.com/cszn/DPIR/blob/master/LICENSE), deepinv/drunet card BSD-3-Clause. Downloads: `scunet_color_real_psnr.pth`
(72 MB) and `drunet_color.pth` (131 MB) from the KAIR v1.0 release, SHA-256 equal to the Hub LFS ids in deepinv/scunet
and deepinv/drunet; `onnx` + `onnxconverter-common` wheels (10 MB) into a scratch venv. Measured (M3 Pro, loaded
machine): every static export is 1 Core ML partition; per 512² tile w32 104–109 ms (≈ 12–13 s at 24 MP), w64 (random
weights) 276 ms fp32 (≈ 32 s), SCUNet static 499–559 ms fp32 (≈ 58–65 s extrapolated, vs 141 partitions and ≈ 12 min
CPU today), DRUNet 216 ms. Simulated noise (Sample 8 clean + measured ISO 12800/1600/1250 curves): w32 34.26/37.18/37.29
dB with its own colour, 34.39/36.44/36.49 with the filter; SCUNet +0.3–0.5 dB; DRUNet with σ estimated from the noisy image (no oracle; the oracle
curve gives 38.7–38.9) 38.9–39.0 dB at ISO 1250–1600 with its own colour but weak at 12800 (σ-map clamp and clamped
shadows not separated). Deviations: (1) w64 not exported with weights and not pinned:
its weights (464 MB) exceed the 300 MB download limit; only a random-weight graph was timed. (2) None of our exports
is hosted (no GitHub Release can be created here), so `models.toml` gains no verified entry; the check "w64 downloads
and runs end to end" is not done. (3) The plan said fp16; fp16 graphs were slower on Core ML than fp32 (w32 1.7×, w64
3.2–6.7×, SCUNet 2.4×, DRUNet 1.08×), so the TODO entries name static fp32 files. (4) SCUNet's "under a minute at 24 MP" is at the edge (58–65 s, extrapolated
from tile times on a loaded machine), so it is recommended as the hosted JPEG choice but needs an idle real 24 MP
timing before `CPU_ONLY_MODELS` drops it. (5) No Lightroom on this machine: the Lightroom column is "not measured"
and the D5 gate stays open. (6) The photo set is the ON1 sample RAWs in `~/Pictures/ON1 Samples` (ISO 800–12800, no
ISO 6400, no clean long-exposure reference, no in-camera high-ISO JPEG: a RAW-derived JPEG stands in); PSNR is on
simulated white noise. Crop images stay in the scratchpad (`…/scratchpad/p26/out/`), not the public repo, because the
photos are ON1's. (7) DRUNet needs about 2× the measured σ on real photos (correlated noise); the strength is a
parameter, not calibrated. Tests: `cargo test -p photobook-develop --lib` 213 passed (manifest test included),
`--features denoise-drunet --lib` 218 passed, `--test denoise` 11 passed, `cargo check --no-default-features` (with
and without `denoise-drunet`) builds. No TS changed. Review fixes (same day): DRUNet's PSNR uses σ estimated
from the noisy image (oracle kept as a reference row); the σ map clamps to 50/255 after the strength multiply
(`sigma_encoded_raw`); SCUNet wording softened to "borderline" in the doc and the TODO; README unlock steps (replace
the Heliosoph entry, add a `denoise-sigma` Task, fill w64's placeholders); `export_nafnet.py --compare-onnx`;
`__pycache__/`, `*.pyc` in `.gitignore`.

WORKFLOW_PLAN [5.2](../WORKFLOW_PLAN.md#52-model-candidates-to-evaluate-hugging-face-and-elsewhere) (W6.3). Size: 2 days. Depends on: 24.

**Goal.** Settle the open gate "at least as clean as Lightroom's Detail panel": pin NAFNet width-64, re-export SCUNet
with static shapes, try a σ-map model, and write the comparison.

## Decisions

- Every candidate's licence is checked on its own model card before download; MIT, Apache-2.0, BSD only; pinned in
  `crates/develop/models.toml` with `url`, `bytes`, `sha256`.
- Our own exports (`scripts/models/export_nafnet.py`) are hosted on a GitHub Release of this repo, fp16, static 512.
- The evaluation set: RAW + JPEG at ISO 1600–12800, a long-exposure reference where one exists; PSNR plus a
  side-by-side export at 100 %.

## Steps

1. Export NAFNet-SIDD-width64 (fp16, static 512), host, pin as `nafnet-w64`; confirm the Core ML partition count.
2. Re-export SCUNet with static shapes and no `Einsum`; measure partitions and time; keep as the JPEG fallback only
   if it runs on Core ML in under a minute at 24 MP.
3. DRUNet σ-map experiment behind a feature flag: feed the noise profile σ (23) as the map; compare against the
   NAFNet blend.
4. Write `docs/design/DENOISE_EVAL.md`: five photos, Lightroom Denoise at matched settings, our w32, w64, chroma
   filter on and off; verdict per photo; recommended defaults.

## Check

- `models.toml` validates (`cargo test` manifest test); w64 downloads and runs end to end.
- The evaluation doc exists with the comparison images (or their paths) and a one-paragraph verdict.
