//! The chroma filter and mask noise on the GPU (workflow plan 24; the CPU reference is [`crate::ops::noise`]).
//!
//! 1. `noise_cells` (shaders/noise.wgsl): the coarse cells of the input (Oklab L and the two chroma ratios), read back.
//! 2. The coefficients and the fit weight are solved on the CPU with the reference code
//!    ([`crate::ops::noise::planes_from_cells`]: a few box filters and a median on a plane of a sixteenth of the
//!    pixels, about a millisecond for a preview) and uploaded; kept per input image and key ([`NoiseCoarse`]).
//! 3. `noise_apply`: the joint upsampling pass, per pixel, with the Colour strength and the masks' local amounts
//!    (one plane computed on the CPU from the composited masks, uploaded per tile), per render tile into a
//!    tile-sized texture the chain starts from (its `start_image` binding) while every guide (highlights/shadows,
//!    clarity, dehaze) still reads the unfiltered input, as the CPU does. GPU memory: one tile (at most 2048² ×
//!    16 B = 64 MB) plus its amounts window, whatever the image size.

use std::sync::OnceLock;

use super::engine::GpuError;
use super::kernels::{module_source, storage, Kernel, Res, Slot, Uni, ACC_FORMAT, IMAGE_FORMAT, PLANE_FORMAT};
use super::GpuContext;
use crate::color::oklab::Oklab;
use crate::cpu::LocalBlend;
use crate::local::blur::reduced_size;
use crate::ops::noise::{local_amounts, planes_from_cells, NoiseKey, NoiseParams, L_FLOOR, MASK_LUMA_SHARE};

type Result<T> = std::result::Result<T, GpuError>;

pub(crate) const NOISE: &str = include_str!("shaders/noise.wgsl");

struct NoiseKernels {
    cells: Kernel,
    apply: Kernel,
}

fn kernels(ctx: &GpuContext) -> &'static NoiseKernels {
    static KERNELS: OnceLock<NoiseKernels> = OnceLock::new();
    KERNELS.get_or_init(|| {
        let module = ctx.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("noise"),
            source: wgpu::ShaderSource::Wgsl(module_source(NOISE).into()),
        });
        use Slot::{Storage as S, Store as W, Texture as T, Uniform as U};
        NoiseKernels {
            cells: Kernel::new(&ctx.device, &module, "noise_cells", &[U(0), T(1), W(2, ACC_FORMAT), S(5)]),
            apply: Kernel::new(
                &ctx.device,
                &module,
                "noise_apply",
                &[U(0), T(1), T(3), T(4), S(5), T(6), W(7, IMAGE_FORMAT)],
            ),
        }
    })
}

/// The Oklab matrices as 12 padded rows (to_lms, from_lms, m2, m2_inv).
fn matrices(ctx: &GpuContext) -> wgpu::Buffer {
    let rows: Vec<[f32; 4]> =
        Oklab::new().matrices().iter().flat_map(|m| m.iter().map(|r| [r[0], r[1], r[2], 0.0])).collect();
    storage(&ctx.device, "oklab", &rows)
}

fn texture(ctx: &GpuContext, label: &str, (w, h): (u32, u32), format: wgpu::TextureFormat, usage: wgpu::TextureUsages) -> wgpu::Texture {
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

/// A sampled texture holding `data` (`channels` floats per texel, 1 or 4).
fn upload(ctx: &GpuContext, label: &str, (w, h): (u32, u32), channels: u32, data: &[f32]) -> wgpu::Texture {
    let format = if channels == 1 { PLANE_FORMAT } else { ACC_FORMAT };
    let tex = texture(ctx, label, (w, h), format, wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST);
    ctx.queue.write_texture(
        tex.as_image_copy(),
        bytemuck::cast_slice(data),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w * 4 * channels), rows_per_image: Some(h) },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    tex
}

/// Read an rgba32float texture back as `[f32; 4]` per texel.
fn read_rgba(ctx: &GpuContext, tex: &wgpu::Texture) -> Result<Vec<[f32; 4]>> {
    let (w, h) = (tex.width(), tex.height());
    let row = w * 16;
    let bpr = row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let buffer = ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("noise-cells-read"),
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
    let (tx, rx) = std::sync::mpsc::channel();
    buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    ctx.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| GpuError(format!("poll: {e}")))?;
    rx.recv().map_err(|e| GpuError(format!("map: {e}")))?.map_err(|e| GpuError(format!("map: {e}")))?;
    let data = buffer.slice(..).get_mapped_range().map_err(|e| GpuError(format!("mapped range: {e}")))?;
    let mut out = Vec::with_capacity((w * h) as usize);
    for y in 0..h as usize {
        let r = &data[y * bpr as usize..y * bpr as usize + row as usize];
        out.extend(r.chunks_exact(16).map(|b| {
            std::array::from_fn(|k| f32::from_le_bytes([b[k * 4], b[k * 4 + 1], b[k * 4 + 2], b[k * 4 + 3]]))
        }));
    }
    drop(data);
    buffer.unmap();
    Ok(out)
}

/// The coarse coefficients of one input image for one key.
#[derive(Debug)]
pub(crate) struct NoiseCoarse {
    key: NoiseKey,
    lw: u32,
    lh: u32,
    factor: u32,
    /// `(α_a, β_a, α_b, β_b)` per coarse cell.
    coef: wgpu::Texture,
    /// `(fit, α_L, β_L, 0)` per coarse cell.
    aux: wgpu::Texture,
}

/// Compute [`NoiseCoarse`] for `input` (see the module notes).
fn coarse(ctx: &GpuContext, input: &wgpu::Texture, key: NoiseKey) -> Result<NoiseCoarse> {
    let (w, h) = (input.width() as usize, input.height() as usize);
    let factor = key.factor(w, h);
    let (lw, lh) = reduced_size(w, h, factor);
    let cells = texture(
        ctx,
        "noise-cells",
        (lw as u32, lh as u32),
        ACC_FORMAT,
        wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
    );
    let m = matrices(ctx);
    let u = Uni {
        i0: [factor as i32, lw as i32, lh as i32, 0],
        i1: [w as i32, h as i32, 0, 0],
        f0: [L_FLOOR, 0.0, 0.0, 0.0],
        ..Uni::default()
    };
    let ub = u.buffer(&ctx.device);
    let mut enc = ctx.device.create_command_encoder(&Default::default());
    kernels(ctx).cells.run(
        &ctx.device,
        &mut enc,
        &[Res::Buffer(&ub), Res::View(&view(input)), Res::View(&view(&cells)), Res::Buffer(&m)],
        (lw as u32, lh as u32),
    );
    ctx.queue.submit([enc.finish()]);
    let texels = read_rgba(ctx, &cells)?;
    let planes: [Vec<f32>; 3] = std::array::from_fn(|c| texels.iter().map(|t| t[c]).collect());
    let p = planes_from_cells(key, (w, h), factor, (lw, lh), planes);
    let coef: Vec<f32> = p.chroma.iter().flatten().copied().collect();
    let aux: Vec<f32> = (0..p.lw * p.lh)
        .flat_map(|i| {
            let (a, b) = p.luma.as_ref().map_or((0.0, 0.0), |l| (l[i][0], l[i][1]));
            [p.fit[i], a, b, 0.0]
        })
        .collect();
    let size = (p.lw as u32, p.lh as u32);
    Ok(NoiseCoarse {
        key,
        lw: size.0,
        lh: size.1,
        factor: factor as u32,
        coef: upload(ctx, "noise-coef", size, 4, &coef),
        aux: upload(ctx, "noise-aux", size, 4, &aux),
    })
}

/// What the per-tile pass needs for one render (the coarse textures are shared handles, not copies).
pub(crate) struct NoiseRun {
    coef: wgpu::Texture,
    aux: wgpu::Texture,
    lw: u32,
    lh: u32,
    factor: u32,
    params: NoiseParams,
    /// The masks' local amounts for the whole input (`Σ w·noise / 100`), when a mask uses `noise`.
    amounts: Option<Vec<f32>>,
    width: u32,
    matrices: wgpu::Buffer,
}

/// Get the coarse stage from `slot` (recomputed when the key changes, counted in `computed`) and the masks' local
/// amounts, for [`NoiseRun::record_tile`].
pub(crate) fn prepare(
    ctx: &GpuContext,
    input: &wgpu::Texture,
    slot: &mut Option<NoiseCoarse>,
    computed: &mut usize,
    params: &NoiseParams,
    blend: Option<&LocalBlend>,
) -> Result<NoiseRun> {
    if slot.as_ref().is_none_or(|c| c.key != params.key) {
        *slot = None;
        *slot = Some(coarse(ctx, input, params.key)?);
        *computed += 1;
    }
    let c = slot.as_ref().expect("just set");
    Ok(NoiseRun {
        coef: c.coef.clone(),
        aux: c.aux.clone(),
        lw: c.lw,
        lh: c.lh,
        factor: c.factor,
        params: params.clone(),
        amounts: blend.filter(|_| params.local).map(local_amounts),
        width: input.width(),
        matrices: matrices(ctx),
    })
}

impl NoiseRun {
    /// The tile-sized targets: the filtered image the chain starts from and the local amounts' window (1 × 1
    /// without masks). Reused by every tile, so the pass costs `core` pixels of GPU memory, not the whole image.
    pub(crate) fn targets(&self, ctx: &GpuContext, core: (u32, u32)) -> (wgpu::Texture, wgpu::Texture) {
        let out = texture(
            ctx,
            "noise-start",
            core,
            IMAGE_FORMAT,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
        );
        let size = if self.amounts.is_some() { core } else { (1, 1) };
        let amounts = texture(
            ctx,
            "noise-amounts",
            size,
            PLANE_FORMAT,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        );
        (out, amounts)
    }

    /// Record the joint upsampling pass of the tile `(x0, y0, w, h)` of `input` into `out` (at its origin): the
    /// masks' amounts window is written first (a queue write, so the caller submits each tile before the next one's
    /// write, as it does for the mask layers).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_tile(
        &self,
        ctx: &GpuContext,
        enc: &mut wgpu::CommandEncoder,
        input: &wgpu::Texture,
        out: &wgpu::Texture,
        amounts: &wgpu::Texture,
        (x0, y0, w, h): (u32, u32, u32, u32),
    ) {
        match &self.amounts {
            Some(plane) => ctx.queue.write_texture(
                amounts.as_image_copy(),
                bytemuck::cast_slice(plane),
                wgpu::TexelCopyBufferLayout {
                    offset: (y0 as u64 * self.width as u64 + x0 as u64) * 4,
                    bytes_per_row: Some(self.width * 4),
                    rows_per_image: Some(h),
                },
                wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            ),
            None => ctx.queue.write_texture(
                amounts.as_image_copy(),
                bytemuck::cast_slice(&[0.0f32]),
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: Some(1) },
                wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            ),
        }
        let p = &self.params;
        let u = Uni {
            i0: [self.lw as i32, self.lh as i32, self.amounts.is_some() as i32, p.key.luma.is_some() as i32],
            i1: [w as i32, h as i32, x0 as i32, y0 as i32],
            f0: [1.0 / self.factor as f32, p.chroma, MASK_LUMA_SHARE, L_FLOOR],
            ..Uni::default()
        };
        let ub = u.buffer(&ctx.device);
        kernels(ctx).apply.run(
            &ctx.device,
            enc,
            &[
                Res::Buffer(&ub),
                Res::View(&view(input)),
                Res::View(&view(&self.coef)),
                Res::View(&view(&self.aux)),
                Res::Buffer(&self.matrices),
                Res::View(&view(amounts)),
                Res::View(&view(out)),
            ],
            (w, h),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The module parses and validates with naga (no device needed).
    #[test]
    fn module_validates() {
        use wgpu::naga;
        let src = module_source(NOISE);
        let module = naga::front::wgsl::parse_str(&src).unwrap_or_else(|e| panic!("noise: {}", e.emit_to_string(&src)));
        naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all())
            .validate(&module)
            .unwrap_or_else(|e| panic!("noise: {e:?}"));
    }
}
