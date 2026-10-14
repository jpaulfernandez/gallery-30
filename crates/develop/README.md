# photobook-develop

The develop pipeline behind the editor's Develop module: pure Rust, no Tauri. Design and maths:
`docs/design/archive/DEVELOP_PLAN.md` (sections 4.2 and 5). Tests: `source ~/.cargo/env && cargo test -p photobook-develop`.

## Module map

| Module | What it holds |
| --- | --- |
| `settings`, `canonical`, `lib.rs` | serde mirror of the Zod `DevelopSettings`, `develop_hash`, `ENGINE_VERSION` (D1.1) |
| `image` | `LinearImage` (interleaved RGB `f32`, linear Rec.2020 D65, upright, plus `ImageMeta`: RAW flag, as-shot WB, camera matrices) and `Rgb8Image` (sRGB 8-bit) |
| `decode` | `decode_file`, `decode_jpeg`: JPEG (turbojpeg, DCT-scaled), PNG 8/16-bit (`image`, alpha over white), EXIF orientation, ICC via `moxcms`, linear-light Lanczos3 downscale; `decode_raw` (feature `raw`, D6.1): camera RAW through `rawler`; `heic` (feature `heic-imageio`, macOS, D6.2): HEIC/HEIF through ImageIO into extended linear sRGB half floats |
| `color` | RGB ↔ XYZ matrices (sRGB, Display P3, Rec.2020), sRGB transfer, Oklab/OKLCH, CAT16, Robertson CCT/tint, Fritsch–Carlson curves and 4096-entry LUTs, `camera` (DNG-style colour matrices interpolated by CCT, neutral ↔ white, camera → Rec.2020), `output` (`OutputProfile` sRGB / Display P3: matrices, file suffix, the compact v4.3 ICC tags) |
| `geometry` | D2: `Homography` (compose, invert, DLT via `nalgebra`), user rotate/flip matrices, inscribed-rectangle maths and `constrain_crop` (mirrored in TS), the manual Transform matrix, the guided Upright solver (`upright`), automatic Upright (`segments`, `vanishing`, `auto`), mask/guide re-mapping (`remap`), `GeometryPlan` (the composed map and output size), `warp` (exact copy, copy + resize, Catmull-Rom / Lanczos3 resample) |
| `local` | D3.1 filters on `f32` planes: `blur` (separable Gaussian, exact kernel below σ 4 and three running-sum box passes above; box filter; min filter; integer down/upsampling), `guided` (guided filter with a grey guide, fast form with a quarter-resolution coarse stage), `prepass` (the planes below and `PrePasses`, their per-image cache) |
| `ops` | one pure function per control on rows of RGB triples, each with a `Params` built from the settings (`None` = skipped); `detail` gathers clarity, texture, dehaze and sharpen; `effects` (workflow plan 17) gathers `grading` (Oklab chroma per lightness band), `grain` (two-octave value noise in reference px), `vignette` (post-crop gain on linear light) and `halation` (blurred highlight excess, warm tint) |
| `masks` | D4.1: `raster` (`MaskPlane`, linear/radial/brush/luminance/colour rasterisers onto the output grid), `composite` (`rasterise_mask`, `grow`), `hash` (`component_hash`, `MaskCache` LRU), `blend` (`MaskLayers`, `local_weights`, `LocalParams`: the per-pixel contract). Applied by `cpu::masked` and the GPU chain |
| `cpu` | `Params` (with `Sliders`, the global values masks add to), `develop()` / `develop_with_masks()` and `Developer` (holds the image, its `PrePasses`, the last geometry warp with its own, and the mask caches; `render(&settings)`, `sharpen_mask(&settings)`, `mask_overlay(&settings, id)`), `rayon` over rows; `masked`: `LocalBlend`, `PreparedLayers`, the per-pixel local path |
| `render` | `render_preview`, `render_full` (+ `render_full_with` for an explicit resample quality; `*_with_options` / `render_preview_with` for explicit `RenderOptions`, else `RenderOptions::for_image`: the look on for RAW), `encode_jpeg` (sRGB ICC embedded) and `encode_jpeg_as` (the `RenderOptions::output` profile's ICC), `copy_exif`; each tries the GPU first |
| `gpu` | D3.2: `wgpu` 30 compute port of the pipeline (WGSL), verified against the CPU: `GpuContext`, `init`, `RenderBackend`, crash flag, `PHOTOBOOK_FORCE_CPU` (see GPU below) |
| `ai` | D4.2, feature `ai` (default on): `registry` (the pinned `models.toml`), `download` (resumable, verified downloads), `runtime` (`ort` sessions with the CoreML EP), `ModelDir`, `status`, `installed` (see AI below); D4.3: `preprocess`, `segment`, `depth`, `refine` (see AI masks below) |
| `lut` | Workflow plan 18: 3D LUTs: `.cube` parser, HALD conversion, tetrahedral `Lut3d::apply`, the by-id store the render reads (see Look below) |
| `lutfit` | Workflow plan 22: Match camera JPEG. Neutral RAW render, alignment with the camera JPEG (scale/offset search, per-tile offsets), flat-pixel sampling, a 33³ least-squares fit with a second-difference smoothness term (conjugate gradients), CIE76 ΔE; `decode::film_simulation` reads the Fujifilm film simulation tag |
| `preview_modes` | Plan 53: focus peak and zebra drawn over a preview's 8-bit output (`apply_preview_mode`, CPU reference `apply_preview_mode_cpu`, GPU pass `gpu::preview_mode`); view-only, never in the develop hash (see Preview modes below) |
| `stats` | Plan 38: `photo_stats` (per-tile noise-corrected Laplacian variance, structure-tensor motion, clip shares, median luma) and `phash` (DCT perceptual hash via `image_hasher`) of an upright 8-bit proxy, for the cull; not render maths (see Photo stats below) |
| `xmp` | D6.3: Lightroom `crs:` import (`read_sidecar`, `read_packet`, `read_embedded` → `XmpImport`), our `photobook:` packet (`write_photobook_packet`, `read_photobook_packet`), the lossy `crs:` export (`write_crs_packet`), `merge_into_sidecar`, and the orientation remaps (`fields`). Parsed with `quick-xml` into a small namespace-resolved tree (`dom`) |

## Pipeline order

decode → geometry warp into the crop framing → white balance → exposure → (local pre-passes, cached) →
highlights/shadows → whites/blacks → contrast → clarity → texture → dehaze → sharpening → colour mix, vibrance,
saturation (OKLCH) → halation → vignette → optional display look → Rec.2020 → output RGB (sRGB or Display P3,
`RenderOptions::output`), gamut map by chroma reduction → sRGB transfer (Display P3 uses it too) →
parametric + point curves → 3D LUT (plan 18) → colour grading → grain → dither → 8-bit.

Every control at its default is skipped, so an unedited photo renders back to its decoded pixels exactly.

## Effects (workflow plan 17)

`settings.effects` (`Effects`: `grading`, `grain`, `vignette`, `halation`) is serialised only when it differs from
its defaults (`skip_serializing_if`, mirrored by `HASH_OPTIONAL_SECTIONS` / `hashableDevelop` in TS), so adding it left
every existing `develop_hash` unchanged; the `effects` parity fixture covers the non-default case. The CPU runs all
four ([`ops::effects`]: `LinearEffects` in both the global and the masked row paths, `DisplayEffects` inside
`encode_row_with`), and since workflow plan 19 so does the GPU, in the same places of the chain (see GPU below), so
an effect no longer sends the render to the CPU. Halation and vignette run in scene-linear light before
the RAW display look, so a Threshold picks out a different brightness on RAW than on JPEG.

- **Grading**: Oklab `L` remapped so the Balance pivot (`0.5 − 0.25·balance`) sits at 0.5; shadows fade out around
  1/3 and highlights in around 2/3 over a smoothstep of width `0.08..0.6` (Blending); midtones take the rest. Each
  wheel adds `saturation/100 · 0.06` Oklab chroma in the direction of its colour-wheel hue (the fully saturated sRGB
  colour of that HSV hue), faded out at black and white. Display-referred: decode the curve output to linear output
  RGB, Oklab round trip, gamut map, re-encode. Plan 55: each wheel's `luminance` (−100..100) moves Oklab `L` by up to
  `0.1` (`GRADING_LUMINANCE`) weighted by its band, and the Global wheel (`grading.global`) adds its chroma and
  luminance at weight 1, under the same fade; `L` is then clamped to 0..1. Both are left out of the JSON at their
  defaults (`skip_serializing_if`), and `GradingParams::extra` is `None` then, so engine 3's arithmetic runs unchanged.
  The harmony lock (`grading.harmony` in TS) is UI state: serde ignores it and the hash never sees it.
- **Grain**: value noise (integer lattice hash, fixed seed, smootherstep), coarse octave at `0.5..4` reference px
  (Size) plus Roughness × the half-size octave, at `(x, y) · 2048 / long edge` (pixel corners), so a render at twice
  the size samples the proxy's points at its even pixels exactly. Amplitude `0.12 · amount` of the encoded range times
  `4·Y'(1 − Y')` (Rec.709 luma of the encoded output); added equally to R, G, B.
- **Vignette**: gain `2^(±2 EV · amount · smoothstep(mid − w/2, mid + w/2, d))` on linear light, `d` the
  superellipse distance from the frame centre (exponent `2 + 6·max(0, −roundness)`; positive roundness rescales the
  axes towards a circle in pixels), `mid = 0.35..1.25` (Midpoint), `w = 0.03..1.3` (Feather).
- **Halation**: a cached pre-pass (`local::prepass::halation_plane`, an LRU of one keyed by `HalationKey`): the excess
  `max(0, Y − t/grey)` (capped at 4) of the warped image, averaged down so σ stays at least 3 px, Gaussian-blurred
  there (σ `3..60` reference px for Radius), sampled bilinearly per row; added as `1.5 · amount · grey · glow ·
  (1, 0.3, 0.1)`. `t = srgb_to_linear(threshold/100)`; `grey` is exposure × white-balance grey gain, so only those two
  sliders move the source. 24 MP release CPU render: about 96 ms with halation against 82 ms without (the pre-pass
  about 8 ms); about 0.5 s with all four effects, the grading round trip dominating
  (`cargo test -p photobook-develop --release --test effects -- --ignored --nocapture`).

## Look: 3D LUTs (workflow plan 18)

`settings.look` (`Look { lut: Option<LutRef { id, name, strength }> }`) is left out of the JSON and the hash while it
has no LUT (like `effects`); with one, the hash names the LUT's id (the SHA-256 of its canonical `.cube` text, `lut::canonical_cube`: no title or
comments, LF, six decimals, which is also the stored file), so renders with
and without it never collide, even when the file is missing. [`lut`] parses `.cube` (`LUT_3D_SIZE` 2..129,
`DOMAIN_MIN/MAX` or Resolve's `LUT_3D_INPUT_RANGE`, `TITLE`; 1D LUTs refused), converts HALD CLUT images
(`hald_from_rgb`, `decode_hald_png`: level `L` is `L³ × L³` px holding an `L²` cube) and writes `.cube` text
(`to_cube`). `Lut3d::apply` is tetrahedral interpolation with inputs clamped to the domain (an identity 33³ LUT is
exact to float rounding: the lisbon fixture renders byte-identical through it). The store: `set_lut_dir` (the
editor's `<appdata>/luts`), `get(id)` (pinned LUTs from `insert`, then an LRU of six parsed files re-read when the file's mtime changes or it is
gone; a file must parse and hash to its id, and failures are remembered for 5 s), `forget`,
`present`.

`ops::lut::LutParams` sits on `OutputParams::lut` and runs inside `encode_row_with` after the curves and before
grading, on the transfer-encoded output values (the output's primaries with the sRGB curve; Display P3 renders apply
the LUT to P3-encoded values), then `strength` blends with the input and the result is clamped to 0..1. Masked rows
get it too. A missing file makes `LutParams::new` `None` (logged once per id); `ops::lut::missing_lut(settings)`
tells callers (the editor marks cached renders `lutMissing` and refuses full renders). GPU: `PASS_LUT`, the LUT as a
`size³` `rgba32float` 3D texture (binding 14, kept between renders while the render's `Arc<Lut3d>` is the same one) and `lut_apply` in chain.wgsl
doing the same tetrahedral arithmetic; CPU vs GPU on the `look.json` fixture (with the committed 9³
`tests/fixtures/luts/<sha256>.cube`) differs by at most one level (`tests/lut.rs`). A LUT with active effects stays on
the GPU too (plan 19).

## Geometry (D2.1–D2.3)

- **Model**: in normalised coordinates `H = T_crop · R(straighten, about the crop centre) · M_manual · H_upright ·
  O_orientation`. `O` is the user rotate (clockwise, 90/270 swap the size) followed by the flips, which act in
  the rotated frame (as seen on screen). `H_upright` is `upright.transform` (row-major, 0..1 coordinates of the
  oriented image) when the mode is not `off`, else identity; renders never run the solver
  (`transform::upright_matrix`). `M_manual` is `transform::manual_matrix_with_focal`. The transformed frame keeps
  the oriented frame's size. `pre_crop_matrix` (`M · U · O`) and `perspective_matrix` (`M · U`) are exposed for
  the UI.
- **Manual Transform** (`manual_matrix`): `offset · scale · aspect · keystone · rotate` (rotate first) in centred
  long-edge units (origin at the frame centre, long edge 1). Exactly the identity at the defaults.
  - Vertical / Horizontal (−100..100): keystone `K · R_x(pitch) · R_y(yaw) · K⁻¹`, `K = diag(f, f, 1)`,
    `pitch = −vertical/100 · 30°`, `yaw = horizontal/100 · 30°`, `f = upright.focal` when set, else 1 (the long
    edge). **Negative Vertical widens the top** (corrects converging verticals), positive widens the bottom;
    **positive Horizontal enlarges the right side**. Then recentred (the centre stays put) and rescaled so the two
    centre lines keep their length on geometric average (`recentre_and_rescale`).
  - Rotate (−10..10): degrees about the centre, positive clockwise (like straighten).
  - Aspect (−100..100): x × `2^(0.137·a/100)`, y × `2^(−0.137·a/100)`; positive stretches horizontally.
  - Scale (50..150): uniform `scale/100`.
  - Offset X / Y (−100..100): `offset/100` long edges; positive X moves the picture right, positive Y down.
  - Lightroom's exact ranges and signs are unverified (plan 4.11); only the Vertical sign is pinned by the plan.
- **Guided Upright** (`upright::solve_guided(guides, frame_w, frame_h, focal)`): guide endpoints in fractions of
  the oriented frame (map stored guides back with `remap_points(.., &perspective_matrix(..), &identity)`).
  Combinations: 2H → `Level` (horizontals parallel and level), 2V → `Vertical` (verticals parallel and vertical),
  2H+2V, 2H+1V, 2V+1H, 1V+1H → `Full`; anything else is `UprightError::InvalidGuides`. Vanishing points by cross
  products, `R` in closed form (shortest rotation for 2H/2V; both directions with Gram–Schmidt for 2H+2V; the
  single guide's back-projected plane for 2V+1H/2H+1V; the smallest rotation over the one-parameter family for
  1V+1H), `H = K R K⁻¹`, refined by a hand-written Nelder–Mead (`nelder_mead`) on the length-weighted squared
  deviation of the warped guides from their axis, then recentred and rescaled. Focal: `√(−v₁·v₂)` for 2H+2V with
  two finite vanishing points and a negative product (kept within 0.2..10 long edges), else the caller's, else
  `DEFAULT_FOCAL = 28/36 ≈ 0.78` long edges (28 mm on a 36 mm long edge). For 2H+2V that a rotation cannot fit,
  a four-point DLT of the guides' quad onto a rectangle is kept when its residual is lower. A frame corner through
  infinity or a warped area above 4× is `UprightError::Unstable`. Result: `transform` (store in
  `upright.transform`), `focal` (store in `upright.focal`), `residual` (weighted RMS degrees), `correction`.
- **Automatic Upright and Auto level** (D2.3): `auto::analyse(image, exif_focal_35mm) -> Analysis` once per image
  (the *oriented* frame), then `auto::solve_auto(&analysis, mode, frame_w, frame_h) -> AutoSolution` per mode
  (`Level`, `Vertical`, `Full`, `Auto`; no pixels touched). About 12 ms on a 1280 px frame and 35 ms from a 24 MP
  one in release (luminance, downscale, detection, RANSAC); 10–180 ms on the sample photos in the dev profile.
  - *Segments* (`segments::detect_segments`): clean-room edge-drawing detector on a ≤ 1280 px luminance copy
    (`analysis_luma`): gamma 0.45 + unsharp (0.5, σ 1.5), Sobel, non-maximum suppression, noise-adaptive threshold
    (`max(0.012, 4 × median magnitude)`, anchors 2×), chains walked from the strongest anchors while the orientation
    stays within 22.5°, incremental total-least-squares pieces (sub-pixel edges, ≤ 1 px deviation, ≥ 10 points),
    collinear merge (≤ 1.5°, ≤ 1.5 px, gap ≤ ¼ of the shorter piece or 4 px), length ≥ 2.5 % of the long edge.
    Edge pixels in the 2 % border band are ignored. Weight = length × contrast (mean gradient); sorted by weight.
    Endpoints in fractions of the frame and in analysis pixels; `angle_deg` in (−90, 90], positive clockwise.
  - *Vanishing points* (`vanishing::find_vanishing_point`): classes within 30° of each axis; 400 two-segment
    hypotheses drawn by weight from the 200 heaviest (fixed-seed SplitMix64, deterministic); finite candidates inside
    the frame rejected; inliers by Tardif's criterion (endpoint distance from the line through the candidate and the
    midpoint ≤ `min(2 px, max(0.5 px, ½·length·tan 2°))`), MSAC score; weighted least-squares refinement (smallest
    eigenvector of `Σ w·l·lᵀ`). Accepted with ≥ 3 inliers, inlier length ≥ ½ long edge and score ≥ 25 % of the
    class weight. Points are homogeneous in analysis pixels (`z ≈ 0`: parallel lines).
  - *Level*: angles folded into −45..45, weighted histogram (0.1° bins, σ 0.2°, circular, parabolic peak, then the
    weighted mean within ±0.5°); confidence = weight within ±0.75° over the total; the horizontal class alone wins
    when it has a clear peak (≥ 50 %) and ≥ 35 % of the weight. Needs confidence ≥ 0.3 and ≥ 3 supporting segments
    or a support ≥ 0.3 long edges (one clear horizon). `LevelResult::angle_deg` is the straighten angle to apply
    (positive clockwise, the sign of `crop.angle`): the crop tool's Auto button writes it to `crop.angle`. With the
    `vision-horizon` feature on macOS, fewer than 3 segments fall back to Vision's `VNDetectHorizonRequest`
    (`objc2-vision`; Vision's angle is the horizon's y-down tilt, negated). Off by default.
  - *Focal*: `√(−v₁·v₂)` from two finite vanishing points within 10 long edges (kept in 0.3..5 and within 1.5× of the
    EXIF focal when known), else EXIF `focal35 / 36`, else `DEFAULT_FOCAL`.
  - *Solve*: `upright::solve_from_vanishing_points` (factored out of `solve_guided`, whose output is bit-identical):
    shortest rotation for one point, Gram–Schmidt (vertical exact) for two, Nelder–Mead on the weighted inlier
    residuals with a 10⁻⁴ pull toward the closed form (noisy lines would otherwise drift along the free yaw), warped
    area ≤ 4×. Level is a pure rotation about the centre. Missing structure falls back Full → Vertical → Level; Full
    also falls back to Vertical when the two directions are > 10° from orthogonal (`Analysis::skew_deg`).
  - *Auto*: vertical point with a camera tilt ≤ 20° → Full if the horizontal point needs a yaw of 5–25°, is within 2°
    of orthogonal and fits with residual ≤ 1°, else Vertical (residual ≤ 1°); otherwise Level with confidence ≥ 0.4
    and a rotation ≥ 0.05°; otherwise `UprightError::NoStructure` ("no straight lines found", "already level", ...).
  - `AutoSolution { transform, focal, residual, correction, confidence, angle, used }`: `correction` is what ran
    (may differ from the mode asked), `angle` the rotation at the frame centre, `used` flags the analysis segments
    the correction used (the "show structure" overlay); `Analysis::used` flags any segment used by Level or a point.
  - Limits: Manhattan scenes only (city panoramas with many facade directions get small or no corrections from
    Auto; explicit Full may still follow a minor facade); no lens-distortion model (curved lines split or drop); the
    focal is a guess without two finite vanishing points or EXIF; a single long horizon is enough for Level but a
    soft or hazy one may not be detected (Vision helps there).
- **Crop**: an axis-aligned rectangle in fractions of the transformed, uncropped frame; the straighten angle
  (positive = clockwise) turns the *picture* about the crop centre in pixel units, so the frame stays square to
  the screen. With `constrainCrop` the stored rectangle is shrunk about its centre (never enlarged) until it fits
  the rotated picture (`constrain_crop`); a valid rectangle comes back bit-for-bit. After an Upright or manual
  warp the picture is the warped outline clipped to the frame (`transform::warped_region`), and the shrink uses
  `constrain_crop_in_polygon` (bisection; the centre moves to the outline's vertex average only when it lies
  outside). `max_crop_in_warped(geometry, frame_w, frame_h)` is the UI's auto-fit: the largest rectangle of the
  crop's aspect at its angle with a free centre (Nelder–Mead, tie-broken toward the frame centre). Without
  constrain, an angled or warped crop's corners clamp to the image edge. At angle 0 the crop snaps to whole source
  pixels.
- **Masks and guides** (`remap`): `remap_points(points, h_old, h_new)` applies `H_new · H_old⁻¹`;
  `remap_geometry_vectors(old, new, source_w, source_h, masks, guides)` re-maps brush points, linear from/to,
  radial centres (radii and angle through the local Jacobian, approximate) and guide endpoints between two
  geometries' `pre_crop_matrix`. Nothing calls them yet; the store will when the geometry changes.
- **Sizes**: `GeometryPlan::developed_size` (= `developed_size(&geometry, w, h)`, `Developer::developed_size`) is
  the crop at the source's resolution; `render_full` outputs that size and `render_preview` fits it to the long edge.
- **Warp paths**: (1) exact copy when output pixel centres land on source pixel centres one to one (rotate,
  flips, whole-pixel crops: bit-exact, about 14 ms for a 24 MP crop); (2) exact copy of the crop then the
  `fast_image_resize` Lanczos3 downscale when it is axis-aligned but scaled; (3) inverse mapping per pixel
  centre with Catmull-Rom (`Quality::Preview`) or Lanczos3 (`Quality::Export`), clipped to the 2×2 nearest
  pixels (no ringing, no negatives), with a Mitchell prefilter of the source first when the map minifies by
  more than 1.25. `Developer` and `render_full` pick Preview up to a 2000 px long edge and Export above.
- **Caching**: `Developer` keeps the last warp (keyed by the geometry's canonical JSON and the quality) with
  its own base plane, so light and colour sliders never re-warp. An identity geometry skips the warp entirely.
- **Parity**: `tests/fixtures/geometry/*.json` (written by `tests/geometry.rs` with
  `UPDATE_GEOMETRY_FIXTURES=1`) pin `maxAreaRectInRotated`, `fixedAspectHalfWidth`, `constrainCrop`,
  `largestRectInQuad`, `geometryPlan` and `manualMatrix`, `remapPoints` to 1e-9, and `solveGuided` and
  `maxCropInWarped` (Nelder–Mead inside) to 1e-6, for the TypeScript twins.

## Masks (D4.1)

Rasterised by the pure functions in `masks/` and **applied in the pipeline** by `cpu::masked` (CPU) and the chain
kernel (GPU); see "Applied in the pipeline" below.

- **Grid**: masks are rasterised onto the output (crop) grid, sampled at pixel centres, values 0..1 (`MaskPlane`,
  one `f32` plane per mask). Vector shapes are stored in fractions of the transformed, uncropped frame and reach the
  grid through `GeometryPlan::frame_to_output_matrix()` (normalised frame → output pixels; a similarity). Distances
  are *frame-metric*: frame pixels scaled to output pixels (`FrameGrid`; the Jacobian column lengths give the frame
  width and height in output pixels), so shapes stay round on screen whatever the frame aspect, crop, straighten or
  output size, and the preview and the export agree.
- **Linear** `from → to`: 0 at and before `from`, 1 at and after `to`, smoothstep between (the middle line is 0.5).
- **Radial**: ellipse at `center`, semi-axes `radii` as fractions of the frame width and height, turned `angle`
  degrees clockwise (the convention of `remap_geometry_vectors`). 1 inside, 0 outside; `feather` 0..100 is the band
  inside the edge (fraction of the normalised radius) over which it falls 1 → 0 by smoothstep.
- **Brush**: round dabs every quarter diameter along each polyline. `size` 0..100 is the **diameter as a percentage of
  the frame's short side** (radius in output pixels `size/100 · short / 2`, the short side from the local Jacobian at
  each point); `feather` 0..100 is the soft edge as a fraction of the radius (never narrower than 1 px); `flow` 0..100
  is each dab's opacity, and dabs combine by **max** within and across strokes (overlaps and slow strokes never
  build past the flow); an `erase` stroke subtracts its coverage (saturating at 0). Strokes apply in order.
- **Luminance range**: reads `luminance_plane(input)` = sRGB-encoded Rec.2020 `Y` of the *input* image (decoded and
  warped, before any develop adjustment, clamped 0..1), so it does not move while sliders are dragged. 1 inside
  `range` (inclusive; swapped when reversed), falling to 0 over `feather/100 · 0.25` luminance units outside each end.
- **Colour range**: `samples` are hex sRGB (`#rrggbb` or `#rgb`; invalid ones ignored). Mask = max over samples of
  `exp(−d²/2σ²)` of the Oklab distance (lightness difference weighted by 0.5), rescaled to reach 0 at 3σ, with
  `σ = 0.02 + 0.13 · tolerance/100` (0.085 at the default 50). Reads the input image, like luminance.
- **AI**: the caller's `ai_rasters(component id)` supplies the raster on the grid (any size is resized bilinearly; the
  pipeline's lookup, `masks::ai_cache::lookup_on_plan`, already warps it there); when it returns `None` the component
  contributes 0 and its id is listed in `MaskResult::missing_ai`.
- **Composition** (`rasterise_mask`): components in order, each inverted first when its `invert` is set; `add` = max,
  `subtract` = `max(0, acc − c)`, `intersect` = min; the first component always acts as `add`. Then the mask's
  `invert`, its `feather` (Gaussian, **σ = feather/100 · 2 % of the frame's short side** in output pixels), and
  `opacity/100`. `enabled` is the caller's business (`MaskLayers::build` skips disabled masks and masks whose
  adjustments are all zero). `grow(plane, amount, short)` dilates (`amount > 0`) or erodes up to 1 % of the short side
  (square window, `min_filter` and a max filter); no schema field uses it yet.
- **Cache**: `component_hash` = SHA-256 of the component's canonical JSON without `id`, `mode` and `invert`, plus
  `mask-raster/1`. `MaskCache` (LRU, 128 MB default) keys a component's raster by `(component hash, width, height,
  frame_to_output normalised and rounded to 1e-6)`; keep one per source image (range masks depend on its pixels) and
  `clear()` it when the image changes. Missing AI rasters are not cached.
- **Blend contract** (`blend`): per pixel `i`, local slider values are `Σ wₘ(i) · adjustmentsₘ` over `MaskLayers`
  (`LocalParams::at`, or `local_weights` to iterate), added to the global values in the sliders' own units before the
  operator runs (overlapping masks add up; the pipeline clamps to each slider's range). All current local sliders blend
  as parameters; curves and colour grading, if masks gain them, render per mask and mix by mask value.

### Applied in the pipeline

- **Where**: masks are composited on the render's working grid (the warped, cropped input; for a preview, the preview
  grid) before white balance. The active masks (enabled, some adjustment set) become one `f32` plane each
  (`PreparedLayers`: planes plus a per-row "any mask here" flag); `LocalBlend` adds the current adjustments, which
  local sliders some mask sets, and the per-render tables. Per pixel the local values are `Σ w · adjustments`
  (`LocalBlend::local_at`, layers in order, zero weights skipped) and each operator runs with `global + local`,
  clamped to the range that operator accepts. A row no mask touches runs the global row passes unchanged, and inside a
  masked pixel an operator whose own local value is 0 runs its global path, so mask-less renders and untouched pixels
  are bit-identical to the global pipeline (tested).
- **Blending table**:

  | Local slider | Blends as | Where |
  | --- | --- | --- |
  | Exposure (EV) | `2^(EV + EV_local)`, within −10..10 | exposure; also rescales the cached highlights/shadows base for that pixel |
  | Temperature, Tint | added to the incremental sliders (−100..100; `asShot` = 0/0); for `absolute` a mired (`MIRED_PER_UNIT`) and tint (`TINT_PER_UNIT`, within −150..150) shift of the source illuminant, through `WhiteBalanceParams::for_image` (so RAW stays relative to as-shot) | white balance, from a per-render table over the local range (≤ 129 × 129 entries, ≤ 2 units apart, bilinear; exact at the nodes) |
  | Highlights, Shadows | added to the sliders (−100..100) | exact `tone_gain_ev` per pixel (no table) on the base rescaled by the pixel's own exposure and white balance |
  | Whites, Blacks | added to the sliders | the end-point curve's constants rebuilt per pixel (`WhitesBlacksParams::from_unit`, a few flops) |
  | Contrast | added to the slider | the exponent is per pixel anyway |
  | Clarity, Texture | added to the sliders (the sign picks the boost or the smoothing strength) | gain on the cached detail/band planes |
  | Dehaze | added to the slider | the cached density; the atmospheric light stays the global one |
  | Sharpness | added to the sharpening Amount (0..150; negative only reduces it, no blur) | radius, detail and masking stay global; works with global sharpening off (the planes are computed for the settings' radius) |
  | Saturation | added to the slider | the chroma scale `1 + s` in the OKLCH step |
  | Hue | an extra OKLCH hue rotation of `hue/100 · 30°` (positive turns red towards yellow), after the colour mix | the OKLCH step (runs with an identity mix when the global colour pass is off) |
  | Noise | `Σ w·noise/100` added to the chroma filter's strength, and a weaker self-guided L filter | `ops::noise`, before white balance (workflow plan 24) |

- **Cost** (choice for the tonal operators): no per-slider tables are rebuilt per pixel. Highlights/shadows evaluate
  the shape exactly (a smoothstep, a cubic and one `exp2`), whites/blacks rebuild four constants, contrast/clarity/
  texture/dehaze/sharpening already compute their gain per pixel from a scalar; only white balance needs a table (the
  Robertson + CAT16 solve is microseconds). Measured on the 1600 px scene with three masks covering most of it
  (release, M3 Pro): a CPU slider change 38 ms vs 28 ms without masks; GPU 3.5 ms vs 2.2 ms.
- **Caching** (`Developer`): component rasters in a `MaskCache` and the composited planes keyed by `layers_key` (the
  canonical JSON of the active masks *without* their adjustments), both for the current input (the decoded image or
  the current warp; cleared when it changes, since range components read its pixels). Global and local slider drags
  reuse the planes (`mask_build_count()`); editing a mask re-composites from the cached components. The GPU keeps the
  uploaded layers of a one-tile render under the same key.
- **Range masks**: luminance and colour ranges read the input image on the working grid (on the GPU path with a
  geometry that is the CPU warp, made once per geometry for that purpose), so dragging exposure does not move them
  (tested byte for byte).
- **`Developer::mask_overlay(&settings, id)`**: one mask's composited plane (after invert, feather, opacity; disabled
  masks too) at the render's size, for the UI overlay; `None` for an unknown id. The editor's `develop_mask_overlay`
  sends it as a greyscale JPEG.
- **AI components**: rasters come from `Developer::set_ai_rasters` (one-shot renders: `masks::ai_cache::with_ai_source`),
  stored on the decoded image's grid and warped onto the render's (see AI masks below). Without one the component
  counts as 0 and `LocalBlend::missing_ai` lists it; such planes are not cached (CPU layers and GPU upload), so a
  raster generated meanwhile shows on the next render.
- **GPU**: the planes go up as an `r32float` 2D array texture (one layer per mask, so the GPU blends exactly the CPU's
  values; `r8unorm` would round them by up to 1/510) plus a storage buffer of the adjustments (4 × `vec4` per layer);
  the chain sums the weighted adjustments per pixel exactly like the CPU and applies them in the same places. A one-tile
  render uploads the whole planes once (cached); tiled renders upload each tile's core window before its dispatch, so
  mask memory is at most `16 × 2048² × 4` bytes. At most `gpu::MAX_MASK_LAYERS` = 16 active masks render on the GPU;
  more render on the CPU. Parity (`tests/gpu.rs`, masked cases on the photo and the 1600 px scene, on defaults and on
  every control, plus absolute white balance and a straightened crop): maximum 1 level, mean ≤ 0.0001; tiles of 2048
  and 777 px are bit-identical to the whole image.
- **Timings** (release, M3 Pro, `--test masks -- --ignored timing_masked`): 1600 px proxy with three masks, first
  render CPU 69 ms; 24 MP export with three masks 0.54 s on the GPU (`render_full`, CPU warp skipped: no range mask),
  1.18 s on the CPU.

## GPU (D3.2)

The `gpu` module is a `wgpu` 30 port of the CPU pipeline as WGSL compute shaders (Metal on macOS; Vulkan/DX12 elsewhere,
untested). The CPU path stays the reference; `tests/gpu.rs` renders every fixture of `pipeline.rs` and `detail.rs`
(plus geometry cases) on both and requires at most 2 levels per channel and 0.3 on average.

- **Which backend**: `RenderOptions::backend` is `RenderBackend::Auto` (default: the GPU when `GpuContext::get()` is
  `Some`), `Cpu` or `Gpu` (falls back to the CPU with a warning when there is none). `Developer::render*`,
  `render_full` and `render_preview` all go through it; `Developer::last_backend()` says which ran
  (`sharpen_mask`, the Alt-drag view, stays on the CPU). A GPU error on a
  render (validation, out of memory, a failed map) falls back to the CPU for that render; an uncaptured device error or
  a lost device marks the context broken and the rest of the process stays on the CPU. Images over the GPU's texture
  limit (16384 px on Apple silicon) or `gpu::MAX_PIXELS` (64 MP) render on the CPU.
- **Context** (`gpu::device`): one per process behind a `OnceLock`, high-performance adapter, the adapter's own limits.
  `GpuContext::get()` is `None` when `PHOTOBOOK_FORCE_CPU` is set (to anything but empty/`0`/`false`; read on every
  call), when the crash flag exists, or when the adapter, device or kernels fail. **Editor hook-up**: call
  `photobook_develop::gpu::init(Some(cache_dir))` once at startup. It names the crash flag
  (`<cache_dir>/gpu-crash-flag`: written before the device is created, removed once it and every kernel exist, so a
  crash while bringing the GPU up leaves it and the next launch stays on the CPU, as RapidRAW does; `clear_crash_flag()`
  re-enables) and creates the device on a background thread (about 20 ms with Metal's shader cache warm, about 2 s
  the first time after the shaders change). Without `init` there is no flag and the first render creates the device.
- **Shaders** (`gpu/shaders/`, 8 × 8 workgroups): each module is a generated `const` prelude (every tuning constant
  printed from the Rust constants as round-tripping `f32` literals, so the two paths cannot drift on a value), then
  `common.wgsl`, then the module. `upload` (f32 RGB bands → texture), `warp` (`copy_map`, `resize` = fast_image_resize's
  convolution with its coefficients computed on the CPU exactly as it does, `gather_catmull_rom` 16 taps and
  `gather_lanczos3` 36 taps with normalised weights, both through `textureLoad` from the inverse homography and clipped
  to the 2×2 nearest pixels), `planes` (`log_luminance`, `convolve` with the sampled Gaussian, `box_blur`, `difference`,
  `sobel`), `guided` (`cell_mean_log`, `cell_dark`, `min_max`, `stats`, `box4`, `coefficients`) and `chain`
  (`develop`: the whole per-pixel chain in f32, curves from a 4096-entry `rgba32float` 1D texture, the dither, 8-bit
  into an `rgba8uint` texture). Readback is `copy_texture_to_buffer` with rows padded to 256 bytes, stripped to RGB.
- **Pass order**: upload → warp (copy | copy + Lanczos3 resize | Mitchell prefilter if minifying by more than 1.25 →
  Catmull-Rom/Lanczos3 gather | resize only, for a preview without geometry) → coarse stages once per input image
  (highlights/shadows and clarity: cell means of log Y → (I, I², p, Ip) → box means → coefficients → box means;
  dehaze: dark channel cells → min/max opening → read back and sorted on the CPU for the atmospheric light → dark
  channel of I/A → opening → the same guided steps) → per tile: log Y, texture band, sharpening fine/coarse/edges →
  `develop` → readback. The guided planes are applied inside `develop` (`ā·I + b̄` with the coefficients upsampled
  bilinearly), so they need no tile overlap.
- **Effects** (workflow plan 19): `PASS_HALATION`, `PASS_VIGNETTE`, `PASS_GRADING`, `PASS_GRAIN` in the chain, at the
  CPU's places (halation then vignette after the colour passes, before the display look; grading then grain after the
  LUT, before the dither), on masked and unmasked pixels alike. The halation glow is a whole-image pre-pass like the
  coarse guided stages: `cell_mean_excess` (the excess over the threshold, averaged into cells of
  `local::prepass::halation_reduction`'s factor) then the tile planes' Gaussian (`convolve` / `box_blur`) at that
  reduced size, cached per input image for the last `HalationKey` (counted in `prepass_count()`), bound at binding 15
  and sampled bilinearly in `develop`, so tiles need no overlap for it. The vignette uses the image pixel position,
  grain the output pixel position with the same integer lattice hash as the CPU (only its smootherstep blend is float).
  Plan 55: the luminance offsets and the Global wheel (`grading_c`, `grading_l` in the uniform) run in
  `grading_apply_wheels`, which only the `develop_wheels` pipeline calls (the `GRADING_WHEELS` override constant,
  chosen per render when `GradingParams::extra` is set). Metal compiles with fast math, so any edit to the plain
  `develop` kernel moved some engine 3 pixels by a level (seen on the ON1 samples); the separate pipeline keeps the
  plain kernel's code, and `tests/engine_bump.rs` (ignored, ON1 samples) proves its output byte-identical.
  `gpu::unsupported` still exists (returning `None`) for any future operator that lands on the CPU first. CPU vs GPU
  (`tests/gpu.rs`: each op at both signs and its shape extremes, all four alone and with every other control, the
  `effects.json` fixture, the display look, Display P3, the masked cases, a straighten, with the fixture LUT): at most
  1 level, mean at most 0.0012; tiles of 2048 and 777 px equal the whole image. A 1600 px proxy slider change with
  every control and every effect on takes about 4 ms on an M3 Pro (about 3–3.6 ms without the effects; 4 ms also when
  the drag recomputes the glow, threshold or exposure), against 140–330 ms on the CPU, measured on a loaded machine
  (`--release --test gpu -- --ignored --nocapture timing_effects`).
- **Tiling**: an image whose sides both fit in `gpu::TILE_SIZE` (2048) is one tile and its planes are cached; larger
  ones are cut into 2048 px tiles, each with an overlap equal to the total support of its filters at that resolution
  (the texture band's coarse Gaussian, the sharpening Gaussians at σ and 2σ and the edge path σ + Sobel + σ: 65 px
  for a 6000 × 4000 image, set by the texture band's three boxes; sharpening alone needs 25 px at radius 1). The
  coarse guided stages are computed once for the whole image. Filters run in difference form (`x_p + Σ kᵢ(xᵢ − x_p)`, which also keeps flat regions exactly flat),
  so tiled and whole-image renders are bit-identical (`tiles_match_the_whole_image`, 3000 × 2000, tiles of 2048, 1000
  and 777 px).
- **Caching** (`gpu::GpuState`, one per `Developer`): the uploaded image, the last warp under the CPU's key, and per
  input image the coarse coefficients (and the atmospheric light) and the cached tile's planes (texture band, the
  sharpening planes for the last radius). `prepass_count()` and `warp_count()` count GPU misses like CPU ones, so a
  slider change is one `develop` dispatch and one readback.
- **Precision and caveats**: the per-pixel chain is f32 throughout. Images (source, warp intermediates, warped) are
  `rgba32float`, not the plan's `rgba16float`: f16 rounds the input by up to 2.4·10⁻⁴ relative, which most controls turn
  into at most one level, but dehaze divides by a transmission as low as 0.08 (×12.5) and dehaze +100 then differed from
  the CPU by up to 5 levels on the haze fixture (mean 0.15) and 8 on one chart pixel. `kernels::IMAGE_FORMAT` switches back to f16 (half the
  image memory) at that cost. Planes are `r32float` (log-domain differences need f32), accumulators `rgba32float`.
  Remaining differences are last-bit ones: Metal compiles with fast math (its `pow`, `exp2`, `log2`, `atan2`, `tanh`
  and `cbrt` as `pow(x, 1/3)` differ from Rust's by a few ulp, and multiply-adds fuse), box means are direct f32 sums
  instead of the CPU's f64 running sums, and the atmospheric light is averaged from f32 cell sums. A value that lands
  within that distance of a quantisation step moves by one level.
- **Measured** (M3 Pro): CPU vs GPU, every fixture × 9 setting sets (defaults, every slider, everything, light
  extremes both ways with absolute WB, colour extremes, detail ±100, the display look) and four geometries in both
  qualities: maximum difference 1 level, mean at most 0.0002; previews, which only come out as JPEG, compared after a
  q100 round trip on both sides: maximum 4 (the codec's own rounding), mean below 0.003. Release timings
  (`--test gpu -- --ignored`): a 1600 px proxy slider change with every control set takes about 2.6 ms (CPU about
  43 ms; JPEG encode another 3 ms), the first render of a proxy about 40 ms (upload and pre-passes); a 24 MP
  `render_full` with every control 0.37–0.46 s including upload and readback (CPU 1.2–1.3 s), 0.33 s with a 3°
  straighten. A `Developer` holding the 24 MP image re-renders with every Detail control in about 0.23 s (tiles
  recompute their planes; CPU 0.38 s).

## Lightroom XMP (D6.3, parser half)

`xmp::read_sidecar(path)`, `read_packet(xml)` and `read_embedded(jpeg)` (the APP1 `http://ns.adobe.com/xap/1.0/\0`
packet; extended XMP is ignored) return an `XmpImport { settings, process_version, dropped, already_applied,
orientation, ignored }` (serde camelCase for the editor). Properties are read from every top-level `rdf:Description`,
as attributes and as child elements (Lightroom writes both); nested descriptions (`crs:Look`, mask corrections) are
not mixed in. `AlreadyApplied="True"` sets `already_applied` (an exported JPEG: callers should skip it). Process
versions below PV2012 (`ProcessVersion` < 6.7, or no version and only legacy fields such as `Exposure`/`Brightness`)
leave the settings at their defaults and list the legacy fields in `dropped`. Unknown `crs:` fields go to `ignored`.

| `crs:` field | Setting | Scaling |
| --- | --- | --- |
| `Exposure2012`, `Contrast2012`, `Highlights2012`, `Shadows2012`, `Whites2012`, `Blacks2012` | `light.*` | 1:1 |
| `Texture`, `Clarity2012`, `Dehaze` | `detail.texture/clarity/dehaze` | 1:1 |
| `Vibrance`, `Saturation` | `color.vibrance/saturation` | 1:1 |
| `{Hue,Saturation,Luminance}Adjustment{Red..Magenta}` (24) | `color.mix.<band>.hue/saturation/luminance` | 1:1 |
| `WhiteBalance="As Shot"` (incremental fields absent or 0) | `whiteBalance: asShot` | |
| `IncrementalTemperature`, `IncrementalTint` (rendered files) | `whiteBalance: incremental` | 1:1 |
| `Temperature`, `Tint` with any other `WhiteBalance` (RAW) | `whiteBalance: absolute` | Kelvin 2000..50000, tint 1:1 |
| `ToneCurvePV2012`, `…Red`, `…Green`, `…Blue` (`rdf:Seq` of `"x, y"`) | `curve.luma/red/green/blue` | 0..255 → 0..1 |
| `ParametricShadows/Darks/Lights/Highlights` | `curve.parametric.*` | 1:1 |
| `ParametricShadowSplit/MidtoneSplit/HighlightSplit` | `curve.parametric.splits` | 0..100 → 0..1 |
| `Sharpness`, `SharpenRadius`, `SharpenDetail`, `SharpenEdgeMasking` | `detail.sharpen.amount/radius/detail/masking` | 1:1 (amount 0..150 both) |
| `HasCrop`, `CropLeft/Top/Right/Bottom`, `CropAngle` | `geometry.crop` (`rect`, `angle`, aspect `free`) | rect = L, T, R − L, B − T, then the orientation remap |
| `CropConstrainToWarp` | `geometry.constrainCrop` | `1`/`True` |
| `PerspectiveUpright` 0..5 | `upright.mode` off, auto, full, level, vertical, guided | |
| `UprightTransform_<mode>` (9 numbers) or six scalar `UprightTransform_0..5` (2×3 affine, padded 0, 0, 1) | `upright.transform` | `P · H · P⁻¹` into the oriented frame; not imported when the mode is off |
| `UprightFocalLength35mm` | `upright.focal` | mm / 36 (long edges) |
| `UprightFourSegments_0..3` (`"x1,y1,x2,y2"`) | `upright.guides` (ids `xmp-guide-N`, kind by the longer extent) | recorded frame → `P` → Upright → Transform sliders (the latter only when `tiff:ImageWidth/ImageLength` or `exif:PixelX/YDimension` give the size) |
| `PerspectiveVertical/Horizontal/Rotate/Aspect/Scale/X/Y` | `geometry.transform` | 1:1, then the orientation remap |

**Orientation.** Lightroom stores crop, Upright and the Transform sliders in the recorded frame (before
`tiff:Orientation`); ours live in the oriented frame. With `P_o` the normalised map recorded → oriented
(`xmp::orientation_map`: 2 `(1−u, v)`, 3 `(1−u, 1−v)`, 4 `(u, 1−v)`, 5 `(v, u)`, 6 `(1−v, u)`, 7 `(1−v, 1−u)`,
8 `(v, 1−u)`):

- Crop (`remap_crop_for_orientation`): both rectangle corners through `P_o` (width and height swap for 5..8); the
  angle keeps its sign (positive clockwise on both sides) except under a mirror (2, 4, 5, 7), where it negates.
- Transform sliders (`remap_transform_sliders`): `(Horizontal, Vertical)` as the vector toward the side that grows
  and `(X, Y)` as a translation, both through the linear part of `P_o`. Orientation 6: Horizontal = −V, Vertical =
  +H, X = −Y, Y = +X; 8: Horizontal = +V, Vertical = −H, X = +Y, Y = −X; 3: all four negate. Rotate negates under a
  mirror, Aspect negates when the axes swap (5..8), Scale is kept.
- Upright transform (`remap_upright_transform`): `P_o · H · P_o⁻¹`, normalised.
- The writer applies the inverse orientation (6 ↔ 8, the others are their own inverse). If the file's own EXIF
  orientation differs from the sidecar's (rotated in Lightroom), `orientation_change(file, xmp)` gives the
  `rotate`/`flipH` to set.

**Dropped** (`DropKind::Dropped`, only when in use): masks and local corrections (`MaskGroupBasedCorrections`,
`Gradient…`, `CircularGradient…`, `PaintBasedCorrections`, with a count), `LuminanceSmoothing` and
`ColorNoiseReduction` ("denoise is model-based here"), spot removal, Looks, grain, vignettes, lens profile and
manual distortion, CA and defringe, split toning and colour grading, calibration, black and white, legacy (pre-PV2012)
sliders, and any value that does not parse.

**Unverified** (`DropKind::Unverified`, imported anyway): `UprightTransform_N` (layout from third-party readers),
`UprightFourSegments_N` (assumed 0..1 of the recorded, unwarped frame), `CropAngle` (we turn about the crop centre;
Lightroom's rotation centre for the rectangle is not documented), and the Transform sliders (ranges, Vertical sign
and keystone maths). Lightroom's rendering maths differs in any case, so an import matches slider values, not pixels.

**Writing.** `write_photobook_packet(settings)` stores the canonical settings JSON in `photobook:Develop` and the
engine in `photobook:Engine` (namespace `http://ns.photobook.app/develop/1.0/`); `read_photobook_packet` reads it
back exactly. `write_crs_packet(settings, &CrsExportOptions { warn, orientation, source_size })` is the lossy
reverse (PV `15.4`, curves rounded to 0..255 integers, splits to whole percents, geometry into the recorded frame,
`photobook:ExportWarning` when `warn`); masks, denoise and the crop aspect preset are not written. Writing then
reading gives back every importable field (`tests/xmp.rs`). `merge_into_sidecar(existing, packet)` keeps every
property of an existing sidecar except the ones the packet sets, and all old `crs:` fields when the packet carries
`crs:` settings; an existing sidecar that does not parse is an error rather than being overwritten.

**Editor half (D6.3).** `apps/editor/src-tauri/src/commands/xmp.rs`: `read_xmp(folder, relPath, fileOrientation?)` looks
for `<stem>.xmp` (Lightroom's name), then `<file>.xmp` (extension in any case), then the packet embedded in a JPEG;
a `photobook:Develop` property is read back exactly (`format: "photobook"`), otherwise the `crs:` fields are mapped
(`format: "crs"`). `orientationChange` (`rotate`, `flipH`) comes from `orientation_change(file, xmp)` when the caller
passes the file's own EXIF orientation. `write_xmp_sidecar(folder, relPath, settings, orientation, width, height, mode)`
merges the Photobook or lossy `crs:` packet into the existing sidecar (kept as `<sidecar>.bak`) or a new
`<stem>.xmp`; `width`/`height` are the upright size the book stores and are swapped for orientations 5..8.
Presets (`commands/presets.rs`): `<appdata>/presets/<ULID>.json`, sections `light`, `whiteBalance`, `curve`, `color`,
`detail` only (geometry and masks are rejected). The UI is in `components/develop/{PresetsMenu,SyncDialog,XmpImportDialog}.tsx`.

## AI runtime and models (D4.2)

Feature `ai` (default on; `cargo check -p photobook-develop --no-default-features` builds without it). Nothing in
the render pipeline uses it yet; D4.3 (AI masks) and D5 (denoise) will.

- **Registry** (`ai::registry`, `models.toml` compiled in): per model `name`, `title`, `version`, `task`
  (`subject`, `subject-fast`, `sky`, `people-detect`, `sam-encoder`, `sam-decoder`, `depth`, `denoise`), `licence` + `licence_url`,
  `homepage`, `input` (static NCHW shape), `dims` (ONNX `dim_param` overrides that make the graph static),
  `static_input`, `verified` and `files` (the graph first, then its external data files, each with `url` pinned to a
  Hugging Face commit, `bytes` and `sha256`, from the Hub's tree API and its `X-Linked-ETag`). `registry()`,
  `Registry::get` / `for_task`, `ModelEntry::downloadable()` (verified with every hash pinned). Unverified entries
  are listed but refused by the downloader. Validation (`parse_manifest`) rejects path-like file names, non-https
  URLs and malformed hashes; `manifest_is_valid` checks the shipped file and that every licence is MIT/Apache/BSD.
- **Layout** (`ModelDir`): `<root>/<name>/<version>/<file>`, partial downloads as `<file>.part` beside it, the
  CoreML cache in `<root>/<name>/<version>/coreml-cache/` (per version: Core ML keys its cache on graph metadata,
  not weights). The editor's root is `<appdata>/models`. `status(entry, dir)` is `Installed` (every file at its
  manifest size), `Partial(bytes)` (finished files plus parts) or `Missing`; `installed(dir)` lists installed
  models with the disk used under `<root>/<name>` (all versions, parts and the CoreML cache).
- **Downloader** (`ai::download_model(entry, dir, &progress, &cancel)`, blocking; run it on a worker thread):
  `reqwest` blocking client (rustls, HTTP/2 adaptive window, 15 s connect timeout, no total timeout). Per file: skip
  if installed; otherwise re-hash an existing part and ask for `Range: bytes=<len>-` (206 appends; 200 restarts;
  416 or a wrong `Content-Range` drops the part and restarts), stream into the part while hashing, then compare the
  SHA-256 and rename into place. Progress covers the whole model; cancel is polled per 256 KB chunk and keeps the
  part. Errors: `Offline` (DNS/connect), `Network` (dropped mid-transfer, part kept), `HashMismatch` and
  `SizeMismatch` (part removed), `Http`, `Cancelled`, `Unverified`. A finished download removes the model's other
  versions. `delete_model` removes `<root>/<name>`. About 13 MB/s from the Hugging Face CDN here (curl: 16 MB/s).
- **Runtime** (`ai::Session::load(path, &SessionOptions)`, `load_model(entry, dir)`): `ort` 2.0.0-rc.13 with ONNX
  Runtime linked statically from pyke's prebuilt binaries (fetched by `ort-sys`' build script into
  `~/Library/Caches/ort.pyke.io`). CoreML EP on macOS: ML Program, all compute units, `RequireStaticInputShapes`,
  the model cache dir, graph optimisation level 1, intra-op threads `min(cores, 8)`, no `error_on_failure` (so a
  failed EP registration runs on the CPU). If loading with CoreML fails, the cache is cleared and the load retried
  (a process killed while Core ML compiled leaves a half-written cache that otherwise fails every later load), then
  the CPU EP is used. `run(&[(name, Tensor::F32|F16|I64(view))])` returns `Outputs` as `f32` arrays; `warm_up(n)`
  runs zeros of the static shapes. Each session captures ONNX Runtime's log while loading (verbose, kept in memory)
  and `log_compute_plan()` prints once per model: provider, partitions, supported/total nodes, the op types CoreML
  rejected, load time, inputs and outputs (`[photobook:ai]`). `SessionOptions::profile_compute_plan` additionally
  asks Core ML for its per-operation plan, which Core ML prints to stderr itself.
- **Measured** (M3 Pro, SkyWater-Seg fp16 at 384 px, `cargo test -p photobook-develop --test ai -- --ignored
  --nocapture`): CoreML 17 partitions, 806 of 838 nodes; the 32 `Gather` nodes CoreML rejects are the attention's
  k/v selection (`Gather with scalar 'indices' supports 'data' rank up to 4`, the tensor is rank 5). Median run
  65–74 ms with CoreML, 135–250 ms on the CPU EP; first load with compilation about 25 s, then about 6 s with the
  cache; the CoreML cache takes 274 MB for the 48 MB model. A blue-over-green synthetic image comes back 100 % sky
  in the top 40 % and 0 % in the bottom 40 % on both EPs. The plan's "about 3 ms, one partition" needs the graph
  rewritten (Gather → Slice/Squeeze, or a re-export) first.
- **Build cost**: the editor's debug binary grows from 76.2 MB to 91.4 MB (+15.2 MB). Incremental `cargo build -p
  photobook-editor` after touching the editor or this crate stays at 5–8 s (5–7 s without `ai`; noisy, other builds
  were running). A clean build fetches ONNX Runtime once (about 9 MB compressed) and compiles rustls/aws-lc for the
  downloader. `ort`, `ndarray` and `half` have `opt-level = 3` in the dev profile; the TLS stack made no
  measurable difference at 3 and stays at 0.

## AI denoise (D5.1)

`ai::tiling` and `ai::denoise` (feature `ai`). An explicit action, like Lightroom's Enhance: the editor runs it once
per photo and settings key and the develop pipeline then decodes the result instead of the source.

- **Models**: `nafnet-w32` → `nafnet-sidd-width32` (primary; ailia's fp32 ONNX, pinned in D5.1 by hashing a
  download: 117,115,760 bytes, SHA-256 `c3af4811…bd4ead4`; input `inp` [1, 3, h, w] dynamic, fixed to 512² by
  `dims`), `scunet` → `scunet-color-real-psnr` (fallback, 512²), `nafnet-w64` → not in the manifest yet
  (`Error::UnknownModel`). Where the files come from and how to re-export NAFNet: `scripts/models/README.md`.
- **Sessions**: `DenoiseSessions::new(ModelDir)` loads an engine per model on first use and keeps it
  (`engine(model)`; `forget(model)`). `DenoiseEngine::load` uses CoreML unless the model is in `CPU_ONLY_MODELS`
  (SCUNet) or CoreML splits it into more than `MAX_COREML_PARTITIONS` (8) partitions, then the CPU EP. The tile size
  is the manifest's static input (512). Inputs are fed as f32 (f16 when the graph wants it).
- **Pipeline** (`denoise(sessions, image, settings, progress, cancel)`, `denoise_with(engine, image, settings, opts,
  progress, cancel) -> (image, DenoiseStats)`):
  1. linear Rec.2020 → sRGB primaries, clamped, sRGB-encoded (what the models were trained on), per tile;
  2. `tiling::tile_plan(w, h, 512, 48, 16)`: the image reflect-padded to a multiple of 16 and at least one tile,
     tiles evenly spaced with at least 48 px overlap (117 tiles for 6000 × 4000); `tiling::Blender` accumulates the
     outputs with a separable raised-cosine window (ramps only towards neighbours) normalised by the accumulated
     weight, in `f64`, holding one tile row: a constant blends back bit-exactly. One tile in flight; `progress(done,
     total)` after each, `cancel` polled before each (`Error::Cancelled`);
  3. the model's change applied as a residual in linear light (`x + dec(out) − dec(enc(x))`), so highlights above 1
     and colours outside sRGB pass through;
  4. Oklab per channel: L by the frequency-aware merge (`ai::merge`, workflow plan 25, below; it was the flat
     `lerp(L_in, L_out, luminance/100)`), `ab = lerp(ab_in, ab_out, chroma/100)`
     (`blend_lab`, exact at 0 and 100) with `chromaMode: model`; with `chromaMode: filter` (the default, workflow
     plan 24) `ab = ab_in`, and the render applies the chroma filter (below) at `chroma/100`;
  5. a luminance-only unsharp mask on Oklab L: `L += 0.05·tanh(k·(L − G_σ L)·mask / 0.05)`, `k = sharpen/100`,
     σ = 0.8 reference px (scaled by the *full* image's `min(w, h)/1080`, so the 512 px tuning crop matches the full
     run via `DenoiseOptions::reference_size`), mask = smoothstep(0.02, 0.06) of the Sobel magnitude of `G_σ L` per
     reference px, smoothed by σ: flat areas, where the leftover noise is, are not sharpened.
- **Intermediate**: `denoise_key(hash, model, model_version, luminance, chroma, sharpen, chroma_mode)` = SHA-256 hex
  of those (strengths to 2 decimals; the chroma part is `model:<chroma>`, or just `filter`, since the filter runs at
  render time), `DENOISE_ENGINE` (`denoise/2`; `denoise/1` intermediates are simply not reused) and the L merge
  (`merge:wavelet`, `ai::merge::MERGE`, since workflow plan 25: intermediates made with the flat blend get new keys). `write_intermediate(path, image, key)` writes a
  16-bit RGB PNG (fast deflate) with **Rec.2020 primaries and the sRGB tone curve**, tagged with a matching ICC
  profile so viewers show it correctly and `decode_file` reads it too; values are divided by `scale =
  clamp(max, 1, 16)` (1 for JPEG sources) so RAW highlights survive. The sidecar `<name>.json` (written last, so it
  marks a complete file) holds `{key, width, height, engine, encoding, scale, isRaw, asShot, camera}`: the RAW white
  balance data survives the substitution. `read_intermediate(path)` / `read_intermediate_fit(path, max_long_edge)`
  decode it exactly (65,536-entry table; round trip within 1/65535 of the encoded value);
  `intermediate_ready(path, key)`, `prune_intermediates(dir, keep)`.
- **Editor** (`commands/develop.rs`): `<appdata>/cache/<hash>/develop/denoise-<key>.png` plus a 1600 px
  `denoise-<key>-proxy.png` for the working proxy; the three most recent keys' files are kept per photo (`KEEP_DENOISE_KEYS`). Commands
  `denoise_status`, `run_denoise` (progress `develop:denoise-progress`), `cancel_denoise`, `preview_denoise_crop`;
  `render_develop_cached` reports `denoiseStale` while the intermediate is missing; the render's meta file records
  which denoise file (if any) it was made from, and a cached render made from another input is redone.
- **Measured** (M3 Pro, release, `cargo test -p photobook-develop --release --test denoise -- --ignored
  --nocapture`): NAFNet-w32 runs entirely in Core ML (1 partition, 1246/1246 nodes; load 0.5–1.8 s with the
  cache), about 111–136 ms per 512² tile (CPU EP: about 640 ms); a 24 MP image is 117 tiles, 13.1 s of inference and
  13.8 s in all (0.24 s blend and sharpen), well under the plan's 20 s. The intermediate of that (noisy synthetic)
  image is 144 MB, written in 0.45 s and read back to a 1600 px proxy in 0.25 s. SCUNet on CoreML splits into 141
  partitions (Einsum, dynamic Reshape/Slice) and took 72 s for one tile, hence CPU only: 4.4–4.9 s per tile, 708 s for 24 MP
  (other builds were running), so SCUNet is a crop-sized or small-image fallback until it is re-exported for CoreML. On a synthetic 1536 × 1024 scene (σ 0.05 grey noise plus blotchy chroma noise, 25.5 dB) NAFNet
  reaches 31.3 dB and SCUNet 39.0 dB: NAFNet-SIDD leaves strong channel-correlated synthetic noise (a flat field
  with it goes 26.0 → 32.7 dB in Python's ONNX Runtime too), while on independent per-channel noise it goes 26.0 →
  39.9 dB. Tile seams on a flat region: the column-mean step across tile edges is 0.84 levels (NAFNet) and 0.09
  (SCUNet), the same as inside tiles.

### Wavelet luminance merge (workflow plan 25)

`ai::merge`, used by `denoise::finish` (CPU only). The Luminance slider no longer blends the input's and the model's
L flatly: an à trous B3-spline decomposition (kernel `[1, 4, 6, 4, 1]/16` at dilations 1, 2, 4; edges mirrored
without repeating the edge sample; filters in difference form so a flat plane stays flat) splits L into three bands
and a residual. At strength `t = luminance/100` the finest band (1–2 px, the grain) is `lerp(in, out, t)`, and the
two coarser bands and the residual are `lerp(in, out, min(1, t / 0.1))` (`COARSE_RAMP`): the model's from Luminance 10
up, ramping in from the input's at 0 so the merge is continuous there. The decomposition is linear, so the merge
decomposes only `D = L_in − L_out` and adds `Σ (1 − w_k)·d_k(D)` to `L_out`, stopping after the last band whose weight
is not 1: one level (a reach of 2 px each side) from Luminance 10 up, all three (14 px) below. Luminance 100 and 0
return `L_out` and `L_in` bit for bit, so results (and PSNR) there are unchanged. A non-finite model value takes the
input's before the filters. The merge runs once per intermediate on the whole image after the tiles are blended, so it
needs no tile halo; it holds up to five extra f32 planes at once (about 0.5 GB at 24 MP, none at Luminance 100).

Every 0 < Luminance < 100 intermediate changes and the key names the merge (`merge:wavelet`), so no `DENOISE_ENGINE`
bump. The editor's cached proxy and thumbnail renders record the denoise key they were made from and are redone once
the new intermediate exists, but full-size renders (`<source>/.photobook-cache/develop/`) and exports made from a
flat-merge intermediate are keyed by the develop hash, which does not include the denoise key, so they keep their
pixels until a setting changes. There is no engine bump for that either: nothing has been released since plan 19's
`develop-engine/3` bump invalidated every earlier render, so only renders made in between from an unreleased tree are
affected.

Measured (M3 Pro, release, `--test denoise merge_timing -- --ignored`): 53 ms for a 24 MP plane at one level, 110 ms
at three. A WGSL port was written and matched the CPU but took 64–78 ms (mostly the planes' upload and readback) and
nothing renders the merge interactively, so it was dropped. On a Fujifilm X100VI ISO 6400 camera JPEG (σ 3.4 % of
mid-grey; `iso6400_grain_crop_compare`, NAFNet, Colour 75 through the chroma filter, no sharpening), what Luminance
50 leaves on top of the model's result is 0.44–0.46 of the input's noise in RMS, against 0.5 for the flat blend:
its finest band is 94–95 % of the flat blend's (the grain, slightly less because the à trous bands overlap) and its
coarse bands 50–52 % (the blotches). The 200 % crops show the grain the flat blend kept, without its mottling. On the
synthetic fixture at Luminance 50 with a perfect "model" PSNR is 32.8 dB against 31.8 dB for the flat blend (model
colour), 30.9 against 30.4 dB (filter).

## Chroma filter and mask noise (workflow plan 24)

`ops::noise` (CPU reference), `gpu::noise` + `shaders/noise.wgsl` (GPU). Classical colour noise reduction that
replaces the denoise model's a/b by default (`Denoise.chroma_mode`, `ChromaMode::Filter`) and implements the masks'
`noise` slider. It runs first in the chain on the decoded (warped) input, before white balance; the local pre-passes
(highlights/shadows, clarity, dehaze, ...) stay computed from the unfiltered input.

- **Coarse stage** (`noise_planes`, cached in `PrePasses` by `NoiseKey`): Oklab L and the chroma ratios `a / max(L,
  0.1)`, `b / max(L, 0.1)` averaged over `guided_subsample(radius)` cells (a quarter of the resolution from an 8 px
  radius). Ratios, because scaling linear RGB scales L, a and b alike: a one-hue texture keeps its ratio while its
  lightness varies, so detail finer than the cells keeps its colour. On the coarse grid `chroma_coefficients` solves
  the guided filter of each ratio with L as the guide and a fit test: the window's residual variance (a + b) against
  the noise floor of its lightness (the 25th percentile of the residuals in each of 8 bands of the window's mean L,
  linear between band centres) gives a weight `min(1, 3·floor / residual)`, so the filter steps back where a linear
  model of colour against lightness does not hold (two hues of similar lightness, multicoloured texture) but not in
  the shadows just because they are noisier. ε grows below mid-grey as read noise does in L, `ε·(0.5646 / L)⁴`. With a mask
  `noise`, a self-guided filter of L (half the radius, at least 2 reference px) is solved too.
- **Per pixel** (`apply_row`, `noise_apply` in WGSL): the coefficients and the fit upsampled bilinearly, applied to
  the pixel's own L (joint upsampling): `a' = (ā·L + b̄)·max(L, 0.1)`, `a = a·(1 − t·fit) + a'·t·fit`, `t` = the
  Colour slider plus `Σ w·noise/100` of the masks (clamped to 1); L moves only under a mask, by `0.6·Σ w·noise/100`.
- **From σ** (`ImageMeta::noise_sigma`, the editor fills it from `noise.json`: plan 23's `measured.sigma`, quantised
  to 3 significant digits by `chroma_sigma`, the ISO when there is no fit, else 2 % of mid-grey): radius
  `clamp(3·sqrt(σ as % of mid-grey), 3, 20)` reference px, ε `(0.5·1.0456·σ)² + 1e-6` in L². The editor measures the
  photo before a render that needs σ (`commands::develop::developer_for`, `decode_full_input`).
- **GPU**: `noise_cells` writes the coarse cells, which are read back; the coefficients come from the same CPU code
  (`planes_from_cells`, about a millisecond for a preview) and are uploaded once per input and key; `noise_apply`
  runs per render tile into a tile-sized texture (at most 2048² × 16 B) the chain starts from (`start_image`,
  binding 20, read at the tile's own coordinates), while every guide still reads the unfiltered input; the masks'
  local amounts are one CPU plane uploaded per tile window. `tests/noise.rs` compares CPU and GPU (chroma, chroma with
  tone and clarity, mask noise, a warp, tiled, and the coarse grid at 1/2 and 1/4 on a 1601 px wide image, whole and
  in 512 px tiles): at most 1 level apart, mean at most 0.001.
- **Editor caches**: the cached proxy's meta records the σ it used and is redone when `noise.json` gives another
  (or none: a failed measurement fell back to the ISO); a cached `Developer` is decoded again likewise. Measurements
  (`commands::noise::ensure_record`) run at most two at once and once per photo.
- **Measured** (M3 Pro, release): a Colour slider drag on a 1600 × 1067 image costs 14–16 ms per frame on the CPU
  (8 ms without the filter) and 5–16 ms on the GPU (3–7 ms without; the range is other builds running), after a
  first frame that computes the coarse stage (46 ms CPU). The whole filter on a 24 MP image takes 0.34 s on the CPU.
  On the synthetic denoise fixture (σ 0.05, 25.5 dB) NAFNet with its own colour reaches 31.29 dB and NAFNet with the
  filter 31.92 dB (a/b RMS error 0.0111 → 0.0085); the filter alone on that scene with light noise goes 36.9 → 38.3
  dB. Read-noise shadows (Y ≈ 0.02) keep 18.0 % of their chroma noise against 17.3 % in the mid-tones (29 % with one
  global floor and ε).

## Noise profiles (workflow plan 23)

`ai::noise_profile` (pure Rust, under the `ai` feature because it feeds the denoise) and `decode::camera_exif`
(make, model and ISO from Exif or, for RAW, rawler's metadata; names cleaned so a camera's JPEGs and RAWs agree).

- **Self-profile** (`measure(&LinearImage) -> NoiseFit`): 16 px blocks of the linear image (the editor passes the
  1600 px working decode); per block and channel the mean and the plane-detrended variance; a block is flat when the
  high-pass (Immerkær 3×3) share of its variance is high (adaptive threshold); per channel `variance = a·mean + b` is
  fitted on quantile bins (lower-quartile variance, monotone lower envelope, weighted least squares, one outlier
  round, `a, b ≥ 0`, blocks with a mean above 0.6 left out). `NoiseFit { channels: [{a, b}; 3], sigma, confidence,
  patches, range, extrapolated, width, height }`; `sigma` is σ at mid-grey (0.18) in linear units at the analysed
  size, `confidence` is `1 − exp(−patches / 300)` over the fitted blocks, halved per two stops mid-grey lies outside
  `range` (`extrapolated`); under 12 fitted blocks (a bright snow picture) or a channel without noise there is no fit
  (σ 0, confidence 0), and `NoiseFit::is_valid` is false. Recovers `a` and `b` within 10 % on synthetic Poisson-Gaussian
  noise; well under 0.1 s for a 1600 px image (release).
- **Learned profiles** (`ProfileStore`): `<dir>/<make>-<model>.json` (version 2; both names required, slugged,
  at most 80 characters; a non-ASCII name becomes a hash) `{ version, make, model, raw: { iso: entry }, processed:
  { iso: entry } }`, entry `{ fits: [{ a: [3], b: [3], sigma }] (the newest 16), n, photos }` (`photos` are hash
  prefixes so a photo counts once). The entry's curve is the component-wise median of the fits within 2× of the
  median σ, *established* (used) once 3 agree. `learn` refuses invalid fits, empty or non-hex hashes and confidence
  under 0.3, and, once established, fits more than 2× off; a file of another version or unparseable is copied to
  `.json.bak` first. `lookup` / `profile_at` return `CameraProfile { make, model, source, iso, channels, sigma,
  photos, totalPhotos, agreeing, established, interpolated, distance, isos }` from established entries: exact,
  log-log interpolated between neighbours, or scaled from the nearest (`a ∝ ISO`, `b ∝ ISO²`), never more than 2 stops
  away; `confidence()` is 0 unless established and halves per stop of `distance`. `blend(fit, learned)` weighs the two
  by confidence.
- **Measured** (`cargo test -p photobook-develop --release --test noise_profile -- --ignored --nocapture`): σ / 0.18
  is about 0.35 % for 8-bit quantisation alone, 2.3 % for a synthetic ISO 12800-like JPEG (5 % before 4:2:0
  subsampling and compression), 1.1–2.1 % for base-ISO RAW decodes, 2.8–4.6 % for ISO 800–1600 RAWs and 12 % for an
  ISO 12800 RAW (the ON1 samples). The editor's `suggestedAmount` (`apps/editor/src/lib/denoise.ts`) maps RAW and
  processed σ on separate log scales for that reason.
- **Editor** (`commands/noise.rs`): `noise_profile`, `camera_profile`, `learn_profile`; the measurement is cached in
  `<appdata>/cache/<hash>/noise.json` and the profiles live in `<appdata>/noise-profiles/`.

## Photo stats (plan 38)

`stats` (pure Rust, no feature; `image_hasher` is MIT / Apache-2.0) gives the cull six numbers and a hash per photo,
computed by the editor's `prepare` on the upright 1600 px proxy it has just made (`commands/assets.rs`). They rank and
explain; the thresholds live in the editor. Nothing here is part of the develop hash.

- `photo_stats(gray, rgb, w, h, sigma) -> PhotoStats { sharpness, sharpness_max, sharpest_tile, motion, clip_high,
  clip_low, median_lum }`: the 4-neighbour Laplacian's variance per tile of an 8 × 8 grid less `20 σ²` (σ given, or
  Immerkær's estimate from the lower-quartile tile); `sharpness` the tile mean, `sharpness_max` the best tile and
  `sharpest_tile` its index (`row * 8 + column`); `motion` is `1 − λmin / λmax` of the summed unit-trace gradient
  tensors of the textured tiles, scaled down when under half the tiles have texture; `clip_high` any channel ≥ 250,
  `clip_low` every channel ≤ 5, `median_lum` the median Rec. 709 luma (0 to 1). `luma(rgb)` gives the gray plane.
- `phash(gray, w, h) -> u64`: box-averaged to 64 × 64, then `image_hasher` Median + DCT (the pHash recipe), Hamming
  distance between two.
- `decode::camera_exif` also reads `taken` (epoch ms of `DateTimeOriginal` + `SubSecTimeOriginal`, else `DateTime`,
  read as UTC; "05" is 50 ms), `lens`, `focal` and `serial` (rawler's metadata for CR3 and RAF).
- Fixtures: `tests/fixtures/stats/` (sharp, defocused, panned, bokeh portrait, blown, dark, silhouette, high-key;
  synthetic, CC0, `scripts/make-stats-fixtures.py`, with a Python `reference.json` of the clip shares and median).
  `--test stats` checks the ranking (sharp first; the portrait not below the defocused frame), motion > 0.6 on the
  panned frame only, the clip shares within 1 % of the reference, the hash distances and the Exif.
- `palette(rgb, w, h) -> Vec<String>` (plan 56): five `#rrggbb` colours, the largest cluster first: k-means (k-means++
  from a fixed xorshift seed, at most 12 Lloyd passes) in Oklab over the image box-averaged in linear light to 240 px on
  the long edge, so the same pixels always give the same palette. About 4 ms on a 960 × 640 frame (release); the
  storytelling sorts (`packages/shared/src/cull/sorts.ts`) read it.
- Cost: on the lisbon-demo JPEGs `prepare` went from about 60 to about 71 ms a photo (best of three, M-series, the
  `prepare_timing_lisbon` ignored test in `src-tauri`), under the 20 ms budget, so the stats stay in the same pass.

## Preview modes (plan 53)

`preview_modes` draws Cull's *Assist* overlays over the 8-bit output of a preview, after the develop and outside it:
`PreviewMode::FocusPeak | Zebra`. Only the editor's `render_develop_preview` takes them (its `modes` argument, focus peak
first); they are not settings, so they never reach `develop_hash`, the canonical JSON, a cached render or a full render,
and `render_preview_image_with` (the preview before its encode) is what they draw on. No feature gate.

- Focus peak: Rec. 709 luma in integers (`(54 R + 183 G + 19 B + 128) >> 8`), its 4-neighbour Laplacian (edges clamp),
  `≥ PEAK_THRESHOLD` (64) painted the brass accent at 60 %.
- Zebra: diagonal stripes 4 px wide, dark at 70 % over pixels with any channel `≥ stats::CLIP_HIGH`, light at 35 % the
  other way over pixels with every channel `≤ stats::CLIP_LOW` (plan 41's clip test per pixel).
- Both (`apply_preview_modes`, the GPU pass's bit flags): each test reads the plain pixels; focus peak is painted
  first and zebra over it.
- `apply_preview_mode_cpu` is the reference; `gpu::preview_mode` (`gpu/preview_mode.rs`, `shaders/preview_mode.wgsl`:
  one `u32` per pixel up and back, the constants printed from the Rust ones) does the same integer maths, so the two are
  equal (`--test preview_modes` asserts equality on the fixtures at 1600 px and at an odd size, every set of modes). `apply_preview_mode` takes the GPU as a render does and the CPU under `PHOTOBOOK_FORCE_CPU` or on any error.

## AI masks (D4.3)

Feature `ai`. `ai::segment::generate(component, &GenerateContext)` is the whole flow; the editor's `generate_ai_mask` /
`sam_refine_mask` commands call it and store the result with `masks::ai_cache`.

- **Targets** (`ai::segment`, unrefined planes on the picture's grid):

  | Target | Models | Input | Output → plane |
  | --- | --- | --- | --- |
  | Subject | BiRefNet lite | 1024², letterboxed, ImageNet | `output_image` logits → sigmoid |
  | Background | BiRefNet lite | as Subject | `1 − subject` (`background(subject, Some(sky))` can union the sky; the command does not) |
  | Sky | SkyWater-Seg | 384², stretched, ImageNet | `output_fp32` 4 logits resized to the picture, softmax; the `sky` class (`SkyResult` also has water, person, background) |
  | People | RT-DETR v2 → SAM 2.1 tiny | 640² stretched, RGB/255 → 1024² letterboxed, ImageNet | class-0 score > 0.5, NMS IoU 0.5 → one SAM box prompt per person (best of 3 masks by predicted IoU), merged by max; the boxes are returned (transformed-frame fractions) so the UI can make one component per person with a box prompt |
  | Prompts (Subject/Background/People with `prompts`) | SAM 2.1 tiny | 1024² letterboxed | points together (positive 1, negative 0); each positive box decoded with all points, merged by max; `input_boxes` is `[1, 0, 4]` without a box |
  | Depth | Depth Anything V2 Small | 518² stretched, ImageNet, bicubic | relative inverse depth → `0` near … `1` far between the 1st/99th percentiles (`DepthMap`, raw kept too); the raster is `depth_range_plane(depth, depthRange ?? [0, 1], 0.05)` |

- **Preprocessing** (`ai::preprocess`): linear Rec.2020 → sRGB primaries, clamped, sRGB transfer (the models are trained on
  JPEGs); `fast_image_resize` convolution (bilinear, Catmull-Rom for depth) into the input; letterbox pads right/bottom
  with the ImageNet mean (0 after normalising). `unletterbox` copies the content box out first (so the filter never reads
  the padding) and resizes it to the picture; SAM's 256² masks map through the same frame.
- **Refinement** (`ai::refine`): the plane is upsampled to the working size and guided-filtered against the picture's
  sRGB luminance, radius 8 px at a 1080 px short side (scaled), eps 1e-3, clamped. Depth maps are refined the same way
  before the range is applied.
- **Frame and cache** (`masks::ai_cache`): the models see the decoded proxy turned and flipped as `geometry.rotate`/
  `flipH`/`flipV` say (`InferenceFrame`, an exact pixel permutation; Upright, Transform, straighten and crop are left
  out), prompts are mapped from the transformed frame through the inverse perspective, and the result is permuted back,
  so **rasters are stored on the decoded image's grid** (the 1600 px proxy). Renders map every output pixel through
  `GeometryPlan::inverse` and sample the raster bilinearly (`MaskPlane::warp_into`), so a raster follows the content
  through crop, straighten, Upright, rotate and flip without regenerating, and the preview, overlay and full-size export
  read the same file. Files: `<appdata>/cache/<hash>/develop/masks/<componentHash>.png` (8-bit grey), depth maps as
  `depth-<model>-<version>.png` (16-bit; every range of that model version reads it, no model run). `componentHash`
  covers target, model, version, prompts and depth range; `stamp_model` sets `model`/`modelVersion` to the model used.
  `AiRasterCache` is a 96 MB LRU over the files (misses re-read the disk, so a raster written later is found);
  `ImageRasters` binds it to a photo for `Developer::set_ai_rasters`, and `with_ai_source` installs one for one-shot
  renders on the calling thread. Layers with a missing raster are not cached (CPU or GPU).
- **Sessions** (`segment::Sessions`, `load_session`): loaded once per model. A model whose CoreML load fell back to the
  CPU gets a `coreml-unsupported` marker in its version folder and later loads skip CoreML (a failed compile costs
  minutes each time); deleting or updating the model removes the marker.
  Updating a model (a new `version`) removes the old version folder, marker included (checked: the downloader's
  `prune_other_versions` deleted `fp16-…/coreml-unsupported` and the new folder started without one).
- **Why BiRefNet stays on the CPU**: the fp16 and the fp32 `onnx-community/BiRefNet_lite-ONNX` graphs fail Core ML's
  ML Program parser on the same dilated `Conv` in the decoder's `aspp_deforms` (no `pads`), so a different precision
  does not help; `onnx-community/BiRefNet-ONNX` (full size, 490 MB fp16 / 973 MB fp32) shares that module and was not
  tried. Fixing it needs the graph rewritten (explicit `pads` on those `Conv` nodes) or a re-export. Meanwhile the
  manifest also lists U²-Netp as task `subject-fast` (Apache-2.0): it compiles as one CoreML partition and runs in
  about 0.2 s. Subject and Background use it when BiRefNet lite is not installed and U²-Netp is (`model_for`); a mask
  made with U²-Netp is reported as outdated once BiRefNet lite arrives, so Regenerate upgrades it. The SAM encoding is kept per picture and
  rotation (`LastSamEncoding`), so clicks only run the decoder.
- **Measured** (M3 Pro, release, `--test ai_masks -- --ignored --nocapture`, 1600 px proxies of `fixtures/lisbon-demo`;
  the machine had a load average of 20–30 from other builds, so treat times as upper bounds):

  | Model | CoreML partitions (nodes) | Load: first / cached | Run (warm) |
  | --- | --- | --- | --- |
  | SkyWater-Seg | 17 (806/838; `Gather`×32 on CPU) | 25 s / 6–35 s | 95–105 ms incl. pre/post, 233 ms first |
  | RT-DETR v2 | 13 (1224/1255; ScatterND, Log, TopK… on CPU) | 18–21 s / 5 s | 165–270 ms (2 s first) |
  | SAM 2.1 encoder | 19 (463/517; Reshape×36, Transpose×18) | 44–50 s / 15 s | 0.5–1.1 s (4.7–7 s first) |
  | SAM 2.1 decoder | CoreML fails (`error code: -14` building the dynamic ML Program) → CPU | 0.1 s | 36–60 ms per prompt; ~50–130 ms per person |
  | Depth Anything V2 S | 13 (674/710; Gather×36) | 51–57 s / – | 124–168 ms (1 s first) |
  | BiRefNet lite fp16 | CoreML fails (ML Program parse: dilated `Conv` without `pad`; 47 partitions, 2925/4177 nodes attempted) → CPU | 4–6 min wasted once, then ~9 s | **5.5–7 s on the CPU EP** (8–46 s under heavier load) |
  | BiRefNet lite fp32 (tried, not shipped) | the same failure (`aspp_deforms.2/atrous_conv/Conv: Required param 'pad' is missing`; 47 partitions, 2839/4083 nodes attempted) → CPU | 196 s once (two CoreML attempts, then the CPU), then the marker skips CoreML | 5.8–7.0 s on the CPU EP (fp16 on the CPU: 7.8 s in the same run); masks identical to fp16 (mean abs difference of the sigmoids below 0.0001) |
  | U²-Netp (`subject-fast`, 4.7 MB, 320²) | 1 (371/371 nodes) | 0.8 s (first load compiled in under a second) | 160–230 ms for the model alone, 965 ms first; on IMG_10 the mask agrees with BiRefNet lite at IoU 0.99 (mean abs difference 0.002) |

  Refinement plus the frame mapping adds about 20 ms at 1600 px. Masks: Subject picks the pastry on the plate, the tram,
  the pastries and the door cleanly; rotating 90° gives the same raster (mean difference 0.0001). Sky separates the arch
  and the bridge from the sky (soft around thin cables); People finds 25 people on the square and 23 on the street;
  depth's near third is the foreground on street and rooftop scenes. There is no portrait in the fixtures, so the
  plan's hair-line check is not done.

## Choices worth knowing

- **Display look**: the fixed sigmoid (mid-grey 0.18 → 0.46 encoded) is implemented but off by default
  (`RenderOptions { look: true }` turns it on). With it on, white lands at 217, which breaks "defaults are a
  no-op" for JPEG/PNG input, and the plan's no-op check wins.
- **Curves** act on the output-encoded sRGB values. `luma` is the composite curve applied to all three
  channels, then `red`/`green`/`blue`.
- **Colour mix bands** use the plan's centre/width table on the sRGB hue wheel (red 0°, green 120°, ...).
  Each pixel's OKLCH hue is mapped onto that wheel first, then hue/chroma/L are changed in OKLCH. σ = width / 3.
- **White balance**: `incremental` shifts ±1 mired per unit around 6500 K (tint 1:1), `absolute` adapts
  (Kelvin, tint) to D65, `asShot` does nothing.
- **Highlights/shadows base**: a guided-filter base (see Detail above), computed once per `Developer`. Exposure
  and white balance rescale it analytically, so slider drags never recompute it.
- **ICC**: non-sRGB RGB input profiles go through `moxcms`; sRGB-like ones take the exact analytic path;
  grey, CMYK or broken profiles are ignored (treated as sRGB). PNG gAMA/cHRM/cICP are ignored. Output JPEGs
  carry the compact profile of their output space in APP2 (`color::output`, about 530 bytes): a v4.3 matrix/TRC
  display profile assembled by hand (Bradford-adapted colorants, `chad`, one shared `para` sRGB curve), not
  `moxcms`'s encoder, which adds a `cicp` tag with narrow range and, for Display P3, SMPTE 431 (DCI-P3) primaries.
  The P3 colorants equal Apple's `Display P3.icc` exactly; `tests/color.rs` checks the tags through `moxcms`
  (within 6e-5 of the analytic XYZ) and through ColorSync (`sips --matchTo`).
- **Output profile** (D6.2): `RenderOptions::output` (the book's `outputProfile`) swaps the output matrix and the
  gamut mapper's Oklab converter; the GPU reads both from its uniform block (`to_srgb`, `out_to_lms`,
  `out_from_lms`), so the shader needs no branch. CPU and GPU agree within 1 level in either space. Render file
  names carry `OutputProfile::file_suffix` (`-p3`) after the develop hash, which stays profile-free.
- **Exif**: `copy_exif` copies the source APP1 and rewrites Orientation to 1, because rendered pixels are
  already upright. Other tags (thumbnail, pixel dimensions) are copied as they are.
- **HEIC** (D6.2, macOS, feature `heic-imageio`, on by default): ImageIO decodes the primary image at its bit depth
  (10-bit iPhone HEICs stay 10-bit), CoreGraphics draws it over white into a 16-bit half-float RGBA bitmap in
  `kCGColorSpaceExtendedLinearSRGB` (ColorSync applies the file's ICC or nclx colour; P3 colours outside sRGB
  stay negative / above 1 instead of clipping), then BT.709 → BT.2020; `kCGImagePropertyOrientation` (from HEIF
  `irot`/`imir`) is applied after the downscale. A 12 MP HEIC decodes in about 0.55 s (release, M3 Pro), versus
  1.2 s for `sips` to a 16-bit PNG; the mean linear colour matches that PNG within 1e-4
  (`--test color -- --ignored`). Elsewhere HEIC is `Error::Unsupported`.
- **CMYK JPEG** is not decoded here. The editor converts it with `sips` first.

## RAW input (D6.1)

`decode_file` sends RAW extensions (`decode::RAW_EXTENSIONS`: `.dng .cr2 .cr3 .arw .raf .nef .orf .rw2 .pef .srw` and
other `rawler` formats; `is_raw_path` for the editor's scan) to `decode::raw::decode_raw`, which returns the image and a
`CameraData` (make, model, ISO, exposure, orientation, as-shot neutral and multipliers, colour matrices, black/white
levels, `BaselineExposure`). Behind the `raw` feature (on by default; `--no-default-features` makes RAW files
`Error::Unsupported`). `rawler` 0.8 (dnglab, LGPL-2.1) covers about 870 models, CR3 and X-Trans included.

Pipeline, the plan's default without camera profiles (section 4.4):

1. `rawler` decodes the mosaic; black and white levels scale it to 0..1.
2. As-shot white balance on the mosaic: each sensel times `1 / AsShotNeutral` of its colour (the maker's multipliers for
   proprietary formats), smallest multiplier 1, then clipped at 1, so blown highlights go white rather than magenta
   (dcraw `-H 0`; no highlight reconstruction).
3. Demosaic (`rawler`: PPG for Bayer, bilinear for X-Trans), active area and default crop.
4. Colour through the matrix (`color::camera::CameraColor`): the as-shot white is the chromaticity whose camera neutral
   is the as-shot neutral (DNG `NeutralToXY`, iterating because the colour matrix is interpolated in mired between its
   two calibration illuminants by that white's CCT); camera → XYZ by the inverted matrix scaled so the neutral has
   Y = 1, CAT16 from that white to D65, XYZ → Rec.2020. White-balanced (1, 1, 1) is Rec.2020 (1, 1, 1). Negative
   (out-of-gamut) values are kept; the output stage gamut-maps.
5. `BaselineExposure` as `2^BE`: the DNG tag when present, else `decode::raw::DEFAULT_BASELINE_EXPOSURE` (+1 EV; every
   proprietary format, whose per-model value lives in Adobe's database). See "Exposure" below.
6. Downscale to `max_long_edge` in linear light, then the orientation from the file's EXIF.

White balance: `LinearImage::meta` carries `is_raw`, `as_shot: (Kelvin, tint)` and the camera colour data. With it,
`WhiteBalance::Absolute { temperature, tint }` re-solves the balance through the camera matrix
(`CameraColor::rebalance_rec2020`: camera→Rec.2020 at the new white times the inverse at the as-shot white), so the
as-shot values are a no-op and other values match a camera that recorded that white. `decode::camera_as_shot_kelvin_tint`
gives the numbers for the UI. Rendered files keep the old meaning (Kelvin/tint → D65). The meta survives the geometry
warp and the linear resize, and every render entry point builds its `Params` with `Params::for_image`.

Display look: on by default for RAW. `RenderOptions::for_image(&meta)` is `look: meta.is_raw`, and `render_full`,
`render_full_with` and `render_preview` use it (JPEG/PNG renders are unchanged); `render_full_with_options` and
`render_preview_with` take explicit options. `Developer::render` also uses `RenderOptions::for_image` of its image, so
every default path turns the look on for RAW; `render_with` takes explicit options. The settings
have no field to switch the look off; a per-photo toggle would need a schema field (and would change the develop hash).

Exposure: measured with the ignored real-file test (mean luminance of the as-shot render with the look on against the
camera's embedded JPEG; rough, different tone curves and framing). Without a default baseline the renders were darker on
10 of 11 files (median −1.15 EV); with +1 EV, 10 of 11 are within ±0.5 EV:

| File | Camera | Before (BE 0) | After (BE +1) |
| --- | --- | --- | --- |
| ON1 Sample 1.nef | Nikon D300 | −0.61 | +0.37 |
| ON1 Sample 2.CR2 | Canon EOS 350D | −1.15 | −0.43 |
| ON1 Sample 3.NEF | Nikon Z 50 | −1.41 | −0.28 |
| ON1 Sample 4.CR2 | Canon EOS 5D Mark III | −1.19 | −0.24 |
| ON1 Sample 5.ARW | Sony ILCE-7RM2 | −0.32 | +0.50 |
| ON1 Sample 6.ARW | Sony ILCE-7RM2 (dark, ISO 1600) | +0.15 | +1.45 |
| ON1 Sample 7.CR2 | Canon EOS 6D | −0.93 | −0.13 |
| ON1 Sample 8.cr2 | Canon EOS 5DS R | −1.12 | −0.05 |
| ON1 Sample 9.nef | Nikon D300 | −1.27 | −0.26 |
| ON1 Sample 10.cr2 | Canon EOS Rebel T3i | −1.36 | −0.09 |
| ON1 Sample 11.ARW | Sony ILCE-7RM3 | −1.32 | −0.11 |

The one outlier is a night scene the camera kept dark. Grey-world temperatures were within about 300 K of the camera's
on 8 of 11 files (unchanged by the offset).

Editor scan helpers (no sensor decode): `decode::raw::raw_info(path)` reads the upright output size (active area and
default crop, the same as the full decode; checked on every sample), the orientation and the as-shot `(Kelvin, tint)`
with rawler's metadata-only ("dummy") decode in a few milliseconds (about 70 ms the first time, when rawler parses its
camera database); it errors for Fujifilm's 45°-rotated sensors. `decode::raw::embedded_preview(path, min_long_edge)`
returns the camera's embedded JPEG (preview, else full-size, else thumbnail image) as 8-bit RGB in stored orientation,
10–180 ms on the samples. Some are not the photo's framing (the ILCE-7RM3 embeds a 1920×1080 16:9 preview of a 3:2
sensor), so the editor checks the aspect ratio.

Cost: `rawler` has no reduced-resolution decode, so even a proxy decodes, demosaics and converts the whole sensor
before downscaling (0.2–1.3 s for 12–50 MP in release); peak memory is about 20 bytes per sensel. Make RAW proxies from
the embedded preview first.

Missing: Apple `CIRAWFilter` as the macOS complement (bodies `rawler` lacks, ProRAW), lens corrections (DNG opcodes,
maker notes), camera profiles (DCP, `ForwardMatrix`, `ProfileHueSatMap`, `ProfileToneCurve`), `AnalogBalance` and
`CameraCalibration`, 4-colour CFAs (CYGM, RGBE) and monochrome sensors, highlight reconstruction.

Tests: `cargo test -p photobook-develop --test raw` writes a 64×48 dual-illuminant DNG with a tiny TIFF writer (no
binary fixtures). `-- --ignored --nocapture` (with `--release`) also decodes the RAW files in `PHOTOBOOK_RAW_DIR` (default
`~/Pictures/ON1 Samples`), read only, prints make/model, as-shot Kelvin/tint, timings and a comparison with the
camera JPEG, and checks `raw_info` against the full decode.

## Not implemented yet

These settings are read but ignored until their steps land: `detail.denoise` inside the render (the editor substitutes the
denoise intermediate for the decode instead, see AI denoise above) and a mask's local `noise` (D5). The automatic Upright modes are solved by the caller (`geometry::auto`); renders
only apply the stored `upright.transform` (in any mode but `off`).

**Engine version.** `ENGINE_VERSION` is `develop-engine/4` (plan 55: the grading wheels' luminance offsets and the
Global wheel). Settings without them render byte-identical to `/3` on the CPU and the GPU: `tests/engine_bump.rs`
(ignored; needs the ON1 sample RAWs) renders 11 samples × 18 settings fixtures × CPU and GPU and compares a SHA-256
per render with the committed baseline `tests/fixtures/engine-bump/digests-engine-<n>.txt` of the current engine
(`UPDATE_ENGINE_DIGESTS=1` writes it; `PHOTOBOOK_BUMP_OUT=<file>` copies the digests out). The digests are the
writing machine's (Apple M3 Pro, Metal): regenerate the baseline before relying on it elsewhere. **Bump procedure**:
(1) with the engine unchanged, run the test and see it pass against `digests-engine-<n>.txt`; (2) change the maths
and run it again: every render whose settings do not use the change must still match (a GPU kernel edit can move
pixels under Metal's fast math even where the arithmetic is unchanged; plan 55 moved its new code into a separate
pipeline for that reason); (3) bump `ENGINE_VERSION` and `DEVELOP_ENGINE_VERSION`, regenerate the parity, look and
geometry fixtures, then write `digests-engine-<n+1>.txt` with `UPDATE_ENGINE_DIGESTS=1`, check it equals the old
file (`cmp`) when the bump changes no existing output, and run the test once more. `/3` was workflow plan 19, the one bump for the looks work: Effects, the 3D LUT and their GPU port. It
must change together with `DEVELOP_ENGINE_VERSION` in TypeScript, and
the parity fixtures be regenerated with it. Before that bump, 38 full renders made under `/2` (a real project, 8 of them
cropped) re-rendered pixel-identical, so settings without effects or a LUT render as they did; only their develop hash
(and so every cache and render file name) changes. The AI denoise intermediate is keyed separately (`DENOISE_ENGINE`),
so a change to denoise output does not need another bump of this one.

CPU timing on an M3 Pro (release, `PHOTOBOOK_FORCE_CPU=1 cargo test -p photobook-develop --release -- --ignored --nocapture`;
without the variable these tests now run on the GPU):
a 24 MP render with every slider set takes about 0.45 s; a 1600 px proxy takes about 28 ms to render and 3 ms to encode.
With every Detail control set too (`--test detail`), a 24 MP render takes about 0.78 s the first time (pre-passes),
0.37 s with them cached and 0.55 s after a sharpening-radius change; a 1600 px proxy 64 ms first, then about 30 ms per
slider change.
A 24 MP straighten warp takes about 165 ms with Lanczos3 and 75 ms with Catmull-Rom; warping it straight into a
2048 px preview (Mitchell prefilter + Catmull-Rom) about 135 ms (`--test geometry -- --ignored`). With Upright and
every manual slider set (constrained to 4744 × 3163) it takes about 133 ms with Lanczos3, 60 ms with Catmull-Rom and
163 ms into a 2048 px preview; a 2H+2V guided solve takes about 45 µs.

### σ-map denoise experiment (workflow plan 26, feature `denoise-drunet`)

`ai::drunet`, off by default (`cargo test -p photobook-develop --lib --features denoise-drunet drunet`). DRUNet
(KAIR/DPIR, MIT) takes the noise level as a fourth input channel. `SigmaCurve` holds the plan 23 per-channel curve
(`variance = a·mean + b`, Rec.2020) and a scale (1 when measured at full size; `for_full_size` scales a 1600 px fit
by the long-edge ratio, the white-noise bound); `sigma_plane` reads it per pixel at the blurred level, carried through
the Rec.2020 → sRGB matrix (independent channel noise grows about 1.6× in σ) and the slope of the sRGB curve, clamped
to 50/255 (DRUNet's training range). `infer_sigma` tiles like `denoise::infer` (same overlap, blend and linear
residual) with the σ plane as channel 4, over any `SigmaModel` (`DrunetEngine` loads an export from a path; the unit
tests use a mock); `denoise_sigma` adds `denoise::finish`. The model is not in `models.toml` until our export
(`scripts/models/export_drunet.py`) is hosted. Evaluation (`docs/design/DENOISE_EVAL.md`): on real photos the
measured σ is about half of what DRUNet needs (demosaiced noise is correlated); σ × 2 cleans like NAFNet w32 with more
texture kept. `DenoiseEngine::from_session` loads any 3-channel export for the same kind of evaluation, and the
ignored `p26_*` tests in `tests/denoise.rs` produced the numbers in that document.
