# How denoising works and how close it is to Lightroom

This document explains the denoise feature of the develop module for a developer who knows image processing but not
this repository: what it does, which models it runs, the pipeline from decoded pixels to the file the renderer reads,
the noise profiling that tunes it, and what was measured. Every number below is quoted from `crates/develop/README.md`,
`crates/develop/models.toml` or `docs/design/DENOISE_EVAL.md` (workflow plan 26). Where a comparison or a measurement
does not exist, the text says "not measured". The user-facing description of the controls is in [docs/DEVELOP.md](../DEVELOP.md)
(section "Detail, Sharpen & denoise"); it is not repeated here.

## 1. Overview

Denoise is an explicit action, like Lightroom's Enhance, not a live slider on the render. The editor runs it once per
photo and settings key. The run decodes the source at full resolution, pushes it through a neural denoiser in tiles,
blends the result with the input, and writes a 16-bit intermediate PNG. From then on the develop pipeline decodes
that intermediate instead of the source file, so every later stage (white balance, tone, masks, look, export) sees an
already denoised image; the render pipeline reads only denoise's Colour strength, for the chroma filter. The rest of
the pipeline is described in [EDITING.md](EDITING.md).

There are three sliders, all 0 to 100:

| Slider | Default | What it does |
| --- | --- | --- |
| Luminance | 50 | How much of the model's lightness change is kept. Not a flat blend: see the wavelet merge in section 3. |
| Colour | 75 | How much colour noise is removed. With the default colour mode this is applied at render time, not by the model. |
| Sharpen | 25 | An edge-masked luminance unsharp mask that restores some detail after denoising. |

The editor's single "Amount" slider is Luminance; Colour follows it 25 above until the user sets Colour apart
(`apps/editor/src/lib/denoise.ts`). The schema holds only the three values plus the model and the colour mode.

The colour mode (`chromaMode`) has two values. `filter`, the default, keeps the input's colour channels in the
intermediate and lets the renderer apply a classical, noise-aware colour filter guided by the denoised lightness.
`model` takes the colour channels from the network. The default is `filter` because on the real photos of the
evaluation it kept colours closer to the input than the network's own colour (section 5).

The default model is NAFNet-SIDD-width32. Alternatives are SCUNet (a fallback) and, not yet available, NAFNet width64.

## 2. Models

### What is pinned

The model registry is `crates/develop/models.toml`, compiled into the crate. Each entry is a list of files downloaded
into `<appdata>/models/<name>/<version>/`, with a URL, a byte size and a SHA-256. Nothing is bundled with the app.

| Settings value | Manifest name | Role | File |
| --- | --- | --- | --- |
| `nafnet-w32` | `nafnet-sidd-width32` | Primary | ailia's fp32 ONNX export, opset 11, 117,115,760 bytes, SHA-256 `c3af4811…bd4ead4` |
| `scunet` | `scunet-color-real-psnr` | Fallback | Heliosoph's export of SCUNet color_real_psnr, fp32, opset 17, two files (3,798,678 + 73,138,176 bytes) |
| `nafnet-w64` | `nafnet-sidd-width64` | Candidate | not in the manifest yet; asking for it gives `Error::UnknownModel` |

The evaluation also built DRUNet as a candidate that takes a noise-level map as a fourth input channel. It sits behind
the crate feature `denoise-drunet`, which is off, and has no usable manifest entry.

### Licences and pinning rules

Only permissive licences are allowed (MIT, Apache-2.0, BSD); a test of the shipped manifest enforces it. NAFNet is MIT
(the ailia file also carries BasicSR's Apache-2.0 notice), SCUNet is Apache-2.0 for the code and Heliosoph's export
repository ships KAIR's MIT licence, KAIR and DPIR are MIT.

A file is only downloadable when its entry is `verified` with every hash pinned. The manifest validator rejects
path-like file names, non-https URLs and malformed hashes. The downloader resumes partial files with HTTP range
requests, compares the SHA-256 before renaming a file into place, and keeps the part file on cancel or a dropped
connection. Hugging Face URLs pin a commit, so the file cannot change under us. The NAFNet URL is a plain bucket URL
that is not content-addressed, so the SHA-256 is what guards it; it was pinned by hashing a download and matching the
bucket's MD5. Entries added by plan 26 stay commented out until a GitHub Release of this repo hosts them, because the
manifest test refuses unverified hashes and an unresolvable URL would only fail at download time.

### Runtime and shapes

Models run through ONNX Runtime (`ort` 2.0.0-rc.13, linked statically) with the Core ML execution provider on macOS:
ML Program, all compute units, `RequireStaticInputShapes`. Static shapes matter. The models are exported with dynamic
height and width, and the manifest's `dims` entry fixes them to 512 x 512. Without `dims`, ailia's width32 splits into
75 Core ML partitions (302 of 1625 nodes on Core ML); with fixed shapes it is one partition holding all 1246 nodes.
The tile size is the manifest's static input.

The partitions rule: the engine uses Core ML unless the model is on `CPU_ONLY_MODELS` (today only
`scunet-color-real-psnr`) or Core ML splits it into more than `MAX_COREML_PARTITIONS` (8) partitions; then it uses the
CPU execution provider. If a Core ML load fails the cache is cleared and the load retried once, then the CPU is used.
Heliosoph's SCUNet is on the CPU list because Core ML splits it into 141 partitions (Einsum and dynamic Reshape or
Slice are unsupported) and took 72 s for one tile.

### fp32, not fp16

The plan asked for fp16 at static 512. Plan 26 measured the opposite of what one would expect: on Core ML (M3 Pro) fp16
exports were slower than fp32. The fp32 graphs are compiled to an ML Program that already computes in reduced
precision, and the converted fp16 graphs carry extra casts and may land on a different compute unit; the cause was
not investigated. Per 512 x 512 tile (median of 10):

| Model | fp32 | fp16 | fp16 / fp32 |
| --- | --- | --- | --- |
| width32 (ours) | 104 ms | 179 ms | 1.7 times |
| width64 (random weights) | 276 ms | 882 to 1862 ms | 3.2 to 6.7 times |
| SCUNet (ours) | 499 ms | 1203 ms | 2.4 times |
| DRUNet (ours) | 216 ms | 234 ms | 1.08 times |

So every candidate export is a static 512 x 512 fp32 graph, and the larger download is accepted. Exports are
byte-reproducible with torch 2.14.0, onnx 1.23.2 and onnxconverter-common 1.16.0; the scripts and the hosting
procedure are in `scripts/models/README.md`.

## 3. Pipeline step by step

The entry point is `ai::denoise` in `crates/develop/src/ai/denoise.rs`. The input is a linear Rec.2020 image; the
output is another image of the same size.

### Tiles and colour mapping

The networks were trained on sRGB images in 0..1, so each tile is converted on extraction: linear Rec.2020 to sRGB
primaries, clamped to 0..1, sRGB-encoded, float32 NCHW. This happens per tile, so no encoded copy of the whole image
is kept. The clamp is a known weakness: noise below zero in the shadows is cut off before the model sees it (section
7).

The tile grid comes from `ai/tiling.rs`. The image is conceptually reflect-padded to a multiple of 16 (NAFNet has four
2x downsamplings) and to at least one tile. Square 512 px tiles are laid over it with at least 48 px of overlap; the
leftover is spread evenly so every seam gets about the same overlap and the last tile ends exactly at the padded
edge. A 6000 x 4000 image (24 MP) is 117 tiles.

Tile outputs are accumulated by a blender with a separable raised-cosine window. Inside a tile the weight is 1; over
the overlap pixels next to a neighbouring tile it rises as one half minus one half times cos(pi times (i + 1/2) over
overlap). Sides on the padded image's border get no ramp, which is the "ramps only toward neighbours" rule. Each
pixel is divided by its accumulated weight, so overlaps of any width form a partition of unity. Accumulation is in
float64 and only a band of one tile row is held, so memory stays at one tile row and a constant image comes back bit
for bit. One tile is in flight at a time. Progress is reported after each tile and cancel is polled before each
(`Error::Cancelled`), so a cancelled job leaves no partial file.

Tile seams were checked on a flat region: the column-mean step across tile edges is 0.84 levels (NAFNet) and 0.09
(SCUNet), the same as inside tiles.

### Residual in linear light

The model's change is applied as a residual in linear light: result = x + dec(out) - dec(enc(x)), where enc is the sRGB
mapping above and dec its inverse. Whatever the model could not represent, such as highlights above 1 or colours
outside sRGB, passes through untouched, because only the difference the model made is added back.

### Oklab split and the wavelet luminance merge

The result is split per pixel into Oklab lightness L and colour channels a and b.

For L, the Luminance slider does not blend input and output flatly. Plan 25 replaced the flat mix because denoise
models leave low-frequency mottling that a flat mix at 50 keeps at half strength. Instead L is decomposed with an
a trous B3-spline wavelet (kernel 1, 4, 6, 4, 1 over 16 at dilations 1, 2 and 4, edges mirrored, filters in difference
form so a flat plane stays flat) into three bands and a residual. At strength t = Luminance / 100:

- The finest band (1 to 2 px, the grain) is the lerp of input and model output at t.
- The two coarser bands and the residual (the blotches) use the lerp at min(1, t / 0.1). This is `COARSE_RAMP`: the
  model's value from Luminance 10 up, ramping in from the input's value at 0 so the merge is continuous there.

Because the decomposition is linear, the code decomposes only the difference between input and model L and adds the
weighted bands to the model's L, stopping after the last band whose weight is not 1. At Luminance 0 and 100 the result
is the input's or the model's L bit for bit. The merge runs once per intermediate on the whole image after the tiles
are blended, so it needs no tile halo. It holds up to five extra float32 planes (about 0.5 GB at 24 MP) and costs 53 ms
for a 24 MP plane at one level and 110 ms at three.

On a Fujifilm X100VI ISO 6400 camera JPEG at Luminance 50, what is left on top of the model's result is 0.44 to 0.46 of
the input's noise in RMS, against 0.5 for the flat blend. The finest band is 94 to 95 percent of the flat blend's and
the coarse bands 50 to 52 percent. On the synthetic fixture with a perfect "model" the PSNR is 32.8 dB against 31.8 dB
for the flat blend (model colour), and 30.9 against 30.4 dB (filter).

### Colour: model or filter

With `chromaMode: model`, a and b are the lerp of input and model output at Colour / 100 (exact at 0 and 100).

With `chromaMode: filter` (default, plan 24) the intermediate keeps the input's a and b, and the renderer applies the
chroma filter at Colour / 100. The filter lives in `ops::noise` (CPU reference) and `gpu::noise` with
`shaders/noise.wgsl`, and it also implements the masks' noise slider. Because the strength is not part of the
intermediate's key, moving Colour never waits for the model. How it works:

- **Ratios, not channels.** On a coarse grid (a quarter of the resolution from an 8 px radius) it works on L and the
  chroma ratios a / max(L, 0.1) and b / max(L, 0.1). Scaling linear RGB scales L, a and b alike, so a one-hue texture
  keeps its ratio while its lightness varies, and detail finer than the grid cell keeps its colour.
- **Guided by the denoised L.** For each ratio a guided filter is solved with L as the guide: the denoised L (the
  intermediate) or, before the model has run, the input's L.
- **Fit test.** The window's residual variance of a linear model of colour against lightness is compared with the
  noise floor of its lightness (the 25th percentile of residuals in each of 8 bands of the window's mean L, linear
  between band centres). The weight is min(1, 3 x floor / residual). Where colour is not a linear function of
  lightness (two hues of similar lightness, multicoloured texture) the filter steps back, but not in the shadows
  merely because they are noisier.
- **Epsilon from sigma and shadows.** The guided filter's regularisation is (0.5 x 1.0456 x sigma)^2 + 1e-6 in L^2,
  where sigma is the measured noise (section 4). Below mid-grey it grows as read noise does in L, by
  epsilon x (0.5646 / L)^4. The radius is clamp(3 x sqrt(sigma as percent of mid-grey), 3, 20) reference px.
- **Per pixel.** The coefficients and the fit are upsampled bilinearly and applied to the pixel's own L (joint
  upsampling). On the GPU the coefficients are solved on the CPU with the same code and uploaded once per input.

Costs on an M3 Pro: a Colour slider drag on a 1600 x 1067 image takes 14 to 16 ms per frame on the CPU and 5 to 16 ms
on the GPU; the whole filter on a 24 MP image takes 0.34 s on the CPU. On the synthetic fixture (sigma 0.05, 25.5 dB)
NAFNet with its own colour reaches 31.29 dB and with the filter 31.92 dB.

### Edge-masked sharpening

A luminance-only unsharp mask on Oklab L, bounded by a tanh so it cannot halo: L += 0.05 x tanh(k x (L - G(L)) x mask /
0.05), with k = Sharpen / 100 and G a Gaussian of 0.8 reference px. The reference scale is the full image's
min(w, h) / 1080, so a 512 px tuning crop matches the full run. The mask is a smoothstep from 0.02 to 0.06 of the Sobel
magnitude of G(L) per reference px, smoothed by the same sigma, so flat areas, where the leftover noise is, are not sharpened.

### The intermediate, its key and the caches

`write_intermediate` writes a 16-bit RGB PNG with Rec.2020 primaries and the sRGB tone curve, tagged with a matching
ICC profile so any viewer shows it correctly. Values are divided by a scale of clamp(max, 1, 16) (1 for JPEG sources)
so RAW highlights above 1 survive; the sidecar records it. The sidecar `<name>.json` is written last, so it marks a
complete file. It holds the key, size, engine, encoding, scale and the source's RAW metadata (white balance data), so a
substituted decode behaves like the original. Reading is exact: a 65,536-entry table, round trip within 1/65535 of the
encoded value. For a 24 MP synthetic image the PNG is 144 MB, written in 0.45 s and read back to a 1600 px proxy in
0.25 s.

The key is a SHA-256 of `DENOISE_ENGINE` (`denoise/2`), the photo's content hash (the library entry's hash, not the
develop hash), the model and its version, Luminance and Sharpen (to 2 decimals), the colour part (`model:<chroma>`, or
just `filter` in filter mode, since the filter runs at render time) and the merge name (`merge:wavelet`). Changing any of them makes the old intermediate unused rather than
wrong. Moving Colour in filter mode keeps the key.

The editor stores `<appdata>/cache/<hash>/develop/denoise-<key>.png` and a 1600 px `denoise-<key>-proxy.png` for the
working proxy. The editor keeps the current key and the two most recently written others per photo
(`KEEP_DENOISE_KEYS` is 3); `prune_intermediates` and `prune_intermediates_keeping` remove the rest, with sidecars.
The render cache's meta file records which denoise file a render came from, and a cached render made from another
input is redone; `denoiseStale` tells the UI the intermediate is missing. The run is a job on the GPU lane
(`run_denoise`, progress event `develop:denoise-progress`, `cancel_denoise`), and `preview_denoise_crop` renders a
512 px crop for the loupe.

### Speed

NAFNet width32 on an M3 Pro (release): one Core ML partition, about 111 to 136 ms per tile in the D5.1 run (the plan 26
re-run measured 109 ms for the pinned file and 104 ms for our static export, section 5), 640 ms per tile on the CPU. A 24 MP image is 13.1 s of inference and 13.8 s
all in, including 0.24 s for the blend and sharpen.

## 4. Noise profiles

Plan 23 (`ai::noise_profile`, `decode::camera_exif`) measures how noisy a photo is, because both the chroma filter and
the editor's suggested amount need a number.

### Self-measurement

`measure` works on the 1600 px linear working decode in 16 px blocks. Per block and channel it takes the mean and the
plane-detrended variance. A block counts as flat when the Immerkaer 3x3 high-pass share of its variance is high
(adaptive threshold). Per channel it then fits the Poisson-Gaussian model variance = a x mean + b on quantile bins
(lower-quartile variance, monotone lower envelope, weighted least squares, one outlier round, a and b not negative,
blocks with a mean above 0.6 left out). The result carries sigma, the standard deviation at mid-grey (0.18) in linear
units at the analysed size, and a confidence of 1 - exp(-patches / 300), halved per two stops mid-grey lies outside the
fitted range. Under 12 fitted blocks (a bright snow picture) or with a noiseless channel there is no fit and the
profile is invalid. It recovers a and b within 10 percent on synthetic data and takes well under 0.1 s for a 1600 px
image.

### Learned profiles per camera and ISO

The same measurement is stored per camera and ISO in `<appdata>/noise-profiles/<make>-<model>.json`, separately for RAW
and processed sources. Each ISO entry keeps the newest 16 fits; its curve is the component-wise median of the fits
within 2 times of the median sigma, and it is "established" (used) once 3 photos agree. Learning refuses invalid fits,
confidence under 0.3, and, once established, fits more than 2 times off. Lookups return an exact entry, a log-log
interpolation between neighbouring ISOs, or a scaling of the nearest (a proportional to ISO, b to ISO squared), never
more than 2 stops away; confidence halves per stop of distance. A measured fit and a learned curve are blended by
their confidences. The editor's measurement is cached in `<appdata>/cache/<hash>/noise.json`.

### What sigma feeds

- **The chroma filter** takes sigma quantised to 3 significant digits (or, with no fit, derived from the ISO, else 2
  percent of mid-grey) for its radius and epsilon (section 3). The cached proxy and a cached `Developer` record the
  sigma they used and are redone when it changes.
- **The suggested amount** (`suggestedAmount` in `apps/editor/src/lib/denoise.ts`) maps sigma over mid-grey onto 0 to
  100 on a log scale, with separate ranges for RAW (0.015 to 0.1) and processed files (0.007 to 0.05), because a RAW
  decode has no noise reduction and reads 1 to 2 percent even at base ISO while a camera JPEG has had its noise reduced
  and compressed. Examples from its comment: a processed file at 0.35 percent suggests 0 and at 2.3 percent suggests 61;
  a RAW suggests 0 to 12 at ISO 100 to 200, 33 to 55 at ISO 1250 to 1600 and 100 at ISO 12800. Without a trusted sigma
  (confidence under 0.1) the ISO decides: 400 gives 0, 3200 gives 50, 25600 gives 100. Below 15 the UI says "Not
  needed".
- **A future DRUNet** would take it as its noise-level map; the evaluation found the measured scale too low for real,
  correlated noise (section 5).

Measured sigma over mid-grey: about 0.35 percent for 8-bit quantisation alone, 2.3 percent for a synthetic ISO
12800-like JPEG, 1.1 to 2.1 percent for base-ISO RAW decodes, 2.8 to 4.6 percent for ISO 800 to 1600 RAWs and 12
percent for an ISO 12800 RAW (the ON1 samples).

## 5. Measured results (plan 26)

Source: `docs/design/DENOISE_EVAL.md`, run on 2026-10-13 on the M3 Pro development machine, shared with other jobs (load
average 10 to 25), so every time is an upper bound; the relative order held across two runs. The test set is four ON1 sample
RAWs plus a camera-like JPEG made from one of them; the PSNR numbers use a simulation (a clean Canon 5DS R ISO 100 image plus Poisson-Gaussian
noise from each high-ISO photo's measured curve), which is white and channel-independent noise and so favours models
trained on white Gaussian noise. Lightroom was not available; see section 6.

### Speed and Core ML partitions

| Model | Graph | Size | Core ML partitions | ms per 512 x 512 tile (median of 10) | 24 MP (117 tiles) |
| --- | --- | --- | --- | --- | --- |
| width32, ailia (pinned) | fp32, dims fixed | 117.1 MB | 1 | 109 | about 13 s |
| width32, ours | fp32 static | 117.1 MB | 1 | 104 | about 12 s |
| width32, ours | fp16 static | 58.9 MB | 1 | 179 | about 21 s |
| width64 (random weights) | fp32 static | 463.9 MB | 1 | 276 | about 32 s |
| width64 (random weights) | fp16 static | 232.4 MB | 1 | 882 to 1862 | about 100 to 220 s |
| SCUNet, Heliosoph (pinned) | fp32 dynamic | 76.9 MB | 141 (687 of 1669 nodes on the CPU) | 72,000 on Core ML; runs on the CPU | about 12 min (CPU) |
| SCUNet, ours | fp32 static, no Einsum | 77.7 MB | 1 | 499 (first run 559) | about 58 to 65 s |
| SCUNet, ours | fp16 static | 39.4 MB | 1 | 1203 | about 141 s |
| DRUNet, ours | fp32 static, 4 channels | 130.6 MB | 1 | 216 | about 25 s |
| DRUNet, ours | fp16 static | 65.3 MB | 1 | 234 | about 27 s |

The 24 MP figures are tiles times the median tile time; the blend, sharpening and intermediate add about 2 s. SCUNet's
static export removes every Einsum, Shape, Range, ScatterND and Where, after which Core ML takes all 1588 nodes. Whether
58 to 65 s counts as under a minute is not established: it needs an idle, real 24 MP timing before SCUNet leaves
`CPU_ONLY_MODELS`.

### Simulated noise (PSNR in dB, mean of four 512 x 512 crops, sRGB-encoded)

| Method | ISO 12800 noise | ISO 1600 noise | ISO 1250 noise |
| --- | --- | --- | --- |
| Noisy input | 22.96 | 33.16 | 33.70 |
| Chroma filter alone | 29.69 | 35.83 | 35.89 |
| width32, own colour (filter off) | 34.26 | 37.18 | 37.29 |
| width32 + chroma filter | 34.39 | 36.44 | 36.49 |
| SCUNet static, own colour | 34.71 | 37.49 | 37.54 |
| SCUNet static + chroma filter | 34.75 | 36.87 | 36.90 |
| DRUNet, estimated sigma x 1, own colour | 30.58 | 38.90 | 39.02 |
| DRUNet, estimated sigma x 1 + chroma filter | 34.03 | 37.27 | 37.32 |
| DRUNet, estimated sigma x 1.5, own colour | 33.07 | 37.80 | 37.97 |
| DRUNet, estimated sigma x 0.75 + chroma filter | 34.47 | 37.45 | 37.49 |
| DRUNet, 1600 px estimate scaled to full size, own colour | 29.26 | 38.84 | 39.01 |
| DRUNet, oracle sigma (the curve that made the noise), own colour | 29.98 | 38.73 | 38.86 |
| width64 | not measured (weights not downloaded) | | |
| Lightroom Denoise / Detail panel | not measured (no Lightroom) | | |

Reading the table: the chroma filter costs up to 0.8 dB at ISO 1250 to 1600 against width32's own colour and gains 0.1
dB at ISO 12800. The two textured (foliage) crops score 3 to 7 dB lower than the two sky crops for every method, and the
filter loses most there (about 1.5 dB at ISO 1600). At ISO 12800 DRUNet's own colour falls 3.7 dB behind width32; with
the filter it is level. The clamped shadows and the sigma map's clamp at 50/255 were not separated as causes.

### Real photos at 100 percent

1. **Egret, Nikon Z 50, ISO 12800 RAW.** width32 and SCUNet both clean the head and the blurred background completely
   at the defaults; SCUNet keeps the eye ring and the feather edge crisper. Verdict: width32 + filter is good; SCUNet
   is better on detail but 5 times slower.
2. **Egret as a camera-like JPEG.** width32 leaves low-frequency mottling in the background (JPEG-compressed noise is
   not what SIDD taught it); SCUNet removes it. Verdict: SCUNet; this is the case the JPEG fallback is for.
3. **Milky Way, Sony A7R II, ISO 1600, 13 s.** width32 with its own colour adds a warm cast to the sky and lifts it by
   1.8 levels, and drops the faintest stars; the filter removes the cast. Verdict: width32 + filter at the defaults,
   with Luminance below 50 for astro.
4. **Spider, Sony A7R III, ISO 1250.** width32's own colour desaturates the orange legs; with the filter the colour
   matches the input. SCUNet smooths the fine hairs. Verdict: width32 + filter; DRUNet would be the detail-preserving
   choice.
5. **Fox, Canon T3i, ISO 800.** width32 and SCUNet make the fur plastic at full strength (SCUNet more so); at the
   defaults width32 is acceptable. Verdict: width32 + filter at the defaults, with Luminance 30 to 40 for fur and
   foliage.

### Verdict and recommended defaults

NAFNet width32 with the chroma filter at Luminance 50, Colour 75, Sharpen 25 stays the default. For JPEG and other
processed sources, suggest SCUNet once its static export is hosted and an idle 24 MP run confirms about a minute;
until then width32. DRUNet stays off: its measured sigma is too low for real, spatially correlated noise (twice the
measured sigma cleaned the ISO 12800 background about as well as width32 while keeping more of the fox's fur), and the
scale needs calibrating per source kind. NAFNet width64's weights (464 MB) exceeded the evaluation's 300 MB download
limit, so its quality was not measured; its published SIDD number is 0.34 dB above width32, for 2.6 times the time.

## 6. How close to Lightroom

Image-quality parity with Lightroom was **not measured**. No Lightroom is installed on the development machine, so
every Lightroom column in `docs/design/DENOISE_EVAL.md` reads "not measured", and the DEVELOP_PLAN gate "at least as
clean as Lightroom's Detail panel" is still open. The table below compares what the two do, not how well. Lightroom
facts come from public sources named inline; Adobe does not publish its method.

### Lightroom's two noise tools

**Denoise (AI)** is Lightroom's counterpart of this feature. Per Adobe's Eric Chan, as quoted at
https://www.lightroomqueen.com/denoise-work/:

- It launched in v12.3 (2023) for Bayer and X-Trans mosaic raw files only: not JPEG, HEIC, TIFF or PSD, not sRAW or
  mRAW, not Apple ProRAW, not DNGs from other software. v14.0 added Linear Raw DNG
  (https://alternativeto.net/news/2024/10/adobe-lightroom-classic-14-released-with-enhanced-generative-remove-tool-and-denoise-support).
  No release note adding JPEG, TIFF or HEIC was found through Lightroom Classic 15.5 (August 2026), so treat rendered
  files as unsupported.
- It works on the original mosaic data, before the develop pipeline. Whether it demosaics internally is not stated.
- It writes a new linear raw DNG with three RGB channels, keeps the mosaic too, is about 4 times the original size and
  gets the suffix "-Enhanced-NR".
- It has one Amount slider.
- The same source reports 9 s on a recent computer and about 3 min on an old laptop. No Apple Silicon figure is
  published.
- Adobe calls it GPU-intensive and advises 8 GB or more of GPU memory; on a Mac, Apple silicon with plenty of RAM.
  Adobe's Enhance help page says the Apple Neural Engine is not used
  (https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/enhance-details.html).
- v14.4 moved Denoise, Raw Details and Super Resolution into the Detail panel
  (https://helpx.adobe.com/lightroom-classic/help/whats-new/release-notes.html).

**Manual noise reduction** (the Detail panel) has six sliders, described at
https://www.bhphotovideo.com/explora/photography/tips-and-solutions/how-to-use-sharpening-and-noise-reduction-in-lightroom/BI/19115/KBID/10779/:
Luminance smooths grey grain; Luminance Detail is a threshold (higher keeps more detail); Luminance Contrast keeps
local contrast (higher gives more mottling); Color removes chroma noise; Color Detail protects fine coloured edges;
Color Smoothness smooths broad colour mottling.

**Working space.** Lightroom's internal space is linear with ProPhoto primaries
(https://community.adobe.com/t5/lightroom-classic-discussions/how-to-change-working-colorspace-in-lightroom/m-p/11274706).
Ours is linear Rec.2020, and the model sees sRGB-encoded tiles (section 3).

### Feature comparison

| Aspect | Lightroom | Ours | Match |
| --- | --- | --- | --- |
| Input formats | Mosaic raw (Bayer, X-Trans) and Linear Raw DNG; no JPEG, HEIC or TIFF | RAW, JPEG and HEIC alike, because we run after demosaic in linear light | No: ours is wider |
| Where in the pipeline | On the mosaic data, before the develop pipeline | On the demosaiced linear Rec.2020 image; model on sRGB tiles, residual added back in linear light | No |
| Trigger | Explicit action (Enhance) | Explicit action, one run per photo and settings key | Yes |
| Controls | One Amount slider | Luminance, Colour and Sharpen, plus the colour mode; the editor shows Amount (= Luminance) with Colour following | Partly |
| Manual noise sliders | Six: Luminance, Detail, Contrast; Color, Detail, Smoothness | The Colour slider (the chroma filter) and the masks' noise slider; no Luminance Detail or Luminance Contrast; the wavelet merge plays the Detail role in part; no Color Detail or Color Smoothness sliders, the filter's fit test protects colour edges and textures instead | No |
| Output | New linear raw DNG, about 4 times the original, "-Enhanced-NR" | 16-bit PNG intermediate (Rec.2020 primaries, sRGB curve, ICC tagged) in the app cache, keyed by settings; the original is never touched | No |
| Hardware | GPU-intensive, 8 GB or more GPU memory advised; Neural Engine not used | Core ML with all compute units, so the Neural Engine may be used; which unit ran each model was not recorded | No |
| Time | 9 s reported on a recent computer of unspecified make; about 3 min on an old laptop | About 12 to 13 s for 24 MP on an M3 Pro (section 5); not a like-for-like comparison | Not comparable |
| Noise profiling | None exposed | Self-measured fit plus learned per-camera, per-ISO profiles (section 4); drives the chroma filter and the suggested amount | No |
| X-Trans | Supported | Supported, because the RAW path demosaics X-Trans first; a Bayer-domain model (section 7) would not cover it | Yes, for now |
| Image quality | Not measured | Not measured | Unknown |

### What this says

The two share the shape: an explicit, GPU- or accelerator-heavy action that replaces the source with a cleaned
intermediate. They differ in input (Lightroom's own pipeline stage is the mosaic; ours is an image already
demosaiced, which is why JPEG and HEIC work), in controls, and in the profiling we add.

Public comparisons are visual reviews only; no numeric PSNR or SSIM benchmark of Lightroom against DxO or against
NAFNet or SCUNet was found. For context: Life After Photoshop (2023) found DxO DeepPRIME XD clearly ahead with Adobe
"half way"
(https://lifeafterphotoshop.com/lightroom-ai-denoise-vs-dxo-deepprime-xd-theres-a-clear-winner), and Chris Wright
(2024) reported that Adobe closed the gap after 2023 (https://chriswright.photography/noise-reduction-in-dxo-photolab/).
Neither tested this editor, so neither says where it stands. Closing the question needs Lightroom on the same RAW set
and settings matched by eye; until then no parity claim is made.

## 7. Open work

- **Width64 hosting.** The manifest entry is a commented TODO with placeholder bytes and SHA-256. It needs the official
  weights exported with `export_nafnet.py --weights NAFNet-SIDD-width64.pth --width 64`, hosted, and compared with
  width32 on real photos before it is worth 464 MB.
- **SCUNet static export timing and hosting.** The static export (77,695,966 bytes, one Core ML partition, outputs
  within 5e-7 of Heliosoph's) should replace the Heliosoph entry once hosted. Its "under a minute" for 24 MP is an
  extrapolation of 58 to 65 s from a loaded machine; an idle, real 24 MP run decides whether it leaves
  `CPU_ONLY_MODELS` and becomes the JPEG choice.
- **DRUNet sigma calibration.** The sigma-map path works end to end but needs a scale (about 2 times the measured sigma
  for RAW) fixed on more photos, a new manifest task for its four-channel input (`denoise-sigma`), and a decision on
  the feature flag.
- **Exposure and clamping.** The RAW decode reaches the models about 1 EV darker than it is shown, so more shadow noise
  is clamped at zero before the model. That may explain DRUNet's weak ISO 12800 result and part of width32's lift of
  the night sky. Feeding the exposure-adjusted image and undoing it afterwards is untested.
- **Bayer-domain RAW denoise.** Today denoise runs after demosaic (PPG for Bayer, bilinear for X-Trans), where noise
  has already become spatially correlated and shared between channels. Denoising the mosaic before demosaic is an idea
  only; nothing in the code or plans 23 to 26 implements or specifies it. X-Trans would need its own handling, since
  the mosaic is not a 2 x 2 pattern, and that gap is open.
- **Tile batching.** Tiles run one at a time. Batching several tiles per session call was not tried.
- **Missing references.** No real long-exposure reference, no camera JPEG at high ISO and no ISO 6400 photo were in the
  evaluation set; PSNR is on simulated white noise only. The Lightroom comparison is not measured (section 6).

## 8. Where to look

| Topic | File |
| --- | --- |
| Pipeline, strengths, intermediate, key | `crates/develop/src/ai/denoise.rs` |
| Tiling and the overlap blend | `crates/develop/src/ai/tiling.rs` |
| Wavelet luminance merge | `crates/develop/src/ai/merge.rs` |
| Chroma filter (CPU, GPU) | `crates/develop/src/ops/noise.rs`, `crates/develop/src/gpu/noise.rs`, `crates/develop/src/gpu/shaders/noise.wgsl` |
| Noise measurement and learned profiles | `crates/develop/src/ai/noise_profile.rs` |
| Pinned models, licences, hosting TODOs | `crates/develop/models.toml` |
| Runtime, downloader, registry | `crates/develop/src/ai/` (`runtime`, `registry`, download) |
| Sigma-map experiment (feature `denoise-drunet`) | `crates/develop/src/ai/drunet.rs` |
| Model exports and hosting procedure | `scripts/models/README.md` |
| Longer technical notes | `crates/develop/README.md` (sections "AI denoise (D5.1)", "Chroma filter and mask noise", "Noise profiles") |
| Measurements and verdicts | `docs/design/DENOISE_EVAL.md` |
| Editor commands (`denoise_status`, `run_denoise`, `cancel_denoise`, `preview_denoise_crop`) | `apps/editor/src-tauri/src/commands/develop.rs` |
| Suggested amount, Amount to Colour mapping | `apps/editor/src/lib/denoise.ts` |
| User-facing controls | [docs/DEVELOP.md](../DEVELOP.md) |
| History of the decisions | `docs/design/archive/plans/23-noise-profile.md` to `26-denoise-model-evaluation.md` |
