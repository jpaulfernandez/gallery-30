//! The guided filter (He, Sun, Tang, "Guided Image Filtering", 2010/2013) with a grey guide, in its fast
//! form (He, Sun, "Fast Guided Filter", 2015): the linear coefficients `a`, `b` are solved on planes
//! box-downsampled by `s`, mean-filtered there, upsampled bilinearly and applied to the full-resolution
//! guide, `q = ā·I + b̄`. Edges in the output follow the full-resolution guide, so the coarse stage costs
//! little sharpness while doing ~1/s² of the work.
//!
//! In each `(2r+1)²` window the output is the least-squares affine map of the guide onto the input with
//! a ridge `eps` on the slope: where the guide's variance is well above `eps` (an edge) `a → 1` and the
//! edge passes through; where it is well below (texture, noise) `a → 0` and the output is the local
//! mean. `eps` is in the guide's units squared.

use super::blur::{box_filtered, downsample_mean, reduced_size};
use rayon::prelude::*;

/// Subsample factor for the coarse stage: a quarter of the resolution once the radius is 8 px or more,
/// less for small radii so the low-resolution window keeps at least two pixels each side.
pub fn guided_subsample(radius: f32) -> usize {
    (radius / 2.0).floor().clamp(1.0, 4.0) as usize
}

/// Guided filter of `input` (or of the guide itself when `None`) with window radius `radius` in
/// full-resolution pixels. Uses the coarse stage at [`guided_subsample`].
pub fn guided_filter(guide: &[f32], input: Option<&[f32]>, w: usize, h: usize, radius: f32, eps: f32) -> Vec<f32> {
    guided_filter_with(guide, input, w, h, radius, eps, guided_subsample(radius))
}

/// [`guided_filter`] with an explicit subsample factor (1 = the exact filter).
pub fn guided_filter_with(
    guide: &[f32],
    input: Option<&[f32]>,
    w: usize,
    h: usize,
    radius: f32,
    eps: f32,
    subsample: usize,
) -> Vec<f32> {
    let s = subsample.max(1);
    let (lw, lh) = reduced_size(w, h, s);
    let g_low = downsample_mean(guide, w, h, s);
    let p_low = input.map(|p| downsample_mean(p, w, h, s));
    let (a, b) = guided_coefficients(&g_low, p_low.as_deref(), lw, lh, radius / s as f32, eps);
    apply_coefficients(&a, &b, lw, lh, s, guide, w, h)
}

/// The mean-filtered coefficients `(ā, b̄)` on a (possibly reduced) plane. `input = None` filters the
/// guide by itself. `radius` is in the plane's own pixels (rounded, at least 1).
pub fn guided_coefficients(
    guide: &[f32],
    input: Option<&[f32]>,
    w: usize,
    h: usize,
    radius: f32,
    eps: f32,
) -> (Vec<f32>, Vec<f32>) {
    let r = (radius.round() as usize).max(1);
    let mean_i = box_filtered(guide, w, h, r);
    let sq: Vec<f32> = guide.par_iter().map(|v| v * v).collect();
    let corr_ii = box_filtered(&sq, w, h, r);
    drop(sq);
    let (mean_p, corr_ip) = match input {
        None => (None, None),
        Some(p) => {
            let gp: Vec<f32> = guide.par_iter().zip(p).map(|(g, p)| g * p).collect();
            (Some(box_filtered(p, w, h, r)), Some(box_filtered(&gp, w, h, r)))
        }
    };
    let mean_p = mean_p.as_deref().unwrap_or(&mean_i);
    let corr_ip = corr_ip.as_deref().unwrap_or(&corr_ii);
    let mut a = vec![0.0f32; w * h];
    let mut b = vec![0.0f32; w * h];
    a.par_iter_mut().zip(b.par_iter_mut()).enumerate().for_each(|(i, (a, b))| {
        let (mi, mp) = (mean_i[i], mean_p[i]);
        let var = (corr_ii[i] - mi * mi).max(0.0);
        let cov = corr_ip[i] - mi * mp;
        *a = cov / (var + eps);
        *b = mp - *a * mi;
    });
    (box_filtered(&a, w, h, r), box_filtered(&b, w, h, r))
}

/// `q = up(ā)·I + up(b̄)` at full resolution, the coefficients upsampled bilinearly from the plane
/// reduced by `factor`.
#[allow(clippy::too_many_arguments)]
pub fn apply_coefficients(
    a: &[f32],
    b: &[f32],
    lw: usize,
    lh: usize,
    factor: usize,
    guide: &[f32],
    w: usize,
    h: usize,
) -> Vec<f32> {
    let mut out = vec![0.0f32; w * h];
    if w == 0 || h == 0 {
        return out;
    }
    let scale = 1.0 / factor.max(1) as f32;
    let coord = |v: usize, n: usize| -> (usize, usize, f32) {
        let p = ((v as f32 + 0.5) * scale - 0.5).max(0.0);
        let i = (p as usize).min(n - 1);
        let j = (i + 1).min(n - 1);
        (i, j, p - i as f32)
    };
    let xs: Vec<(usize, usize, f32)> = (0..w).map(|x| coord(x, lw)).collect();
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let (y0, y1, fy) = coord(y, lh);
        let lerp = |p: &[f32], x0: usize, x1: usize, fx: f32| {
            let (r0, r1) = (&p[y0 * lw..(y0 + 1) * lw], &p[y1 * lw..(y1 + 1) * lw]);
            let top = r0[x0] + (r0[x1] - r0[x0]) * fx;
            let bottom = r1[x0] + (r1[x1] - r1[x0]) * fx;
            top + (bottom - top) * fy
        };
        let g = &guide[y * w..(y + 1) * w];
        for ((cell, &(x0, x1, fx)), gv) in row.iter_mut().zip(&xs).zip(g) {
            *cell = lerp(a, x0, x1, fx) * gv + lerp(b, x0, x1, fx);
        }
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(n: usize, seed: u32) -> Vec<f32> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (s >> 8) as f32 / (1u32 << 24) as f32 - 0.5
            })
            .collect()
    }

    /// Standard deviation over columns 20..90 (the left flat, clear of the edge's reach).
    fn flat_std(p: &[f32], w: usize, h: usize) -> f32 {
        let v: Vec<f32> = (0..h).flat_map(|y| p[y * w + 20..y * w + 90].iter().copied()).collect();
        let m = v.iter().sum::<f32>() / v.len() as f32;
        (v.iter().map(|x| (x - m).powi(2)).sum::<f32>() / v.len() as f32).sqrt()
    }

    /// A noisy step: the filter keeps the step sharp and smooths the flats, exact and fast forms.
    #[test]
    fn step_edge_is_kept_and_flats_are_smoothed() {
        let (w, h) = (240, 160);
        let n = noise(w * h, 11);
        let plane: Vec<f32> = (0..w * h).map(|i| if i % w < w / 2 { 0.0 } else { 3.0 } + 0.1 * n[i]).collect();
        for s in [1, 4] {
            let out = guided_filter_with(&plane, None, w, h, 12.0, 0.05, s);
            for y in [20, 80, 140] {
                let row = &out[y * w..(y + 1) * w];
                // No blur across the edge: one pixel either side keeps nearly the full step.
                assert!(row[w / 2 - 2] < 0.15, "s={s} left of edge {}", row[w / 2 - 2]);
                assert!(row[w / 2 + 1] > 2.85, "s={s} right of edge {}", row[w / 2 + 1]);
            }
            // Noise on the flats drops a lot.
            let (before, after) = (flat_std(&plane, w, h), flat_std(&out, w, h));
            assert!(after < before * 0.3, "s={s} {before} -> {after}");
        }
    }

    #[test]
    fn constant_stays_constant_and_input_follows_guide() {
        let (w, h) = (50, 40);
        let c = vec![0.7f32; w * h];
        let out = guided_filter(&c, None, w, h, 9.0, 0.01);
        assert!(out.iter().all(|v| (v - 0.7).abs() < 1e-5));
        // An input that is an affine function of the guide comes back (small eps).
        let g: Vec<f32> = (0..w * h).map(|i| (i % w) as f32 / w as f32).collect();
        let p: Vec<f32> = g.iter().map(|v| 2.0 * v + 0.25).collect();
        let out = guided_filter_with(&g, Some(&p), w, h, 4.0, 1e-6, 1);
        assert!(out.iter().zip(&p).all(|(a, b)| (a - b).abs() < 1e-3));
    }
}
