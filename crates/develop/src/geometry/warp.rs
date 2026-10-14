//! Resample a [`LinearImage`] through a [`GeometryPlan`].
//!
//! Three paths, picked from the plan's inverse map:
//!
//! 1. **Copy**: the map sends output pixel centres onto source pixel centres one to one (rotate 90/180/270,
//!    flips, whole-pixel crops, any mix). Pixels are copied, bit-exact, no filtering.
//! 2. **Copy + resize**: axis-aligned (no straighten) but scaled, with a crop on whole source pixels:
//!    exact copy of the crop, then the same `fast_image_resize` Lanczos3 downscale decode uses.
//! 3. **Resample**: inverse mapping per output pixel centre. When the map minifies by more than
//!    [`PREFILTER_THRESHOLD`] anywhere, the source is first reduced with a Mitchell filter (area-aware, by
//!    the smallest local minification, so nothing is magnified afterwards). Then each pixel is gathered
//!    with Catmull-Rom (4×4, [`Quality::Preview`]) or Lanczos3 (6×6, normalised weights,
//!    [`Quality::Export`]); the result is clipped to the range of the 2×2 nearest source pixels, which
//!    removes ringing and negative values. Taps past the edge clamp to the edge.

use fast_image_resize as fr;
use rayon::prelude::*;

use super::homography::Homography;
use super::transform::GeometryPlan;
use crate::decode::resize_linear;
use crate::image::LinearImage;

/// Resampling quality.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Quality {
    /// Catmull-Rom bicubic.
    Preview,
    /// Lanczos3.
    Export,
}

/// Images whose long edge is at most this many pixels resample with [`Quality::Preview`].
pub const PREVIEW_MAX_LONG_EDGE: u32 = 2000;

impl Quality {
    /// [`Quality::Preview`] for images up to [`PREVIEW_MAX_LONG_EDGE`], [`Quality::Export`] above.
    pub fn for_size(width: u32, height: u32) -> Quality {
        if width.max(height) <= PREVIEW_MAX_LONG_EDGE {
            Quality::Preview
        } else {
            Quality::Export
        }
    }
}

/// Local minification above which the source is prefiltered.
pub const PREFILTER_THRESHOLD: f64 = 1.25;

/// Which path a warp took.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WarpPath {
    Copy,
    CopyResize,
    /// `prefilter` is the reduction factor applied first, if any.
    Resample { prefilter: Option<f64> },
}

/// What a warp did, for tests and logging.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WarpStats {
    pub path: WarpPath,
    /// Output pixels whose centre mapped outside the source (more than 1e-6 px past an edge), i.e. pixels
    /// filled by edge clamping. Zero whenever the crop is constrained.
    pub out_of_bounds: u64,
}

/// Warp `image` into the plan's output framing. `image` must be the size the plan was made for.
pub fn warp(image: &LinearImage, plan: &GeometryPlan, quality: Quality) -> LinearImage {
    warp_with_stats(image, plan, quality).0
}

/// [`warp`], also reporting the path taken and the edge-clamped pixel count. The output keeps the source's
/// [`meta`](LinearImage::meta).
pub fn warp_with_stats(image: &LinearImage, plan: &GeometryPlan, quality: Quality) -> (LinearImage, WarpStats) {
    let (out, stats) = warp_paths(image, plan, quality);
    (out.with_meta(image.meta.clone()), stats)
}

fn warp_paths(image: &LinearImage, plan: &GeometryPlan, quality: Quality) -> (LinearImage, WarpStats) {
    assert_eq!(
        (image.width, image.height),
        (plan.source_width, plan.source_height),
        "warp: the image is not the size the plan was made for"
    );
    let (ow, oh) = (plan.output_width, plan.output_height);
    if let Some(map) = PixelMap::new(&plan.inverse, image.width, image.height, ow, oh) {
        return (map.copy(image), WarpStats { path: WarpPath::Copy, out_of_bounds: 0 });
    }
    if let Some(out) = copy_resize(image, plan) {
        return (out, WarpStats { path: WarpPath::CopyResize, out_of_bounds: 0 });
    }
    resample(image, plan, quality)
}

/// The general path (3), whatever the plan: for tests and benchmarks.
pub fn resample(image: &LinearImage, plan: &GeometryPlan, quality: Quality) -> (LinearImage, WarpStats) {
    let (ow, oh) = (plan.output_width, plan.output_height);
    let (sw, sh) = (image.width as f64, image.height as f64);
    let out_of_bounds = count_out_of_bounds(&plan.inverse, ow, oh, sw, sh);

    let min_scale = min_local_scale(&plan.inverse, ow, oh);
    let reduced;
    let (src, inverse, prefilter) = if min_scale > PREFILTER_THRESHOLD {
        let rw = ((sw / min_scale).round() as u32).max(1);
        let rh = ((sh / min_scale).round() as u32).max(1);
        reduced = resize_filter(image, rw, rh, fr::FilterType::Mitchell);
        let inv = plan.inverse.then(&Homography::scale(rw as f64 / sw, rh as f64 / sh));
        (&reduced, inv, Some(min_scale))
    } else {
        (image, plan.inverse, None)
    };

    let mut data = vec![0.0f32; ow as usize * oh as usize * 3];
    if !data.is_empty() {
        match quality {
            Quality::Preview => gather::<4, _>(src, &inverse, ow, &mut data, &catmull_rom_weights),
            Quality::Export => {
                let lut = lanczos3_lut();
                gather::<6, _>(src, &inverse, ow, &mut data, &|t| lanczos3_weights(lut, t))
            }
        }
    }
    (LinearImage::new(ow, oh, data), WarpStats { path: WarpPath::Resample { prefilter }, out_of_bounds })
}

// ---------- path 1: exact copies ----------

/// An integer map: source index = `origin + i·dx + j·dy` for output pixel `(i, j)`.
struct PixelMap {
    width: u32,
    height: u32,
    origin: (i64, i64),
    dx: (i64, i64),
    dy: (i64, i64),
}

fn near_int(v: f64, eps: f64) -> Option<i64> {
    let r = v.round();
    ((v - r).abs() <= eps).then_some(r as i64)
}

impl PixelMap {
    fn new(inverse: &Homography, sw: u32, sh: u32, ow: u32, oh: u32) -> Option<PixelMap> {
        if !inverse.is_affine(1e-12) {
            return None;
        }
        let m = inverse.normalized().0;
        let a = [m[0], m[1], m[3], m[4]].map(|v| near_int(v, 1e-9));
        let [Some(a0), Some(a1), Some(a3), Some(a4)] = a else { return None };
        if ![a0, a1, a3, a4].iter().all(|v| v.abs() <= 1) || (a0 * a4 - a1 * a3).abs() != 1 {
            return None;
        }
        // Source pixel index of output pixel (0, 0): centre maps to centre.
        let p = inverse.apply([0.5, 0.5]);
        let ox = near_int(p[0] - 0.5, 1e-6)?;
        let oy = near_int(p[1] - 0.5, 1e-6)?;
        let map = PixelMap { width: ow, height: oh, origin: (ox, oy), dx: (a0, a3), dy: (a1, a4) };
        let (lx, ly) = (ow as i64 - 1, oh as i64 - 1);
        for (i, j) in [(0, 0), (lx, 0), (0, ly), (lx, ly)] {
            let (x, y) = map.at(i, j);
            if x < 0 || y < 0 || x >= sw as i64 || y >= sh as i64 {
                return None;
            }
        }
        Some(map)
    }

    #[inline]
    fn at(&self, i: i64, j: i64) -> (i64, i64) {
        (self.origin.0 + i * self.dx.0 + j * self.dy.0, self.origin.1 + i * self.dx.1 + j * self.dy.1)
    }

    fn copy(&self, image: &LinearImage) -> LinearImage {
        let (ow, oh) = (self.width as usize, self.height as usize);
        let sw = image.width as usize;
        let mut data = vec![0.0f32; ow * oh * 3];
        data.par_chunks_mut(ow * 3).enumerate().for_each(|(j, row)| {
            let (x0, y0) = self.at(0, j as i64);
            if self.dx == (1, 0) {
                let s = (y0 as usize * sw + x0 as usize) * 3;
                row.copy_from_slice(&image.data[s..s + ow * 3]);
                return;
            }
            for (i, px) in row.chunks_exact_mut(3).enumerate() {
                let (x, y) = (x0 + i as i64 * self.dx.0, y0 + i as i64 * self.dx.1);
                let s = (y as usize * sw + x as usize) * 3;
                px.copy_from_slice(&image.data[s..s + 3]);
            }
        });
        LinearImage::new(self.width, self.height, data)
    }
}

// ---------- path 2: exact crop, then a resize ----------

fn copy_resize(image: &LinearImage, plan: &GeometryPlan) -> Option<LinearImage> {
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
    // Source footprint of the whole output.
    let a = inv.apply([0.0, 0.0]);
    let b = inv.apply([ow, oh]);
    let (sx0, sx1) = (a[0].min(b[0]), a[0].max(b[0]));
    let (sy0, sy1) = (a[1].min(b[1]), a[1].max(b[1]));
    let eps = 1e-6;
    let (x0, x1, y0, y1) = (near_int(sx0, eps)?, near_int(sx1, eps)?, near_int(sy0, eps)?, near_int(sy1, eps)?);
    if x0 < 0 || y0 < 0 || x1 > image.width as i64 || y1 > image.height as i64 || x1 <= x0 || y1 <= y0 {
        return None;
    }
    // Intermediate: the output orientation at source resolution.
    let (iw, ih) = if swap { (y1 - y0, x1 - x0) } else { (x1 - x0, y1 - y0) };
    let to_out = Homography::scale(ow / iw as f64, oh / ih as f64);
    let inv_i = to_out.then(inv);
    let map = PixelMap::new(&inv_i, image.width, image.height, iw as u32, ih as u32)?;
    let cropped = map.copy(image);
    resize_linear(cropped, plan.output_width, plan.output_height).ok()
}

// ---------- path 3: resampling ----------

fn count_out_of_bounds(inv: &Homography, ow: u32, oh: u32, sw: f64, sh: f64) -> u64 {
    let eps = 1e-6;
    (0..oh)
        .into_par_iter()
        .map(|j| {
            let mut n = 0u64;
            for i in 0..ow {
                let [x, y] = inv.apply([i as f64 + 0.5, j as f64 + 0.5]);
                if !(x >= -eps && y >= -eps && x <= sw + eps && y <= sh + eps) {
                    n += 1;
                }
            }
            n
        })
        .sum()
}

/// Smallest singular value of the inverse map's Jacobian over a 9×9 grid of the output: how much the
/// least-minified part of the output shrinks the source.
fn min_local_scale(inv: &Homography, ow: u32, oh: u32) -> f64 {
    let mut best = f64::INFINITY;
    for gy in 0..=8 {
        for gx in 0..=8 {
            let p = [ow as f64 * gx as f64 / 8.0, oh as f64 * gy as f64 / 8.0];
            let [a, b, c, d] = inv.jacobian(p);
            // Singular values of [[a, b], [c, d]].
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

fn resize_filter(image: &LinearImage, width: u32, height: u32, filter: fr::FilterType) -> LinearImage {
    let src: Vec<fr::pixels::F32x3> =
        image.data.chunks_exact(3).map(|p| fr::pixels::F32x3::new([p[0], p[1], p[2]])).collect();
    let src = fr::images::TypedImageRef::new(image.width, image.height, &src).expect("valid image size");
    let mut dst = fr::images::TypedImage::<fr::pixels::F32x3>::new(width, height);
    let options = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(filter));
    fr::Resizer::new().resize_typed(&src, &mut dst, &options).expect("same pixel type");
    LinearImage::new(width, height, dst.pixels().iter().flat_map(|p| p.0).collect())
}

/// Catmull-Rom (Keys, a = −½) weights for taps at `floor − 1 .. floor + 2`, `t` the fractional offset.
#[inline]
fn catmull_rom_weights(t: f32) -> [f32; 4] {
    let t2 = t * t;
    let t3 = t2 * t;
    [
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
    ]
}

const LANCZOS_LUT_PER_UNIT: usize = 1024;

fn lanczos3(x: f64) -> f64 {
    let x = x.abs();
    if x < 1e-12 {
        return 1.0;
    }
    if x >= 3.0 {
        return 0.0;
    }
    let px = std::f64::consts::PI * x;
    3.0 * px.sin() * (px / 3.0).sin() / (px * px)
}

fn lanczos3_lut() -> &'static [f32] {
    static LUT: std::sync::OnceLock<Vec<f32>> = std::sync::OnceLock::new();
    LUT.get_or_init(|| {
        (0..=3 * LANCZOS_LUT_PER_UNIT + 1).map(|i| lanczos3(i as f64 / LANCZOS_LUT_PER_UNIT as f64) as f32).collect()
    })
}

/// Lanczos3 weights for taps at `floor − 2 .. floor + 3`, normalised to sum to 1.
#[inline]
fn lanczos3_weights(lut: &[f32], t: f32) -> [f32; 6] {
    let k = |x: f32| {
        let f = x.abs() * LANCZOS_LUT_PER_UNIT as f32;
        let i = f as usize;
        if i >= 3 * LANCZOS_LUT_PER_UNIT {
            return 0.0;
        }
        let r = f - i as f32;
        lut[i] + (lut[i + 1] - lut[i]) * r
    };
    let mut w = [k(t + 2.0), k(t + 1.0), k(t), k(1.0 - t), k(2.0 - t), k(3.0 - t)];
    let sum: f32 = w.iter().sum();
    if sum != 0.0 {
        for v in &mut w {
            *v /= sum;
        }
    }
    w
}

/// Gather every output pixel with an `N`-tap separable kernel (`N` = 4 or 6).
fn gather<const N: usize, F: Fn(f32) -> [f32; N] + Sync>(
    src: &LinearImage,
    inv: &Homography,
    ow: u32,
    data: &mut [f32],
    weights: &F,
) {
    let (sw, sh) = (src.width as i64, src.height as i64);
    let stride = src.width as usize * 3;
    let m = inv.0;
    let affine = inv.is_affine(0.0);
    let back = (N as i64) / 2 - 1; // taps start at floor − back
    data.par_chunks_mut(ow as usize * 3).enumerate().for_each(|(j, row)| {
        let yc = j as f64 + 0.5;
        for (i, px) in row.chunks_exact_mut(3).enumerate() {
            let xc = i as f64 + 0.5;
            let (mut x, mut y) = (m[0] * xc + m[1] * yc + m[2], m[3] * xc + m[4] * yc + m[5]);
            if !affine {
                let w = m[6] * xc + m[7] * yc + m[8];
                x /= w;
                y /= w;
            }
            // Continuous → index space (pixel centres on integers).
            let (fx, fy) = (x - 0.5, y - 0.5);
            let (ix, iy) = (fx.floor(), fy.floor());
            let (tx, ty) = ((fx - ix) as f32, (fy - iy) as f32);
            let (ix, iy) = (ix as i64, iy as i64);
            let wx = weights(tx);
            let wy = weights(ty);
            let xs: [usize; N] = std::array::from_fn(|k| ((ix - back + k as i64).clamp(0, sw - 1) as usize) * 3);
            let ys: [usize; N] = std::array::from_fn(|k| (iy - back + k as i64).clamp(0, sh - 1) as usize * stride);
            let mut acc = [0.0f32; 3];
            for (yk, &wyk) in ys.iter().zip(wy.iter()) {
                let r = &src.data[*yk..*yk + stride];
                let mut racc = [0.0f32; 3];
                for (xk, &wxk) in xs.iter().zip(wx.iter()) {
                    racc[0] += wxk * r[*xk];
                    racc[1] += wxk * r[*xk + 1];
                    racc[2] += wxk * r[*xk + 2];
                }
                acc[0] += wyk * racc[0];
                acc[1] += wyk * racc[1];
                acc[2] += wyk * racc[2];
            }
            // Clip to the 2×2 nearest neighbours (taps `back` and `back + 1`).
            let (n0, n1) = (xs[back as usize], xs[back as usize + 1]);
            let (r0, r1) = (ys[back as usize], ys[back as usize + 1]);
            for c in 0..3 {
                let a = src.data[r0 + n0 + c];
                let b = src.data[r0 + n1 + c];
                let d = src.data[r1 + n0 + c];
                let e = src.data[r1 + n1 + c];
                let lo = a.min(b).min(d.min(e));
                let hi = a.max(b).max(d.max(e));
                px[c] = acc[c].clamp(lo, hi);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernels_are_partitions_of_unity_and_interpolate() {
        for t in [0.0f32, 0.25, 0.5, 0.9] {
            let s: f32 = catmull_rom_weights(t).iter().sum();
            assert!((s - 1.0).abs() < 1e-6);
            let s: f32 = lanczos3_weights(lanczos3_lut(), t).iter().sum();
            assert!((s - 1.0).abs() < 1e-6);
        }
        assert_eq!(catmull_rom_weights(0.0), [0.0, 1.0, 0.0, 0.0]);
        let w = lanczos3_weights(lanczos3_lut(), 0.0);
        assert!((w[2] - 1.0).abs() < 1e-6 && w[0].abs() < 1e-6 && w[5].abs() < 1e-6);
    }
}
