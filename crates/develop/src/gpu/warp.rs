//! The geometry warp on the GPU: the same three paths as [`crate::geometry::warp`], chosen by the same
//! tests on the plan's inverse map (mirrored here because the CPU helpers are private to that module;
//! `path_matches_the_cpu` checks the choice against `warp_with_stats`):
//!
//! 1. exact integer copy (`copy_map`),
//! 2. exact copy of the crop, then fast_image_resize's Lanczos3 convolution (`resize`, coefficients
//!    computed here exactly as fast_image_resize computes them),
//! 3. inverse mapping per output pixel centre (`gather_catmull_rom` / `gather_lanczos3`), after a Mitchell
//!    prefilter (`resize`) when the map minifies by more than [`PREFILTER_THRESHOLD`].

use crate::geometry::warp::PREFILTER_THRESHOLD;
use crate::geometry::{GeometryPlan, Homography, Quality};

use super::kernels::{storage, Res, Uni, IMAGE_FORMAT, LANCZOS_LUT_PER_UNIT};
use super::GpuContext;

/// An integer map: source pixel = `origin + i·dx + j·dy` for output pixel `(i, j)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PixelMap {
    pub width: u32,
    pub height: u32,
    pub origin: (i64, i64),
    pub dx: (i64, i64),
    pub dy: (i64, i64),
}

fn near_int(v: f64, eps: f64) -> Option<i64> {
    let r = v.round();
    ((v - r).abs() <= eps).then_some(r as i64)
}

impl PixelMap {
    /// `geometry::warp`'s `PixelMap::new`.
    pub fn new(inverse: &Homography, sw: u32, sh: u32, ow: u32, oh: u32) -> Option<PixelMap> {
        if !inverse.is_affine(1e-12) {
            return None;
        }
        let m = inverse.normalized().0;
        let a = [m[0], m[1], m[3], m[4]].map(|v| near_int(v, 1e-9));
        let [Some(a0), Some(a1), Some(a3), Some(a4)] = a else { return None };
        if ![a0, a1, a3, a4].iter().all(|v| v.abs() <= 1) || (a0 * a4 - a1 * a3).abs() != 1 {
            return None;
        }
        let p = inverse.apply([0.5, 0.5]);
        let ox = near_int(p[0] - 0.5, 1e-6)?;
        let oy = near_int(p[1] - 0.5, 1e-6)?;
        let map = PixelMap { width: ow, height: oh, origin: (ox, oy), dx: (a0, a3), dy: (a1, a4) };
        let (lx, ly) = (ow as i64 - 1, oh as i64 - 1);
        for (i, j) in [(0, 0), (lx, 0), (0, ly), (lx, ly)] {
            let (x, y) = (map.origin.0 + i * map.dx.0 + j * map.dy.0, map.origin.1 + i * map.dx.1 + j * map.dy.1);
            if x < 0 || y < 0 || x >= sw as i64 || y >= sh as i64 {
                return None;
            }
        }
        Some(map)
    }
}

/// fast_image_resize's convolution coefficients for one axis (`precompute_coefficients` with the crop
/// covering the whole input and an adaptive kernel size): per output index the first input tap and the
/// tap count, and `window` weights (normalised in `f64`, stored as `f32`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Coefficients {
    pub bounds: Vec<[u32; 2]>,
    pub weights: Vec<f32>,
    pub window: usize,
}

pub(crate) fn coefficients(in_size: u32, out_size: u32, filter: fn(f64) -> f64, support: f64) -> Coefficients {
    let scale = in_size as f64 / out_size as f64;
    let filter_scale = scale.max(1.0);
    let filter_radius = support * filter_scale;
    let window = filter_radius.ceil() as usize * 2 + 1;
    let recip = 1.0 / filter_scale;
    let mut weights = Vec::with_capacity(window * out_size as usize);
    let mut bounds = Vec::with_capacity(out_size as usize);
    for out_x in 0..out_size {
        let in_center = (out_x as f64 + 0.5) * scale;
        let x_min = (in_center - filter_radius).floor().max(0.) as u32;
        let x_max = (in_center + filter_radius).ceil().min(in_size as f64) as u32;
        let cur = weights.len();
        let mut coeffs: Vec<f64> = Vec::with_capacity(window);
        let mut ww = 0.0f64;
        let center = in_center - 0.5;
        let mut start = x_min;
        let mut end = x_max;
        for x in x_min..x_max {
            let w = filter((x as f64 - center) * recip);
            if x == start && w == 0. {
                start += 1;
            } else {
                coeffs.push(w);
                ww += w;
            }
        }
        for &c in coeffs.iter().rev() {
            if end <= start || c != 0. {
                break;
            }
            end -= 1;
        }
        if ww != 0.0 {
            coeffs.iter_mut().for_each(|w| *w /= ww);
        }
        coeffs.resize(window, 0.);
        weights.extend(coeffs.iter().map(|&w| w as f32));
        debug_assert_eq!(weights.len(), cur + window);
        bounds.push([start, end - start]);
    }
    Coefficients { bounds, weights, window }
}

/// fast_image_resize's Lanczos3 (support 3).
pub(crate) fn lanczos3_filter(x: f64) -> f64 {
    fn sinc(x: f64) -> f64 {
        if x == 0.0 {
            1.0
        } else {
            let x = x * std::f64::consts::PI;
            x.sin() / x
        }
    }
    if (-3.0..3.0).contains(&x) {
        sinc(x) * sinc(x / 3.)
    } else {
        0.0
    }
}

/// fast_image_resize's Mitchell–Netravali, B = C = 1/3 (support 2).
pub(crate) fn mitchell_filter(x: f64) -> f64 {
    let x = x.abs();
    if x < 1.0 {
        (7. * x / 6. - 2.) * x * x + 16. / 18.
    } else if x < 2.0 {
        ((2. - 7. * x / 18.) * x - 10. / 3.) * x + 16. / 9.
    } else {
        0.0
    }
}

/// `geometry::warp`'s Lanczos3 table for the gather (1024 entries per unit, linear interpolation).
pub(crate) fn lanczos_lut() -> Vec<f32> {
    let lanczos3 = |x: f64| {
        let x = x.abs();
        if x < 1e-12 {
            return 1.0;
        }
        if x >= 3.0 {
            return 0.0;
        }
        let px = std::f64::consts::PI * x;
        3.0 * px.sin() * (px / 3.0).sin() / (px * px)
    };
    let n = LANCZOS_LUT_PER_UNIT as usize;
    (0..=3 * n + 1).map(|i| lanczos3(i as f64 / n as f64) as f32).collect()
}

/// `geometry::warp`'s `min_local_scale`.
fn min_local_scale(inv: &Homography, ow: u32, oh: u32) -> f64 {
    let mut best = f64::INFINITY;
    for gy in 0..=8 {
        for gx in 0..=8 {
            let p = [ow as f64 * gx as f64 / 8.0, oh as f64 * gy as f64 / 8.0];
            let [a, b, c, d] = inv.jacobian(p);
            let s1 = a * a + b * b + c * c + d * d;
            let det = (a * d - b * c).abs();
            let disc = (s1 * s1 - 4.0 * det * det).max(0.0).sqrt();
            let smin = ((s1 - disc) / 2.0).max(0.0).sqrt();
            best = best.min(smin);
        }
    }
    if best.is_finite() {
        best
    } else {
        1.0
    }
}

/// The resize of `(iw, ih)` to `(ow, oh)`: horizontal then vertical, each only when that axis changes.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Resize {
    pub from: (u32, u32),
    pub to: (u32, u32),
    pub horizontal: Option<Coefficients>,
    pub vertical: Option<Coefficients>,
}

impl Resize {
    /// fast_image_resize's Lanczos3 convolution (`decode::resize_linear`).
    pub fn lanczos3(from: (u32, u32), to: (u32, u32)) -> Resize {
        Resize::new(from, to, lanczos3_filter, 3.0)
    }

    fn new(from: (u32, u32), to: (u32, u32), filter: fn(f64) -> f64, support: f64) -> Resize {
        Resize {
            from,
            to,
            horizontal: (from.0 != to.0).then(|| coefficients(from.0, to.0, filter, support)),
            vertical: (from.1 != to.1).then(|| coefficients(from.1, to.1, filter, support)),
        }
    }
}

/// Which warp to run, as `geometry::warp::warp_with_stats` would choose.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum WarpOp {
    Copy(PixelMap),
    CopyResize { map: PixelMap, resize: Resize },
    Resample { prefilter: Option<Resize>, inverse: Homography, quality: Quality },
    /// Only a resize (a preview of an image without geometry, `decode::resize_linear`).
    Resize(Resize),
}

/// The path name, as `WarpPath` would print it (for tests and logs).
impl WarpOp {
    pub fn path_name(&self) -> &'static str {
        match self {
            WarpOp::Copy(_) => "Copy",
            WarpOp::CopyResize { .. } => "CopyResize",
            WarpOp::Resample { .. } => "Resample",
            WarpOp::Resize(_) => "Resize",
        }
    }
}

pub(crate) fn plan_warp(plan: &GeometryPlan, quality: Quality) -> WarpOp {
    let (sw, sh) = (plan.source_width, plan.source_height);
    let (ow, oh) = (plan.output_width, plan.output_height);
    if let Some(map) = PixelMap::new(&plan.inverse, sw, sh, ow, oh) {
        return WarpOp::Copy(map);
    }
    if let Some(op) = copy_resize(plan) {
        return op;
    }
    let min_scale = min_local_scale(&plan.inverse, ow, oh);
    if min_scale > PREFILTER_THRESHOLD {
        let (swf, shf) = (sw as f64, sh as f64);
        let rw = ((swf / min_scale).round() as u32).max(1);
        let rh = ((shf / min_scale).round() as u32).max(1);
        let inverse = plan.inverse.then(&Homography::scale(rw as f64 / swf, rh as f64 / shf));
        let prefilter = Resize::new((sw, sh), (rw, rh), mitchell_filter, 2.0);
        return WarpOp::Resample { prefilter: Some(prefilter), inverse, quality };
    }
    WarpOp::Resample { prefilter: None, inverse: plan.inverse, quality }
}

/// `geometry::warp`'s `copy_resize`.
fn copy_resize(plan: &GeometryPlan) -> Option<WarpOp> {
    let inv = &plan.inverse;
    if !inv.is_affine(1e-12) {
        return None;
    }
    let m = inv.normalized().0;
    let tiny = |v: f64| v.abs() <= 1e-12;
    let swap = if tiny(m[1]) && tiny(m[3]) {
        false
    } else if tiny(m[0]) && tiny(m[4]) {
        true
    } else {
        return None;
    };
    let (ow, oh) = (plan.output_width as f64, plan.output_height as f64);
    let a = inv.apply([0.0, 0.0]);
    let b = inv.apply([ow, oh]);
    let (sx0, sx1) = (a[0].min(b[0]), a[0].max(b[0]));
    let (sy0, sy1) = (a[1].min(b[1]), a[1].max(b[1]));
    let eps = 1e-6;
    let (x0, x1, y0, y1) = (near_int(sx0, eps)?, near_int(sx1, eps)?, near_int(sy0, eps)?, near_int(sy1, eps)?);
    if x0 < 0 || y0 < 0 || x1 > plan.source_width as i64 || y1 > plan.source_height as i64 || x1 <= x0 || y1 <= y0 {
        return None;
    }
    let (iw, ih) = if swap { (y1 - y0, x1 - x0) } else { (x1 - x0, y1 - y0) };
    let to_out = Homography::scale(ow / iw as f64, oh / ih as f64);
    let inv_i = to_out.then(inv);
    let map = PixelMap::new(&inv_i, plan.source_width, plan.source_height, iw as u32, ih as u32)?;
    let resize = Resize::new((iw as u32, ih as u32), (plan.output_width, plan.output_height), lanczos3_filter, 3.0);
    Some(WarpOp::CopyResize { map, resize })
}

pub(crate) fn image_texture(ctx: &GpuContext, label: &str, w: u32, h: u32) -> wgpu::Texture {
    ctx.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: IMAGE_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::STORAGE_BINDING,
        view_formats: &[],
    })
}

fn view(t: &wgpu::Texture) -> wgpu::TextureView {
    t.create_view(&Default::default())
}

fn identity_map((w, h): (u32, u32)) -> PixelMap {
    PixelMap { width: w, height: h, origin: (0, 0), dx: (1, 0), dy: (0, 1) }
}

fn record_copy(ctx: &GpuContext, enc: &mut wgpu::CommandEncoder, src: &wgpu::TextureView, map: &PixelMap) -> wgpu::Texture {
    let out = image_texture(ctx, "warp-copy", map.width, map.height);
    let u = Uni {
        i0: [map.origin.0 as i32, map.origin.1 as i32, map.dx.0 as i32, map.dx.1 as i32],
        i1: [map.dy.0 as i32, map.dy.1 as i32, map.width as i32, map.height as i32],
        ..Uni::default()
    };
    let ub = u.buffer(&ctx.device);
    ctx.kernels.copy_map.run(&ctx.device, enc, &[Res::Buffer(&ub), Res::View(src), Res::View(&view(&out))], (map.width, map.height));
    out
}

/// One separable resize; `src` is `r.from` in size. Returns the `r.to` texture (`None` when nothing
/// changes size, then `src` is the result).
fn record_resize(ctx: &GpuContext, enc: &mut wgpu::CommandEncoder, src: &wgpu::TextureView, r: &Resize) -> Option<wgpu::Texture> {
    let mut cur: Option<wgpu::Texture> = None;
    let mut size = r.from;
    for (coeffs, horizontal) in [(&r.horizontal, true), (&r.vertical, false)] {
        let Some(c) = coeffs else { continue };
        let out_size = if horizontal { (r.to.0, size.1) } else { (size.0, r.to.1) };
        let out = image_texture(ctx, "warp-resize", out_size.0, out_size.1);
        let bounds = storage(&ctx.device, "resize-bounds", &c.bounds);
        let weights = storage(&ctx.device, "resize-weights", &c.weights);
        let u = Uni { i0: [out_size.0 as i32, out_size.1 as i32, c.window as i32, horizontal as i32], ..Uni::default() };
        let ub = u.buffer(&ctx.device);
        let src_view = cur.as_ref().map(view);
        let input = src_view.as_ref().unwrap_or(src);
        ctx.kernels.resize.run(
            &ctx.device,
            enc,
            &[Res::Buffer(&ub), Res::View(input), Res::View(&view(&out)), Res::Buffer(&bounds), Res::Buffer(&weights)],
            out_size,
        );
        cur = Some(out);
        size = out_size;
    }
    cur
}

/// Record `op` on the source texture (`sw × sh`); returns the warped texture.
pub(crate) fn record_warp(
    ctx: &GpuContext,
    enc: &mut wgpu::CommandEncoder,
    src: &wgpu::Texture,
    op: &WarpOp,
    (ow, oh): (u32, u32),
) -> wgpu::Texture {
    let src_view = view(src);
    match op {
        WarpOp::Copy(map) => record_copy(ctx, enc, &src_view, map),
        WarpOp::CopyResize { map, resize } => {
            let cropped = record_copy(ctx, enc, &src_view, map);
            record_resize(ctx, enc, &view(&cropped), resize).unwrap_or(cropped)
        }
        WarpOp::Resize(r) => match record_resize(ctx, enc, &src_view, r) {
            Some(t) => t,
            None => record_copy(ctx, enc, &src_view, &identity_map(r.from)),
        },
        WarpOp::Resample { prefilter, inverse, quality } => {
            let reduced = prefilter.as_ref().and_then(|r| record_resize(ctx, enc, &src_view, r));
            let (input, (iw, ih)) = match (&reduced, prefilter) {
                (Some(t), Some(r)) => (view(t), r.to),
                _ => (src_view, (src.width(), src.height())),
            };
            let m = inverse.0.map(|v| v as f32);
            let u = Uni {
                i0: [iw as i32, ih as i32, ow as i32, oh as i32],
                f0: [m[0], m[1], m[2], m[3]],
                f1: [m[4], m[5], m[6], m[7]],
                f2: [m[8], 0.0, 0.0, 0.0],
                ..Uni::default()
            };
            let ub = u.buffer(&ctx.device);
            let lut = storage(&ctx.device, "lanczos", &lanczos_lut());
            let out = image_texture(ctx, "warp-resample", ow, oh);
            let kernel = match quality {
                Quality::Preview => &ctx.kernels.gather_catmull_rom,
                Quality::Export => &ctx.kernels.gather_lanczos3,
            };
            kernel.run(&ctx.device, enc, &[Res::Buffer(&ub), Res::View(&input), Res::View(&view(&out)), Res::Buffer(&lut)], (ow, oh));
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::warp::{warp_with_stats, WarpPath};
    use crate::image::LinearImage;
    use crate::settings::{Crop, CropAspect, CropRect, Geometry, Rotation};

    fn crop(x: f64, y: f64, w: f64, h: f64, angle: f64) -> Option<Crop> {
        Some(Crop { rect: CropRect { x, y, w, h }, angle, aspect: CropAspect::default() })
    }

    /// The path choice mirrors `warp_with_stats` for every kind of geometry.
    #[test]
    fn path_matches_the_cpu() {
        let (w, h) = (64u32, 48u32);
        let img = LinearImage::new(w, h, vec![0.5; (w * h * 3) as usize]);
        let mut cases = vec![
            (Geometry { rotate: Rotation::R90, ..Geometry::default() }, None),
            (Geometry { flip_h: true, crop: crop(0.25, 0.25, 0.5, 0.5, 0.0), ..Geometry::default() }, None),
            (Geometry { crop: crop(0.25, 0.25, 0.5, 0.5, 0.0), ..Geometry::default() }, Some(16)),
            (Geometry { crop: crop(0.1, 0.1, 0.7, 0.6, 4.0), ..Geometry::default() }, None),
            (Geometry { crop: crop(0.1, 0.1, 0.7, 0.6, 4.0), ..Geometry::default() }, Some(20)),
        ];
        let mut keystone = Geometry::default();
        keystone.transform.vertical = -40.0;
        cases.push((keystone, None));
        for (g, edge) in cases {
            let plan = GeometryPlan::new(&g, w, h, edge);
            let (_, stats) = warp_with_stats(&img, &plan, Quality::Preview);
            let op = plan_warp(&plan, Quality::Preview);
            let want = match stats.path {
                WarpPath::Copy => "Copy",
                WarpPath::CopyResize => "CopyResize",
                WarpPath::Resample { prefilter } => {
                    let WarpOp::Resample { prefilter: p, .. } = &op else { panic!("{g:?}: {op:?}") };
                    assert_eq!(prefilter.is_some(), p.is_some(), "{g:?}");
                    "Resample"
                }
            };
            assert_eq!(op.path_name(), want, "{g:?} {edge:?}");
        }
    }

    #[test]
    fn coefficients_are_normalised() {
        for (i, o) in [(100u32, 25u32), (25, 100), (7, 5), (6000, 1600)] {
            let c = coefficients(i, o, lanczos3_filter, 3.0);
            for (k, b) in c.bounds.iter().enumerate() {
                let s: f32 = c.weights[k * c.window..k * c.window + b[1] as usize].iter().sum();
                assert!((s - 1.0).abs() < 1e-5, "{i}->{o} at {k}: {s}");
                assert!(b[0] + b[1] <= i);
            }
        }
    }
}
