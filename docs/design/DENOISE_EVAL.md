# Denoise model evaluation

Workflow plan 26 (`docs/design/archive/plans/26-denoise-model-evaluation.md`, WORKFLOW_PLAN 5.2, W6.3), run on 2026-10-13 on
the M3 Pro development machine. It compares the pinned NAFNet-SIDD-width32 with the candidates the plan names
(NAFNet width64, SCUNet re-exported with static shapes, DRUNet fed a σ map), with the plan 24 chroma filter on and
off, and recommends defaults. The open gate from DEVELOP_PLAN D5, "at least as clean as Lightroom's Detail panel",
is **not settled here**: Lightroom is not installed on this machine, so every Lightroom column below is "not
measured". What was measured and what was not is said in each section.

## Summary

- **Keep NAFNet width32 as the default model**, as pinned (ailia's fp32 file with `dims` fixed to 512²: one Core ML
  partition, about 105 ms per 512² tile, about 12 s for 24 MP). It is the best balance of cleanliness, colour and
  speed on the RAW files.
- **Keep the chroma filter (`chromaMode: filter`) as the default.** On the real photos it kept colours closer to the
  input than NAFNet's own colour (a warm cast in a night sky, desaturated orange on a spider); on white simulated
  noise it costs up to 0.8 dB PSNR at ISO 1250 to 1600 and gains 0.1 dB at ISO 12800.
- **Keep Luminance 50, Colour 75, Sharpen 25.**
- **SCUNet on Core ML is borderline.** Our static export runs in one partition instead of 141, about 0.5 s per
  tile; 24 MP comes to 58 to 65 s, extrapolated from tile times on a loaded machine (against about 12 min on the CPU
  today). Whether it meets the plan's "under a minute" is not established: it needs an idle, real 24 MP timing
  before it leaves `CPU_ONLY_MODELS`. It is the cleanest model on the camera-like JPEG and on flat areas, but smears
  fine texture (fur) on RAW files. Recommendation: host the static fp32 export to replace the Heliosoph entry, and
  decide on the JPEG role after that timing; never the default.
- **NAFNet width64 is not pinned.** Its weights (464 MB) were over this session's 300 MB download limit, so its
  quality was not measured; its graph (exported with random weights) runs in one Core ML partition at about 276 ms
  per tile in fp32 (about 32 s for 24 MP, 2.6 times width32). NAFNet's own SIDD numbers give it +0.34 dB over
  width32. The manifest entry is commented out with a TODO until the export is hosted.
- **fp16 exports are slower on Core ML than fp32**: 1.7 times for width32, 3.2 to 6.7 times for width64 (its fp16
  tile times varied from 882 to 1862 ms), 2.4 times for SCUNet, 1.08 times for DRUNet. The plan said "fp16, static
  512"; we recommend static fp32 instead and accept the larger download.
- **DRUNet with a σ map** is behind the crate feature `denoise-drunet` (off). With σ estimated from the noisy
  image itself (plan 23's `measure`, no oracle) it is the best model on simulated white noise at ISO 1250 to 1600
  (+1.7 dB over width32 with their own colour), but removes too little real, spatially correlated noise; at twice
  the measured σ it cleans like width32 while keeping more texture. Promising, not ready: the σ scale needs
  calibrating per source kind, and the simulation's white noise is DRUNet's training distribution.

## Method

### Models and files

| Candidate | File | Licence (checked on the source) |
| --- | --- | --- |
| NAFNet-SIDD-width32 (pinned) | ailia `NAFNet-SIDD-width32.onnx`, fp32, 117,115,760 bytes, SHA-256 `c3af4811…bd4ead4` (manifest) | MIT ([NAFNet LICENSE](https://github.com/megvii-research/NAFNet/blob/main/LICENSE); the file also carries BasicSR's Apache-2.0 notice) |
| NAFNet width32, our static export | `export_nafnet.py --weights-from-onnx` (weights read from the pinned file), fp32 117,085,438 bytes (`c995bbef…bfb629f7a`) and fp16 58,943,660 bytes (`5efeca7c…f4d8af66`); output within 2e-4 of ailia's | MIT |
| NAFNet-SIDD-width64 | not downloaded: `NAFNet-SIDD-width64.pth` (Google Drive, linked from the [NAFNet README](https://github.com/megvii-research/NAFNet#results-and-pre-trained-models)) or [mlx-community/NAFNet-SIDD-width64](https://huggingface.co/mlx-community/NAFNet-SIDD-width64) (card: MIT, 463,995,842 bytes); random-weight exports of the same graph for speed only | MIT |
| SCUNet real PSNR (pinned) | Heliosoph's export, fp32, dynamic shapes, 141 Core ML partitions, CPU only in the editor | Apache-2.0 ([SCUNet LICENSE](https://github.com/cszn/SCUNet/blob/main/LICENSE)) |
| SCUNet, our static export | `export_scunet.py` with `scunet_color_real_psnr.pth` from the [KAIR v1.0 release](https://github.com/cszn/KAIR/releases/tag/v1.0) (71,982,841 bytes, SHA-256 `fa78899b…f809c2e`, equal to the Hub's LFS id in [deepinv/scunet](https://huggingface.co/deepinv/scunet)); fp32 77,695,966 bytes (`fe844d4e…9081a6d`), fp16 39,393,004 bytes; output within 5e-7 of Heliosoph's | Apache-2.0 (code), KAIR MIT |
| DRUNet colour | `export_drunet.py` with `drunet_color.pth` from the KAIR v1.0 release (130,579,305 bytes, SHA-256 `479abe3c…cee430bec4b4`, equal to the Hub's LFS id in [deepinv/drunet](https://huggingface.co/deepinv/drunet), card BSD-3-Clause); fp32 130,589,231 bytes (`4431b4f4…0533f5b5`), fp16 65,315,797 bytes | MIT ([KAIR LICENSE](https://github.com/cszn/KAIR/blob/master/LICENSE), [DPIR LICENSE](https://github.com/cszn/DPIR/blob/master/LICENSE)) |

Every download was checked against an independent SHA-256 (the Hugging Face LFS id of the same file). The three
weight files came to 213 MB with the `onnx` wheels. The exports are byte-reproducible with torch 2.14.0, onnx 1.23.2
and onnxconverter-common 1.16.0 (each built twice with the same hash). The scripts and the hosting procedure are in
`scripts/models/README.md`; the commented-out manifest entries are at the end of `crates/develop/models.toml`.

### Photos

No Lightroom, no long-exposure (clean) references of the same scenes and no camera JPEGs at high ISO exist on this
machine. The repo's fixtures are low-noise exports. The set therefore uses the ON1 sample RAW files in
`~/Pictures/ON1 Samples` (ON1's sample images, not ours: the crops are kept out of the public repo and only their
paths are given):

| # | Photo | Camera, ISO | Full-size σ (plan 23, % of mid-grey) | Crops (centre, fraction of the frame) |
| --- | --- | --- | --- | --- |
| 1 | `ON1 Sample 3.NEF`, egret | Nikon Z 50, ISO 12800 | 20.9 % (12.0 % at 1600 px) | head (0.60, 0.28); blurred reeds (0.20, 0.50) |
| 2 | Photo 1 as a camera-like JPEG | (developed at defaults, quality 90, 4:2:0, as plan 24) | 20.4 % (12.4 % at 1600 px) | head |
| 3 | `ON1 Sample 6.ARW`, Milky Way, 13 s | Sony A7R II, ISO 1600 | 7.2 % (4.0 %) | stars (0.55, 0.25); dark shore (0.50, 0.62) |
| 4 | `ON1 Sample 11.ARW`, spider | Sony A7R III, ISO 1250 | 6.6 % (2.8 %) | body (0.47, 0.50); bokeh (0.20, 0.30) |
| 5 | `ON1 Sample 10.cr2`, fox | Canon T3i, ISO 800 | 7.9 % (4.6 %) | face (0.60, 0.45); grass (0.88, 0.40) |

ISO 6400 is missing from the set; ISO 800 stands in for the low end of the plan's 1600 to 12800 range.

For PSNR, which needs a clean reference, a simulation: `ON1 Sample 8.cr2` (Canon 5DS R, ISO 100) decoded and
halved to 4344 × 2896 is the clean image (its own σ is 2.2 % of mid-grey, so it is not noise-free and caps the
scores). Poisson-Gaussian noise with each high-ISO photo's measured curve (`variance = a·mean + b` per channel,
plan 23's `measure` on a 2048² crop at full size) is added per pixel and channel. This noise is white and
independent between channels; real demosaiced noise is spatially correlated and partly shared between channels, so
the simulation favours models trained on white Gaussian noise (DRUNet) and the plan 24 filter tuned for blotchy
chroma noise is at a disadvantage. PSNR is measured on the sRGB-encoded result (0..1) over four 512² crops.

### Runs

The three ignored tests at the end of `crates/develop/tests/denoise.rs` (their header comment lists the environment
variables) produced every number here:

- `p26_coreml_partitions_and_timing`: loads each ONNX file with the CoreML EP as the editor does, prints the
  partition count and the ops left on the CPU, times ten 512² tiles after a warm-up and extrapolates to the 117
  tiles of a 6000 × 4000 image.
- `p26_psnr_simulated`: the simulation above; every model at full strength (Luminance 100, Colour 100, Sharpen 0)
  with NAFNet's own colour (`chromaMode: model`, "filter off") and with the chroma filter at strength 1 ("filter
  on"); DRUNet at 0.75 to 2 times the σ estimated from the noisy image (plus, for reference, the 1600 px estimate scaled to
  full size and the oracle curve that made the noise).
- `p26_eval_photos`: side-by-side 512² crops at 100 % of the five photos, at the editor's defaults (50 / 75 / 25,
  filter) and at full strength. Panels: input, width32 with its own colour, width32 + filter, SCUNet static +
  filter, DRUNet σ map + filter, the filter alone.

The machine was shared with other jobs (load average 10 to 25), so every time is an upper bound; the relative
order held across two runs.

## Speed and Core ML partitions

| Model | Graph | Size | Core ML partitions | ms per 512² tile (median of 10) | 24 MP (117 tiles) |
| --- | --- | --- | --- | --- | --- |
| width32, ailia (pinned) | fp32, dims fixed | 117.1 MB | 1 | 109 | ≈ 13 s |
| width32, ours | fp32 static | 117.1 MB | 1 | 104 | ≈ 12 s |
| width32, ours | fp16 static | 58.9 MB | 1 | 179 | ≈ 21 s |
| width64 (random weights) | fp32 static | 463.9 MB | 1 | 276 | ≈ 32 s |
| width64 (random weights) | fp16 static | 232.4 MB | 1 | 882 to 1862 | ≈ 100 to 220 s |
| SCUNet, Heliosoph (pinned) | fp32 dynamic | 76.9 MB | 141 (687 of 1669 nodes on the CPU, D5.1) | 72,000 on CoreML; runs on the CPU | ≈ 12 min (CPU) |
| SCUNet, ours | fp32 static, no Einsum | 77.7 MB | 1 | 499 (first run 559) | ≈ 58 to 65 s |
| SCUNet, ours | fp16 static | 39.4 MB | 1 | 1203 | ≈ 141 s |
| DRUNet, ours | fp32 static, 4 channels | 130.6 MB | 1 | 216 | ≈ 25 s |
| DRUNet, ours | fp16 static | 65.3 MB | 1 | 234 | ≈ 27 s |

The 24 MP figures are tiles × median tile time; the blend, the sharpening and the intermediate add about 2 s
(D5.1). Without `dims`, ailia's width32 splits into 75 partitions (302 of 1625 nodes on Core ML): fixed shapes are
what makes it one partition, the export precision is not. Why the fp16 graphs are slower was not investigated (the
fp32 graphs are compiled to an ML Program that already computes in reduced precision; the converted graphs carry
extra casts and may land on a different compute unit). SCUNet's static export removes every `Einsum`, `Shape`,
`Range`, `ScatterND` and `Where` from the graph; Core ML then takes all 1588 nodes.

## Simulated noise (PSNR, dB, mean of four crops)

| Method | ISO 12800 noise | ISO 1600 noise | ISO 1250 noise |
| --- | --- | --- | --- |
| Noisy input | 22.96 | 33.16 | 33.70 |
| Chroma filter alone | 29.69 | 35.83 | 35.89 |
| width32, own colour (filter off) | 34.26 | 37.18 | 37.29 |
| width32 + chroma filter | 34.39 | 36.44 | 36.49 |
| SCUNet static, own colour | 34.71 | 37.49 | 37.54 |
| SCUNet static + chroma filter | 34.75 | 36.87 | 36.90 |
| DRUNet, estimated σ × 1, own colour | 30.58 | **38.90** | **39.02** |
| DRUNet, estimated σ × 1 + chroma filter | 34.03 | 37.27 | 37.32 |
| DRUNet, estimated σ × 1.5, own colour | 33.07 | 37.80 | 37.97 |
| DRUNet, estimated σ × 0.75 + chroma filter | 34.47 | 37.45 | 37.49 |
| DRUNet, 1600 px estimate scaled to full size, own colour | 29.26 | 38.84 | 39.01 |
| DRUNet, oracle σ (the curve that made the noise), own colour | 29.98 | 38.73 | 38.86 |
| width64 | not measured (weights not downloaded) | | |
| Lightroom Denoise / Detail panel | not measured (no Lightroom) | | |

"Estimated σ" is plan 23's `measure` on a 2048² full-size crop of the noisy image (scale 1); it came out 4 to 8 %
above the oracle (0.0391 against 0.0376 at ISO 12800, 0.0137 against 0.0129 at ISO 1600, 0.0127 against 0.0119 at
ISO 1250), and the 1600 px estimate scaled by the long-edge ratio (2.71, `SigmaCurve::for_full_size`) scores the
same, because this noise is white; for real, correlated noise that scaling is only an upper bound. The chroma filter
always gets the editor's σ (the 1600 px measurement), never the oracle. The full table (DRUNet at 0.75, 1, 1.25, 1.5
and 2 times the estimated σ, per-crop values) is in the session log
`/private/tmp/claude-501/-Users-polaris-projects-photobook/b60be4b3-2592-42f4-8fbc-7012baac04f9/scratchpad/p26/psnr3.log`
(scratch, not kept; `p26_psnr_simulated` regenerates it, see Runs). The two textured
crops (foliage) score 3 to 7 dB lower than the two sky crops for every method, and the chroma filter loses most
there (about 1.5 dB at ISO 1600): on white chroma noise between thin multicoloured leaves its colour-versus-lightness
fit steps back less than it should. At ISO 12800 DRUNet's own colour falls 3.7 dB behind width32; with the filter it is level. Two factors were not
separated: the clamped shadows (noise below zero cut off before the model) and the σ map's clamp at 50/255
(DRUNet's training range), which at ISO 12800 binds in the shadows, where the sRGB slope multiplies σ (the clamp
applies after the strength multiply since the review; before, strength could push σ to 100/255, and the photo crops
were regenerated after the change with no visible difference).

Strips of crop 1 (noisy, clean, width32 + filter, SCUNet + filter, DRUNet + filter):
`/private/tmp/claude-501/-Users-polaris-projects-photobook/b60be4b3-2592-42f4-8fbc-7012baac04f9/scratchpad/p26/out/sim-iso12800.jpg`,
`…/p26/out/sim-iso1600.jpg`, `…/p26/out/sim-iso1250.jpg`.

## Real photos (crops at 100 %)

All crop images are in
`/private/tmp/claude-501/-Users-polaris-projects-photobook/b60be4b3-2592-42f4-8fbc-7012baac04f9/scratchpad/p26/out/`
as `<photo>-crop<n>-{default,full}.jpg` (six 512 px panels side by side, in the order listed under Runs) and as
3 × 2 grids in `out/grid/`; `out/drunet-strengths.jpg` compares width32 + filter with DRUNet at 1, 2 and 3 times σ.
They are session scratch files that will not survive the session: rerun `p26_eval_photos` with the environment
variables in the test's header comment (and `PHOTOBOOK_P26_DRUNET_STRENGTH=2` or `3` for the strength comparison)
to recreate them. The Lightroom column is not measured for any
photo.

Mean levels of the rendered panels (8-bit) rise slightly with every model: width32 by 0.6 to 2.0 levels on every
crop, SCUNet by 0 to 1.8 (none on the dark crops), DRUNet and the filter alone by at most 1.1. Removing dark noise
speckles raises the mean a little by itself, so only width32's 1.8 levels on the night sky is clearly visible.
Low-frequency saturation (HSV S after an 8 px blur) with width32's own colour against the filter: spider 148.6
against 151.3 (input 151.3), night sky 18.6 against 15.0 (input 15.4).

1. **Egret, ISO 12800 RAW.** width32 and SCUNet both clean the head and the blurred background completely at the
   defaults; SCUNet keeps the eye ring and the feather edge crisper, width32 is slightly softer. DRUNet at the
   measured σ leaves most of the luminance grain. Filter on and off look alike (low-frequency saturation 27.0 against 26.6, input
   29.8: both lose a little colour with the noise). *Verdict: width32 + filter is good; SCUNet is better on detail but 5 times slower.*
2. **Egret as a camera-like JPEG.** width32 leaves low-frequency mottling in the background (JPEG-compressed noise
   is not what SIDD taught it); SCUNet removes it. DRUNet and the filter alone leave the grain. *Verdict: SCUNet;
   this is the case the JPEG fallback is for.*
3. **Milky Way, ISO 1600, 13 s.** width32 with its own colour adds a warm cast to the sky and lifts it by 1.8
   levels, and drops the faintest stars; the filter removes the cast. SCUNet keeps more faint stars. DRUNet keeps the
   stars and the tone best but leaves fine grain. *Verdict: width32 + filter at the defaults; Luminance below 50
   for astro.*
4. **Spider, ISO 1250.** width32's own colour desaturates the orange legs; with the filter the colour matches the
   input. SCUNet smooths the fine hairs; DRUNet keeps them with a mild clean-up. *Verdict: width32 + filter;
   DRUNet would be the detail-preserving choice.*
5. **Fox, ISO 800.** width32 and SCUNet make the fur plastic at full strength (SCUNet more so); at the defaults
   width32 is acceptable. DRUNet at the measured σ (with the filter) keeps the fur and removes the colour noise; at twice σ it is about
   as clean as width32 with more texture. *Verdict: width32 + filter at the defaults; Luminance 30 to 40 for fur
   and foliage.*

**DRUNet's σ.** On every real photo the measured σ (white-noise equivalent, full size) is too low for DRUNet: real
noise after demosaicing is spatially correlated, so it has more low-frequency power than white noise of the same
σ, and a model trained on white noise needs a larger σ to remove it. Twice the measured σ cleaned the ISO 12800
background about as well as width32 while keeping more of the fox's fur; three times matched width32's smoothness.
The σ map itself accounts for the Rec.2020 → sRGB matrix (which amplifies independent channel noise by about 1.6
in σ; without it DRUNet's own colour scored 2.2 to 3.5 dB lower on the simulation) and for the sRGB curve's slope.
Two approximations remain: the curve is read at the mean of the three linear channels (a saturated colour's
channels all get the σ of that mean), and the sRGB slope is first order (in deep shadows the curve bends within ±σ).
The map is clamped to 50/255 after the strength multiply.

## Verdict

NAFNet width32 with the chroma filter, at Luminance 50, Colour 75 and Sharpen 25, stays the default: it cleaned
every RAW in the set without colour shifts, it is the fastest model at about 12 s for 24 MP, and the filter kept
colour truer than the model's own colour on the two photos where they differed (night sky, spider), at a small PSNR
cost on white simulated noise. SCUNet's static export turns it from a 12 minute CPU job into one Core ML partition at
about 0.5 s per tile; whether that is under a minute for 24 MP is borderline (58 to 65 s extrapolated on a loaded
machine) and needs an idle, real 24 MP timing before it leaves `CPU_ONLY_MODELS`. It was the clear winner on the
camera-like JPEG, so it should replace the Heliosoph files once hosted, and become the JPEG choice if that timing
holds. Width64 cannot be judged without its weights; at 2.6 times the time and 464 MB for a 0.34
dB SIDD gain it is not worth hosting before a real comparison. DRUNet's σ-map path works end to end and is the most
detail-preserving option, but only with a σ scale (about 2 for RAW) that this set is too small to fix. Whether any of
this is "at least as clean as Lightroom" is still open: that comparison needs Lightroom and is not measured here.

## Recommended defaults

- New denoise: `nafnet-w32`, Luminance 50, Colour 75, Sharpen 25, `chromaMode: filter` (unchanged).
- JPEG and other processed sources: suggest SCUNet once its static export is hosted and an idle, real 24 MP run
  confirms about a minute (extrapolated 58 to 65 s so far); until then width32 (SCUNet on the CPU takes about
  12 min).
- Fur, foliage, astro: Luminance 30 to 40.
- `nafnet-w64`: leave unavailable until hosted and compared with real weights.
- DRUNet: keep the `denoise-drunet` feature off; if it is pursued, start from σ × 2 for RAW and calibrate on more
  photos, and add a `denoise-sigma` task for its four-channel input.

## Not measured, and open issues

- Lightroom Denoise / Detail panel at matched settings: not measured (not installed). The D5 gate stays open.
- NAFNet width64 quality: not measured (weights over the download limit). Its manifest entry is a commented TODO.
- No real long-exposure reference of the same scene, no camera JPEG at high ISO, no ISO 6400 photo: the PSNR is on
  simulated white noise only.
- Hosting: none of our exports is on a GitHub Release yet, so none is pinned (`models.toml` carries commented
  entries with the exact `bytes` and `sha256` for SCUNet and DRUNet, placeholders for width64).
- The RAW decode is fed to the models about 1 EV darker than it is shown (the baseline exposure is applied later),
  so more of the shadow noise is clamped at zero before the model (which sees sRGB-encoded 0..1). That may explain
  DRUNet's weak ISO 12800 result with its own colour and contribute to width32's lift on the night sky. Feeding the
  model the exposure-adjusted image and undoing it after is worth a test.
- Times were taken on a loaded machine; SCUNet's "under a minute" is at the edge and should be re-timed idle,
  ideally with a real 24 MP run instead of the extrapolation.
