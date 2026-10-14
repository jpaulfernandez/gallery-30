# Photobook Develop Module: Research and Implementation Plan

Oct 9, 2026 · Research only, no code was written for this plan. Companion to [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
(phases 1 and 2) and [DESIGN_NOTES.md](../DESIGN_NOTES.md).

The goal: a non-destructive, Lightroom-style **Develop** module inside the editor, so a trip folder can be culled,
edited and laid out in one app. The edit pipeline runs in Rust (CPU reference first, GPU second), AI masks and
denoising run locally through ONNX Runtime with models downloaded from Hugging Face on first use, and every edit is
plain data in the project file so publish, undo and relink keep working as they do today.

| Phase | Delivers | Usable gate |
| --- | --- | --- |
| **D1. Global develop** | Light, white balance, curves, colour mix, vibrance and saturation on a Rust CPU pipeline; live proxy preview; edited photos flow through the canvas, filmstrip and publish | A JPEG edited in the app publishes with the edit baked in, and reopening the project shows the same sliders |
| **D2. Geometry** | Crop with aspect presets and straighten (manual, drag-a-horizon, auto level); manual perspective sliders; guided and automatic Upright (level, vertical, full) with constrain-to-image; one inverse-mapped resample on the CPU | A tilted architecture shot is levelled and its verticals straightened with one click, the crop stays inside the image, and the published photo matches the preview |
| **D3. Detail and GPU** | Clarity, texture, dehaze, sharpening; wgpu compute path (including the geometry warp) with the CPU pipeline as the reference; full-resolution tiled export | A 24 MP export matches the 1600 px preview and a slider drag stays under one frame on Apple silicon |
| **D4. Masks** | Brush, linear, radial, luminance and colour range masks; AI subject, sky, background, people and depth masks through ONNX Runtime | Select Subject on a portrait returns a usable mask in a few seconds and a local exposure edit publishes correctly |
| **D5. Denoise** | AI denoise with separate luminance and chroma strength, tiled, followed by sharpening; cached as a 16-bit intermediate | A high-ISO JPEG denoised in the app looks at least as clean as the Lightroom Detail panel at the same settings |
| **D6. RAW, colour management, interop** | RAW decode, ICC-aware input and tagged output, Lightroom XMP import, presets, copy and sync settings | A RAW file opens, develops and publishes; a Lightroom sidecar imports with the same slider values |

## Status (Oct 10, 2026)

Every step D1.1 to D6.3 is implemented, in `crates/develop`, `apps/editor` and `packages/{shared,publish}`: the Rust CPU
pipeline and its wgpu port, geometry with Upright, the detail operators, masks and AI masks, AI denoise, RAW and
colour management (sRGB and Display P3 output), and presets, sync and Lightroom XMP. Verification rests on
`cargo test -p photobook-develop` (GPU and `PHOTOBOOK_FORCE_CPU=1`), the Vitest suites and the editor's dev log
(`[photobook:` lines); nothing was checked by looking at the running window, because there was no screen capture. The
UI therefore has component tests and logs behind it, not visual review. The technical record is
`crates/develop/README.md`; the user guide is [../DEVELOP.md](../../DEVELOP.md); the UI notes are in
[DESIGN_NOTES.md](../DESIGN_NOTES.md#develop-view).

Known gaps, stated plainly:

- **Subject and Background run on the CPU.** BiRefNet lite fails Core ML's parser (a dilated `Conv` without `pads`) in
  both fp16 and fp32, so a mask takes about 6 s. U²-Netp (4.7 MB,
  about 0.2 s, one Core ML partition) is in the manifest as `subject-fast` but no mask tool selects it. The
  plan's "about 3 ms, one partition" for the sky model was not reached either (17 partitions, about 70 ms).
- **SCUNet is CPU only and slow** (about 12 minutes for 24 MP; Core ML splits it into 141 partitions). NAFNet (about
  14 s for 24 MP) is the working denoise model.
- **The NAFNet file is not self-hosted.** It is ailia's fp32 export, pinned by SHA-256 from their storage bucket; our own
  fixed-shape fp16 export (`scripts/models/export_nafnet.py`) exists as a script but no file from it is hosted or pinned,
  and the width-64 model is not in the manifest. The denoise gate "at least as clean as Lightroom's Detail panel" was not compared against
  Lightroom; only a synthetic-noise PSNR check exists.
- **No portrait fixture, so the hair-line mask check of D4.3 was not done.**
- **Lightroom field uncertainties** (section 4.11 and 4.6): the `UprightTransform_N` layout, `UprightFourSegments_N`,
  `CropAngle`'s rotation centre and the Transform slider ranges and signs are unverified against real Lightroom
  output. The import dialog lists them as "Imported, but unverified". Lightroom's masks are not imported.
- **RAW**: Apple's `CIRAWFilter` (bodies `rawler` lacks, ProRAW), lens corrections, camera profiles (DCP) and highlight
  reconstruction are not done; the exposure of formats without a DNG baseline tag is a measured +1 EV default.
- **Local Noise** (a mask's `noise` slider) is shown disabled; the settings field exists but nothing renders it.
- **Platforms**: only macOS on Apple silicon was run. The Vulkan and DX12 GPU backends, Linux and Windows are untested.

Each phase is split into steps that are individually shippable, ordered by dependency; a step is done when its check
passes.

---

## 1. What this adds, and what it does not

**In scope**

- Light: exposure, contrast, highlights, shadows, whites, blacks.
- Tone curve: parametric (highlights, lights, darks, shadows with three split points) and point curves (luma, R, G, B).
- White balance: temperature and tint (absolute Kelvin for RAW, incremental for JPEG/HEIC/PNG).
- Colour: vibrance, saturation, colour mix (8 hue bands with hue, saturation and luminance).
- Detail: clarity, texture, dehaze, sharpening (amount, radius, detail, masking), denoise.
- Geometry: rotate 90° and flip; crop with aspect presets, lock and overlays; straighten (angle slider, drag along a
  horizon, auto level) with constrain-to-image; perspective with manual sliders (vertical, horizontal, rotate, aspect,
  scale, x and y offset), guided lines (2 to 4), and automatic Upright modes (auto, level, vertical, full) with
  constrain crop.
- Masks and local edits: brush, linear gradient, radial gradient, luminance range, colour range, AI subject, sky,
  background, people, depth; add, subtract and intersect; invert, feather, opacity.
- AI denoise with chroma and luminance strength, tiling and post-sharpening, running locally.
- Everything stored in the project file; previews and renders cached; publish bakes the edits in.

**Out of scope for these phases** (listed so nobody builds them by accident): lens corrections and profiles
(distortion, vignetting, chromatic aberration; note Lightroom recommends a lens profile before Upright, so auto
perspective here works on uncorrected pixels), healing and generative fill, HDR output, panorama and focus merge, video, a catalogue across folders,
printing. Each is a separate plan if ever wanted.

---

## 2. Decisions to lock before step D1.1

Recommendation first, then why. The research behind each row is in section 4.

| Decision | Recommendation | Why |
| --- | --- | --- |
| Where the pipeline runs | A new pure-Rust library crate `crates/develop` (no Tauri dependency), used by the editor's Tauri commands and later by a sidecar binary | Keeps the maths testable with plain `cargo test`, lets the publish CLI reuse it, and mirrors the `packages/shared` rule that the renderer never imports from apps |
| CPU first, GPU second | Ship D1 on a `rayon` f32 CPU pipeline; add `wgpu` 30 compute shaders (WGSL) in D3 with the CPU path kept as the reference implementation and fallback | A 1600 px proxy is 2.5 MP; per-pixel maths on an M3 Pro is tens of milliseconds, which is enough to ship. LightCraft and RapidRAW both keep a CPU path; verifying GPU output against it is how you keep preview and export identical |
| Working space | Linear Rec.2020, D65, f32 per channel; Oklab/OKLCH for hue, saturation and vibrance operations | darktable's default and its reasoning hold: wide enough for camera gamuts, D65 like every input and output here, so no extra chromatic adaptation. Oklab is a pair of 3×3 matrices and a cube root and is designed for hue-stable chroma changes |
| White balance model | Temperature and tint to chromaticity by the Robertson isotemperature-line method (as in the DNG SDK), applied as a CAT16 von Kries scaling in LMS | Matches Lightroom's Kelvin and tint ranges; CAT16 is darktable's default and avoids Bradford's out-of-gamut behaviour on difficult illuminants |
| Order of operations | Scene-linear first (WB, exposure, highlights/shadows, whites/blacks, contrast, local detail), perceptual colour next (mix, vibrance, saturation), then a display transform and the curves, then output encoding | darktable's pipeline rationale and the DNG SDK's render order; see section 4.2 for the full list |
| Local operators | Guided filter (He, Sun, Tang) as the base layer for highlights/shadows protection, clarity and dehaze; a band-pass of two Gaussians for texture; two-scale unsharp mask with an edge mask for sharpening | O(N), edge preserving, maps well to compute shaders, and is the approach RapidRAW converged on after a year of iteration. Local Laplacian (darktable's local contrast) is a later quality upgrade |
| Resolution independence | Every blur radius is expressed at a 1080 px short-side reference and scaled by `min(w, h) / 1080` | Otherwise the proxy and the export disagree. Export tiles at 2048 px with an overlap wider than the largest kernel, or computes the low-frequency base at reduced size |
| Geometry position | Orientation, perspective and straighten are one 3×3 homography applied as the **first** spatial step on the linear float image, resampled once directly into the crop's output framing; everything else (local pre-passes, masks, colour) runs on the warped, cropped grid | darktable's pipe puts rotate-and-perspective right after lens correction and before exposure; one resample avoids double-softening and keeps sharpening and denoise on the final grid. RawTherapee runs masks before geometry and its users complain that masks do not follow the warp |
| Geometry model | `H = T_crop · R(straighten, about the crop centre) · M_manual(offset · scale · aspect · keystone · rotate) · H_upright · O_orientation`; keystone as a virtual camera rotation `K R K⁻¹` with `f` = the long edge (or the EXIF 35 mm-equivalent focal when present); the Upright analysis stores its resulting homography in the settings like Lightroom's `UprightTransform_N` | Straight lines stay straight by construction; a stored homography makes renders deterministic and independent of the detector version, and lets "Update" be an explicit action |
| Resampling | Inverse mapping per output pixel; Catmull-Rom bicubic for previews, Lanczos3 for export, with a Mitchell area prefilter when the local scale minifies by more than about 1.25; 16-tap or 36-tap gathers in WGSL | What LightCraft ships and what darktable (bicubic default) and RawTherapee (sharpened cubic) do; compute shaders have no hardware bicubic, so the taps are explicit |
| Auto level and Upright | Classical first: a clean-room line-segment detector (EDLines/ELSED-style, or the `lsdetect` crate once vetted), RANSAC vanishing points, focal from two orthogonal vanishing points (`f² = −v₁·v₂` about the centre, else the EXIF or a 28 mm-equivalent default), a closed-form rectifying rotation, then a Nelder-Mead refinement on the weighted line residuals; Apple's Vision horizon detector as a free macOS fallback for line-poor scenes; GeoCalib (Apache code, CC BY 4.0 weights, 118 MB) only if accuracy on landscapes later justifies the download | This is the published Adobe Upright design (Lee et al. 2012) and the lineage shared by darktable, ART and RawTherapee; zero bundle cost; lines can be shown and edited as guides. Perspective Fields is non-commercial and the other learned models lack licences |
| Crop storage | Crop rectangle in fractions of the **transformed, uncropped** image plus the straighten angle (−45..45) and an aspect lock; constrain-to-image recomputes the largest inscribed rectangle after any geometry change | darktable's `cl/cr/ct/cb` convention and the project's "fractions, never pixels" rule; Lightroom's crop also lives in the transformed frame (it resets the crop when Upright changes) |
| Masks and geometry | Vector masks (brush strokes, gradients, guides) are stored in the transformed, uncropped frame; when the perspective changes they are re-mapped through `H_new · H_old⁻¹` so they stick to image content; AI mask rasters are regenerated | Masks follow the pixels the user painted on, which is the behaviour RawTherapee's users ask for |
| Edit storage | `develop` object on each entry of `book.assets`, Zod schema in `packages/shared/src/develop/`, schema version 6 | Per photo, like Lightroom; survives relink because assets keep their ids; undo comes free from zundo on the book slice |
| Rust and TypeScript parity | Zod is the source of truth; a serde struct in `crates/develop` deserialises the same JSON; a fixture-based parity test runs in both Vitest and `cargo test` | Project convention (never hand-write a duplicate type) applied across the language boundary |
| Cached derivatives | Keyed by `(source hash, develop hash)` where the develop hash is SHA-256 of the canonical settings JSON plus an engine version | Any change to the maths bumps the engine version and invalidates renders; unchanged photos cost nothing on reopen |
| Preview transport | Rust renders the proxy and returns JPEG bytes through `tauri::ipc::Response`; the webview shows them in an `<img>` from a blob URL; committed edits are also written as `proxy-<developHash>.jpg` and `thumb-<developHash>.jpg` so the canvas and filmstrip keep using file URLs | Tauri documents `Response` as the path for large binary returns; RapidRAW moved from base64 to IPC for this reason. Writing committed previews to the cache means the existing resolver needs a one-line change |
| Publish | The editor renders full-resolution developed JPEGs (quality 95, sRGB, EXIF copied) into `<sourceFolder>/.photobook-cache/develop/<hash>-<developHash>.jpg` (v8: the asset's folder in `folders`) before launching the CLI; the CLI's freeze step substitutes them; the publish fingerprint includes develop settings | No sharp changes, no second renderer in Node; the viewer is untouched |
| Inference runtime | `ort` 2.0.0-rc.13 with the statically linked prebuilt binaries, CoreML execution provider on macOS (ML Program format, static input shapes, model cache dir, graph optimisation level 1), DirectML on Windows later, CPU fallback always | One model format for every platform, about 9 MB compressed added to the binary, no dylib to sign. The alternatives are weaker: candle needs each model ported by hand, tract covers a third of the ONNX test suite, burn's importer is immature, tch is hundreds of MB, wonnx is archived |
| Model download | A small `reqwest` downloader in Rust with `Range` resume, a `.part` file, SHA-256 verification and a Tauri progress event, into `<appdata>/models/<name>/<version>/` | `hf-hub` 1.0 dropped resumable downloads (open issue, August 2026) and only retries headers; 0.5 works but imposes the Hub's blob/snapshot layout. RapidRAW does the same thing with reqwest |
| Model licences | Only permissive weights ship by default: BiRefNet (MIT), SkyWater-Seg (MIT), SAM 2.1 (Apache-2.0), RT-DETR (Apache-2.0), Depth Anything V2 Small (Apache-2.0), MODNet (Apache-2.0), NAFNet (MIT), SCUNet (Apache-2.0) | The repo is MIT and public; non-commercial weights (RMBG 1.4 and 2.0, NVIDIA SegFormer, EdgeSAM, Depth Anything V2 Base/Large, Depth Pro, MIRNet-v2) and copyleft ones (Ultralytics YOLO, RVM) would taint any build someone else ships. Section 4.9 has the full table |
| RAW decoding | `rawler` 0.8 (LGPL-2.1) in D6, with Apple's `CIRAWFilter` through `objc2-core-image` as a macOS-only complement for bodies rawler lacks | The only maintained pure-Rust decoder with broad coverage (about 870 models) and a built-in develop path to linear f32. LGPL is fine for an MIT app that ships source |
| Colour management | `moxcms` 0.9 for ICC input profiles and tagged output; previews rendered in the output space and tagged, never filtered in CSS | Pure Rust, permissive, NEON paths. The webview colour-manages tagged images, so rendering into the export space and tagging it is what keeps preview and export identical |
| Lightroom XMP | Read `crs:` sidecars as an import (D6); write our own `photobook:` namespace; optionally emit `crs:` as a lossy "send to Lightroom" export with a warning | The slider names and ranges are public and map one-to-one, the maths is not, so round-tripping through `crs:` as the source of truth would silently change images |
| Existing `filter: bw | fade` | Keep as-is in D1; in D6 turn them into develop presets applied at the element level, then deprecate | They are page-element properties rendered in CSS and published books rely on them; no reason to break that early |
| Studying RapidRAW | Read its shaders and mask code for ideas; never copy code | RapidRAW is AGPL-3.0. Its pipeline order, hue-band table and mask combination model are described in section 4.1 so nothing has to be lifted |

---

## 3. How it fits the current code

What exists today, and what each piece becomes.

| Today | After the Develop module |
| --- | --- |
| `apps/editor/src-tauri/src/commands/assets.rs` decodes JPEG with libjpeg-turbo DCT scaling, resizes with `fast_image_resize`, writes `<appdata>/cache/<hash>/{thumb,proxy}.jpg` | Unchanged for the *source* proxies. A new `commands/develop.rs` calls `crates/develop` to render `proxy-<developHash>.jpg` and `thumb-<developHash>.jpg` next to them, plus full-resolution renders into the source folder's `.photobook-cache/develop/` |
| `packages/shared/src/schema.ts` `AssetSchema` has `path`, `hash`, size, orientation, `rating`, `flag` | Gains `develop?: DevelopSettings`; `CURRENT_VERSION` becomes 6 with a no-op migration case (every new field is optional) |
| `apps/editor/src/components/preview/resolve.ts` `makeResolver` returns `file.proxyUrl` or `file.thumbUrl` | Returns the developed variant when the asset has a `develop` object and the file for its current develop hash exists, else the source variant (so the canvas never goes blank while a render is pending) |
| `asset.width` / `asset.height` are the source's upright size, used by the renderer's cover layout and by relink | Stay as they are (relink keys on them). The developed size (after crop and perspective) is written to the cache meta and returned by the resolver as `ResolvedImage.width/height`, which the renderer already prefers; a page element's pan and zoom are relative to the slot, so a crop in Develop re-fits the photo without touching the page |
| `apps/editor/src/store/assets.ts` tracks scan, hash, prepare per file | Tracks `developedUrls: Record<developHash, {thumbUrl, proxyUrl}>` and a `rendering` flag per asset; a `renderDeveloped(assetId)` action with the same job-cancellation pattern as `hash_files` |
| `apps/editor/src/components/review/ReviewMode.tsx` shows one photo large with rating keys | The Develop view reuses this shell (large image, neighbour strip, keyboard stepping) and adds the right-hand panel; `D` opens Develop from the filmstrip or Review |
| `packages/shared/src/publish/fingerprint.ts` hashes used asset content hashes and pages | Also hashes each used asset's `develop` object, so "unpublished changes" lights up after an edit |
| `packages/publish/src/freeze.ts` resolves `absPath` for each used asset | For assets with `develop`, resolves to `.photobook-cache/develop/<hash>-<developHash>.jpg` and fails with a clear "render in the editor first" error when missing; `outDir` becomes `out/<hash>-<developHash>` so the sharp cache is keyed correctly |
| `apps/editor/src-tauri/src/commands/publish.rs` launches the CLI through `tsx` | Before launching, invokes the render-all step for every used asset whose render is missing or stale, with progress in the publish panel |
| `.claude/launch.json`, CSP in `tauri.conf.json` | CSP `img-src` gains `blob:` (already present) and `connect-src` stays as is; model downloads happen in Rust, not the webview |
| Cargo: a single crate under `apps/editor/src-tauri` | A root `Cargo.toml` workspace with members `apps/editor/src-tauri` and `crates/develop` (later `crates/develop-cli`). `source ~/.cargo/env` still applies in agent shells |

Existing guarantees that must survive: `ensure_allowed` for every path (the new cache folders are under the app data
dir or the source root), `write_book` atomic writes, ids never regenerated, secrets never in the project file, Biome
formatting, and the shared renderer never importing from `apps/*`.

---

## 4. Research summary

Sources were checked on Oct 9, 2026 (crates.io, GitHub API, Hugging Face trees, vendor docs). Items marked
*unverified* could not be confirmed against a primary source. Full links are in section 9.

### 4.1 Reference implementations

**RapidRAW** (Rust, Tauri 2, React, wgpu; AGPL-3.0; about 10k stars; pushed Oct 8, 2026) is the closest existing
thing to this plan. Study it, do not copy it. What it does:

- Everything is wgpu **compute** in WGSL (8×8 workgroups), `Rgba16Float` intermediates, one main 76 KB shader plus
  `blur`, `guided`, `flare` and `display` shaders. Pre-passes compute separable Gaussian blurs at four radii scaled by
  `min(w,h)/1080` (1.0 sharpen, 3.5 tonal, 8.0 clarity, 40.0 structure) and a guided-filter pass whose `(a, b)`
  coefficients the main pass uses for clarity, dehaze and highlight/shadow detail protection.
- Export tiles at 2048 px with 128 px overlap. Masks are an `R8Unorm` 2D array texture (up to 32 layers); per-mask
  slider values are **added into the global parameters weighted by the mask value**, so most local edits are parameter
  blending rather than a second render; only curves, colour grading and LUTs are rendered per mask and mixed.
- Shader order: CA fix → to linear → mask accumulation → noise reduction → sharpening (two blur levels, shaped by
  `d / (1 + (d/s)²)`) → clarity on `log2(luma)` detail from the guided filter → exposure `2^EV` → dehaze (dark channel,
  `A = (0.95, 0.97, 1.0)`, `t0 = 0.08`) → white balance in LMS (Bradford) → tonal controls in gamma 2.2 space
  (contrast S-curve about 0.5, shadows `sh·t·(1−t)^4.5`, blacks around a 0.2 pivot, whites pivot 0.45, highlights pivot
  0.06 on a detail-stripped base) → HSL with eight Gaussian hue bands → saturation and vibrance (weighted by
  `(1 − sat)^1.25`, skin dampener at hue 25°) → colour grading → tone map (AgX or sRGB) → 16-point monotone cubic curves
  (Fritsch–Carlson limiter) → grain, dither, clamp.
- Masks are CPU-rasterised with `rayon`, combined by max / saturating-subtract / min, then inverted, grown (dilate or
  erode up to 1% of the short side) and feathered (Gaussian up to 0.5%). AI masks: SAM ViT-B (1024 px, box prompt),
  U²-Net for foreground, a U²-Net sky model, Depth Anything V2 small (518 px); `ort` with the default CPU provider
  (no CoreML), models fetched with `reqwest` and SHA-256 checked. On macOS it decodes RAW through `CIRAWFilter` for
  linear float output.
- Its changelog from Oct 6, 2026 ("rewritten whites adjustment, improved shadow and highlight recovery") shows the
  tonal maths is still being tuned after a year; expect the same here.

**LightCraft** (MIT or Apache-2.0, created Sep 30, 2026, egui + wgpu compute with a CPU reference pipeline, reads
`crs:` XMP, never writes it) and **RAWmakase** (MIT, LibRaw + Metal/Vulkan/DX12, "close, not exact" Lightroom parity)
are permissively licensed Rust references that are weeks old and partly AI-written. Useful as idea sources, not as
dependencies.

**darktable** (C, GPL-3.0) is the best documented pipeline: `exposure.c`, `colorbalancergb.c` (contrast as a power
about an 18.45% fulcrum, vibrance `v·(1 − C^|v|)`), `toneequal.c` (9 EV bands over a guided-filtered mask),
`bilat.c` (local contrast via local Laplacian), `hazeremoval.c`, `sigmoid.c`, `rgbcurve.c`, `colorequal.c`,
`channelmixerrgb.c` (CAT16 by default). Its pixelpipe page explains why linear operations go first and tone mapping
late.

### 4.2 Pipeline order and the maths per control

Adobe publishes no formulas. The DNG SDK's `dng_render` (exposure ramp with a quadratic toe, ACR3 default curve as a
1025-entry table), Camera Raw help pages, Adobe staff forum answers and user measurements (Russell Cottrell's Process
2012 notes) are the public record. Everything below is "Lightroom-like".

Recommended order, one pass per frame unless noted:

1. **Decode** to linear Rec.2020 f32: JPEG/HEIC/PNG through the inverse transfer function and the embedded ICC (else
   sRGB) via `moxcms`; RAW through `rawler` (black/white level, WB coefficients, demosaic, camera matrix adapted to D65).
   If a denoised intermediate exists for the current denoise settings, it replaces the decode.
2. **White balance**: Kelvin and tint → chromaticity by the Robertson method (31-row table, mired interpolation, tint
   along the isotherm normal; Lightroom ranges 2000–50000 K, tint −150..150), then a von Kries scale in CAT16 LMS. For
   non-RAW input Lightroom uses incremental temperature and tint (−100..100); map them to a mired shift around 6500 K.
3. **Exposure**: `rgb *= 2^EV`.
4. **Local pre-passes** (cached per frame, recomputed only when the image or the radii change): luminance `Y`, a guided
   filter base of `log2(Y)` at a clarity-sized radius, and two Gaussians for texture and sharpening. Radii are given at
   a 1080 px short-side reference.
5. **Highlights / Shadows**: weights `smoothstep` over the *base* luminance (not the pixel's own), so texture inside a
   highlight survives while its level is compressed; shadows lift with a `t·(1−t)^k` shape.
   **Whites / Blacks**: end-point stretch with a quadratic toe (the DNG SDK `exposure_ramp` shape: blacks moves the left
   end with the right fixed, whites the reverse).
6. **Contrast**: on `Y` as a power about a 0.18 fulcrum (`Y' = f·(Y/f)^(1+c)`), with RGB rescaled by `Y'/Y` so hue and
   chroma stay put.
7. **Clarity**: amplify `log2(Y) − base`, shaped by `d / (1 + (d/s)²)` to tame halos, gated out of the noise floor and
   near white; midtone-weighted. **Texture**: a band-pass `blur(σ≈1.5) − blur(σ≈6)` on luminance with a gain (Adobe
   describes Texture as the mid-frequency band between sharpening and clarity). **Dehaze**: dark-channel prior
   (He et al.), transmission from the guided-filtered dark channel, `J = (I − A)/max(t, t0) + A`; negative values mix
   toward `A`. **Sharpening**: two-scale unsharp mask on luminance; Detail mixes the fine and the coarse term; Masking is
   a smoothed Sobel magnitude threshold; Alt-drag shows the mask.
8. **Colour in Oklab/OKLCH**: colour mix as eight normalised Gaussian hue bands (centre/width in degrees, starting
   table: red 358/35, orange 25/45, yellow 60/40, green 115/90, aqua 180/60, blue 225/60, purple 280/55, magenta
   330/50) rotating `h`, scaling `C` and `L`; saturation scales `C`; vibrance scales `C` by `(1 − C_norm)^1.25` with a
   soft skin-hue dampener; gamut-map by reducing chroma, never by clipping channels.
9. **Display transform**: a fixed default look (sigmoid with mid-grey 0.18 → about 0.46 encoded) that users can switch
   off, then the **parametric curve** (four raised-cosine bump weights between the split points added to the identity,
   clamped monotone) and the **point curves** (Fritsch–Carlson monotone cubic Hermite through the points, baked to a
   4096-entry LUT per channel per frame).
10. **Output**: Rec.2020 → sRGB (or Display P3) matrix and transfer function, dither, encode, tag with the profile.

Per-pixel operators (2, 3, 5 whites/blacks, 6, 8, 9, 10) are cheap and re-run on every slider change. Local operators
(5 highlights/shadows base, 7, denoise, mask feathering) depend on neighbourhoods, so they must scale their radii with
resolution and need overlap when tiling. A 40 px reference σ on a 6000 px image is about 220 px σ, so either the
overlap is large or the low-frequency base is computed at reduced resolution and upsampled, which is what the guided
filter's coarse stage does.

Masks: composite each mask to one R8 layer at the working resolution. Linear-ish sliders (exposure, temperature,
tint, saturation, clarity, dehaze, texture, sharpness) blend their *parameters* per pixel before the pass; curves and
colour grading render per mask and mix by mask value. Luminance and colour range masks read the **input** image so
they do not move while dragging.

### 4.3 GPU and transport

- `wgpu` 30.0.1 (Aug 2026) on Metal; compute shaders in WGSL; `rgba16float` storage textures for intermediates,
  `rgba32float` only for accumulators; readback through `copy_texture_to_buffer` with 256-byte row alignment and
  `map_async`. RapidRAW pinned wgpu 29 because of a Display P3 shift when *presenting* through a wgpu surface; that
  does not apply when bytes are returned instead. `rust-gpu` is not production ready; `metal-rs` is deprecated in
  favour of `objc2-metal`; going Metal-only would gain MPS kernels but cost portability and a second shader language.
- CPU fallback: `rayon` over rows, `wide` for stable-Rust SIMD (`std::simd` is still nightly). The CPU path is the
  reference the GPU path is tested against.
- Transport: `tauri::ipc::Response::new(bytes)` from an `async` command (Tauri warns that large JSON returns are slow
  and points at `Response`); a 1600 px JPEG at quality 85 is a few hundred KB and encodes in a few milliseconds with
  turbojpeg. A custom URI scheme protocol is the alternative for `<img src>` with caching; a native wgpu surface under a
  transparent webview is what RapidRAW does and is overkill here.
- WebGPU inside Tauri's WKWebView: Safari 26 ships it and it is on by default on macOS 26, but exposure in WKWebView is
  *unverified* and macOS 15 (this machine) does not have it. WebGL2 with half-float render targets works, but a
  TypeScript preview pipeline would mean two implementations of the same maths in two languages that must match to the
  pixel. Keep one Rust pipeline; revisit only if measured latency is unacceptable.

### 4.4 RAW decoding

| Option | Status | Licence | Notes |
| --- | --- | --- | --- |
| `rawler` 0.8.0 (dnglab) | Aug 30, 2026, active | LGPL-2.1 | About 870 models incl. CR3 and X-Trans; `imgop/develop.rs` does rescale, demosaic (PPG for Bayer, bilinear for X-Trans), white balance, camera matrix with Bradford adaptation to D65; use `develop_intermediate` for linear f32 |
| `rawloader` 0.37 | Aug 2026 | LGPL-2.1 | rawler's ancestor, Bayer only, no metadata |
| `zenraw` 0.2 | Apr 2026 | AGPL-3.0 or commercial | Wraps the above; licence rules it out |
| `libraw-sys` / `libraw-rs` | 2015 / LibRaw 0.20 | MIT bindings, LibRaw LGPL or CDDL | Stale bindings, needs the C library |
| Apple `CIRAWFilter` via `objc2-core-image` | macOS 12+ | Apple | Linear float output in extended linear sRGB; covers ProRAW; RapidRAW's `apple_raw.rs` is a complete worked example |

Lightroom "process versions" (PV2012 = 6.6/6.7, 10.0, 11.0, 15.4 current) are a Lightroom-only concept; the DNG spec
carries `BaselineExposure`, colour matrices and `ProfileToneCurve` instead. Without a camera profile, a decent default
is: black/white level → WB → demosaic → camera matrix interpolated by CCT and adapted to D65 → Rec.2020 →
`BaselineExposure` → the default display look. darktable applies no base curve by default and so looks flatter than
Lightroom; most of the visible difference is tone curve plus baseline exposure.

### 4.5 Colour management

Linear Rec.2020 D65 as the working space; sRGB and Display P3 outputs are a 3×3 matrix plus a transfer function.
ICC is needed only for embedded input profiles and tagged or soft-proofed output: `moxcms` 0.9.1 (BSD-3 or Apache-2.0,
pure Rust, SIMD) or `lcms2` 6.2 as the mature fallback. WKWebView colour-manages tagged images and treats untagged
canvases as sRGB, so: render in the output space in Rust, embed the profile, show it in an `<img>`, and never apply CSS
filters or re-encode in JS. Published JPEGs are tagged the same way, so the viewer matches the editor.

### 4.6 Lightroom XMP

Reading `crs:` is feasible: field names, types and ranges are documented by Exiv2 and ExifTool (`Exposure2012`,
`Contrast2012`, `Highlights2012`, `Shadows2012`, `Whites2012`, `Blacks2012`, `Clarity2012`, `Texture`, `Dehaze`,
`Vibrance`, `Saturation`, `Temperature`, `Tint`, `IncrementalTemperature`/`IncrementalTint`, `ToneCurvePV2012[Red|Green|Blue]`
as 0..255 point pairs, the parametric fields and splits, the 24 `{Hue,Saturation,Luminance}Adjustment<Band>` fields,
`Sharpness`/`SharpenRadius`/`SharpenDetail`/`SharpenEdgeMasking`, `LuminanceSmoothing`, `ColorNoiseReduction`).
LightCraft's interop doc gives a tested mapping (local exposure is a fraction × 4 EV, most local values −1..1 × 100,
skip packets with `AlreadyApplied="True"`). Masks live in `MaskGroupBasedCorrections` with gradient, circular, paint,
range and `Mask/Image` components; AI mask rasters are **not** in the XMP but in an undocumented `.acr` sidecar
(reported to be a container of JPEG XL rasters, *unverified*). Every open importer drops them. Writing `crs:` is
structurally possible but the rendering will differ because Adobe's maths and DCP look tables are proprietary.

### 4.7 Local inference runtime

| Runtime | Version | macOS GPU/ANE | Windows GPU | Adding a model | Bundle cost | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `ort` | 2.0.0-rc.13 (Jul 28, 2026), ORT 1.28, MIT/Apache | CoreML EP (ANE + GPU), WebGPU/Metal experimental | DirectML, WebGPU; CUDA too large | Drop in an ONNX file | 9.2 MB compressed static library for `aarch64-apple-darwin+coreml`; estimated 20–40 MB in the binary (*unverified*) | **Use** |
| `candle` | 0.11.0 (Jun 2026) | Metal, GPU only | CUDA only | Hand-port each model in Rust; no denoisers ported | Small | No |
| `tract` | 0.23.8 (Sep 2026) | CPU SIMD, new Metal runtime | CPU | ONNX, 33% of the backend scoreboard | Small | CPU fallback only if `ort` size bites |
| `burn` + `burn-onnx` | 0.22 / 0.21 | wgpu | wgpu, CUDA | Build-time codegen, many skipped ops | Small | No |
| `tch-rs` | 0.26 (libtorch 2.13) | MPS | CUDA | TorchScript | Hundreds of MB | No |
| Core ML direct (`coreml-native` 0.2, `objc2-core-ml` 0.3) | Sep 2026 | ANE + GPU, full control | None | `.mlpackage` via coremltools 9 (PyTorch only, ONNX frontend removed) | None | Per-model escape hatch on macOS when the ORT EP partitions badly |
| `wonnx` | archived May 2025 | | | | | Dead |

CoreML EP pitfalls to design around: every unsupported op splits the graph into CoreML and CPU islands (an 18-partition
ResNet ran 8× slower than a 1-partition one; reflect `Pad`, `QuickGelu` fusion and int8 ops are common culprits), so
run `with_profile_compute_plan` once per model and count partitions, use optimisation level 1, prefer `MLProgram`, keep
inputs static (`RangeDim` kicks a model off the Neural Engine, one report measured 10× slower), set a model cache
directory (Core ML compilation can take minutes and the cache is keyed on model metadata), and expect one or two
warm-up runs. Published Apple-silicon numbers: Depth Anything V2 Small 518 px in 25–33 ms on the ANE, DETR semantic
segmentation 15 ms, SkyWater-Seg about 3 ms, BiRefNet_lite about 4.3 s on CPU-only ORT on an M1 Max (CoreML not
measured), RMBG-2.0 Core ML 3–5 s at 1024 px on an M1 Pro, NAFNet-width32 23.6 ms per 256² tile on an M4 Max via
WebGPU, GraXpert denoise 314 s on ORT CPU vs 46 s native Core ML on an M4 Air.

### 4.8 Masking models

Only permissively licensed weights with ONNX available or exportable. Sizes are from the Hugging Face file trees.

| Task | Primary | Fallback / upgrade | Notes |
| --- | --- | --- | --- |
| Subject (no prompt) | **BiRefNet_lite** ONNX, MIT, 115 MB fp16, 1024 px | BiRefNet full (MIT, 490 MB fp16) for quality; U²-Netp (Apache, 4.7 MB, 320 px) for instant previews | RMBG-2.0 is better but CC BY-NC; BEN2 Base is MIT with a muddled licence history |
| Background | Invert the subject mask | SkyWater-Seg background class | |
| Sky | **SkyWater-Seg** (SegFormer MiT-B2 trained from scratch), MIT, 48 MB fp16, 384 px, sky IoU 92% | xiongzhu666 skyseg U²-Net (MIT) | NVIDIA's SegFormer ADE20K weights are non-commercial |
| People | **RT-DETR** person boxes (Apache-2.0) → SAM 2.1 tiny box prompts | SkyWater-Seg person class; `u2net_human_seg` | YOLO is AGPL, SCRFD and Sapiens v1 non-commercial |
| Hair-accurate portrait matte | **BiRefNet-matting** / HR-matting ONNX (MIT, trimap-free) | MODNet (Apache, 13 MB fp16, 512 px short side) for speed; ViTMatte-S with an auto trimap for best edges (Composition-1k dataset terms need checking) | MatAnyone is non-commercial, RVM is GPL |
| Click and box refinement | **SAM 2.1 Hiera-tiny** ONNX (Apache, 67 MB fp16 encoder + 21 MB decoder, 1024 px; use the Geo-IA re-export if mask-input refinement is needed) | MobileSAM or EfficientSAM-Ti (Apache, 25–45 MB); SAM 2.1 small/base+ for quality | EdgeSAM is fastest on Apple hardware but S-Lab non-commercial; SAM 3 (Nov 2025) adds text prompts under a custom gated "SAM License" with a 935 MB fp16 encoder: later, if ever |
| Depth range | **Depth Anything V2 Small** ONNX (Apache, 49.6 MB fp16, 518 px, multiple of 14) | Depth Anything 3 small/base (Apache) | V2 Base/Large and Depth Pro are non-commercial |

"Select subject" with no prompt is a saliency model, not SAM's automatic mask generator (which returns every object
after dozens of decoder passes). Masks are refined against the image with a guided filter so edges snap, then upsampled
to the working resolution.

### 4.9 Denoising models and pipeline

| Model | Licence | Size | SIDD PSNR | ONNX | Fit |
| --- | --- | --- | --- | --- | --- |
| **NAFNet-SIDD-width32** | MIT | about 63 MB fp16 | 39.97 dB | ailia export, LiteRT card; spandrel loads the `.pth` | Primary: best speed for quality, trained on 256 px patches |
| NAFNet-SIDD-width64 | MIT | 464 MB fp32 | 40.30 dB | Qualcomm AI Hub (fixed 256²) | "High quality" optional download |
| **SCUNet** `color_real_psnr` | Apache-2.0 | 72 MB | none published (blind, synthetic training) | community fixed-512 export | Fallback: degrades gracefully on JPEG and web images where SIDD models over-smooth |
| DRUNet | MIT | 131 MB | Gaussian only | export needed | Only permissive model with a built-in strength (σ map), but Gaussian-trained |
| KBNet_s | MIT | 57.8 GMAC | 40.35 dB | spandrel only | Weights not clearly published |
| Restormer | MIT | 26M params | 40.02 dB | none | Slow attention; spandrel wrongly lists it as restrictive |
| Uformer-B | MIT | 50.9M | 39.89 dB | spandrel | 128 px window padding |
| MIRNet-v2, PromptIR | Academic | | | | Non-commercial, avoid |
| SwinIR denoise | Apache | | Gaussian only | | No real-noise checkpoint |
| MambaIR | Apache | | 39.89 dB | | Needs CUDA kernels, not exportable |

Pipeline (an explicit "Denoise" action, like Lightroom's Enhance, not a live slider):

1. Decode the full-resolution source to sRGB-encoded f32 (the models are trained on sRGB).
2. Reflect-pad to a multiple of 16, tile at 512 px with 32–64 px overlap, run the fixed-shape fp16 model per tile
   through the CoreML EP (one `Session` per tile size), blend with a raised-cosine window normalised by accumulated
   weight (chaiNNer's crossfade is the reference implementation).
3. Convert input and output to Oklab and blend per channel: `L = lerp(L_in, L_out, luminance)`,
   `ab = lerp(ab_in, ab_out, chroma)`. This is what darktable's profiled denoise (Y0U0V0 curves), OpenCV's coloured
   NLM (separate `h` for L and ab) and Lightroom's Luminance/Colour sliders amount to; chroma can run near 1.0, luminance
   lower to keep grain. No single model gives both strengths natively.
4. Luminance-only unsharp mask with an edge mask after the blend (RawTherapee's capture sharpening and darktable's
   diffuse module both warn to denoise before sharpening; model-based deblur targets motion blur and is overkill).
5. Write a 16-bit PNG intermediate keyed by `(hash, model, model version, luminance, chroma, sharpen)`; the develop
   pipeline uses it as its input. Preview during tuning on a 512×512 crop at 100%, as Lightroom does.

Memory: NAFNet-width64 on a whole 2048² fp16 image would need several GB in ORT; a 576² padded tile peaks at a few
hundred MB plus 232 MB of fp16 weights. A 24 MP image is roughly 100 tiles; at a plausible 50–150 ms per tile on CoreML
(*unverified*, no Mac numbers exist for NAFNet) that is 5–15 s with progress, which is acceptable for an explicit
action.

For comparison: Lightroom Denoise is RAW-only, joint demosaic and denoise, default amount 50, folded into the Detail
panel since 14.4 (June 2025); DxO DeepPRIME XD3 reached Bayer in March 2026. Raw-domain denoisers (PMRID Apache, ELD
MIT, LED, RawNIND) become relevant only after D6 adds RAW.

### 4.10 Model distribution and licensing

- Download with a thin `reqwest` client: `Range` resume into a `.part` file, SHA-256 against a pinned manifest in the
  repo (`crates/develop/models.toml`: name, version, URL, size, hash, licence), a Tauri event for progress, offline
  detection, into `<appdata>/models/`. `hf-hub` 1.0 (Jul 2026) has no resume (issue #196 open) and retries only headers
  (issue #229); 0.5 works but imposes the Hub's blob and snapshot layout.
- ONNX files above 2 GB use external data files that must travel together; none of the chosen models do.
- Ship nothing by default; the first use of a mask or denoise prompts to download that model (sizes shown), under a
  Settings page that lists models, licences, sizes, and a delete button.

Licence table for the models considered (commercial use means "someone can ship a build of this MIT app"):

| Permissive (ok) | Non-commercial or copyleft (do not ship) |
| --- | --- |
| BiRefNet and variants (MIT), InSPyReNet (MIT), U²-Net (Apache), MODNet (Apache), MobileSAM, EfficientSAM, SAM 2/2.1 (Apache), RT-DETR (Apache), SkyWater-Seg (MIT), Depth Anything V2 Small and DA3 small/base (Apache), NAFNet (MIT), SCUNet, SwinIR (Apache), DRUNet/DPIR (MIT), KBNet, Uformer, Restormer (MIT), Real-ESRGAN (BSD-3), BEN2 Base (MIT, with caveats), biubug6 RetinaFace (MIT), Mask2Former code (MIT) | RMBG-1.4 and RMBG-2.0 (BRIA, NC), NVIDIA SegFormer weights (NC), EdgeSAM and MatAnyone (S-Lab NC), Depth Anything V2 Base/Large (CC BY-NC), Apple Depth Pro (research only), Sapiens v1 (CC BY-NC), MIRNet-v2 and PromptIR (academic), Ultralytics YOLO (AGPL), RobustVideoMatting (GPL-3), InsightFace SCRFD weights (NC), Noise2Noise (CC BY-NC), SAM 3 (custom gated licence, acceptable but review it) |

### 4.11 Geometry: crop, straighten, perspective

**What Lightroom does** (Adobe help pages, Camera Raw wording): Upright has five modes. Level corrects horizontal
tilt only; Vertical applies level plus vertical convergence; Full applies level, vertical and horizontal; Auto applies
"a balanced set" that preserves as much of the image as possible; Guided takes two to four user-drawn lines in the
combinations 2H, 2V, 2H+2V, 2H+1V, 2V+1H, 1V+1H (anything else is an invalid configuration). Adobe recommends a lens
profile before Upright and caches the analysis until "Update" is clicked. Selecting an Upright mode resets the crop and
the manual Transform sliders (Alt preserves them); the sliders (Vertical, Horizontal, Rotate, Aspect, Scale, X and Y
Offset) refine the result afterwards. "Constrain Crop" trims the blank corners to the original aspect and re-applies
on every change. The Crop tool has aspect presets, a lock, an Angle slider (−45..45), an Auto button that performs a
level, drag-outside-the-frame rotation, a straighten ruler, cycling overlays (grid, thirds, diagonal, triangle,
golden ratio, spiral), X to swap orientation, and "Constrain to Image" when Transform leaves transparent corners. Slider
numeric ranges (Rotate −10..10, Scale 50..150, the rest −100..100) and the Vertical slider's sign are *unverified*
against Adobe sources; RAWmakase's reverse engineering records the forward matrix as offset · scale · aspect ·
keystone · rotate in centred long-edge units, with Aspect as `2^(±0.137·a/100)` per axis and the sliders acting in the
recorded (pre-orientation) frame.

**Open-source lineage.** darktable's rotate-and-perspective module (2016, inspired by ShiftN) is the design every
other open-source editor copied: LSD line segments on the preview buffer (gamma 0.45, optional edge enhancement),
classified vertical or horizontal within 30° of the axis and weighted by length × width × precision; per-direction
RANSAC vanishing points (two-line hypotheses, candidates inside the frame rejected, a self-tuning epsilon aiming at a
60% elimination ratio, 400 runs); a Nelder-Mead fit (400 iterations, parameters squashed through a logit) of rotation,
vertical and horizontal lens shift and shear minimising the weighted squared deviation of warped lines from their
axis; sanity rejection when the warped area exceeds 4× the original; and automatic cropping by Nelder-Mead over a
rectangle centre and diagonal angle ("largest area" or "original format"). Right-drag along a horizon sets the rotation.
ART (2019) kept that model and added auto-crop and auto-fill; RawTherapee 5.9 (2022) ported it but replaced the lens-shift
chain with a camera model (`P · R_yaw · R_pitch · R_roll · T`, focal from EXIF × crop factor) and added control lines
with a two-per-direction minimum. All three are GPL, and the embedded LSD is AGPL: study only. LightCraft
(MIT/Apache, Sept 2026) is the permissive Rust reference: its own gradient-region-growing segment detector,
deterministic vanishing-point consensus over the 60 longest segments, Level as a weighted median rotation, Vertical as
rotating the vertical vanishing point onto the axis with a default focal, Full as a Gram-Schmidt frame from both
vanishing points with the focal from orthogonality, Auto choosing between them by thresholds (20°, 25°, 5°), Guided
from up to four lines, a hand-written DLT homography, `max_inscribed_scale` for constrain-to-image, and a single-pass
resample with a Mitchell prefilter under minification. RapidRAW has crop, straighten, flip, a transform modal and
guided perspective (vanishing points by cross products, largest inscribed crop by clipping and slab search) but no
automatic mode; it warps on the CPU with bilinear sampling before its GPU colour pass.

**Algorithms to implement.**

- *Level*: segments → fold angles to −45..45 → weighted mode (0.1° bins, Gaussian smoothing, parabolic peak
  refinement, or the doubled-angle circular mean) → confidence from the peak's share of the total weight; require a
  minimum segment count, else report "no structure". For line-poor scenes on macOS, the Vision framework's horizon
  request (macOS 10.13+) returns an angle for free and ships with the OS.
- *Vanishing points*: two-line hypotheses, inliers by the distance from the vanishing point to the line through each
  segment's midpoint (Tardif's pixel-meaningful criterion, capped at about 2 px), refinement by weighted least squares.
- *Calibration and rectification*: with the principal point at the centre, `f = √(−v₁·v₂)` when both vanishing points
  are finite and the product is negative, else the EXIF 35 mm-equivalent or a default; columns of `R` from
  `K⁻¹v_i` normalised, third by cross product; `H = K R K⁻¹` (a conjugate rotation keeps lines straight); Vertical
  sends only the vertical vanishing point to infinity, Full both; then recentre and rescale so the centre stays put and
  the centre line keeps its length. Refine with Nelder-Mead (`argmin`) on the darktable objective, bound the warped
  area, and apply Auto's thresholds to pick Level, Vertical or Full. Degenerate cases: a vanishing point inside the
  frame (lines do not converge, no correction), at infinity (already upright on that axis), fewer than two lines per
  direction.
- *Guided*: same solver with the user's lines as the only input, weights by length; 1V+1H needs the assumed focal;
  four lines forming a quad can also go straight to a four-point DLT.
- *Manual sliders*: keystone as `K R(pitch, yaw) K⁻¹` with the slider mapped to an angle, Rotate about the centre,
  Aspect as a per-axis power of two, Scale uniform, Offsets as translations in long-edge units; one matrix, inverted
  once per render.
- *Crop*: rotated-rectangle inscribed formula for the straighten angle (half-constrained case when the short side is
  below `2·sinθ·cosθ·long`), the fixed-aspect zoom factor `p(φ) = min(a/(cosφ + sinφ/r), b/(sinφ + cosφ/r))` for
  constrain-to-image, and for the warped quad a binary search on scale about the mapped centre with point-in-polygon
  tests (darktable's Nelder-Mead and Alt-Hsu-Snoeyink's exact algorithm are the alternatives).

**Resampling**: inverse mapping from each output pixel centre; Catmull-Rom (Keys a = −½) or Mitchell (⅓, ⅓) cubic for
previews, Lanczos3 (36 taps) for export with normalised weights and clipping of the overshoot; when the Jacobian
minifies, stretch the kernel or prefilter, because a perspective warp's footprint grows toward the vanishing line.
WGSL compute shaders have no hardware bicubic: 16 or 36 `textureLoad` taps, or Sigg-Hadwiger's four-bilinear-fetch
trick for B-splines.

**Learned options** (for later, if ever): GeoCalib (ECCV 2024, Apache-2.0 code, CC BY 4.0 weights) estimates roll,
pitch, focal and distortion from one image with median roll error around 0.4° and pitch 0.9–1.9° across four
benchmarks, beating line-based methods on scenes without Manhattan structure; the official model does not export to
ONNX because of its embedded Levenberg-Marquardt solver, but a community export of the network half exists (118 MB
fp32, dynamic size in multiples of 32) with the 10–30-iteration solver reimplemented outside, which maps cleanly onto
`ort` plus a Rust solver. M-LSD-tiny (Apache-2.0, 0.6M parameters, ONNX available) is the only small permissive learned
line detector. Avoid Perspective Fields (Adobe non-commercial research licence), Deep Hough Transform (CC BY-NC), and
DeepCalib and deephorizon (no licence). Pixelmator replaced Apple's Vision horizon detector with its own model in 2024,
which suggests the classical path plus Vision is a reasonable baseline.

**Rust crates.** `imageproc` 0.27 (MIT): `Projection::from_control_points` (DLT through `nalgebra` SVD),
`warp_into_with` with a closure inverse map, bicubic sampling, `rayon` rows; `nalgebra` 0.35 for SVD and eigenvectors;
`argmin` 0.11 for Nelder-Mead; `lsdetect` 0.3 (MIT/Apache, a clean-room LSD in pure Rust with a Lanczos warp, two
weeks old and single-author: vet before depending, or port ELSED, which is Apache-2.0); `fast_image_resize` 6 for the
axis-aligned prefilter. Not `opencv` (system library, bundle cost) and not rust-cv (dormant since 2020). The
`objc2` Vision bindings for the horizon request need a crate-name check.

**XMP fields** (ExifTool, Exiv2; all "not in the XMP specification, found in sample files"): `PerspectiveUpright`
(0 off, 1 auto, 2 full, 3 level, 4 vertical, 5 guided), `PerspectiveVertical/Horizontal/Scale/Aspect` (integer),
`PerspectiveRotate/X/Y` (real), `UprightTransform_0..5` (a row-major forward homography in 0..1 coordinates of the
recorded frame, per third-party readers), `UprightFourSegments_0..3` ("x1,y1,x2,y2" guides), `UprightFocalLength35mm`,
`UprightCenterNormX/Y`, `CropTop/Left/Bottom/Right` (0..1 of the straightened frame, before orientation), `CropAngle`
(positive = clockwise per two independent importers), `HasCrop`, `CropConstrainToWarp`. Orientation is not in `crs:`
but in `tiff:Orientation`, and the Transform sliders act in the recorded frame, so a 90°-rotated photo stores
Vertical as Horizontal.

---

## 5. Architecture

```
photobook/
  Cargo.toml                 workspace: apps/editor/src-tauri, crates/develop (later crates/develop-cli)
  crates/develop/            pure Rust, no Tauri
    src/settings.rs          serde mirror of DevelopSettings; develop_hash()
    src/decode/              jpeg (turbojpeg), png, heic (sips now, ImageIO later), raw (rawler, D6), icc (moxcms)
    src/color/               rec2020, oklab, cat16, robertson temperature, curves (monotone cubic → LUT)
    src/ops/                 wb, exposure, tonal, contrast, clarity, texture, dehaze, sharpen, mix, vibrance
    src/geometry/            homography (compose, invert, DLT), orientation, manual transform, crop + inscribed
                             rectangles, warp (inverse-mapped resample, prefilter), segments (line detector),
                             vanishing points + calibration, upright solver (level / vertical / full / guided)
    src/local/               gaussian (separable), guided filter, box filter, radius scaling
    src/masks/               brush, linear, radial, range masks, composite, feather, grow
    src/cpu/                 reference pipeline (rayon)
    src/gpu/                 wgpu device, WGSL shaders, tiling, readback (D3)
    src/ai/                  ort sessions, model registry + downloader, segment, depth, denoise tiling (D4, D5)
    src/render.rs            render(input, settings, target) -> Rgba16 / Rgb8; preview and export entry points
    models.toml              pinned model manifest (name, version, url, bytes, sha256, licence)
    tests/fixtures/          settings JSON shared with packages/shared; golden images
  apps/editor/src-tauri/src/commands/develop.rs   Tauri commands + job state
  packages/shared/src/develop/schema.ts            Zod DevelopSettings, defaults, developHash()
  apps/editor/src/components/develop/              DevelopMode, panels, sliders, curve editor, mask tools
```

**Data model** (Zod sketch; the real file is the source of truth):

```ts
const Slider = (min: number, max: number, def = 0) => z.number().min(min).max(max).default(def);
export const LightSchema = z.object({
  exposure: Slider(-5, 5),       // EV
  contrast: Slider(-100, 100),
  highlights: Slider(-100, 100),
  shadows: Slider(-100, 100),
  whites: Slider(-100, 100),
  blacks: Slider(-100, 100),
});
export const WhiteBalanceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('asShot') }),
  z.object({ mode: z.literal('absolute'), temperature: z.number().min(2000).max(50000), tint: Slider(-150, 150) }),
  z.object({ mode: z.literal('incremental'), temperature: Slider(-100, 100), tint: Slider(-100, 100) }),
]);
export const CurvePoint = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
export const CurveSchema = z.object({
  parametric: z.object({ highlights: Slider(-100, 100), lights: Slider(-100, 100), darks: Slider(-100, 100),
    shadows: Slider(-100, 100), splits: z.tuple([z.number(), z.number(), z.number()]).default([0.25, 0.5, 0.75]) }),
  luma: z.array(CurvePoint).default([[0, 0], [1, 1]]),
  red: ..., green: ..., blue: ...,
});
export const HUE_BANDS = ['red','orange','yellow','green','aqua','blue','purple','magenta'] as const;
export const ColorSchema = z.object({
  vibrance: Slider(-100, 100), saturation: Slider(-100, 100),
  mix: z.record(z.enum(HUE_BANDS), z.object({ hue: Slider(-100, 100), saturation: Slider(-100, 100), luminance: Slider(-100, 100) })),
});
export const DetailSchema = z.object({
  clarity: Slider(-100, 100), texture: Slider(-100, 100), dehaze: Slider(-100, 100),
  sharpen: z.object({ amount: Slider(0, 150, 40), radius: Slider(0.5, 3, 1), detail: Slider(0, 100, 25), masking: Slider(0, 100) }),
  denoise: z.object({ model: z.enum(['nafnet-w32', 'nafnet-w64', 'scunet']), luminance: Slider(0, 100, 50),
    chroma: Slider(0, 100, 75), sharpen: Slider(0, 100, 25) }).nullable().default(null),
});
const Point = z.tuple([z.number(), z.number()]);                 // fractions of the transformed, uncropped image
export const GuideSchema = z.object({ id, kind: z.enum(['vertical', 'horizontal']), from: Point, to: Point });
export const GeometrySchema = z.object({
  /** User rotation and flips on top of the EXIF orientation. */
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  flipH: z.boolean().default(false), flipV: z.boolean().default(false),
  upright: z.object({
    mode: z.enum(['off', 'auto', 'level', 'vertical', 'full', 'guided']).default('off'),
    guides: z.array(GuideSchema).max(4).default([]),
    /** Row-major forward homography in 0..1 coordinates of the oriented image, stored by the analysis (like
     *  Lightroom's UprightTransform_N) so renders never re-run line detection; null until analysed. */
    transform: z.array(z.number()).length(9).nullable().default(null),
    /** Focal length in long-edge units the analysis assumed (EXIF 35 mm-equivalent or the 28 mm default). */
    focal: z.number().positive().nullable().default(null),
  }).prefault({}),
  /** Manual Transform sliders, applied after Upright. */
  transform: z.object({ vertical: Slider(-100, 100), horizontal: Slider(-100, 100), rotate: Slider(-10, 10),
    aspect: Slider(-100, 100), scale: Slider(50, 150, 100), offsetX: Slider(-100, 100), offsetY: Slider(-100, 100) }).prefault({}),
  /** Keep the crop inside the warped image: recompute the largest inscribed rectangle after every geometry change. */
  constrainCrop: z.boolean().default(true),
  crop: z.object({
    /** Fractions of the transformed, uncropped image. */
    rect: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }),
    /** Straighten angle in degrees, about the crop centre, positive clockwise. */
    angle: Slider(-45, 45),
    aspect: z.union([z.literal('free'), z.literal('original'), z.tuple([z.number().positive(), z.number().positive()])]).default('free'),
  }).nullable().default(null),
});
export const MaskComponentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('brush'), strokes: z.array(StrokeSchema) }),          // points as image fractions
  z.object({ kind: z.literal('linear'), from: Point, to: Point }),
  z.object({ kind: z.literal('radial'), center: Point, radii: Point, angle: z.number(), feather: Slider(0, 100, 50) }),
  z.object({ kind: z.literal('luminance'), range: z.tuple([z.number(), z.number()]), feather: Slider(0, 100) }),
  z.object({ kind: z.literal('color'), samples: z.array(z.string()), tolerance: Slider(0, 100, 50) }),
  z.object({ kind: z.literal('ai'), target: z.enum(['subject','background','sky','people','depth']),
    model: z.string(), modelVersion: z.string(), prompts: z.array(PromptSchema).default([]),
    depthRange: z.tuple([z.number(), z.number()]).optional() }),
]).and(z.object({ id, mode: z.enum(['add','subtract','intersect']).default('add'), invert: z.boolean().default(false) }));
export const MaskSchema = z.object({
  id, name: z.string(), enabled: z.boolean().default(true), invert: z.boolean().default(false),
  opacity: Slider(0, 100, 100), feather: Slider(0, 100), components: z.array(MaskComponentSchema).min(1),
  adjustments: LocalAdjustmentsSchema,   // the Lightroom subset: light, wb, clarity, dehaze, texture, saturation, sharpness, noise, hue, color
});
export const DevelopSchema = z.object({
  version: z.literal(1),               // develop settings version, independent of the book version
  light: LightSchema.prefault({}), whiteBalance: WhiteBalanceSchema.default({ mode: 'asShot' }),
  curve: CurveSchema.prefault({}), color: ColorSchema.prefault({}), detail: DetailSchema.prefault({}),
  geometry: GeometrySchema.prefault({}),
  masks: z.array(MaskSchema).default([]),
});
```

Brush strokes and prompts are vectors in the JSON (small, undoable); AI mask rasters and denoised intermediates are
**cache**, never source of truth, stored under `<appdata>/cache/<hash>/develop/` and regenerated from the model id,
version and prompts when missing. `developHash(settings)` = SHA-256 of `canonicalJson(settings)` plus the engine
version string; the same function exists in TS (for cache lookup and the publish fingerprint) and Rust (for file
names), with a parity test.

**Preview flow** (one slider drag):

1. The slider updates `book.assets[id].develop` through a store action wrapped in zundo's pause/resume so one drag is
   one undo step (the pattern `pauseDepth` in `store/book.ts` already supports).
2. A debounced (about 16 ms) `render_preview(folder, relPath, hash, settings, job)` command returns JPEG bytes; jobs
   are numbered and a newer job cancels older ones, like `hash_files`.
3. The Develop view swaps the `<img>` source to a blob URL. The canvas behind it is untouched until the drag ends.
4. On pointer up (or 300 ms idle) the editor calls `render_cached(…)`, which writes `proxy-<developHash>.jpg` and
   `thumb-<developHash>.jpg` and returns their paths; the assets store records them and the resolver picks them up, so
   the canvas and filmstrip update.
5. The Rust side keeps the decoded linear proxy, the warped and cropped working image and the local pre-passes for
   the current asset in memory, so a per-pixel slider costs one pass. A geometry change re-warps from the decoded
   proxy (one resample) and invalidates the pre-passes; a crop-only change without constrain or angle is a re-framing
   of the same warp.

**Geometry flow**: the Upright buttons and the crop tool's Auto run an *analysis* command on the proxy
(`analyse_geometry(…) -> { transform, focal, lines, confidence }` in a few hundred milliseconds), whose result is
written into the settings (`upright.transform`, or `crop.angle`) like any slider change, so undo, copy and sync work
and renders never depend on the detector. Guides are vectors in the settings; dragging a guide re-solves on the fly.
Constrain-to-image recomputes `crop.rect` in the store from the composed homography, with the same pure function in
TS (for the overlay) and Rust (for the render), covered by the parity fixtures.

**Export and publish flow**: `render_full(assetIds, job)` decodes each source at full resolution (or its denoised
intermediate), renders through the same pipeline (tiled on the GPU in D3, whole-image on the CPU in D1), copies the
EXIF APP1 segment from the source, writes `<sourceFolder>/.photobook-cache/develop/<hash>-<developHash>.jpg` (book v8: the asset's folder in `folders`) atomically,
and emits progress. The publish command runs it for every used asset first; `freeze.ts` substitutes those paths; sharp
does what it does today. Unused renders are pruned by the existing cache maintenance.

---

## 6. Phases and steps

### Phase D1: Global develop on the CPU

#### Step D1.1 Schema, hash and parity

**Build**

- `packages/shared/src/develop/schema.ts` with the Zod schema from section 5, `DEVELOP_DEFAULTS`, `isDefaultDevelop`,
  `developHash(settings)` (reuses `canonicalJson` and `sha256Hex` from `publish/`).
- `AssetSchema.develop` optional; `CURRENT_VERSION = 6`; a `case 5` in `migrate.ts`; tests in `migrate.test.ts`.
- Root `Cargo.toml` workspace; `crates/develop` with `settings.rs` (serde, `#[serde(default)]` everywhere, same
  defaults) and `develop_hash()` using the same canonicalisation. Fixtures in `crates/develop/tests/fixtures/*.json`
  are generated by a Vitest test in shared and asserted equal by a Rust test, including the hash.
- `publishableContent` includes each used asset's `develop` (left out when undefined, so old fingerprints hold).

**Check**: `pnpm typecheck`, `pnpm --filter @photobook/shared test` and `cargo test -p photobook-develop` all pass; a
book with no develop data round-trips to an identical fingerprint.

#### Step D1.2 Decode to linear and the colour core

**Build**

- `decode/`: JPEG through turbojpeg (full or DCT-scaled, as today), PNG through `image`, HEIC through the existing
  `sips` pre-step; sRGB inverse EOTF; embedded ICC through `moxcms` when present; output `Image<f32>` in linear
  Rec.2020 with upright orientation applied.
- `color/`: Rec.2020 ↔ XYZ ↔ sRGB and P3 matrices, Oklab and OKLCH, CAT16 adaptation, Robertson temperature table,
  monotone cubic curves baked to LUTs. Unit tests against published reference values (sRGB white, Oklab examples,
  D65 → D50 adaptation).
- `ops/`: white balance, exposure, whites/blacks, contrast (power about the fulcrum on Y), colour mix, vibrance,
  saturation, parametric and point curves; each a pure function on a row of pixels with a `Params` struct.
- `cpu/`: the reference pipeline in the section 4.2 order, `rayon` over rows, highlights/shadows in this step using a
  cheap separable Gaussian base (the guided filter arrives in D3 with the other local operators).
- `render.rs`: `render_preview(image, settings, long_edge) -> Vec<u8>` (JPEG) and `render_full(...) -> Rgb8` with the
  output transform to sRGB and an embedded profile.

**Check**: golden-image tests on three fixtures (a neutral grey ramp, a saturated chart, a real photo); every slider at
its default is a no-op within one 8-bit level; exposure +1 EV doubles linear values; a 24 MP full render finishes in a
few seconds on the CPU.

#### Step D1.3 Tauri commands, cache and resolver

**Build**

- `commands/develop.rs`: `render_preview`, `render_cached`, `render_full`, `cancel_develop`; a `DevelopJobs` state
  holding the current asset's decoded proxy and pre-passes, a job counter and a semaphore like `AssetJobs`.
- Cache layout: `<appdata>/cache/<hash>/proxy-<developHash>.jpg`, `thumb-<developHash>.jpg`;
  `<sourceFolder>/.photobook-cache/develop/<hash>-<developHash>.jpg` for full renders. All through `ensure_allowed`.
  (Book v8 replaced `sourceFolder` with `folders`; the render goes in the asset's own folder.)
- `lib/tauri.ts` wrappers; `store/assets.ts` gains `developed` urls and the `renderDeveloped` action;
  `makeResolver` prefers the developed variant when the asset has a non-default `develop` and the file exists.
- `prepare_asset` stays the source of the source proxies; stale developed files are deleted when a newer hash is
  written for the same asset (keep the last two for undo responsiveness).

**Check**: edit an asset's `develop` in the store by hand, see the canvas and filmstrip switch to the developed
files, relaunch, see them again without a re-render.

#### Step D1.4 Develop view

**Build**

- `/book` overlay `DevelopMode` reusing the Review shell: large image centre (the live preview `<img>` over the cached
  proxy, with a Before/After toggle on `\`), neighbour strip at the bottom, right panel with collapsible sections in
  this order: **Basic** (white balance mode and sliders, Light), **Curve** (parametric sliders and a point-curve editor
  with channel tabs), **Color** (vibrance, saturation, colour mix with the eight bands and hue/sat/lum tabs). Detail and
  Masks sections appear in D3 and D4.
- Sliders: double-click resets, Shift drags fine, arrow keys nudge, numeric input on click; section reset and
  whole-photo reset; copy and paste settings (`Cmd+Shift+C/V`) between photos; keyboard stepping through the strip
  keeps the panel open.
- Open from the filmstrip (`D` or context menu), from Review (`D`), and from the inspector's photo section
  ("Develop…"). The inspector shows a small "Edited" badge and a reset action on edited photos.
- Dev log lines (`[photobook:develop]`) for render timings, since Tauri windows cannot be screen-captured in agent
  sessions.

**Check**: dragging exposure updates the preview continuously (log shows under 50 ms per render on the proxy), each
drag is one undo step, closing and reopening the book restores the sliders, the filmstrip thumbnail shows the edit.

#### Step D1.5 Publish integration

**Build**

- `run_publish` renders every used asset with a non-default `develop` whose full render is missing or stale, streaming
  progress lines into the publish panel before the CLI starts; cancel aborts both.
- `freeze.ts` substitutes the render path (and keeps `hash` for the asset id → key mapping); `outDir` keys on
  `<hash>-<developHash>`; missing render is a clear error that names the photo and says to open the editor.
- The CLI's `--dry-run` reports which assets are developed and whether their renders are current.
- `UnpublishedBadge` lights up after an edit (fingerprint change from D1.1).

**Check**: publish a book with one edited photo; the viewer shows the edit at every ladder size and in the download;
republishing with no change uploads nothing; editing again flips the badge.

#### Phase D1 definition of done

A real trip folder: pick ten photos, fix exposure and white balance on each, pull highlights on skies, warm a few, add
contrast through the curve; the book canvas, filmstrip, preview mode and the published viewer all show the edited
photos; quit and relaunch keeps everything; undo walks back through the drags.

### Phase D2: Geometry

Crop and straighten are what every photo needs, so D2.1 should ship right after D1; D2.2 and D2.3 can land any time
after.

#### Step D2.1 Orientation, crop and straighten

**Build**

- `geometry/`: 3×3 homography type (compose, invert, apply, DLT from four points, tests against `imageproc`'s
  `Projection`), orientation and flip matrices, the straighten rotation about the crop centre, the inscribed-rectangle
  formulas (rotated rectangle, fixed aspect in a rotated rectangle, binary search in a convex quad), and `warp`:
  inverse-mapped resample into a target size with Catmull-Rom for previews and Lanczos3 plus a Mitchell prefilter for
  export, `rayon` rows, f32 RGB. The pipeline's decode step becomes decode → warp into the crop framing → colour.
- Developed size written to the cache meta and returned through the resolver; `render_full` outputs the cropped size.
- Crop tool in the Develop view (`R`): draggable frame with handles, aspect presets (original, 1:1, 4:5, 5:7, 2:3,
  16:9, custom) and lock, `X` to swap orientation, Alt-drag from the centre, drag outside the frame to rotate, a
  straighten ruler tool (drag along a horizon), the angle slider, rotate-90 and flip buttons, overlay cycling with `O`
  (thirds, grid, diagonal, golden ratio), Return applies and Escape cancels, constrain-to-image on by default so the
  frame shrinks as the angle grows and no transparent corner is ever shown.
- Parity fixtures for the inscribed-rectangle functions (TS and Rust agree to 1e-9).

**Check**: straighten a tilted horizon by dragging along it; the crop stays inside the image at every angle; the canvas
slot re-fits the new aspect without the page layout changing; the published photo has the crop and no soft edges
compared with a crop done in Lightroom at the same size.

#### Step D2.2 Manual and guided perspective

**Build**

- `geometry/transform.rs`: the manual sliders composed into one homography (keystone as `K R K⁻¹` with the focal
  from EXIF or the default, rotate, aspect, scale, offsets), recentred and rescaled; the Transform section in the
  panel with the seven sliders, reset, and constrain crop.
- `geometry/upright.rs` guided mode: draw two to four lines on the preview (Lightroom's valid combinations; invalid
  ones show a message), endpoints draggable with a loupe, lines typed vertical or horizontal by their extent with a
  manual override; the solver sends the implied vanishing points to infinity, refines with Nelder-Mead on the
  weighted residuals, and bounds the warped area.
- Masks and guides re-mapped through `H_new · H_old⁻¹` when the perspective changes; AI mask rasters invalidated.

**Check**: two vertical guides on a building make its edges parallel to the frame within 0.2° measured on the render;
Vertical −30 and +30 visibly widen the top and the bottom respectively; a brush mask painted on a window stays on the
window after Upright changes.

#### Step D2.3 Auto level and automatic Upright

**Build**

- `geometry/segments.rs`: a clean-room line-segment detector (EDLines/ELSED-style, or `lsdetect` after vetting)
  running on a 900–1280 px luminance copy with mild edge enhancement; segments weighted by length and contrast;
  near-border segments dropped.
- `geometry/vanishing.rs`: per-direction RANSAC vanishing points with the midpoint-distance criterion, candidates
  inside the frame rejected, weighted least-squares refinement; calibration from two orthogonal points
  (`f² = −v₁·v₂`) with the EXIF or default focal fallback; `R` from the normalised directions.
- `upright.rs` automatic modes: Level (weighted angle mode with confidence), Vertical, Full, and Auto choosing among
  them by rotation thresholds and the warped-area bound; results stored as `upright.transform` plus the detected lines
  for display; the crop tool's Auto button calls Level. On macOS, the Vision horizon request as the fallback when
  fewer than the minimum segments are found.
- Panel: Off / Auto / Level / Vertical / Full / Guided buttons, an Update action when the image or the lens state
  changes, a "show structure" toggle drawing the used and rejected segments in two colours, and a confidence message
  ("no straight lines found") instead of a wrong correction.
- A fixture set (architecture, interiors, a sea horizon, a portrait, a forest) with expected outcomes: corrected,
  corrected within tolerance, or "no structure"; runtime logged in the dev log.

**Check**: Level on the fixture set is within 0.5° of a manual ruler on every image with lines and declines on the
forest; Full on a tilted-up facade produces parallel verticals and a level cornice with the crop constrained; the
analysis takes under a second on the proxy.

#### Phase D2 definition of done

A day's architecture photos are levelled and uprighted in one click each, cropped to the book's aspect with
constrain on, and the published book shows the same framing; a horizon shot is straightened by dragging along the sea.

### Phase D3: Detail operators and the GPU path

#### Step D3.1 Local pre-passes and detail operators (CPU)

**Build**

- `local/`: separable Gaussian with radius scaling, box filter, guided filter (coarse stage at a quarter resolution),
  all on `f32` luminance planes with `rayon`.
- `ops/`: clarity (guided-filter detail on `log2(Y)` with the halo shaper), texture (band-pass), dehaze (dark channel
  prior with guided transmission, sky-safe clamp), sharpening (two-scale USM, Detail mix, Masking edge mask with an
  Alt-drag visualisation), and highlights/shadows switched to the guided base.
- The Detail panel section: texture, clarity, dehaze, sharpening group.

**Check**: golden images per operator; halos on a backlit edge stay below a visible threshold at clarity +50; a
40 px reference radius on the 1600 px proxy and on a 6000 px render produce the same look side by side at fit-to-screen.

#### Step D3.2 wgpu compute pipeline

**Build**

- `gpu/`: device and queue creation (Metal; fallback to CPU when adapter creation fails, with a crash flag file so a
  GPU crash on launch is detected next time, as RapidRAW does), WGSL ports of every operator including the geometry
  warp (inverse mapping with explicit 16-tap Catmull-Rom or 36-tap Lanczos3 gathers through `textureLoad`, since
  compute shaders have no filtered sampling), `rgba16float`
  intermediates, 1D LUT textures for the curves, parameter uniform buffer, readback with row alignment stripped.
- Tiled full-resolution render: 2048 px tiles with overlap ≥ the largest kernel at that resolution; low-frequency bases
  computed once at reduced resolution and shared across tiles.
- A `cargo test` that renders the fixtures on both paths and asserts a maximum per-channel difference (target: under 2
  8-bit levels, with the known f16 caveats documented).
- Preview path uses the GPU when available; export too.

**Check**: slider drag on the proxy renders in under 8 ms on the M3 Pro (dev log), a 24 MP export in under 2 s, CPU
and GPU golden images agree within tolerance, forcing the CPU path through an env var still works end to end.

#### Phase D3 definition of done

Every Detail control works, previews and exports are indistinguishable at fit-to-screen and plausible at 100%, and
the GPU path is the default on Apple silicon with the CPU path proven by tests.

### Phase D4: Masks and AI masks

#### Step D4.1 Parametric and brush masks

**Build**

- `masks/`: rasterise linear and radial gradients, luminance and colour range (from the input image), brush strokes
  (round dabs with hardness and flow along the polyline, in fractions of the transformed, uncropped image, mapped into
  the crop framing by the affine from D2); composite by max / saturating-sub / min;
  invert; feather (Gaussian) and grow (dilate/erode) as fractions of the short side; cache by component hash.
- Pipeline: per-pixel parameter blending for the linear-ish local sliders; per-mask render and mix for curves.
- Masks panel: list of masks with visibility and overlay colour, add menu, component list with mode and invert, the
  local adjustment sliders, a red overlay toggle (`O`), brush size/feather/flow with `[` `]`.

**Check**: a radial mask darkening the corners publishes identically to the preview; luminance range stays fixed while
dragging exposure; mask overlays follow pan and zoom in the Develop view.

#### Step D4.2 ONNX Runtime and the model registry

**Build**

- `ai/runtime.rs`: `ort` with `download-binaries` and the `coreml` feature; session builder with ML Program, all compute
  units, static input shapes, a model cache dir under app data, optimisation level 1, `error_on_failure` off so CPU is
  the automatic fallback; a one-time `profile_compute_plan` log per model so partition counts are visible in the dev
  log.
- `ai/registry.rs` + `models.toml`: pinned name, version, URL, size, SHA-256, licence, input shape; the `reqwest`
  downloader with `Range` resume, `.part` files, progress events, verification; a Settings → Models page listing
  installed models with sizes and licences, download and delete.
- Build and bundle checks: binary size delta recorded, `cargo build` in the dev profile still around the current
  incremental times (the `ort` crate gets its own `opt-level` entry like the image crates).

**Check**: a hello-world session (SkyWater-Seg, 48 MB) downloads with progress, resumes after a killed download, runs
on CoreML with one partition per the compute plan log, and returns a sky mask on a fixture in a few milliseconds.

#### Step D4.3 AI mask components

**Build**

- `ai/segment.rs`: subject (BiRefNet_lite at 1024 px, letterboxed), sky (SkyWater-Seg at 384 px), background (inverted
  subject, optionally unioned with the sky mask), people (RT-DETR person boxes → SAM 2.1 tiny box prompts, one mask per
  person, merged or separate), depth (Depth Anything V2 Small at 518 px → a range component). Click-to-refine with
  SAM 2.1 point prompts (the image encoder result is cached per asset while the Develop view is open).
- Each result is refined against the image with a guided filter, upsampled to the working resolution, written as PNG
  under `<appdata>/cache/<hash>/develop/masks/<componentHash>.png`, and treated as a cache.
- Masks panel: "Select Subject / Sky / Background / People / Depth" buttons with a first-use download prompt (size and
  licence shown), a busy state, and a "regenerate" action when the model version changes.

**Check**: on a portrait fixture, Subject returns a mask that needs no manual fix at the hair line at 1600 px; People
returns one mask per person; Sky excludes a white building against a bright sky; the whole flow works offline once the
models are present; a project opened on a machine without the models shows the masks from cache and offers to
download before regenerating.

#### Phase D4 definition of done

A backlit portrait gets a brightened subject and a darkened sky with two AI masks and a brush fix, previews at
interactive speed, and publishes identically.

### Phase D5: Denoise

#### Step D5.1 Tiled inference and the luminance/chroma blend

**Build**

- `ai/denoise.rs`: fixed 512 px fp16 NAFNet-SIDD-width32 export (and an optional width64, and SCUNet as the JPEG-friendly
  fallback) with reflect padding to a multiple of 16, 48 px overlap, raised-cosine blending normalised by accumulated
  weight, one session per tile size, progress events, cancel between tiles.
- Oklab per-channel blend with the luminance and chroma strengths, then the luminance-only edge-masked USM; 16-bit
  PNG intermediate keyed as in section 4.9; the develop pipeline substitutes it for the decode.
- Export the ONNX files once from the published PyTorch weights with a documented script under `scripts/models/`
  (fixed shape, fp16, opset pinned, reflect pads decomposed if the compute plan shows CPU partitions) and host them
  under the project's own Hugging Face account with the licence files alongside.

**Check**: a 24 MP ISO 6400 JPEG denoises with progress in under 20 s on the M3 Pro (*target, unverified*), tile seams
are invisible at 200% on a flat sky, chroma blotches vanish at chroma 75 while fine grain remains at luminance 30.

#### Step D5.2 Denoise UI

**Build**

- Detail section gains a Denoise group: model picker (with download state), luminance, chroma, sharpen, a 512×512
  100% crop preview that re-runs on the crop only, an Apply button that runs the full image, and a status line that
  says when the cached intermediate is stale.
- The full render and publish paths require the intermediate to be current; otherwise they run it first.

**Check**: toggling denoise on and off is one undo step each; publishing a denoised photo ships the denoised pixels in
every variant including the download.

#### Phase D5 definition of done

A high-ISO set from a night walk is cleaned with one shared setting pasted across photos and published; the preview
crop predicted the result.

### Phase D6: RAW, colour management, interop

#### Step D6.1 RAW input

**Build**

- `decode/raw.rs` with `rawler` 0.8: `develop_intermediate` to linear camera RGB, camera matrix interpolated by CCT and
  adapted to D65, into Rec.2020; as-shot white balance solved through the matrix; `BaselineExposure`; the default
  display look on by default for RAW (switchable). macOS complement through `CIRAWFilter` for unsupported bodies and
  ProRAW. Scan, hash and proxy generation extended to RAW extensions (proxy from the embedded preview first, developed
  proxy after).
- Absolute white balance mode becomes available (Kelvin and tint from the camera multipliers).

**Check**: a set of RAW fixtures (Canon CR3, Sony ARW, Fujifilm RAF, Apple ProRAW DNG) opens, develops, exports and
publishes; the as-shot rendering is within a stop and a few hundred Kelvin of the camera JPEG.

#### Step D6.2 Colour management end to end

**Build**

- Embedded ICC profiles honoured on input (`moxcms`); output profile choice sRGB or Display P3 per book in Settings;
  previews and renders tagged; a soft-proof toggle in Develop.
- HEIC decoded at 10-bit through ImageIO (`objc2`) instead of the `sips` JPEG detour on macOS.

**Check**: a P3-tagged iPhone HEIC shows identical colour in Develop, on the canvas and in the published viewer on a
P3 display.

#### Step D6.3 Lightroom XMP import, presets, sync

**Build**

- `xmp.rs` (`quick-xml`): read `crs:` sidecars and embedded packets, map to `DevelopSettings` per the field tables in
  sections 4.6 and 4.11 (PV2012+ only; skip `AlreadyApplied`; crop rectangle and angle with the orientation remap,
  the Perspective sliders in the recorded frame, `UprightTransform_N` as the stored homography and the guides),
  report what was dropped (masks); import action in the filmstrip
  with a diff preview. Optional "Export settings as XMP" with the lossy warning.
- Presets: named `DevelopSettings` subsets stored in the app data dir, applied per photo or to a selection; the
  built-in `bw` and `fade` element filters get preset equivalents.
- Sync: copy settings to the filmstrip selection with a checkbox list of sections.

**Check**: ten Lightroom-edited JPEGs with sidecars import with the same slider values and a visibly similar look;
applying a preset to fifty photos renders their thumbnails within seconds.

#### Phase D6 definition of done

The app opens the folder a camera produced, develops RAW, imports whatever Lightroom had already done, and publishes
colour-managed output.

---

## 7. Rough sizing

Working days for one developer who knows the codebase, excluding the research already done. Tuning the look (the
"does it feel like Lightroom" loop) is where every open-source editor spends its time, so the tonal and detail steps
carry the most uncertainty.

| Step | Days | Main risk |
| --- | --- | --- |
| D1.1 schema and parity | 2 | Keeping defaults identical in two languages |
| D1.2 decode and colour core | 5 | Tonal maths tuning |
| D1.3 commands, cache, resolver | 3 | Stale-file races between the drag preview and the committed render |
| D1.4 Develop view | 5 | Curve editor and slider ergonomics |
| D1.5 publish integration | 2 | Cache keys |
| D2.1 crop and straighten | 5 | Crop tool ergonomics; resample quality on the proxy (it is already a downscale) |
| D2.2 manual and guided perspective | 5 | Slider feel versus Lightroom; mask re-mapping |
| D2.3 auto level and Upright | 7 | A clean-room line detector; wrong corrections on non-Manhattan scenes |
| D3.1 detail operators | 5 | Halos and noise amplification |
| D3.2 wgpu path | 7 | f16 precision drift against the CPU path; tiling seams |
| D4.1 parametric and brush masks | 5 | Brush feel |
| D4.2 ORT and registry | 4 | CoreML partitions; binary size; download resume |
| D4.3 AI masks | 6 | Model export quirks; mask edge quality |
| D5.1 denoise pipeline | 5 | Per-tile latency on CoreML, memory |
| D5.2 denoise UI | 2 | |
| D6.1 RAW | 6 | Demosaic quality on X-Trans; camera coverage |
| D6.2 colour management | 3 | Webview tagging edge cases |
| D6.3 XMP, presets, sync | 4 | Lightroom field quirks |
| **Total** | **81** | |

---

## 8. Risks specific to this plan

- **Look parity is approximate.** The slider names match Lightroom; the maths cannot (Adobe's is proprietary, and even
  RAWmakase, which reverse-engineers it, says "close, not exact"). Set the expectation in the UI copy and the docs,
  and keep the engine version in the develop hash so improving the maths re-renders old edits rather than silently
  changing published books (the publish fingerprint changes and the badge lights up).
- **Automatic geometry can be confidently wrong.** Vanishing-point methods assume straight structure; on forests,
  portraits or curved architecture they align to the wrong thing. Mitigated by confidence thresholds that decline
  rather than guess, a visible "structure" overlay, the warped-area bound, and Level as the default Auto on low
  confidence. GeoCalib is the upgrade path if users hit this often.
- **Geometry is upstream of everything.** Every geometry change re-warps and re-runs the colour pipe, and the preview
  warps an already-downscaled proxy (export warps the full-resolution source once). Acceptable for 1600 px, but the
  Develop view should debounce geometry drags harder than colour sliders and show the crop overlay on the current
  warp rather than re-rendering per pixel of handle movement.
- **Two pipelines (CPU and GPU) must agree.** Mitigated by golden tests with a numeric tolerance and by making the CPU
  path the reference rather than a stub.
- **ONNX Runtime bundle and build cost.** About 9 MB compressed added to the binary, more in the build; the first
  CoreML compile of a model can take minutes (mitigated by the model cache dir). If the static library proves awkward,
  `load-dynamic` with the dylib in `bundle.macOS.frameworks` so Tauri signs it is the fallback.
- **Model quality on JPEG input.** SIDD-trained denoisers can over-smooth web-sized or heavily compressed JPEGs; SCUNet
  is the fallback for exactly that case, and the luminance strength lets users keep grain.
- **Licences.** Only permissive weights ship by default and the registry records each licence; adding a model means
  adding its licence to `models.toml` and the Settings page. SAM 3 is attractive for text prompts but gated under a
  custom licence and about 1 GB; defer.
- **Disk usage.** Full-resolution renders for publish and 16-bit denoise intermediates are large (a 24 MP 16-bit PNG is
  about 100 MB). Keep only the current develop hash per asset, prune on close, and show cache size in Settings.
- **Source folders on synced drives.** `.photobook-cache/develop/` in the source folder will sync; document it and
  offer the app data dir as an alternative location in Settings.
- **Windows and Intel Macs.** `ort` rc.11 dropped Intel macOS prebuilt binaries; DirectML on Windows is "sustained
  engineering". Apple silicon first, with CPU fallbacks everywhere, is the realistic target.

---

## 9. Open questions and unverified items

- WebGPU exposure in Tauri's WKWebView on macOS 26 (only Safari is confirmed); irrelevant while the pipeline stays in
  Rust, but worth a one-line check in the app.
- Uncompressed size the static ORT library adds to the Tauri binary; measure in D4.2.
- NAFNet width32's exact parameter count and padding multiple (inferred 16 from four 2× downsamplers); SCUNet's multiple
  (inferred 64); KBNet and Uformer pretrained-weight availability.
- Any native CoreML timing for SAM 2.1 tiny and NAFNet on M-series; the plan's latency targets are targets.
- Whether Tauri 2's bundler signs dylibs placed through `bundle.resources` (only relevant with `load-dynamic`).
- rawler's PPG demosaic quality on X-Trans (bilinear only) for 1600 px proxies.
- Lightroom's `.acr` mask sidecar format (reported as JPEG XL rasters) and whether Lightroom Denoise accepts JPEG
  input in 2026 (sources still say RAW only).
- Lightroom's Transform slider numeric ranges and the sign of Vertical (tutorials only; Adobe pages were not
  fetchable), whether its crop and mask coordinates are expressed before or after Upright, and the nine-number
  layout of `UprightTransform_N` (third-party readers only).
- `lsdetect`'s quality and speed (no benchmarks published; two weeks old), and the crate name for the `objc2` Vision
  framework bindings used for the horizon fallback.
- Whether `imageproc`'s bicubic warp is fast enough on a 24 MP export without the GPU path (measure in D2.1; LightCraft
  ships CPU-only with bilinear plus a prefilter).

---

## 10. Bibliography

Reference implementations: [RapidRAW](https://github.com/CyberTimon/RapidRAW) (AGPL-3.0; `src-tauri/src/shaders/shader.wgsl`,
`gpu_processing.rs`, `mask_generation.rs`, `ai_processing.rs`, `apple_raw.rs`, `white_balance.rs`),
[LightCraft](https://github.com/storytold/lightcraft) and its [xmp-interop doc](https://raw.githubusercontent.com/storytold/lightcraft/main/docs/xmp-interop.md),
[RAWmakase](https://github.com/pch/rawmakase), darktable [source `src/iop`](https://github.com/darktable-org/darktable/tree/master/src/iop) and docs:
[pixelpipe order](https://docs.darktable.org/usermanual/5.0/en/darkroom/pixelpipe/the-pixelpipe-and-module-order/),
[color balance rgb](https://docs.darktable.org/usermanual/5.0/en/module-reference/processing-modules/color-balance-rgb/),
[tone equalizer](https://docs.darktable.org/usermanual/5.0/en/module-reference/processing-modules/tone-equalizer/),
[local contrast](https://docs.darktable.org/usermanual/5.0/en/module-reference/processing-modules/local-contrast/),
[color calibration](https://docs.darktable.org/usermanual/5.0/en/module-reference/processing-modules/color-calibration/),
[denoise (profiled)](https://docs.darktable.org/usermanual/5.6/en/module-reference/processing-modules/denoise-profiled/),
[diffuse or sharpen](https://docs.darktable.org/usermanual/5.6/en/module-reference/processing-modules/diffuse/),
[haze removal](https://docs.darktable.org/usermanual/5.0/en/module-reference/processing-modules/haze-removal/).
RawTherapee [vibrance](https://rawpedia.rawtherapee.com/Vibrance), [capture sharpening](https://rawpedia.pixls.us/capture_sharpening/),
[clarity emulation thread](https://discuss.pixls.us/t/trying-to-emulate-adobes-clarity-in-rawtherapee/11844/37).

Lightroom behaviour: [Process 2012 notes (Cottrell)](https://www.russellcottrell.com/photo/BTDZS/process2012.htm),
[Texture control (Adobe)](https://blog.adobe.com/en/publish/2019/05/14/from-the-acr-team-introducing-the-texture-control),
[Dehaze launch](https://petapixel.com/2015/06/16/dehaze-comes-to-adobe-photoshop-and-lightroom),
[Detail panel](https://helpx.adobe.com/lightroom/web/edit-photos/apply-effects/adjust-details.html),
[Denoise demystified](https://blog.adobe.com/en/publish/2023/04/18/denoise-demystified),
[masking](https://www.adobe.com/uk/products/photoshop-lightroom/masking.html), [Intersect](https://petapixel.com/2021/11/01/understanding-the-intersect-function-of-lightrooms-new-masking-tools),
[Exiv2 crs schema](https://exiv2.org/tags-xmp-crs.html), [ExifTool XMP tags](https://exiftool.org/TagNames/XMP.html),
[.acr sidecar report](https://github.com/RapidRoom/rapidroom/issues/88),
[DNG SDK dng_render.cpp](https://lxr.kde.org/source/graphics/digikam/core/libs/dngwriter/extra/dng_sdk/dng_render.cpp).

Algorithms: [Oklab](https://bottosson.github.io/posts/oklab/), [LMS, Bradford, CAT16](https://en.wikipedia.org/wiki/LMS_color_space),
[Robertson 1968 in colour-science](https://colour.readthedocs.io/en/v0.4.5/_modules/colour/temperature/robertson1968.html),
[monotone cubic interpolation](https://en.wikipedia.org/wiki/Monotone_cubic_interpolation),
[guided filter (He, Sun, Tang)](https://people.csail.mit.edu/kaiming/publications/pami12guidedfilter.pdf),
[dark channel prior](https://people.csail.mit.edu/kaiming/cvpr09/index.html),
[local Laplacian filters](https://people.csail.mit.edu/hasinoff/pubs/ParisEtAl11-lapfilters.pdf), [fast LLF](https://hal.archives-ouvertes.fr/hal-01063419),
[chaiNNer tiling](https://github.com/chaiNNer-org/chaiNNer/blob/main/backend/src/nodes/impl/upscale/auto_split.py),
[Real-ESRGAN tiling](https://github.com/xinntao/Real-ESRGAN/blob/master/realesrgan/utils.py),
[OpenCV coloured NLM](https://docs.opencv.org/modules/photo/doc/denoising.html).

Rust crates (crates.io, Oct 9, 2026): [wgpu](https://github.com/gfx-rs/wgpu/releases) 30.0.1, [rawler](https://crates.io/crates/rawler) 0.8.0 and
[supported cameras](https://raw.githubusercontent.com/dnglab/dnglab/main/SUPPORTED_CAMERAS.md), [moxcms](https://docs.rs/crate/moxcms) 0.9.1,
[lcms2](https://crates.io/crates/lcms2) 6.2.0, [palette](https://crates.io/crates/palette) 0.7.7, [imageproc](https://crates.io/crates/imageproc) 0.27.0,
[wide](https://docs.rs/crate/wide/latest) 1.7.1, [half](https://crates.io/crates/half) 2.7.1, [ort](https://crates.io/crates/ort) 2.0.0-rc.13
([releases](https://github.com/pykeio/ort/releases), [CoreML EP](https://docs.rs/ort/latest/ort/ep/coreml/struct.CoreML.html),
[prebuilt binaries](https://ort.pyke.io/misc/prebuilt-binaries), [linking](https://ort.pyke.io/setup/linking)),
[ORT CoreML EP docs](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html),
[ORT partition fix example](https://github.com/microsoft/onnxruntime/issues/28022), [ML Program vs NeuralNetwork](https://ym2132.github.io/ONNX_MLProgram_NN_exploration),
[candle](https://crates.io/crates/candle-core) 0.11.0, [tract](https://github.com/sonos/tract) 0.23.8, [burn](https://crates.io/crates/burn) 0.22.0,
[coreml-native](https://docs.rs/coreml-native) 0.2.0, [hf-hub](https://crates.io/crates/hf-hub) 1.0.0 ([resume issue](https://github.com/huggingface/hf-hub/issues/196)),
[Tauri calling Rust / `ipc::Response`](https://v2.tauri.app/develop/calling-rust/), [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/),
[WebKit Safari 26 features](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), [WebGPU status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status).

Models: [BiRefNet](https://github.com/ZhengPeng7/BiRefNet), [BiRefNet_lite-ONNX](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX),
[BiRefNet-ONNX](https://huggingface.co/onnx-community/BiRefNet-ONNX), [BiRefNet_lite on M1 Max CPU](https://dev.to/kiarina/removing-a-portrait-background-with-birefnet-onnx-on-cpu-gbj),
[SkyWater-Seg](https://huggingface.co/Realcat/skywater_seg), [SAM 2](https://github.com/facebookresearch/sam2),
[sam2.1-hiera-tiny-ONNX](https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX), [SAM 2.1 ONNX, all sizes](https://huggingface.co/vietanhdev/segment-anything-2.1-onnx-models),
[samexporter](https://github.com/vietanhdev/samexporter), [SAM 3](https://github.com/facebookresearch/sam3) and [licence](https://huggingface.co/facebook/sam3/blob/main/LICENSE),
[MobileSAM](https://github.com/ChaoningZhang/MobileSAM), [EfficientSAM](https://github.com/yformer/EfficientSAM), [RT-DETR ONNX](https://huggingface.co/OpenRAL/rskill-rtdetr_v2_r50vd-any-coco-fp16),
[MODNet ONNX](https://huggingface.co/Xenova/modnet), [ViTMatte](https://github.com/hustvl/ViTMatte), [Matte Anything](https://github.com/hustvl/Matte-Anything),
[Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) and [small ONNX](https://huggingface.co/onnx-community/depth-anything-v2-small),
[Depth Anything 3 ONNX](https://huggingface.co/SpatialHub/depth-anything-3-onnx), [ADE20K labels](https://huggingface.co/datasets/huggingface/label-files/raw/main/ade20k-id2label.json),
[NAFNet](https://github.com/megvii-research/NAFNet) ([paper](https://arxiv.org/abs/2204.04676), [width32 LiteRT card](https://huggingface.co/litert-community/NAFNet-SIDD-width32-LiteRT),
[Qualcomm width64](https://huggingface.co/qualcomm/NAFNet-DeNoise), [ailia ONNX](https://github.com/axinc-ai/ailia-models/blob/master/image_restoration/nafnet), [TLC](https://github.com/megvii-research/TLC)),
[SCUNet](https://github.com/cszn/SCUNet) ([weights mirror](https://huggingface.co/deepinv/scunet)), [DPIR / DRUNet](https://github.com/cszn/DPIR), [KBNet](https://github.com/zhangyi-3/KBNet),
[Restormer](https://github.com/swz30/Restormer), [Uformer](https://github.com/ZhendongWang6/Uformer), [spandrel](https://github.com/chaiNNer-org/spandrel),
[RapidRAW models repo](https://huggingface.co/CyberTimon/RapidRAW-Models/tree/main), [GraXpert CoreML vs ORT CPU](https://github.com/Steffenhir/GraXpert/issues/252).

Geometry: darktable [ashift.c](https://raw.githubusercontent.com/darktable-org/darktable/master/src/iop/ashift.c), [ashift_lsd.c](https://raw.githubusercontent.com/darktable-org/darktable/master/src/iop/ashift_lsd.c),
[iop_order.c](https://raw.githubusercontent.com/darktable-org/darktable/master/src/common/iop_order.c), [rotate and perspective manual](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/rotate-perspective/),
[2016 announcement](https://www.darktable.org/2016/03/a-new-module-for-automatic-perspective-correction/); RawTherapee [perspectivecorrection.cc](https://raw.githubusercontent.com/Beep6581/RawTherapee/dev/rtengine/perspectivecorrection.cc),
[iptransform.cc](https://raw.githubusercontent.com/Beep6581/RawTherapee/dev/rtengine/iptransform.cc); ART [perspectivecorrection.cc](https://raw.githubusercontent.com/artraweditor/ART/master/src/engine/perspectivecorrection.cc);
[ShiftN](https://www.shiftn.de/ShiftN_functionality.html); hugin [linefind](https://hugin.sourceforge.io/docs/manual/Linefind.html), [perspective correction](https://wiki.panotools.org/Perspective_correction);
LightCraft [upright.rs](https://raw.githubusercontent.com/storytold/lightcraft/main/crates/pipeline/src/upright.rs), [transform.rs](https://raw.githubusercontent.com/storytold/lightcraft/main/crates/pipeline/src/transform.rs),
[geometry.rs](https://raw.githubusercontent.com/storytold/lightcraft/main/crates/pipeline/src/geometry.rs), [crop.rs](https://raw.githubusercontent.com/storytold/lightcraft/main/crates/geom/src/crop.rs);
RapidRAW [guided_perspective.rs](https://raw.githubusercontent.com/CyberTimon/RapidRAW/main/src-tauri/src/guided_perspective.rs); RAWmakase [transform.md](https://raw.githubusercontent.com/pch/rawmakase/32d5f92ee007f3529982e0b7d5f911b37a698d3a/docs/transform.md).
Lightroom: [Guided Upright (Classic)](https://helpx.adobe.com/lightroom-classic/desktop/process-and-develop-photos/guided-upright-perspective-correction.html),
[Upright in Camera Raw](https://helpx.adobe.com/camera-raw/desktop/edit-and-enhance-images/crop-rotate-and-geometry/automatic-perspective-correction-camera-raw.html),
[Guided Upright (mobile, valid guide combinations)](https://helpx.adobe.com/lightroom/mobile/crop-and-transform/correct-perspective-with-guided-upright.html),
[Crop and straighten](https://helpx.adobe.com/lightroom-classic/desktop/help/crop-rotate-straighten.html), [keyboard shortcuts](https://helpx.adobe.com/lightroom-classic/desktop/introduction-to-lightroom-classic/keyboard-shortcuts.html),
[crop corners (SDK thread)](https://community.adobe.com/t5/lightroom-classic-discussions/sdk-computing-the-corners-of-a-crop-rectangle/td-p/12995794);
Apple Photos [crop and straighten](https://support.apple.com/guide/photos/pht13f0918f0/mac), Capture One [Keystone](https://support.captureone.com/hc/en-us/articles/360002588058).
Algorithms: [Lee et al., Automatic Upright Adjustment of Photographs (CVPR 2012 / TPAMI 2014)](https://cg.postech.ac.kr/papers/06_Automatic-Upright-Adjustment-of-Photographs-with-Robust-Camera-Calibration.pdf) and [patent US9519954](https://patents.google.com/patent/US9519954),
[LSD (IPOL 2012)](https://ipol.im/pub/art/2012/gjmr-lsd/article.pdf), [ED_Lib / EDLines](https://github.com/CihanTopal/ED_Lib), [ELSED](https://github.com/iago-suarez/ELSED),
[Tardif, non-iterative vanishing point detection (ICCV 2009)](https://www.cs.hunter.cuny.edu/~ioannis/JVPs.pdf), [focal from two vanishing points](https://www.bmva-archive.org.uk/bmvc/2004/papers/paper_225.pdf),
[conjugate rotation homography notes](https://perso.ensta-paris.fr/~manzaner/Cours/ROB313/ROB313_Homographies.pdf), [Mitchell-Netravali filters](https://en.wikipedia.org/wiki/Mitchell%E2%80%93Netravali_filters),
[Lanczos resampling](https://en.wikipedia.org/wiki/Lanczos_resampling), [GPU Gems 2 ch. 20 (cubic filtering)](https://developer.nvidia.com/gpugems/gpugems2/part-iii-high-quality-rendering/chapter-20-fast-third-order-texture-filtering),
[inscribed rectangle of a rotated rectangle](https://tensorpack.readthedocs.io/en/latest/_modules/tensorpack/dataflow/imgaug/geometry.html), [Alt, Hsu, Snoeyink 1995](https://www.cs.ubc.ca/tr/1994/tr-94-28).
Learned: [GeoCalib](https://github.com/cvg/GeoCalib) ([paper](https://arxiv.org/abs/2409.06704), [community ONNX fields export](https://huggingface.co/mprib/geocalib-fields-onnx)),
[Perspective Fields licence](https://raw.githubusercontent.com/jinlinyi/PerspectiveFields/main/LICENSE), [M-LSD](https://github.com/navervision/mlsd), [DeepLSD](https://github.com/cvg/DeepLSD),
[Apple Vision horizon request](https://developer.apple.com/documentation/vision/vndetecthorizonrequest), [Pixelmator auto-straighten model](https://appleinsider.com/articles/24/08/20/photomator-and-pixelmator-pro-add-custom-auto-straightening).
Crates: [imageproc geometric transformations](https://docs.rs/imageproc/latest/imageproc/geometric_transformations/), [lsdetect](https://crates.io/crates/lsdetect), [argmin](https://crates.io/crates/argmin), [nalgebra](https://crates.io/crates/nalgebra).

Licences: [RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4), [RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0), [NVIDIA SegFormer licence](https://raw.githubusercontent.com/NVlabs/SegFormer/master/LICENSE),
[EdgeSAM (S-Lab)](https://github.com/chongzhou96/EdgeSAM), [Depth Pro licence](https://huggingface.co/apple/DepthPro/blob/main/LICENSE), [Ultralytics licence](https://www.ultralytics.com/license),
[MIRNet-v2 licence](https://github.com/swz30/MIRNetv2/blob/main/LICENSE.md), [Noise2Noise licence](https://raw.githubusercontent.com/NVlabs/noise2noise/master/LICENSE.txt),
[Real-ESRGAN licence](https://raw.githubusercontent.com/xinntao/Real-ESRGAN/master/LICENSE).
