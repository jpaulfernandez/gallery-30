# How editing works

Engineering notes on the Develop engine behind oddhalls (the Photobook editor), for a developer who knows image
processing but not this repo. The user-facing description of the Develop stage is [`docs/DEVELOP.md`](../DEVELOP.md) and
is not repeated here. The crate reference, with every measured number and test name, is
[`crates/develop/README.md`](../../crates/develop/README.md); the original plan is
[`archive/DEVELOP_PLAN.md`](archive/DEVELOP_PLAN.md). Where those do not say, this document says "not documented".

## 1. Overview

Editing is non-destructive. The original file is never written. An edit is a small JSON tree of settings (the
`DevelopSettings` of `packages/shared/src/develop/schema.ts`, a Zod schema that is the source of truth) and a render is
a pure function of the decoded pixels and those settings. Nothing is baked into a file until a publish render, an export
or a cached preview is asked for.

Where the settings live:

- In the photo's folder, in `<folder>/.photobook/library.json`, keyed by the SHA-256 of the file's bytes. The edit
  belongs to the photo, not to a book: every project on the folder sees it, and a renamed or moved file keeps it.
- A photo can also carry versions (virtual copies) in the same library entry. A project asset resolves its settings
  through `resolveAssetDevelop` in `packages/shared/src/library.ts`, in this order: a snapshot frozen into the project,
  then the library entry (the asset's chosen version, else the master edit), then the legacy `develop` field of a book
  written before the library existed, else unedited.

The engine is a pure Rust crate, `crates/develop` (`photobook-develop`), with no Tauri dependency, called by the
editor's Tauri commands. It has a CPU reference and a `wgpu` compute port of the same pipeline (section 4).

Two values tie everything together. The develop hash is the SHA-256 of the canonical JSON of the settings, a newline and
the engine version string; it names every cache entry and render file (section 6), and TypeScript and Rust compute the
same value. The engine version (`develop-engine/4` today) changes whenever render maths changes, which invalidates every
cached render at once.

An unedited photo must render back to its decoded pixels exactly. Every control at its default is skipped, and this is a
tested property, not a goal.

## 2. Decode

Every input becomes a `LinearImage`: interleaved RGB `f32`, linear Rec.2020 with a D65 white, already turned upright by
the file's orientation. Alongside the pixels it carries metadata the pipeline needs later: whether the file is a RAW,
the as-shot white balance, and the camera colour matrices.

Linear Rec.2020 is the working space. The plan's reasoning is that it is wide enough for camera gamuts and that D65
matches every input and output here, so no extra chromatic adaptation is needed. Hue-sensitive controls convert to Oklab
or OKLCH locally.

How each input kind is decoded:

- **JPEG and PNG.** JPEG through turbojpeg with DCT-domain scaling, PNG (8 and 16 bit) through the `image` crate with
  alpha over white. The EXIF orientation is applied. An embedded ICC profile is honoured through `moxcms`; grey, CMYK or
  broken profiles are treated as sRGB. Downscaling is a Lanczos3 resize in linear light.
- **HEIC.** macOS only (feature `heic-imageio`). ImageIO decodes at the file's bit depth into extended linear sRGB half
  floats, so Display P3 colours outside sRGB stay negative or above 1 instead of clipping, then BT.709 goes to BT.2020.
- **CMYK JPEG** is not decoded by the crate; the editor converts it once with `sips`.
- **Camera RAW.** Through `rawler` (feature `raw`, about 870 models including CR3 and X-Trans), with no camera profiles:
  scale by black and white levels; apply the as-shot white balance on the mosaic, clipped at 1 so blown highlights go
  white rather than magenta (no highlight reconstruction); demosaic (PPG for Bayer, bilinear for X-Trans); convert
  colour through the camera matrix, interpolated by colour temperature between the file's calibration illuminants,
  adapted to D65 with CAT16 and mapped to Rec.2020; apply `BaselineExposure` (`2^BE`, the DNG tag, else +1 EV for
  proprietary formats); downscale in linear light; apply the orientation. Out-of-gamut negatives are kept and
  gamut-mapped at output.

### Proxies and working sizes

`rawler` has no reduced-resolution decode, so even a proxy demosaics the whole sensor (0.2 to 1.3 s for 12 to 50 MP in
release, per the README). The editor therefore keeps working copies:

- The editor keeps a 1600 px (`PROXY_EDGE`) upright proxy per photo and a 256 px thumbnail, in the app cache. These are
  made by `prepare_asset` when a folder is scanned. For a RAW, `proxy.jpg` is the camera's embedded JPEG preview when it
  is at least `RAW_PREVIEW_MIN_EDGE` px and has the RAW's aspect ratio, else a developed decode; never linear camera
  data.
- Develop's **working decode** is a 1600 px `LinearImage`, held in memory for the open photo (about 30 MB, per the
  source comment). For JPEG-like files it is decoded from the cached `proxy.jpg` when that proxy is a faithful stand-in
  for the source; otherwise from the source. A RAW is always decoded from the source, about 0.2 to 1.3 s.
- A **full render** decodes the full-resolution source (or the full-size denoise intermediate, section 7).

Radii of the local filters are expressed at a 1080 px short-side reference and scaled by `min(w, h) / 1080`, so a proxy
and a full-resolution render apply the same look.

## 3. The pipeline, stage by stage

The order is the same on the CPU and the GPU: scene-linear operations first, perceptual colour next, then the output
transform, then the operations that are defined on output-encoded values. The README states it as: decode, geometry
warp, white balance, exposure, local pre-passes (cached), highlights and shadows, whites and blacks, contrast, clarity,
texture, dehaze, sharpening, colour mix, vibrance and saturation, halation, vignette, optional display look, output
transform, curves, 3D LUT, colour grading, grain, dither, 8-bit. The CPU module header and the noise section put one
more stage in front of white balance: the chroma noise filter.

**Geometry warp.** Rotate, flip, straighten, Upright, the manual Transform sliders and the crop compose into one
homography, and the decoded image is warped into the crop framing once per geometry before anything else runs. The last
warp is cached, so tone and colour sliders never re-warp, and an identity geometry skips it. Paths: an exact copy when
output pixel centres land on source pixel centres (bit exact); an exact copy of the crop plus a Lanczos3 downscale when
axis-aligned but scaled; otherwise an inverse mapping per pixel with Catmull-Rom (preview quality, up to a 2000 px long
edge) or Lanczos3 (export quality), with a Mitchell prefilter when the map minifies by more than 1.25. Space: linear
Rec.2020. Crops and guides are fractions of the frame, never pixels.

**Chroma noise filter.** Before white balance, on the decoded and warped input. A guided filter removes the blotchy,
low-frequency colour noise: Oklab L is the guide, the chroma ratios `a / L` and `b / L` are filtered on a coarse grid,
and a fit test makes it step back in multicoloured texture. Its radius and regularisation come from the photo's measured
noise; its strength is the Colour slider plus any mask noise. It is the default replacement for the denoise model's own
colour and also implements the masks' `noise` slider. The pre-passes below keep reading the unfiltered input.

**White balance.** One 3x3 matrix on linear Rec.2020: temperature and tint become an illuminant chromaticity
(Robertson), then CAT16 adapts it to the working white. A higher temperature means bluer light, so the image is
compensated warmer, as in Lightroom. `asShot` does nothing; `incremental` (JPEG, PNG, HEIC) shifts around a 6500 K
reference, so 0/0 is an exact no-op; `absolute` (Kelvin and tint, RAW) is relative to the as-shot white and solved
through the camera matrix when the RAW has one, else by CAT16 to the as-shot white.

**Exposure.** `rgb *= 2^EV`, linear.

**Local pre-passes.** Computed once per decoded and warped image and cached (`PrePasses`): the highlights and shadows
base, the clarity detail, the texture band, the dehaze density and atmospheric light, and the sharpening planes (cached
for the last radius). The detail planes are differences of `log2(Y + floor)`, which exposure and white-balance grey gain
only shift, so they stay valid while those sliders move; this is why a drag does not recompute them. The filters are
separable Gaussians, box and min filters, and a guided filter with a grey guide whose coefficients are solved at a
quarter of the resolution.

**Highlights and shadows.** Linear light, keyed on the edge-preserving base lightness (guided-filter base of `log2 Y`),
not the pixel's own value, so texture inside a highlight survives while its level moves. The gain in EV multiplies RGB.
The base is rescaled analytically for exposure and white balance.

**Whites and blacks.** An end-point stretch per channel on the encoded value `u = c^(1/2.4)`: blacks moves the left end,
whites the right end, each leaving the other nearly alone.

**Contrast.** A power about a 0.18 fulcrum on luminance, RGB rescaled by `Y'/Y` so hue and chroma stay put.

**Clarity, texture, sharpening.** Three luminance gains on linear RGB, each from a `log2 Y` plane. Clarity is local
contrast on `log2 Y` minus its guided-filter base (negative values soften toward the base). Texture is a mid-frequency
band (Gaussians at 1.5 and 6 reference px) that barely touches strong edges when positive. Sharpening is a two-scale
unsharp mask with amount, radius, detail and an edge-masking threshold, soft-clipped by `tanh` to limit halos.

**Dehaze.** The dark channel prior with the transmission refined by the guided filter and a sky-safe clamp. The
atmospheric light is measured on the decoded image and mapped through white balance and exposure. Negative values add
haze. Space: linear RGB.

**Colour mix, vibrance, saturation.** One Oklab/OKLCH round trip. Eight Gaussian hue bands (defined on the sRGB hue
wheel and reached through a table from each pixel's OKLCH hue) rotate hue, scale chroma and shift lightness. Vibrance
favours weak colours and damps skin hues; saturation scales chroma. The mix is baked into a 720-bin table per render.

**Halation and vignette.** Scene-linear, after the colour passes and before the display look. Halation is a cached
pre-pass: luminance above a threshold, averaged down, blurred and added back with a warm tint. Vignette is a gain of up
to plus or minus 2 EV along a superellipse distance from the centre. On RAW they sit before the display look, so a given
threshold picks a different brightness than on JPEG.

**Display look.** A fixed sigmoid on luminance (mid grey 0.18 lands at 0.46 encoded). On for RAW, off otherwise, because
with it on diffuse white lands at 217 and an unedited JPEG would not come back unchanged. No setting turns it off.

**Output transform.** Linear Rec.2020 to linear output RGB (sRGB or Display P3, the book's `outputProfile`), gamut
mapping by bisecting Oklab chroma down at constant lightness and hue until every channel is in 0..1, then the sRGB
transfer (Display P3 uses it too). Pixels already in gamut pass through untouched, so an unedited sRGB image round-trips
exactly.

**Curves.** On output-encoded values, like Lightroom: four parametric regions (raised-cosine bumps) and Fritsch-Carlson
monotone point curves, `luma` then `red`, `green`, `blue`, baked into one 4096-entry table per channel.

**3D LUT.** The look's LUT on the display values (output primaries, sRGB curve), after the curves and before grading, by
tetrahedral interpolation, blended by its strength. An identity LUT is exact to float rounding.

**Colour grading.** Display-referred: decode to linear, Oklab round trip, gamut map, re-encode. Three wheels weight
lightness bands with smoothstep blends and add Oklab chroma toward the wheel's hue. The luminance offsets and the Global
wheel came with engine `/4`. The harmony lock is UI state and never reaches the hash.

**Grain.** Value noise from an integer lattice hash with a fixed seed, sampled in reference pixels so the proxy and a
full render see the same grain field. Strongest in midtones, added equally to R, G, B on the encoded output.

**Dither and quantise.** A deterministic hash dither scaled to 0.98 LSB, so values already on an 8-bit level never move
and a render is reproducible, then 8-bit quantisation.

Masks are not a stage of their own: they blend local slider values into the operators above per pixel (section 5).

## 4. CPU reference and GPU

The CPU path is the reference. `Developer` holds a decoded image, its pre-pass cache, the last geometry warp and the
mask caches, and runs the pipeline with `rayon` over rows: each row is copied to a scratch buffer, passed through every
active operator and encoded straight into the output.

The GPU path is a `wgpu` compute port of the same chain as WGSL shaders (Metal on macOS; Vulkan and DX12 are untested).
Its design in brief:

- Every tuning constant in the WGSL prelude is printed from the Rust constant as an `f32` literal, so the two paths
  cannot drift on a value.
- The per-pixel chain is `f32` throughout. Images are `rgba32float`, not half float: f16 differed from the CPU by up to
  5 levels on the haze fixture. Planes are `r32float`.
- Passes: upload, warp, the coarse guided stages once per input image, then per tile the log-luminance and detail planes
  and the `develop` kernel, then readback. The guided planes are applied inside `develop` with bilinearly upsampled
  coefficients, so they need no tile overlap.
- A render tries the GPU first. A GPU error falls back to the CPU for that render; a lost device marks the context
  broken and the process stays on the CPU. Images over the texture limit (16384 px on Apple silicon) or 64 MP render on
  the CPU. `PHOTOBOOK_FORCE_CPU` forces the CPU.
- Crash protection: `gpu::init` runs once at startup. A crash flag file is written before the device is created and
  removed once the device and every kernel exist, so a crash while bringing the GPU up leaves the flag and the next
  launch stays on the CPU.

### Tiling

An image whose sides both fit in 2048 px (`gpu::TILE_SIZE`) is one tile and its planes are cached. Larger images are cut
into 2048 px tiles, each with an overlap equal to the total support of its filters at that resolution (65 px for a 6000
by 4000 image, set by the texture band's three boxes). The coarse guided stages are computed once for the whole image.
The filters run in difference form (a value plus weighted differences from it), which keeps flat regions exactly flat,
so tiled and whole-image renders are bit-identical; a test checks this on a 3000 by 2000 image with tiles of 2048, 1000
and 777 px. Mask layers are uploaded per tile window, so mask memory is bounded at 16 layers of 2048 squared floats.

### How equality is tested

`tests/gpu.rs` renders the fixtures of the pipeline and detail tests, plus geometry cases, on both backends. The
original requirement was at most 2 levels per channel and a mean of at most 0.3. The README's later measurements are
tighter: at most 1 level and a mean of at most 0.0002 across nine settings sets and four geometries; the effects, LUT,
Display P3 and mask tests allow at most 1 level and a mean of at most 0.0012. Previews, which only exist as JPEG, are
compared after a q100 round trip and allow 4 levels, the codec's own rounding. What remains are last-bit differences:
Metal compiles with fast math, so `pow`, `exp2`, `log2`, `atan2`, `tanh` and `cbrt` differ from Rust's by a few ulp and
multiply-adds fuse.

Fast math has a consequence for changes: editing the plain `develop` GPU kernel moved some old pixels by a level even
where the arithmetic was unchanged. So the grading luminance and Global wheel (engine `/4`) run in a separate
`develop_wheels` pipeline, and an ignored test, `tests/engine_bump.rs`, renders eleven RAW samples with 18 settings
fixtures on CPU and GPU and compares a SHA-256 per render with a committed baseline.

## 5. Masks

A mask is a list of components (add, subtract, intersect, each optionally inverted) plus a mask-level invert, feather
and opacity, and a set of local slider adjustments: temperature, tint, exposure, contrast, highlights, shadows, whites,
blacks, texture, clarity, dehaze, hue, saturation, sharpness and noise.

**Rasterisation.** Each mask becomes one `f32` plane on the output (crop) grid, sampled at pixel centres. Vector shapes
are stored as fractions of the transformed, uncropped frame, and distances are measured in frame pixels scaled to output
pixels, so shapes stay round whatever the aspect, crop or output size and the preview agrees with the export.

**Component kinds.** Linear and radial gradients with smoothstep falloff. A brush of round dabs combined by max, so
overlap never builds past the flow, with an erase stroke that subtracts. A luminance range, which reads the sRGB-encoded
Rec.2020 `Y` of the input image (decoded and warped, before any develop adjustment) so it does not move while sliders
are dragged. A colour range, a Gaussian falloff on the Oklab distance to each picked sample, which also reads the input.
And the AI components below.

**Blending.** Per pixel, a slider's local value is the sum over masks of weight times adjustment. It is added to the
global value, clamped to the operator's range, and the operator runs once with the total. A row no mask touches runs the
global passes unchanged, so unmasked renders and untouched pixels are bit-identical to the global pipeline (tested).
Curves and colour grading have no per-mask version.

**AI masks.** Models are ONNX files run through `ort` (CoreML execution provider on macOS, CPU fallback). They are
listed with their licence and a pinned URL, size and SHA-256 in `crates/develop/models.toml`; licences are limited to
MIT, Apache-2.0 and BSD, and nothing is bundled. Downloads are resumable and verified.

Subject and background use BiRefNet lite (U2-Netp is the faster fallback when it is not installed), sky uses
SkyWater-Seg, people use RT-DETR v2 to find people and SAM 2.1 tiny for one box prompt per person, click and box
refinement uses SAM 2.1 tiny, and depth range uses Depth Anything V2 Small.

Inputs are converted from linear Rec.2020 to sRGB primaries with the sRGB transfer, since the models are trained on
JPEGs. The raw output is refined by a guided filter against the picture's luminance (radius 8 px at a 1080 px short
side). A BiRefNet quirk worth knowing: its CoreML load fails on a dilated convolution, so Subject and Background run on
the CPU (about 5.5 to 7 s measured); the other models run on CoreML except the SAM decoder, which also falls back.

**How masks are cached.** Three layers:

- On disk: an AI raster is stored on the decoded image's grid (the 1600 px proxy), after turning the image by the user's
  rotate and flips only. Upright, Transform, straighten and crop are left out. A render maps every output pixel back
  through the inverse geometry and samples the raster bilinearly, so a raster follows the content through crop,
  straighten and Upright without regenerating, and the preview, the overlay and a full-size export read the same file.
  The files are `<appdata>/cache/<hash>/develop/masks/<componentHash>.png` (8-bit grey) and
  `depth-<model>-<version>.png` (16-bit, shared by every depth range of that model version). A component hash covers
  target, model, version, prompts and depth range.
- In memory, shared: `AiRasterCache` is a 96 MB LRU over those files.
- In memory, per image: `Developer` keeps a component-raster LRU (`MaskCache`, 128 MB by default, keyed by component
  hash, size and the frame-to-output map) and the composited planes, keyed by the canonical JSON of the active masks
  without their adjustments. Slider drags, global or local, reuse the planes; editing a mask recomposites from cached
  components. Both are cleared when the input changes, because range components read its pixels. A missing AI raster
  counts as 0 and is never cached, so a raster generated meanwhile appears on the next render.

On the GPU the planes go up as an `r32float` 2D array texture, one layer per mask, plus a storage buffer of the
adjustments. At most 16 active masks render on the GPU; more render on the CPU.

## 6. Settings schema, the develop hash and engine versions

**Schema.** `DevelopSettings` has top-level groups for light, white balance, curve, colour, detail (clarity, texture,
dehaze, sharpening, the optional denoise block), geometry (crop, rotate, flips, the manual Transform), Upright (mode,
transform, guides), masks, and the optional `effects` and `look` sections. Every nested object has a default, so parsing
`{ version: 1 }` yields the full default tree. The Rust mirror is `crates/develop/src/settings.rs`, kept in step by
parity fixtures under `crates/develop/tests/fixtures/` that the TypeScript tests write and the Rust tests read.

**The hash.** `develop_hash` is SHA-256 of the canonical JSON of every field (defaults included), a newline, and
`ENGINE_VERSION`. The canonical form sorts object keys at every level and matches `JSON.stringify` number formatting, so
the Rust and TypeScript sides agree byte for byte. Two details keep old hashes stable when the schema grows:

- `effects` and `look` are left out of the hash input while they equal their defaults (`HASH_OPTIONAL_SECTIONS` and
  `hashableDevelop` in TypeScript, `skip_serializing_if` in Rust), so adding them changed no existing hash. Plan 55's
  grading additions are left out at their defaults the same way.
- State that must not change pixels is excluded: the harmony lock, the look metadata (`applied`),
  `detail.denoise.chromaMode` at its default `filter`, and the preview modes (focus peak and zebra), which are drawn
  over the 8-bit output of a preview and never reach any cache. A LUT is named by its content id, so renders with and
  without it never collide, even when the file is missing.

The `detail.denoise` block is part of the settings and so of the hash. The intermediate's own key (it covers more than
the settings, such as the photo's content hash, the denoise engine and the merge tag; see `DENOISING.md`, section 3) is
separate and is not in the hash.

**When the engine version bumps.** Whenever any render maths changes. `DEVELOP_ENGINE_VERSION` in
`packages/shared/src/develop/schema.ts` and `ENGINE_VERSION` in `crates/develop/src/lib.rs` must change together.
History: `/3` was one bump for the effects, the 3D LUT and their GPU port; `/4` added the grading wheels' luminance
offsets and the Global wheel. Settings that do not use a new feature are meant to render byte-identical across the bump;
only the hash changes, and `tests/engine_bump.rs` checks that against a committed baseline of render digests (the README
gives the step-by-step procedure).

**Fixture regeneration.** After a bump, regenerate both sets of fixtures:

- `UPDATE_DEVELOP_FIXTURES=1 pnpm --filter @photobook/shared test`
- `UPDATE_GEOMETRY_FIXTURES=1 cargo test -p photobook-develop --test geometry`

The CPU path is the reference and the GPU must match it. Stats (sharpness, perceptual hash, palette) are not render
maths and do not bump the engine.

## 7. Editor flow

### A slider drag

In the Develop panel (`components/develop/usePreview.ts`):

1. A slider change updates the settings in the book store. The preview hook notes a render is pending and coalesces
   requests to at most one per 16 ms (`PREVIEW_COALESCE_MS`). A request already queued will read the newest settings
   when it fires, so a fast drag does not queue a backlog.
2. It calls the `render_develop_preview` command with a job id that only increases. The Rust side records the highest
   job seen; a job older than that returns empty bytes instead of rendering, checked before the render, after the decode
   and again before the encode.
3. The command renders on a worker thread under a semaphore of two concurrent renders. The open photo's decoded 1600 px
   `Developer` is kept in memory (`DevelopJobs`), so a tick costs one render pass with every pre-pass, warp and mask
   plane cached. It decodes again only when another photo is opened, when the denoise input changes, or when the photo's
   noise sigma was measured after the decode and the settings need it.
4. The result is a 1600 px JPEG at quality 85, tagged with the output profile, returned as bytes. The webview shows it
   through an object URL, decoding it before swapping the `<img>` so there is no blank flash.
5. The edit is committed to the library once per burst: when the pointer is released after a drag, or 300 ms after the
   last change for key nudges and typed values.

The preview is never cached. The default-settings state skips the preview and shows the cached proxy.

### Jobs and lanes

Long work runs as a job (`enqueue` in `apps/editor/src/store/jobs.ts`, not undoable), never inline. Renders and denoise
share one lane (the GPU), publish has one, exports have two, file operations one, AI requests one. Adapters in
`src/lib/jobs/` queue full renders (`enqueueRender`, progress from `develop:progress`, cancel between items) and denoise
runs (`enqueueDenoise`, cancel between tiles). Every writer in a job writes a temp file and renames it, so a cancelled
job leaves no partial file.

### What is cached where

All keyed names use the develop hash (`dh`) from section 6.

| Location | Contents |
| --- | --- |
| `<appdata>/cache/<hash>/` | `thumb.jpg`, `proxy.jpg`, `meta.json` for the source; `{proxy,thumb}-<dh>[-p3].jpg` and `develop-<dh>.json` for developed variants (three kept); histogram and `noise.json` |
| `<appdata>/cache/<hash>/develop/` | Denoise intermediates and their 1600 px proxy copies; `masks/` for AI mask rasters |
| `<appdata>/cache/looks/` | 240 px Looks strip thumbnails |
| `<source>/.photobook-cache/develop/<hash>-<dh>[-p3].jpg` | Full-resolution renders (quality 95, source Exif copied for JPEG and HEIC), used by publish |
| `<source>/.photobook-cache/export/<presetHash>/` | The export cache |
| `<folder>/.photobook/library.json` | The settings themselves |

`render_develop_cached` writes the proxy and thumbnail variants and returns them without rendering when they already
exist. A cached render records which denoise file it was made from, and one made from another input is redone.
`render_develop_full` renders at full resolution into the source folder's cache, skipping files that exist and
cancelling between items. Display P3 renders carry a `-p3` suffix after the develop hash, which stays profile-free.

### Denoise substitution

AI denoise runs outside the render pipeline as an explicit, once-per-settings step. The render does not call the model.
Instead, the editor swaps the pipeline's input: when a current denoise intermediate exists, the working decode (or the
full-size decode) reads the intermediate in place of the source. The intermediate is a 16-bit PNG with Rec.2020
primaries and the sRGB curve, with a sidecar that keeps the RAW white-balance data, and its key is separate from the
develop hash. Full details, including the model choice, tiling, the luminance merge and the chroma filter's role, are in
[`DENOISING.md`](DENOISING.md).

## 8. Export and XMP sidecars

**Export.** An export develops the photo at full resolution exactly as a publish render does (from the source or its
denoise intermediate), then `export::finish` resizes it to the preset's long edge (Lanczos3 on the 8-bit output, never
upscaling), applies output sharpening, the optional watermark and border, and encodes. At the developed size, with
sharpening off and JPEG quality 95, the result is byte for byte the publish render. TIFF and HEIC are developed into 16
bits per channel on the CPU so they keep more than the 8-bit render. Formats are JPEG, PNG, WebP, AVIF (10-bit AV1 from
the 8-bit render, sRGB only), HEIC (macOS only, 10-bit via ImageIO), TIFF (16-bit, Deflate) and Original plus sidecar.
Output files are tagged with the output profile's ICC. The editor keeps each encoded file in an export cache and copies
it to the destination; `export_photo` recomputes the preset hash and refuses a mismatch. A destination outside the
imported roots must be picked in a dialog in the current session and is never added as a root.

**XMP.** The crate has a Lightroom reader and two writers (`xmp` module, editor side in `commands/xmp.rs`).

- Reading: `read_sidecar`, `read_packet` and `read_embedded` return the importable settings plus lists of what was
  dropped and what was imported but unverified. The editor looks for `<stem>.xmp`, then `<file>.xmp`, then a packet
  embedded in a JPEG. A packet in our own namespace is read back exactly; otherwise the `crs:` fields are mapped. A
  sidecar marked `AlreadyApplied` (an exported JPEG) is skipped.
- Writing, Photobook mode (lossless): the canonical settings JSON in `photobook:Develop` and the engine version in
  `photobook:Engine`, under the namespace `http://ns.photobook.app/develop/1.0/`. Lightroom ignores it and Photobook
  reads it back exactly, masks included.
- Writing, Lightroom mode (`crs:`, lossy): process version 15.4 with light, white balance, curves, colour mix, texture,
  clarity, dehaze, sharpening, crop, Upright and the Transform sliders, mapped to Lightroom's fields (curves rounded to
  0..255, parametric splits to whole percents, geometry converted into the recorded frame before EXIF orientation).
  Masks, denoise and the crop aspect preset are not written. A warning property marks the file as lossy. Lightroom
  renders these values with its own maths, so the photo will not match the preview here.
- Merging: an existing sidecar keeps every property except the ones the new packet sets (the old file is kept as
  `.bak`); one that does not parse is an error rather than being overwritten.

What the importer drops and what it marks unverified is listed in the README's Lightroom XMP section and in the import
dialog.

## 9. Where to look

| Feature | File |
| --- | --- |
| Settings schema, `DEVELOP_ENGINE_VERSION`, hash | `packages/shared/src/develop/schema.ts` |
| Resolving a project asset's settings | `packages/shared/src/library.ts` (`resolveAssetDevelop`) |
| Rust settings mirror, `ENGINE_VERSION`, `develop_hash` | `crates/develop/src/settings.rs`, `crates/develop/src/lib.rs`, `crates/develop/src/canonical.rs` |
| Decode (JPEG, PNG, HEIC, RAW) | `crates/develop/src/decode/` |
| Colour maths (Oklab, CAT16, curves, output ICC) | `crates/develop/src/color/` |
| One function per control, local pre-passes | `crates/develop/src/ops/`, `crates/develop/src/local/` |
| CPU reference pipeline, masked path | `crates/develop/src/cpu/mod.rs`, `crates/develop/src/cpu/masked.rs` |
| GPU pipeline and shaders, parity tests | `crates/develop/src/gpu/`, `crates/develop/tests/gpu.rs` |
| Geometry, Upright, warp | `crates/develop/src/geometry/` |
| Mask rasterisers, blend, AI raster cache | `crates/develop/src/masks/` |
| AI models, registry, segmentation, denoise | `crates/develop/src/ai/`, `crates/develop/models.toml` |
| 3D LUTs, camera JPEG matching | `crates/develop/src/lut.rs`, `crates/develop/src/lutfit/` |
| Export encoding | `crates/develop/src/export.rs`, `crates/develop/src/export_heic.rs` |
| Lightroom XMP | `crates/develop/src/xmp/`, `apps/editor/src-tauri/src/commands/xmp.rs` |
| Preview and full renders, proxy, `DevelopJobs` | `crates/develop/src/render.rs`, `apps/editor/src-tauri/src/commands/develop.rs` |
| Live preview hook, engine-bump test | `apps/editor/src/components/develop/usePreview.ts`, `crates/develop/tests/engine_bump.rs` |
| Job queue and render adapters | `apps/editor/src/store/jobs.ts`, `apps/editor/src/lib/jobs/` |
| Cache and on-disk layout | `docs/CODEMAP.md`, "Caches and on-disk layout" |
