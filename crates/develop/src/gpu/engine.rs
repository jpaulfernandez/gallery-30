//! The GPU render: upload, warp, the whole image's coarse guided-filter stages, tiles (full-resolution
//! planes with overlap + the per-pixel chain), readback.
//!
//! [`GpuState`] is one image's GPU cache (what a [`crate::Developer`] keeps between renders): the
//! uploaded source, the last warp keyed like the CPU's, and per input image the coarse coefficients
//! (highlights/shadows, clarity, dehaze with its atmospheric light) and, when the image fits in one tile,
//! that tile's planes (log luminance, texture band, sharpening planes for the last radius). A slider
//! change is then one chain dispatch and one readback.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use rayon::prelude::*;

use super::kernels::{storage, Res, Uni, ACC_FORMAT, OUT_FORMAT, PLANE_FORMAT};
use super::params::{coarse, mask_adjustments, ChainInputs, ChainUniform, PASS_HALATION};
use super::warp::{image_texture, plan_warp, record_warp, Resize, WarpOp};
use super::GpuContext;
use crate::cpu::masked::union_needs;
use crate::cpu::{warp_key, LocalBlend, Params};
use crate::decode::fit;
use crate::geometry::{GeometryPlan, Quality};
use crate::image::{LinearImage, Rgb8Image};
use crate::local::blur::{box_radii_for_gaussian, kernel, reduced_size, BOX_SIGMA_MIN};
use crate::local::guided::guided_subsample;
use crate::local::prepass::{
    AIRLIGHT_FRACTION, AIRLIGHT_NEUTRAL, CLARITY_EPS, CLARITY_RADIUS_REF, DEHAZE_EPS, DEHAZE_GUIDE_RADIUS_REF,
    DEHAZE_PATCH_RADIUS_REF, HS_EPS, HS_RADIUS_REF, MIN_SHARPEN_SIGMA, TEXTURE_COARSE_SIGMA_REF,
    TEXTURE_FINE_SIGMA_REF,
};
use crate::local::prepass::{halation_reduction, HalationKey};
use crate::local::{reference_scale, Needs};
use crate::color::matrix::REC2020_LUMA;
use crate::settings::DevelopSettings;

/// Tile edge for full-resolution renders. An image whose both sides fit is rendered as one tile and its
/// planes are cached; larger images are cut into tiles of this size (plus the overlap).
pub const TILE_SIZE: u32 = 2048;
/// Larger images render on the CPU: the source and its warp are 16 bytes per pixel on the GPU (2 GB at
/// this size). The noise pass (workflow plan 24) adds one tile-sized texture, not a full-size one.
pub const MAX_PIXELS: u64 = 64_000_000;

#[derive(Debug, Clone, PartialEq)]
pub struct GpuError(pub String);

impl std::fmt::Display for GpuError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

type Result<T> = std::result::Result<T, GpuError>;

// ---------- textures ----------

fn texture(ctx: &GpuContext, label: &str, (w, h): (u32, u32), format: wgpu::TextureFormat, copy: bool) -> wgpu::Texture {
    let mut usage = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING;
    if copy {
        usage |= wgpu::TextureUsages::COPY_SRC;
    }
    ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

fn view(t: &wgpu::Texture) -> wgpu::TextureView {
    t.create_view(&Default::default())
}

fn run(ctx: &GpuContext, enc: &mut wgpu::CommandEncoder, k: &super::kernels::Kernel, u: Uni, res: &[Res<'_>], size: (u32, u32)) {
    let ub = u.buffer(&ctx.device);
    let mut all = Vec::with_capacity(res.len() + 1);
    all.push(Res::Buffer(&ub));
    all.extend_from_slice(res);
    k.run(&ctx.device, enc, &all, size);
}

// ---------- upload ----------

/// Upload a linear image into an rgba16float texture, in bands that fit a storage binding.
pub(crate) fn upload(ctx: &GpuContext, image: &LinearImage) -> wgpu::Texture {
    let (w, h) = (image.width, image.height);
    let tex = image_texture(ctx, "source", w, h);
    let limits = ctx.limits();
    let max_bytes = (limits.max_storage_buffer_binding_size as u64).min(limits.max_buffer_size).min(64 << 20);
    let row_bytes = w as u64 * 12;
    let rows = ((max_bytes / row_bytes.max(1)) as u32).clamp(1, h.max(1));
    let staging = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("upload"),
        size: (rows as u64 * row_bytes).max(16),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let dst = view(&tex);
    let mut y = 0;
    while y < h {
        let n = rows.min(h - y);
        let start = y as usize * w as usize * 3;
        let end = (y + n) as usize * w as usize * 3;
        ctx.queue.write_buffer(&staging, 0, bytemuck::cast_slice(&image.data[start..end]));
        let mut enc = ctx.device.create_command_encoder(&Default::default());
        run(
            ctx,
            &mut enc,
            &ctx.kernels.upload,
            Uni { i0: [w as i32, n as i32, y as i32, 0], ..Uni::default() },
            &[Res::Buffer(&staging), Res::View(&dst)],
            (w, n),
        );
        ctx.queue.submit([enc.finish()]);
        y += n;
    }
    tex
}

// ---------- readback ----------

const ROW_ALIGN: u32 = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;

fn padded_row(bytes: u32) -> u32 {
    bytes.div_ceil(ROW_ALIGN) * ROW_ALIGN
}

fn map_read(ctx: &GpuContext, buffer: &wgpu::Buffer) -> Result<()> {
    map_read_all(ctx, &[buffer])
}

/// Map every buffer for reading, with one wait.
fn map_read_all(ctx: &GpuContext, buffers: &[&wgpu::Buffer]) -> Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    for b in buffers {
        let tx = tx.clone();
        b.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
    }
    drop(tx);
    ctx.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| GpuError(format!("poll: {e}")))?;
    for _ in buffers {
        rx.recv().map_err(|e| GpuError(format!("map: {e}")))?.map_err(|e| GpuError(format!("map: {e}")))?;
    }
    Ok(())
}

/// Read a whole single-channel or rgba32float texture back as `f32`s (tightly packed).
fn read_floats(ctx: &GpuContext, tex: &wgpu::Texture, channels: u32) -> Result<Vec<f32>> {
    let (w, h) = (tex.width(), tex.height());
    let row = w * 4 * channels;
    let bpr = padded_row(row);
    let buffer = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("read-floats"),
        size: bpr as u64 * h as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut enc = ctx.device.create_command_encoder(&Default::default());
    enc.copy_texture_to_buffer(
        tex.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: Some(h) },
        },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    ctx.queue.submit([enc.finish()]);
    map_read(ctx, &buffer)?;
    let data = buffer.slice(..).get_mapped_range().map_err(|e| GpuError(format!("mapped range: {e}")))?;
    let mut out = Vec::with_capacity((w * h * channels) as usize);
    for y in 0..h as usize {
        let r = &data[y * bpr as usize..y * bpr as usize + row as usize];
        out.extend(r.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])));
    }
    drop(data);
    buffer.unmap();
    Ok(out)
}

// ---------- coarse guided-filter stages ----------

/// A guided filter's coarse coefficients (ā in r, b̄ in g) over the whole image, at `1/factor`.
#[derive(Debug)]
struct Coarse {
    tex: wgpu::Texture,
    lw: u32,
    lh: u32,
    factor: u32,
}

impl Coarse {
    fn uniform(&self) -> [f32; 4] {
        coarse(self.lw, self.lh, self.factor)
    }
}

#[derive(Debug)]
struct Haze {
    coarse: Coarse,
    airlight: [f32; 3],
}

fn low_plane(ctx: &GpuContext, label: &str, lw: u32, lh: u32) -> wgpu::Texture {
    texture(ctx, label, (lw, lh), PLANE_FORMAT, true)
}

/// `local::guided::guided_coefficients` on low-resolution planes: the coefficient texture.
#[allow(clippy::too_many_arguments)]
fn guided_coefficients(
    ctx: &GpuContext,
    enc: &mut wgpu::CommandEncoder,
    guide: &wgpu::Texture,
    input: Option<&wgpu::Texture>,
    lw: u32,
    lh: u32,
    radius: f32,
    eps: f32,
) -> wgpu::Texture {
    let r = (radius.round() as i32).max(1);
    let inv = (1.0 / (2 * r + 1) as f64) as f32;
    let acc = |label| texture(ctx, label, (lw, lh), ACC_FORMAT, false);
    let (a, b, c) = (acc("gf-a"), acc("gf-b"), acc("gf-c"));
    let base = Uni { i0: [0, lw as i32, lh as i32, 0], ..Uni::default() };
    let k = &ctx.kernels;
    let g = view(guide);
    let p = input.map(view);
    let u = Uni { i1: [0, 0, input.is_some() as i32, 0], ..base };
    run(ctx, enc, &k.stats, u, &[Res::View(&g), Res::View(&view(&a)), Res::View(p.as_ref().unwrap_or(&g))], (lw, lh));
    let boxed = |enc: &mut wgpu::CommandEncoder, src: &wgpu::Texture, tmp: &wgpu::Texture, dst: &wgpu::Texture| {
        let h = Uni { i1: [r, 1, 0, 0], f0: [inv, 0.0, 0.0, 0.0], ..base };
        run(ctx, enc, &k.box4, h, &[Res::View(&view(src)), Res::View(&view(tmp))], (lw, lh));
        let v = Uni { i1: [r, 0, 0, 0], f0: [inv, 0.0, 0.0, 0.0], ..base };
        run(ctx, enc, &k.box4, v, &[Res::View(&view(tmp)), Res::View(&view(dst))], (lw, lh));
    };
    boxed(enc, &a, &b, &c);
    run(ctx, enc, &k.coefficients, Uni { f0: [eps, 0.0, 0.0, 0.0], ..base }, &[Res::View(&view(&c)), Res::View(&view(&a))], (lw, lh));
    boxed(enc, &a, &b, &c);
    c
}

/// A self-guided filter of log luminance (highlights/shadows base, clarity): radius in pixels.
fn log_coarse(ctx: &GpuContext, input: &wgpu::Texture, radius: f32, eps: f32) -> Coarse {
    let (w, h) = (input.width(), input.height());
    let s = guided_subsample(radius);
    let (lw, lh) = reduced_size(w as usize, h as usize, s);
    let (lw, lh) = (lw as u32, lh as u32);
    let mut enc = ctx.device.create_command_encoder(&Default::default());
    let g_low = low_plane(ctx, "log-low", lw, lh);
    let cells = Uni { i0: [s as i32, lw as i32, lh as i32, 0], i1: [w as i32, h as i32, 0, 0], ..Uni::default() };
    run(ctx, &mut enc, &ctx.kernels.cell_mean_log, cells, &[Res::View(&view(input)), Res::View(&view(&g_low))], (lw, lh));
    let tex = guided_coefficients(ctx, &mut enc, &g_low, None, lw, lh, radius / s as f32, eps);
    ctx.queue.submit([enc.finish()]);
    Coarse { tex, lw, lh, factor: s as u32 }
}

/// Dark channel of `I / a` per cell (min, mean, RGB sums), the min then max filter (opening) of the min.
/// Returns (opened min, mean, sums).
fn dark_cells(
    ctx: &GpuContext,
    enc: &mut wgpu::CommandEncoder,
    input: &wgpu::Texture,
    a: [f32; 3],
    factor: usize,
    patch_r: usize,
) -> (wgpu::Texture, wgpu::Texture, wgpu::Texture) {
    let (w, h) = (input.width(), input.height());
    let (lw, lh) = reduced_size(w as usize, h as usize, factor);
    let (lw, lh) = (lw as u32, lh as u32);
    let low = low_plane(ctx, "dark-min", lw, lh);
    let mean = low_plane(ctx, "dark-mean", lw, lh);
    let sums = texture(ctx, "cell-sums", (lw, lh), ACC_FORMAT, true);
    let cells = Uni {
        i0: [factor as i32, lw as i32, lh as i32, 0],
        i1: [w as i32, h as i32, 0, 0],
        f0: [a[0], a[1], a[2], 0.0],
        ..Uni::default()
    };
    let k = &ctx.kernels;
    run(ctx, enc, &k.cell_dark, cells, &[Res::View(&view(input)), Res::View(&view(&low)), Res::View(&view(&mean)), Res::View(&view(&sums))], (lw, lh));
    let tmp = low_plane(ctx, "dark-tmp", lw, lh);
    let out = low_plane(ctx, "dark-open", lw, lh);
    let r = patch_r as i32;
    let pass = |enc: &mut wgpu::CommandEncoder, src: &wgpu::Texture, dst: &wgpu::Texture, horizontal: i32, max: i32| {
        let u = Uni { i0: [0, lw as i32, lh as i32, 0], i1: [r, horizontal, max, 0], ..Uni::default() };
        run(ctx, enc, &k.min_max, u, &[Res::View(&view(src)), Res::View(&view(dst))], (lw, lh));
    };
    pass(enc, &low, &tmp, 1, 0);
    pass(enc, &tmp, &out, 0, 0);
    pass(enc, &out, &tmp, 1, 1);
    pass(enc, &tmp, &out, 0, 1);
    (out, mean, sums)
}

/// `local::prepass::haze_planes` on the GPU: the atmospheric light (sorted on the CPU from the coarse
/// dark channel read back) and the density's coarse coefficients.
fn haze(ctx: &GpuContext, input: &wgpu::Texture) -> Result<Haze> {
    let (w, h) = (input.width() as usize, input.height() as usize);
    let scale = reference_scale(w, h);
    let guide_r = DEHAZE_GUIDE_RADIUS_REF * scale;
    let factor = guided_subsample(guide_r);
    let (lw, lh) = reduced_size(w, h, factor);
    let patch_r = ((DEHAZE_PATCH_RADIUS_REF * scale / factor as f32).round() as usize).max(1);

    let mut enc = ctx.device.create_command_encoder(&Default::default());
    let (dark, _, sums) = dark_cells(ctx, &mut enc, input, [1.0; 3], factor, patch_r);
    ctx.queue.submit([enc.finish()]);
    let dark = read_floats(ctx, &dark, 1)?;
    let sums = read_floats(ctx, &sums, 4)?;
    let mut order: Vec<usize> = (0..dark.len()).collect();
    order.sort_by(|&i, &j| dark[j].total_cmp(&dark[i]).then(i.cmp(&j)));
    let count = ((dark.len() as f32 * AIRLIGHT_FRACTION).ceil() as usize).clamp(1, dark.len());
    let mut sum = [0.0f64; 3];
    let mut n = 0.0f64;
    for &cell in &order[..count] {
        for c in 0..3 {
            sum[c] += sums[cell * 4 + c] as f64;
        }
        n += sums[cell * 4 + 3] as f64;
    }
    let mean = sum.map(|s| (s / n.max(1.0)) as f32);
    let y = REC2020_LUMA[0] * mean[0] + REC2020_LUMA[1] * mean[1] + REC2020_LUMA[2] * mean[2];
    let airlight = mean.map(|c| (y + (c - y) * (1.0 - AIRLIGHT_NEUTRAL)).max(0.05));

    let mut enc = ctx.device.create_command_encoder(&Default::default());
    let (p_low, g_low, _) = dark_cells(ctx, &mut enc, input, airlight, factor, patch_r);
    let tex = guided_coefficients(ctx, &mut enc, &g_low, Some(&p_low), lw as u32, lh as u32, guide_r / factor as f32, DEHAZE_EPS);
    ctx.queue.submit([enc.finish()]);
    Ok(Haze { coarse: Coarse { tex, lw: lw as u32, lh: lh as u32, factor: factor as u32 }, airlight })
}

// ---------- blur and the halation glow ----------

fn plane_uni((w, h): (u32, u32)) -> Uni {
    Uni { i0: [0, 0, w as i32, h as i32], ..Uni::default() }
}

/// `local::blur::gaussian_blur(src) → dst` on a `size` plane (src ≠ dst; `tmp` is scratch at least `size`): the
/// sampled kernel below `BOX_SIGMA_MIN`, three box passes above.
#[allow(clippy::too_many_arguments)]
fn blur_plane(
    ctx: &GpuContext,
    enc: &mut wgpu::CommandEncoder,
    size: (u32, u32),
    src: &wgpu::Texture,
    tmp: &wgpu::Texture,
    dst: &wgpu::Texture,
    sigma: f32,
) {
    let k = &ctx.kernels;
    if sigma >= BOX_SIGMA_MIN {
        let mut from = src;
        for r in box_radii_for_gaussian(sigma, 3) {
            if r == 0 {
                continue;
            }
            let inv = (1.0 / (2 * r + 1) as f64) as f32;
            let h = Uni { i1: [r as i32, 1, 0, 0], f0: [inv, 0.0, 0.0, 0.0], ..plane_uni(size) };
            run(ctx, enc, &k.box_blur, h, &[Res::View(&view(from)), Res::View(&view(tmp))], size);
            let v = Uni { i1: [r as i32, 0, 0, 0], f0: [inv, 0.0, 0.0, 0.0], ..plane_uni(size) };
            run(ctx, enc, &k.box_blur, v, &[Res::View(&view(tmp)), Res::View(&view(dst))], size);
            from = dst;
        }
        if std::ptr::eq(from, src) {
            // Every radius was 0: a copy.
            convolve_plane(ctx, enc, size, src, tmp, dst, &[1.0]);
        }
    } else if sigma > 0.0 {
        convolve_plane(ctx, enc, size, src, tmp, dst, &kernel(sigma));
    } else {
        convolve_plane(ctx, enc, size, src, tmp, dst, &[1.0]);
    }
}

#[allow(clippy::too_many_arguments)]
fn convolve_plane(
    ctx: &GpuContext,
    enc: &mut wgpu::CommandEncoder,
    size: (u32, u32),
    src: &wgpu::Texture,
    tmp: &wgpu::Texture,
    dst: &wgpu::Texture,
    k: &[f32],
) {
    let r = (k.len() / 2) as i32;
    let weights = storage(&ctx.device, "kernel", k);
    let kern = &ctx.kernels.convolve;
    let h = Uni { i1: [r, 1, 0, 0], ..plane_uni(size) };
    run(ctx, enc, kern, h, &[Res::View(&view(src)), Res::View(&view(tmp)), Res::Buffer(&weights)], size);
    let v = Uni { i1: [r, 0, 0, 0], ..plane_uni(size) };
    run(ctx, enc, kern, v, &[Res::View(&view(tmp)), Res::View(&view(dst)), Res::Buffer(&weights)], size);
}

/// The halation glow of one input image (workflow plan 19): `local::prepass::HalationPlane` on the GPU.
#[derive(Debug)]
struct Glow {
    key: HalationKey,
    tex: wgpu::Texture,
    lw: u32,
    lh: u32,
    factor: u32,
}

/// `local::prepass::halation_plane` on the GPU: the excess over the threshold averaged into cells of the same
/// reduction factor, then blurred at that reduced size with the tile planes' blur kernels.
fn halation_glow(ctx: &GpuContext, input: &wgpu::Texture, key: HalationKey) -> Glow {
    let (w, h) = (input.width(), input.height());
    let (factor, sigma) = halation_reduction(w as usize, h as usize, key);
    let (lw, lh) = reduced_size(w as usize, h as usize, factor);
    let (lw, lh) = (lw.max(1) as u32, lh.max(1) as u32);
    let mut enc = ctx.device.create_command_encoder(&Default::default());
    let excess = low_plane(ctx, "halation-excess", lw, lh);
    let cells = Uni {
        i0: [factor as i32, lw as i32, lh as i32, 0],
        i1: [w as i32, h as i32, 0, 0],
        f0: [key.threshold, 0.0, 0.0, 0.0],
        ..Uni::default()
    };
    run(ctx, &mut enc, &ctx.kernels.cell_mean_excess, cells, &[Res::View(&view(input)), Res::View(&view(&excess))], (lw, lh));
    let tmp = low_plane(ctx, "halation-tmp", lw, lh);
    let tex = low_plane(ctx, "halation-glow", lw, lh);
    blur_plane(ctx, &mut enc, (lw, lh), &excess, &tmp, &tex, sigma);
    ctx.queue.submit([enc.finish()]);
    Glow { key, tex, lw, lh, factor: factor as u32 }
}

// ---------- tile planes ----------

/// Pixels a Gaussian of `sigma` reaches (`local::blur::gaussian_blur`: the sampled kernel's radius, or
/// the three box radii).
fn gaussian_support(sigma: f32) -> u32 {
    if sigma <= 0.0 {
        0
    } else if sigma < BOX_SIGMA_MIN {
        (kernel(sigma).len() / 2) as u32
    } else {
        box_radii_for_gaussian(sigma, 3).iter().sum::<usize>() as u32
    }
}

/// What the tile planes hold.
#[derive(Debug, Clone, Copy, PartialEq)]
struct PlaneNeeds {
    texture: bool,
    sharpen: Option<f32>,
}

impl PlaneNeeds {
    fn from(needs: &Needs) -> PlaneNeeds {
        PlaneNeeds { texture: needs.texture, sharpen: needs.sharpen_radius }
    }

    fn any(&self) -> bool {
        self.texture || self.sharpen.is_some()
    }

    /// The overlap a tile needs so its core never sees the clamp at the tile border.
    fn overlap(&self, scale: f32) -> u32 {
        let mut o = 0;
        if self.texture {
            o = o.max(gaussian_support(TEXTURE_FINE_SIGMA_REF * scale)).max(gaussian_support(TEXTURE_COARSE_SIGMA_REF * scale));
        }
        if let Some(r) = self.sharpen {
            let sigma = (r * scale).max(MIN_SHARPEN_SIGMA);
            let s1 = gaussian_support(sigma);
            o = o.max(gaussian_support(2.0 * sigma)).max(2 * s1 + 1);
        }
        o
    }
}

/// The full-resolution planes of one (padded) tile.
#[derive(Debug)]
struct TilePlanes {
    size: (u32, u32),
    log_y: wgpu::Texture,
    band: wgpu::Texture,
    fine: wgpu::Texture,
    coarse: wgpu::Texture,
    edges: wgpu::Texture,
    a: wgpu::Texture,
    b: wgpu::Texture,
    tmp: wgpu::Texture,
    /// What is computed (for the cached whole-image tile).
    has_log: bool,
    has_band: bool,
    sharpen: Option<f32>,
}

impl TilePlanes {
    fn new(ctx: &GpuContext, size: (u32, u32)) -> TilePlanes {
        let p = |label| texture(ctx, label, size, PLANE_FORMAT, false);
        TilePlanes {
            size,
            log_y: p("log-y"),
            band: p("band"),
            fine: p("fine"),
            coarse: p("coarse"),
            edges: p("edges"),
            a: p("plane-a"),
            b: p("plane-b"),
            tmp: p("plane-tmp"),
            has_log: false,
            has_band: false,
            sharpen: None,
        }
    }

    fn uni(&self) -> Uni {
        Uni { i0: [0, 0, self.size.0 as i32, self.size.1 as i32], ..Uni::default() }
    }

    /// `gaussian_blur(src) → dst` (src ≠ dst; `tmp` is scratch).
    fn blur(&self, ctx: &GpuContext, enc: &mut wgpu::CommandEncoder, src: &wgpu::Texture, dst: &wgpu::Texture, sigma: f32) {
        blur_plane(ctx, enc, self.size, src, &self.tmp, dst, sigma);
    }

    fn difference(&self, ctx: &GpuContext, enc: &mut wgpu::CommandEncoder, a: &wgpu::Texture, b: &wgpu::Texture, dst: &wgpu::Texture) {
        run(ctx, enc, &ctx.kernels.difference, self.uni(), &[Res::View(&view(a)), Res::View(&view(dst)), Res::View(&view(b))], self.size);
    }

    /// Compute what `needs` asks for and is not there yet, from the image region at `origin`. `scale` is
    /// the whole image's reference scale. Returns how many planes were computed (log Y, band, sharpening
    /// set), for the pre-pass counter.
    fn compute(
        &mut self,
        ctx: &GpuContext,
        enc: &mut wgpu::CommandEncoder,
        image: &wgpu::TextureView,
        origin: (u32, u32),
        scale: f32,
        needs: PlaneNeeds,
    ) -> usize {
        let mut computed = 0;
        if !needs.any() {
            return 0;
        }
        if !self.has_log {
            let u = Uni { i0: [origin.0 as i32, origin.1 as i32, self.size.0 as i32, self.size.1 as i32], ..Uni::default() };
            run(ctx, enc, &ctx.kernels.log_luminance, u, &[Res::View(image), Res::View(&view(&self.log_y))], self.size);
            self.has_log = true;
        }
        if needs.texture && !self.has_band {
            self.blur(ctx, enc, &self.log_y, &self.a, TEXTURE_FINE_SIGMA_REF * scale);
            self.blur(ctx, enc, &self.log_y, &self.b, TEXTURE_COARSE_SIGMA_REF * scale);
            self.difference(ctx, enc, &self.a, &self.b, &self.band);
            self.has_band = true;
            computed += 1;
        }
        if let Some(radius) = needs.sharpen.filter(|r| self.sharpen.map(f32::to_bits) != Some(r.to_bits())) {
            let sigma = (radius * scale).max(MIN_SHARPEN_SIGMA);
            self.blur(ctx, enc, &self.log_y, &self.a, sigma);
            self.difference(ctx, enc, &self.log_y, &self.a, &self.fine);
            self.blur(ctx, enc, &self.log_y, &self.b, 2.0 * sigma);
            self.difference(ctx, enc, &self.log_y, &self.b, &self.coarse);
            let u = Uni { f0: [scale, 0.0, 0.0, 0.0], ..self.uni() };
            run(ctx, enc, &ctx.kernels.sobel, u, &[Res::View(&view(&self.a)), Res::View(&view(&self.b))], self.size);
            self.blur(ctx, enc, &self.b, &self.edges, sigma);
            self.sharpen = Some(radius);
            computed += 1;
        }
        computed
    }
}

// ---------- per-image cache ----------

/// The coarse stages and cached tile of one input image (decoded or warped).
#[derive(Debug, Default)]
struct InputCache {
    hs: Option<Coarse>,
    clarity: Option<Coarse>,
    haze: Option<Haze>,
    /// The halation glow for the last key (an LRU of one, as `PrePasses::halation`).
    halation: Option<Glow>,
    /// The planes of the whole image when it fits in one tile.
    whole: Option<TilePlanes>,
    /// Log luminance counted (it is shared by several planes, as on the CPU).
    log_counted: bool,
    /// Cache misses, counted as `PrePasses::computed` counts them.
    computed: usize,
    /// The noise filter's coarse coefficients for the last key (workflow plan 24, `gpu::noise`).
    noise: Option<super::noise::NoiseCoarse>,
}

impl InputCache {
    fn count_log(&mut self) {
        if !self.log_counted {
            self.log_counted = true;
            self.computed += 1;
        }
    }

    /// Compute the coarse stages `needs` asks for.
    fn prepare(&mut self, ctx: &GpuContext, input: &wgpu::Texture, needs: &Needs) -> Result<()> {
        let scale = reference_scale(input.width() as usize, input.height() as usize);
        if needs.hs_base && self.hs.is_none() {
            self.count_log();
            self.hs = Some(log_coarse(ctx, input, HS_RADIUS_REF * scale, HS_EPS));
            self.computed += 1;
        }
        if needs.clarity && self.clarity.is_none() {
            self.count_log();
            self.clarity = Some(log_coarse(ctx, input, CLARITY_RADIUS_REF * scale, CLARITY_EPS));
            self.computed += 1;
        }
        if needs.haze && self.haze.is_none() {
            self.haze = Some(haze(ctx, input)?);
            self.computed += 1;
        }
        if needs.texture || needs.sharpen_radius.is_some() {
            self.count_log();
        }
        if let Some(key) = needs.halation.filter(|k| self.halation.as_ref().is_none_or(|g| g.key != *k)) {
            self.halation = None; // free the old glow first
            self.halation = Some(halation_glow(ctx, input, key));
            self.computed += 1;
        }
        Ok(())
    }
}

/// One image's GPU resources, kept by a [`crate::Developer`] between renders.
#[derive(Default)]
pub struct GpuState {
    source: Option<wgpu::Texture>,
    identity: InputCache,
    warped: Option<(String, wgpu::Texture, InputCache)>,
    /// The mask layers of a one-tile render, keyed by the input and [`crate::cpu::layers_key`].
    masks: Option<(String, wgpu::Texture)>,
}

impl std::fmt::Debug for GpuState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GpuState")
            .field("uploaded", &self.source.is_some())
            .field("warp", &self.warped.as_ref().map(|w| &w.0))
            .finish()
    }
}

impl GpuState {
    /// Pre-pass cache misses on the unwarped image (added to `Developer::prepass_count`).
    pub fn prepass_count(&self) -> usize {
        self.identity.computed
    }
}

/// How to cut the render into tiles.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Tiling {
    /// One tile when both sides fit in [`TILE_SIZE`] (planes cached), else tiles of that size.
    Auto,
    /// Always tiles of this size (planes never cached), for tests.
    Size(u32),
}

/// Render `image` with `settings` (geometry included) on the GPU.
///
/// `target`: a long edge to fit the output to (previews); `warps` counts warp cache misses; `masks`: the
/// render's masks on the output grid and their cache key (empty = do not cache the layers).
#[allow(clippy::too_many_arguments)]
pub(crate) fn render(
    ctx: &GpuContext,
    state: &mut GpuState,
    image: &LinearImage,
    settings: &DevelopSettings,
    params: &Params,
    quality: Quality,
    target: Option<u32>,
    tiling: Tiling,
    warps: &AtomicUsize,
    masks: Option<(&LocalBlend, &str)>,
) -> Result<Rgb8Image> {
    let start = Instant::now();
    if let Some(why) = super::unsupported(settings) {
        // Callers check `gpu::supports` first; this keeps any other path from rendering without the effects.
        return Err(GpuError(format!("unsupported: {why}")));
    }
    let max_dim = ctx.limits().max_texture_dimension_2d;
    let (w, h) = (image.width, image.height);
    if w == 0 || h == 0 {
        return Ok(Rgb8Image::new(w, h, Vec::new()));
    }
    if w > max_dim || h > max_dim {
        return Err(GpuError(format!("{w}×{h} exceeds the GPU's {max_dim} px texture limit")));
    }
    if w as u64 * h as u64 > MAX_PIXELS {
        return Err(GpuError(format!("{w}×{h} is above the GPU path's {} MP", MAX_PIXELS / 1_000_000)));
    }
    if state.source.is_none() {
        state.source = Some(upload(ctx, image));
    }

    // The input: the decoded image, or its (cached) warp / preview resize.
    let op = match target {
        None => {
            let plan = GeometryPlan::new(&settings.geometry, w, h, None);
            (!plan.is_identity()).then(|| (warp_key(&settings.geometry, quality), plan_warp(&plan, quality), (plan.output_width, plan.output_height)))
        }
        Some(edge) => {
            let edge = edge.max(1);
            if GeometryPlan::new(&settings.geometry, w, h, None).is_identity() {
                let (fw, fh) = fit(w, h, edge);
                ((fw, fh) != (w, h)).then(|| {
                    let resize = Resize::lanczos3((w, h), (fw, fh));
                    (format!("fit|{fw}x{fh}"), WarpOp::Resize(resize), (fw, fh))
                })
            } else {
                let plan = GeometryPlan::new(&settings.geometry, w, h, Some(edge));
                let key = format!("{}|{edge}", warp_key(&settings.geometry, Quality::Preview));
                Some((key, plan_warp(&plan, Quality::Preview), (plan.output_width, plan.output_height)))
            }
        }
    };
    let input_key = op.as_ref().map_or_else(|| "identity".to_string(), |(key, _, _)| key.clone());
    let (input, cache): (&wgpu::Texture, &mut InputCache) = match op {
        None => (state.source.as_ref().expect("uploaded"), &mut state.identity),
        Some((key, op, size)) => {
            if size.0 > max_dim || size.1 > max_dim {
                return Err(GpuError(format!("output {}×{} exceeds the texture limit", size.0, size.1)));
            }
            if state.warped.as_ref().is_none_or(|w| w.0 != key) {
                state.warped = None; // free the old warp first
                let mut enc = ctx.device.create_command_encoder(&Default::default());
                log::debug!("[photobook:gpu] warp {} to {}x{}", op.path_name(), size.0, size.1);
                let tex = record_warp(ctx, &mut enc, state.source.as_ref().expect("uploaded"), &op, size);
                ctx.queue.submit([enc.finish()]);
                warps.fetch_add(1, Ordering::Relaxed);
                state.warped = Some((key, tex, InputCache::default()));
            }
            let (_, tex, cache) = state.warped.as_mut().expect("just set");
            (&*tex, cache)
        }
    };

    let blend = masks.map(|(b, _)| b).filter(|b| !b.is_empty());
    if let Some(b) = blend {
        if (b.width(), b.height()) != (input.width(), input.height()) {
            return Err(GpuError(format!(
                "mask layers {}×{} are not on the {}×{} grid",
                b.width(),
                b.height(),
                input.width(),
                input.height()
            )));
        }
    }
    let needs = union_needs(params.needs(), blend.map(LocalBlend::needs));
    cache.prepare(ctx, input, &needs)?;
    // Workflow plan 24: the chroma filter and mask noise write the image the chain starts from.
    let noise_run = match params.noise.as_ref() {
        Some(p) => Some(super::noise::prepare(ctx, input, &mut cache.noise, &mut cache.computed, p, blend)?),
        None => None,
    };
    let airlight = cache.haze.as_ref().map(|h| h.airlight);
    let mut chain = ChainInputs::new(params, airlight);
    chain.add_effects(params, (input.width(), input.height()));
    if let Some(b) = blend {
        chain.add_masks(params, b, airlight);
    }
    let layers = blend.map(|b| MaskBind {
        blend: b,
        key: masks.map(|(_, k)| k).filter(|k| !k.is_empty()).map(|k| format!("{input_key}|{k}")),
    });
    let out = develop(ctx, input, noise_run.as_ref(), cache, &chain, PlaneNeeds::from(&needs), tiling, layers, &mut state.masks)?;
    log::debug!("[photobook:gpu] render {}x{} in {:.1} ms", out.width, out.height, start.elapsed().as_secs_f64() * 1e3);
    Ok(out)
}

/// A render's masks for [`develop`]: the blend and, for a render whose layers may be cached (one tile), their key.
struct MaskBind<'a> {
    blend: &'a LocalBlend,
    key: Option<String>,
}

/// An `r32float` 2D array texture of `layers` layers.
fn layer_texture(ctx: &GpuContext, (w, h): (u32, u32), layers: u32) -> wgpu::Texture {
    ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("mask-layers"),
        size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: layers.max(1) },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: PLANE_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

/// Write the `(x0, y0, w, h)` window of every mask plane into the layers of `tex` (at its origin).
fn upload_layers(ctx: &GpuContext, tex: &wgpu::Texture, blend: &LocalBlend, (x0, y0, w, h): (u32, u32, u32, u32)) {
    let stride = blend.width();
    for (k, plane) in blend.layers.planes.iter().enumerate() {
        ctx.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: tex,
                mip_level: 0,
                origin: wgpu::Origin3d { x: 0, y: 0, z: k as u32 },
                aspect: wgpu::TextureAspect::All,
            },
            bytemuck::cast_slice(&plane.data),
            wgpu::TexelCopyBufferLayout {
                offset: (y0 as u64 * stride as u64 + x0 as u64) * 4,
                bytes_per_row: Some(stride * 4),
                rows_per_image: Some(h),
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
    }
}

fn array_view(t: &wgpu::Texture) -> wgpu::TextureView {
    t.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() })
}

/// The look's LUT (plan 18) as a `size³` `rgba32float` 3D texture read with `textureLoad`; a 1³ dummy without one.
/// The last LUT's texture is kept (with the `Arc` it came from, so the pointer cannot be reused) and handed out again
/// while the render uses the same `Arc`: a slider drag uploads it once, not per preview (a 129³ LUT is 34 MB).
fn lut3d_texture(ctx: &GpuContext, lut: Option<&std::sync::Arc<crate::lut::Lut3d>>) -> wgpu::Texture {
    type Held = Option<(std::sync::Arc<crate::lut::Lut3d>, wgpu::Texture)>;
    static LAST: std::sync::Mutex<Held> = std::sync::Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if let (Some(l), Some((held, tex))) = (lut, last.as_ref()) {
        if std::sync::Arc::ptr_eq(l, held) {
            return tex.clone();
        }
    }
    let n = lut.map_or(1, |l| l.size as u32);
    let tex = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("lut3d"),
        size: wgpu::Extent3d { width: n, height: n, depth_or_array_layers: n },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format: wgpu::TextureFormat::Rgba32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    if let Some(l) = lut {
        let data: Vec<[f32; 4]> = l.data.iter().map(|[r, g, b]| [*r, *g, *b, 0.0]).collect();
        ctx.queue.write_texture(
            tex.as_image_copy(),
            bytemuck::cast_slice(&data),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(n * 16), rows_per_image: Some(n) },
            wgpu::Extent3d { width: n, height: n, depth_or_array_layers: n },
        );
        *last = Some((std::sync::Arc::clone(l), tex.clone()));
    }
    tex
}

/// The tiles, the chain and the readback. Mask layers are bound per tile (the tile's core window; for a
/// one-tile render the whole planes, cached in `mask_slot` under the bind's key).
#[allow(clippy::too_many_arguments)]
fn develop(
    ctx: &GpuContext,
    input: &wgpu::Texture,
    noise: Option<&super::noise::NoiseRun>,
    cache: &mut InputCache,
    chain: &ChainInputs,
    needs: PlaneNeeds,
    tiling: Tiling,
    masks: Option<MaskBind<'_>>,
    mask_slot: &mut Option<(String, wgpu::Texture)>,
) -> Result<Rgb8Image> {
    let (w, h) = (input.width(), input.height());
    let scale = reference_scale(w as usize, h as usize);
    let tile = match tiling {
        Tiling::Auto => TILE_SIZE,
        Tiling::Size(t) => t.max(16),
    };
    let whole = matches!(tiling, Tiling::Auto) && w <= tile && h <= tile;
    let overlap = if needs.any() { needs.overlap(scale) } else { 0 };

    let dummy_plane = texture(ctx, "dummy-plane", (1, 1), PLANE_FORMAT, false);
    let dummy_acc = texture(ctx, "dummy-acc", (1, 1), ACC_FORMAT, false);
    let luts = storage(&ctx.device, "luts", &chain.luts);
    let curves = ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("curves"),
        size: wgpu::Extent3d { width: crate::color::curve::LUT_SIZE as u32, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D1,
        format: wgpu::TextureFormat::Rgba32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    if let Some(data) = &chain.curves {
        ctx.queue.write_texture(
            curves.as_image_copy(),
            bytemuck::cast_slice(data),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(data.len() as u32 * 16), rows_per_image: Some(1) },
            wgpu::Extent3d { width: data.len() as u32, height: 1, depth_or_array_layers: 1 },
        );
    }
    let curves_view = curves.create_view(&Default::default());
    let lut3d = lut3d_texture(ctx, chain.lut3d.as_ref());
    let lut3d_view = lut3d.create_view(&Default::default());

    let mut uniform: ChainUniform = chain.uniform;
    let coef_view = |c: Option<&Coarse>| view(c.map_or(&dummy_acc, |c| &c.tex));
    let hs_view = coef_view(cache.hs.as_ref());
    let clarity_view = coef_view(cache.clarity.as_ref());
    let haze_view = coef_view(cache.haze.as_ref().map(|h| &h.coarse));
    uniform.hs = cache.hs.as_ref().map_or([1.0, 1.0, 1.0, 0.0], Coarse::uniform);
    uniform.clarity = cache.clarity.as_ref().map_or([1.0, 1.0, 1.0, 0.0], Coarse::uniform);
    uniform.haze = cache.haze.as_ref().map_or([1.0, 1.0, 1.0, 0.0], |h| h.coarse.uniform());
    // Halation's glow plane (its gain is already in `w`); without one the pass is off, as on the CPU.
    let dummy_glow = texture(ctx, "dummy-glow", (1, 1), PLANE_FORMAT, false);
    let glow_view = view(cache.halation.as_ref().map_or(&dummy_glow, |g| &g.tex));
    match &cache.halation {
        Some(g) => {
            let [lw, lh, inv, _] = coarse(g.lw, g.lh, g.factor);
            uniform.halation = [lw, lh, inv, uniform.halation[3]];
        }
        None => uniform.flags[0] &= !PASS_HALATION,
    }

    let cols = w.div_ceil(tile);
    let rows = h.div_ceil(tile);
    let core_max = (w.min(tile), h.min(tile));
    let out_tex = texture(ctx, "out", core_max, OUT_FORMAT, true);
    let out_view = view(&out_tex);
    let image_view = view(input);
    // Workflow plan 24: the noise pass writes each tile's starting pixels into a tile-sized texture (the chain reads it
    // at the tile's own coordinates); without it the chain starts from the input itself.
    let noise_targets = noise.map(|n| n.targets(ctx, core_max));
    let start_view = view(noise_targets.as_ref().map_or(input, |(t, _)| t));

    // Mask layers: a dummy when there are none; the whole planes (cached) for one tile; else per-tile windows.
    let adjustments = masks.as_ref().map_or_else(Vec::new, |m| mask_adjustments(m.blend));
    let adjustments = storage(&ctx.device, "mask-adjustments", &adjustments);
    let per_tile = masks.as_ref().filter(|_| !whole).map(|m| (m.blend, layer_texture(ctx, core_max, m.blend.len() as u32)));
    let layers_tex: Option<&wgpu::Texture> = match &masks {
        None => None,
        Some(_) if !whole => per_tile.as_ref().map(|(_, t)| t),
        Some(m) => {
            let hit = m.key.is_some() && mask_slot.as_ref().is_some_and(|(k, _)| Some(k) == m.key.as_ref());
            if !hit {
                let tex = layer_texture(ctx, (w, h), m.blend.len() as u32);
                upload_layers(ctx, &tex, m.blend, (0, 0, w, h));
                *mask_slot = Some((m.key.clone().unwrap_or_default(), tex));
            }
            mask_slot.as_ref().map(|(_, t)| t)
        }
    };
    let dummy_layers = layer_texture(ctx, (1, 1), 1);
    let layers_view = array_view(layers_tex.unwrap_or(&dummy_layers));

    // One readback buffer per tile (rows padded to 256 bytes), mapped together at the end.
    struct TileOut {
        x0: u32,
        y0: u32,
        w: u32,
        h: u32,
        bpr: u32,
        buffer: wgpu::Buffer,
    }
    let mut tiles = Vec::new();
    for ty in 0..rows {
        for tx in 0..cols {
            let (x0, y0) = (tx * tile, ty * tile);
            let (cw, ch) = ((w - x0).min(tile), (h - y0).min(tile));
            let bpr = padded_row(cw * 4);
            let buffer = ctx.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("readback"),
                size: bpr as u64 * ch as u64,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            tiles.push(TileOut { x0, y0, w: cw, h: ch, bpr, buffer });
        }
    }

    let mut scratch: Option<TilePlanes> = None;
    let mut enc = ctx.device.create_command_encoder(&Default::default());
    for t in &tiles {
        // The padded region the planes cover.
        let px0 = t.x0.saturating_sub(overlap);
        let py0 = t.y0.saturating_sub(overlap);
        let px1 = (t.x0 + t.w + overlap).min(w);
        let py1 = (t.y0 + t.h + overlap).min(h);
        let planes: Option<&TilePlanes> = if !needs.any() {
            None
        } else if whole {
            if cache.whole.as_ref().is_none_or(|p| p.size != (w, h)) {
                cache.whole = Some(TilePlanes::new(ctx, (w, h)));
            }
            let p = cache.whole.as_mut().expect("just set");
            cache.computed += p.compute(ctx, &mut enc, &image_view, (0, 0), scale, needs);
            cache.whole.as_ref()
        } else {
            let size = (px1 - px0, py1 - py0);
            if scratch.is_none() {
                // Sized for the largest padded tile, reused by every tile.
                scratch = Some(TilePlanes::new(ctx, ((tile + 2 * overlap).min(w), (tile + 2 * overlap).min(h))));
            }
            // A fresh set per tile region (the textures are reused; the planes are recomputed).
            let p = scratch.as_mut().expect("just set");
            p.size = size;
            p.has_log = false;
            p.has_band = false;
            p.sharpen = None;
            p.compute(ctx, &mut enc, &image_view, (px0, py0), scale, needs);
            scratch.as_ref()
        };
        if let (Some(n), Some((start, amounts))) = (noise, &noise_targets) {
            n.record_tile(ctx, &mut enc, input, start, amounts, (t.x0, t.y0, t.w, t.h));
        }
        if let Some((blend, tex)) = &per_tile {
            upload_layers(ctx, tex, blend, (t.x0, t.y0, t.w, t.h));
        }
        let pv = |f: fn(&TilePlanes) -> &wgpu::Texture| view(planes.map_or(&dummy_plane, f));
        let (band, fine, coarse_v, edges) = (pv(|p| &p.band), pv(|p| &p.fine), pv(|p| &p.coarse), pv(|p| &p.edges));
        uniform.flags[1] = t.x0;
        uniform.flags[2] = t.y0;
        uniform.origin = [t.x0 as i32, t.y0 as i32, (t.x0 - px0) as i32, (t.y0 - py0) as i32];
        uniform.size = [t.w, t.h, 0, 0];
        let ub = {
            use wgpu::util::DeviceExt;
            ctx.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("chain"),
                contents: bytemuck::bytes_of(&uniform),
                usage: wgpu::BufferUsages::UNIFORM,
            })
        };
        // Plan 55: the wheels' pipeline only when the luminance offsets or the Global wheel are on.
        let develop = if uniform.grading_c[2] > 0.5 { &ctx.kernels.develop_wheels } else { &ctx.kernels.develop };
        develop.run(
            &ctx.device,
            &mut enc,
            &[
                Res::Buffer(&ub),
                Res::View(&image_view),
                Res::View(&hs_view),
                Res::View(&clarity_view),
                Res::View(&haze_view),
                Res::View(&band),
                Res::View(&fine),
                Res::View(&coarse_v),
                Res::View(&edges),
                Res::Buffer(&luts),
                Res::View(&curves_view),
                Res::View(&out_view),
                Res::View(&layers_view),
                Res::Buffer(&adjustments),
                Res::View(&lut3d_view),
                Res::View(&glow_view),
                Res::View(&start_view),
            ],
            (t.w, t.h),
        );
        enc.copy_texture_to_buffer(
            out_tex.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &t.buffer,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(t.bpr), rows_per_image: Some(t.h) },
            },
            wgpu::Extent3d { width: t.w, height: t.h, depth_or_array_layers: 1 },
        );
        if !whole {
            // Keep the command buffers bounded on big exports.
            ctx.queue.submit([std::mem::replace(&mut enc, ctx.device.create_command_encoder(&Default::default())).finish()]);
        }
    }
    ctx.queue.submit([enc.finish()]);
    map_read_all(ctx, &tiles.iter().map(|t| &t.buffer).collect::<Vec<_>>())?;
    let mut rgb = vec![0u8; w as usize * h as usize * 3];
    let stride = w as usize * 3;
    for t in &tiles {
        let data = t.buffer.slice(..).get_mapped_range().map_err(|e| GpuError(format!("mapped range: {e}")))?;
        rgb[t.y0 as usize * stride..(t.y0 + t.h) as usize * stride].par_chunks_mut(stride).enumerate().for_each(|(y, row)| {
            let s = &data[y * t.bpr as usize..y * t.bpr as usize + t.w as usize * 4];
            let d = &mut row[t.x0 as usize * 3..(t.x0 + t.w) as usize * 3];
            for (o, i) in d.chunks_exact_mut(3).zip(s.chunks_exact(4)) {
                o.copy_from_slice(&i[..3]);
            }
        });
        drop(data);
        t.buffer.unmap();
    }
    Ok(Rgb8Image::new(w, h, rgb))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The overlap a 24 MP tile needs: the texture band's coarse Gaussian (three boxes, 21 + 22 + 22 px)
    /// dominates; the sharpening paths stay within it up to radius 3.
    #[test]
    fn overlap_of_a_24_mp_tile() {
        let scale = reference_scale(6000, 4000);
        let all = |r| PlaneNeeds { texture: true, sharpen: Some(r) };
        assert_eq!(all(1.0).overlap(scale), 65);
        assert_eq!(all(3.0).overlap(scale), 65);
        assert_eq!(PlaneNeeds { texture: false, sharpen: Some(1.0) }.overlap(scale), 25);
        assert_eq!(PlaneNeeds { texture: false, sharpen: None }.overlap(scale), 0);
    }
}
