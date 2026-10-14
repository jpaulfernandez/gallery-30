//! Separable filters on single-channel `f32` planes (row-major, `w * h`), all clamping at the edges
//! (the border pixel repeats), parallel over rows with `rayon`.
//!
//! - [`gaussian_blur`]: an exact sampled kernel for small σ, three box passes above [`BOX_SIGMA_MIN`].
//! - [`box_filter`]: the mean over a `(2r+1)²` window by running sums, O(1) per pixel for any radius.
//! - [`min_filter`]: the minimum over a `(2r+1)²` window, O(r) per pixel (used at reduced resolution).
//! - [`downsample_mean`], [`downsample_min`], [`upsample_bilinear`]: integer-factor resampling for the
//!   coarse stages.

use rayon::prelude::*;

/// From this σ up, [`gaussian_blur`] uses three box passes instead of the sampled kernel.
pub const BOX_SIGMA_MIN: f32 = 4.0;
/// Rows per band in the vertical running sum: each band pays `2r+1` rows to start its window.
const BAND_ROWS: usize = 64;

/// Normalised Gaussian kernel of radius `ceil(3σ)`.
pub(crate) fn kernel(sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil().max(1.0) as i32;
    let k: Vec<f32> = (-radius..=radius).map(|i| (-0.5 * (i as f32 / sigma).powi(2)).exp()).collect();
    let sum: f32 = k.iter().sum();
    k.into_iter().map(|v| v / sum).collect()
}

/// Separable Gaussian blur in place. σ in pixels; `σ <= 0` does nothing.
///
/// Below [`BOX_SIGMA_MIN`] the kernel is sampled exactly (radius `ceil(3σ)`); above, three box passes
/// whose widths match the Gaussian's variance (Kovesi / Kutskir), O(1) per pixel whatever the σ.
pub fn gaussian_blur(plane: &mut [f32], w: usize, h: usize, sigma: f32) {
    if sigma <= 0.0 || w == 0 || h == 0 {
        return;
    }
    assert_eq!(plane.len(), w * h);
    if sigma < BOX_SIGMA_MIN {
        convolve_separable(plane, w, h, &kernel(sigma));
    } else {
        for r in box_radii_for_gaussian(sigma, 3) {
            box_filter(plane, w, h, r);
        }
    }
}

/// [`gaussian_blur`] into a new plane.
pub fn gaussian_blurred(plane: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let mut out = plane.to_vec();
    gaussian_blur(&mut out, w, h, sigma);
    out
}

/// Radii of `n` successive box filters whose combined variance is close to σ² (widths odd, two
/// neighbouring sizes).
pub fn box_radii_for_gaussian(sigma: f32, n: usize) -> Vec<usize> {
    let nf = n as f32;
    let ideal = (12.0 * sigma * sigma / nf + 1.0).sqrt();
    let mut wl = ideal.floor() as i64;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wl = wl.max(1);
    let wu = wl + 2;
    let wlf = wl as f32;
    let m = ((12.0 * sigma * sigma - nf * wlf * wlf - 4.0 * nf * wlf - 3.0 * nf) / (-4.0 * wlf - 4.0)).round();
    let m = m.clamp(0.0, nf) as usize;
    (0..n)
        .map(|i| {
            let width = if i < m { wl } else { wu };
            (width as usize - 1) / 2
        })
        .collect()
}

fn convolve_separable(plane: &mut [f32], w: usize, h: usize, k: &[f32]) {
    let r = k.len() / 2;
    // Horizontal, through a padded copy of each row.
    plane.par_chunks_mut(w).for_each_init(
        || vec![0.0f32; w + 2 * r],
        |pad, row| {
            for (i, p) in pad.iter_mut().enumerate() {
                *p = row[(i as isize - r as isize).clamp(0, w as isize - 1) as usize];
            }
            for (x, cell) in row.iter_mut().enumerate() {
                *cell = k.iter().zip(&pad[x..x + k.len()]).map(|(a, b)| a * b).sum();
            }
        },
    );
    // Vertical: each output row accumulates whole input rows (contiguous, vectorisable).
    let src = plane.to_vec();
    plane.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        row.fill(0.0);
        for (i, kv) in k.iter().enumerate() {
            let sy = (y as isize + i as isize - r as isize).clamp(0, h as isize - 1) as usize;
            for (o, s) in row.iter_mut().zip(&src[sy * w..(sy + 1) * w]) {
                *o += kv * s;
            }
        }
    });
}

/// Mean over the `(2r+1)²` window around each pixel, in place, edges clamped. `r = 0` does nothing.
pub fn box_filter(plane: &mut [f32], w: usize, h: usize, r: usize) {
    if r == 0 || w == 0 || h == 0 {
        return;
    }
    assert_eq!(plane.len(), w * h);
    box_horizontal(plane, w, r);
    box_vertical(plane, w, h, r);
}

/// [`box_filter`] into a new plane.
pub fn box_filtered(plane: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut out = plane.to_vec();
    box_filter(&mut out, w, h, r);
    out
}

fn box_horizontal(plane: &mut [f32], w: usize, r: usize) {
    let inv = 1.0 / (2 * r + 1) as f64;
    plane.par_chunks_mut(w).for_each_init(
        || vec![0.0f32; w],
        |src, row| {
            src.copy_from_slice(row);
            let at = |i: isize| src[i.clamp(0, w as isize - 1) as usize] as f64;
            let r = r as isize;
            let mut sum: f64 = (-r..=r).map(at).sum();
            for (x, cell) in row.iter_mut().enumerate() {
                *cell = (sum * inv) as f32;
                let x = x as isize;
                sum += at(x + r + 1) - at(x - r);
            }
        },
    );
}

fn box_vertical(plane: &mut [f32], w: usize, h: usize, r: usize) {
    let inv = 1.0 / (2 * r + 1) as f64;
    let src = plane.to_vec();
    let row = |y: isize| -> &[f32] {
        let y = y.clamp(0, h as isize - 1) as usize;
        &src[y * w..(y + 1) * w]
    };
    let r = r as isize;
    plane.par_chunks_mut(w * BAND_ROWS).enumerate().for_each_init(
        || vec![0.0f64; w],
        |acc, (band, out)| {
            let y0 = (band * BAND_ROWS) as isize;
            acc.fill(0.0);
            for y in y0 - r..=y0 + r {
                for (a, s) in acc.iter_mut().zip(row(y)) {
                    *a += *s as f64;
                }
            }
            for (i, out_row) in out.chunks_exact_mut(w).enumerate() {
                let y = y0 + i as isize;
                for (o, a) in out_row.iter_mut().zip(acc.iter()) {
                    *o = (*a * inv) as f32;
                }
                for ((a, add), sub) in acc.iter_mut().zip(row(y + r + 1)).zip(row(y - r)) {
                    *a += *add as f64 - *sub as f64;
                }
            }
        },
    );
}

/// Minimum over the `(2r+1)²` window around each pixel (separable), edges clamped.
pub fn min_filter(plane: &mut [f32], w: usize, h: usize, r: usize) {
    if r == 0 || w == 0 || h == 0 {
        return;
    }
    let r = r as isize;
    plane.par_chunks_mut(w).for_each_init(
        || vec![0.0f32; w],
        |src, row| {
            src.copy_from_slice(row);
            for (x, cell) in row.iter_mut().enumerate() {
                let x = x as isize;
                let (a, b) = ((x - r).max(0) as usize, (x + r).min(w as isize - 1) as usize);
                *cell = src[a..=b].iter().copied().fold(f32::INFINITY, f32::min);
            }
        },
    );
    let src = plane.to_vec();
    plane.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        row.fill(f32::INFINITY);
        let (a, b) = ((y as isize - r).max(0) as usize, (y as isize + r).min(h as isize - 1) as usize);
        for sy in a..=b {
            for (o, s) in row.iter_mut().zip(&src[sy * w..(sy + 1) * w]) {
                *o = o.min(*s);
            }
        }
    });
}

/// Size of a plane downsampled by `factor` (partial cells at the right and bottom edges count).
pub fn reduced_size(w: usize, h: usize, factor: usize) -> (usize, usize) {
    (w.div_ceil(factor), h.div_ceil(factor))
}

/// Average of each `factor × factor` cell (edge cells average what they cover).
pub fn downsample_mean(plane: &[f32], w: usize, h: usize, factor: usize) -> Vec<f32> {
    downsample(plane, w, h, factor, |cell| cell.iter().sum::<f32>() / cell.len() as f32)
}

/// Minimum of each `factor × factor` cell.
pub fn downsample_min(plane: &[f32], w: usize, h: usize, factor: usize) -> Vec<f32> {
    downsample(plane, w, h, factor, |cell| cell.iter().copied().fold(f32::INFINITY, f32::min))
}

fn downsample(plane: &[f32], w: usize, h: usize, factor: usize, reduce: impl Fn(&[f32]) -> f32 + Sync) -> Vec<f32> {
    if factor <= 1 {
        return plane.to_vec();
    }
    let (lw, lh) = reduced_size(w, h, factor);
    let mut low = vec![0.0f32; lw * lh];
    low.par_chunks_mut(lw).enumerate().for_each_init(
        || Vec::with_capacity(factor * factor),
        |cell, (ly, row)| {
            let (y0, y1) = (ly * factor, ((ly + 1) * factor).min(h));
            for (lx, out) in row.iter_mut().enumerate() {
                let (x0, x1) = (lx * factor, ((lx + 1) * factor).min(w));
                cell.clear();
                for y in y0..y1 {
                    cell.extend_from_slice(&plane[y * w + x0..y * w + x1]);
                }
                *out = reduce(cell);
            }
        },
    );
    low
}

/// Bilinear upsample of a plane reduced by `factor` back to `w × h`, sampling at pixel centres.
pub fn upsample_bilinear(low: &[f32], lw: usize, lh: usize, factor: usize, w: usize, h: usize) -> Vec<f32> {
    if factor <= 1 {
        return low.to_vec();
    }
    let scale = 1.0 / factor as f32;
    let coord = |v: usize, n: usize| -> (usize, usize, f32) {
        let p = ((v as f32 + 0.5) * scale - 0.5).max(0.0);
        let i = (p as usize).min(n - 1);
        let j = (i + 1).min(n - 1);
        (i, j, p - i as f32)
    };
    let xs: Vec<(usize, usize, f32)> = (0..w).map(|x| coord(x, lw)).collect();
    let mut out = vec![0.0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let (y0, y1, fy) = coord(y, lh);
        let (r0, r1) = (&low[y0 * lw..(y0 + 1) * lw], &low[y1 * lw..(y1 + 1) * lw]);
        for (cell, &(x0, x1, fx)) in row.iter_mut().zip(&xs) {
            let top = r0[x0] + (r0[x1] - r0[x0]) * fx;
            let bottom = r1[x0] + (r1[x1] - r1[x0]) * fx;
            *cell = top + (bottom - top) * fy;
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
                (s >> 8) as f32 / (1u32 << 24) as f32
            })
            .collect()
    }

    fn mean(p: &[f32]) -> f64 {
        p.iter().map(|&v| v as f64).sum::<f64>() / p.len() as f64
    }

    #[test]
    fn box_filter_of_a_constant_is_constant() {
        for r in [1, 3, 17, 80] {
            let mut p = vec![0.37f32; 97 * 61];
            box_filter(&mut p, 97, 61, r);
            assert!(p.iter().all(|v| (v - 0.37).abs() < 1e-6), "r={r}");
        }
    }

    #[test]
    fn box_filter_matches_brute_force() {
        let (w, h, r) = (23, 19, 3);
        let src = noise(w * h, 7);
        let got = box_filtered(&src, w, h, r);
        for y in 0..h {
            for x in 0..w {
                let mut sum = 0.0;
                for dy in -(r as isize)..=r as isize {
                    for dx in -(r as isize)..=r as isize {
                        let sx = (x as isize + dx).clamp(0, w as isize - 1) as usize;
                        let sy = (y as isize + dy).clamp(0, h as isize - 1) as usize;
                        sum += src[sy * w + sx];
                    }
                }
                let want = sum / ((2 * r + 1) * (2 * r + 1)) as f32;
                assert!((got[y * w + x] - want).abs() < 1e-5);
            }
        }
    }

    #[test]
    fn gaussian_preserves_mean_and_smooths() {
        let (w, h) = (400, 300);
        let src = noise(w * h, 3);
        let var = |p: &[f32]| {
            let m = mean(p);
            p.iter().map(|&v| (v as f64 - m).powi(2)).sum::<f64>() / p.len() as f64
        };
        for sigma in [1.0, 2.5, 6.0, 20.0] {
            let out = gaussian_blurred(&src, w, h, sigma);
            assert!((mean(&out) - mean(&src)).abs() < 2e-3, "σ={sigma}");
            assert!(var(&out) < var(&src) * 0.2, "σ={sigma}");
        }
        // A step: the middle lands near half, the far ends stay put.
        let mut step: Vec<f32> = (0..64 * 32).map(|i| if (i % 64) < 32 { 0.0 } else { 1.0 }).collect();
        gaussian_blur(&mut step, 64, 32, 4.0);
        let mid = step[16 * 64 + 32];
        assert!(mid > 0.3 && mid < 0.7);
        assert!(step[16 * 64] < 0.01 && step[16 * 64 + 63] > 0.99);
    }

    #[test]
    fn box_passes_match_gaussian_variance() {
        for sigma in [4.0f32, 7.5, 22.0] {
            let var: f32 = box_radii_for_gaussian(sigma, 3).iter().map(|&r| ((2 * r + 1).pow(2) - 1) as f32 / 12.0).sum();
            assert!((var.sqrt() - sigma).abs() / sigma < 0.08, "σ={sigma} got {}", var.sqrt());
        }
    }

    #[test]
    fn min_filter_and_resampling() {
        let (w, h) = (10, 8);
        let mut p = vec![1.0f32; w * h];
        p[4 * w + 5] = 0.0;
        min_filter(&mut p, w, h, 2);
        assert_eq!(p[2 * w + 3], 0.0);
        assert_eq!(p[2 * w + 2], 1.0);
        let c = vec![0.5f32; w * h];
        let low = downsample_mean(&c, w, h, 3);
        let (lw, lh) = reduced_size(w, h, 3);
        let up = upsample_bilinear(&low, lw, lh, 3, w, h);
        assert!(up.iter().all(|v| (v - 0.5).abs() < 1e-6));
    }
}
