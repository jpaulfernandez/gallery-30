//! Frequency-aware luminance merge of the AI denoise (workflow plan 25): how the model's Oklab L and the input's are
//! combined at a Luminance strength `t` (0..1) instead of the flat `L = lerp(L_in, L_out, t)`.
//!
//! An à trous ("with holes") B3-spline decomposition, [`LEVELS`] levels: `c₀ = L`, `c_{k+1}` = `c_k` filtered by the
//! separable kernel `[1, 4, 6, 4, 1] / 16` with `2^k − 1` zeros between the taps (dilation `2^k`), band
//! `d_k = c_k − c_{k+1}`, residual `c_LEVELS`; `L = Σ d_k + c_LEVELS` exactly. Each band (and the residual) is
//! blended with its own weight ([`BandWeights`]): with [`BandWeights::for_luminance`] the finest band (about 1–2 px,
//! where grain lives) is `lerp(d₀_in, d₀_out, t)` and the coarser bands and the residual are the model's from
//! `t = `[`COARSE_RAMP`] up, ramping linearly from the input's at `t = 0` (so the merge is continuous at 0). So the
//! slider scales how much of the input's grain comes back while the blotchy low-frequency noise the model removed
//! stays removed, where the flat blend brought both back alike.
//!
//! The decomposition is linear, so the merge only decomposes the difference `D = L_in − L_out` once:
//! `L = L_out + Σ (1 − w_k)·d_k(D) + (1 − w_res)·c_LEVELS(D)` ([`add_correction`]), and stops after the last level
//! whose weight is not 1: one level (a reach of 2 px each side) from `t = 0.1` up, all three (14 px) below. All
//! weights 1 returns `L_out` and all 0 returns `L_in`, bit for bit, so Luminance 100 and 0 give exactly what the flat
//! blend gave. A non-finite model value takes the input's before the difference, so it cannot spread through the
//! filters.
//!
//! The merge runs once per intermediate on the whole image after the tiles are blended, so no tile halo is needed.
//! Edges are mirrored without repeating the edge sample ([`mirror`]). The filters run in difference form,
//! `c + K0·((a − c) + (e − c)) + K1·((b − c) + (d − c))`, so a flat plane stays exactly flat. CPU only: about 50 ms at
//! 24 MP for one level, 110 ms for three (M3 Pro, release); a WGSL port measured slower for this one-off merge (the
//! planes' upload and readback) and was dropped.

use rayon::prelude::*;

/// Decomposition levels.
pub const LEVELS: usize = 3;
/// Part of the denoise key ([`super::denoise::denoise_key`]): intermediates made with the flat blend are not reused.
pub const MERGE: &str = "wavelet";
/// The Luminance strength from which the coarse bands and the residual are entirely the model's; below it they ramp
/// linearly from the input's at 0.
pub const COARSE_RAMP: f32 = 0.1;
/// The B3 spline's outer and inner tap weights (1/16, 4/16; the centre is 6/16).
const K0: f32 = 0.0625;
const K1: f32 = 0.25;

/// The weight of the model's output per band (0 = the input's, 1 = the model's).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BandWeights {
    /// Finest first.
    pub bands: [f32; LEVELS],
    pub residual: f32,
}

impl BandWeights {
    /// Every band and the residual at `w` (the flat blend, up to rounding).
    pub const fn uniform(w: f32) -> BandWeights {
        BandWeights { bands: [w; LEVELS], residual: w }
    }

    /// The Luminance slider's weights (`t` = luminance/100): the finest band at `t`, the rest at
    /// `min(1, t / COARSE_RAMP)`; all the input's at `t = 0`, all the model's at 1.
    pub fn for_luminance(t: f32) -> BandWeights {
        let t = t.clamp(0.0, 1.0);
        if t > 0.0 {
            let coarse = (t / COARSE_RAMP).min(1.0);
            let mut bands = [coarse; LEVELS];
            bands[0] = t;
            BandWeights { bands, residual: coarse }
        } else {
            BandWeights::uniform(0.0)
        }
    }

    /// Levels [`add_correction`] has to compute: all when the residual is not the model's, else up to the last band
    /// whose weight is not 1 (0: the merge is `L_out`).
    pub fn levels(&self) -> usize {
        if self.residual != 1.0 {
            LEVELS
        } else {
            self.bands.iter().rposition(|&w| w != 1.0).map_or(0, |k| k + 1)
        }
    }

    fn all(&self, w: f32) -> bool {
        self.residual == w && self.bands.iter().all(|&b| b == w)
    }
}

/// `i` mirrored into `0..n` without repeating the edge sample (`−1 → 1`, `n → n − 2`), clamped when the plane is
/// shorter than the reach.
#[inline]
pub fn mirror(i: isize, n: usize) -> usize {
    let n = n as isize;
    let mut j = i;
    if j < 0 {
        j = -j;
    }
    if j >= n {
        j = 2 * (n - 1) - j;
    }
    j.clamp(0, n - 1) as usize
}

#[inline]
fn b3(a: f32, b: f32, c: f32, d: f32, e: f32) -> f32 {
    c + K0 * ((a - c) + (e - c)) + K1 * ((b - c) + (d - c))
}

/// `c_{level+1}` from `c_level`: the B3 kernel at dilation `2^level`, horizontal then vertical.
pub fn smooth(plane: &[f32], w: usize, h: usize, level: usize) -> Vec<f32> {
    assert_eq!(plane.len(), w * h, "plane size");
    if w == 0 || h == 0 {
        return Vec::new();
    }
    let s = 1isize << level;
    let mut tmp = vec![0.0f32; w * h];
    tmp.par_chunks_mut(w).zip(plane.par_chunks(w)).for_each(|(o, row)| {
        let at = |x: usize, dx: isize| row[mirror(x as isize + dx, w)];
        for (x, v) in o.iter_mut().enumerate() {
            *v = b3(at(x, -2 * s), at(x, -s), row[x], at(x, s), at(x, 2 * s));
        }
    });
    let mut out = vec![0.0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, o)| {
        let row = |dy: isize| {
            let r = mirror(y as isize + dy, h);
            &tmp[r * w..(r + 1) * w]
        };
        let (a, b, c, d, e) = (row(-2 * s), row(-s), row(0), row(s), row(2 * s));
        for (x, v) in o.iter_mut().enumerate() {
            *v = b3(a[x], b[x], c[x], d[x], e[x]);
        }
    });
    out
}

/// The bands (finest first) and the residual of a plane.
#[derive(Debug, Clone)]
pub struct Decomposition {
    pub bands: Vec<Vec<f32>>,
    pub residual: Vec<f32>,
}

/// [`LEVELS`]-level decomposition of `plane`.
pub fn decompose(plane: &[f32], w: usize, h: usize) -> Decomposition {
    let mut bands = Vec::with_capacity(LEVELS);
    let mut cur = plane.to_vec();
    for k in 0..LEVELS {
        let next = smooth(&cur, w, h, k);
        bands.push(cur.par_iter().zip(&next).map(|(c, n)| c - n).collect());
        cur = next;
    }
    Decomposition { bands, residual: cur }
}

/// The sum of the bands and the residual: the plane [`decompose`] was given, up to rounding.
pub fn reconstruct(d: &Decomposition) -> Vec<f32> {
    let mut out = d.residual.clone();
    for band in d.bands.iter().rev() {
        out.par_iter_mut().zip(band).for_each(|(o, b)| *o += b);
    }
    out
}

/// Add `Σ (1 − w_k)·d_k(diff) + (1 − w_res)·c_LEVELS(diff)` to `out`, computing only [`BandWeights::levels`] levels
/// and skipping bands whose scale is 0. `diff` is consumed level by level, so at most three planes (the current level,
/// the next one and the filter's intermediate) are alive besides `out`.
pub fn add_correction(diff: Vec<f32>, out: &mut [f32], w: usize, h: usize, weights: &BandWeights) {
    assert_eq!((diff.len(), out.len()), (w * h, w * h), "plane sizes");
    let levels = weights.levels();
    let mut cur = diff;
    for k in 0..levels {
        let next = smooth(&cur, w, h, k);
        let s = 1.0 - weights.bands[k];
        if s != 0.0 {
            out.par_iter_mut().zip(cur.par_iter().zip(&next)).for_each(|(o, (&c, &n))| *o += s * (c - n));
        }
        cur = next;
    }
    let s = 1.0 - weights.residual;
    if levels == LEVELS && s != 0.0 {
        out.par_iter_mut().zip(cur.par_iter()).for_each(|(o, &c)| *o += s * c);
    }
}

/// The merged L of `l_in` and `l_out` (the model's, consumed and returned with the correction added) with `weights`.
/// Exactly `l_out` when every weight is 1, exactly `l_in` when every weight is 0. Otherwise a non-finite `l_out` value
/// takes `l_in`'s (and a non-finite difference counts as 0) before the filters, so one bad pixel cannot spread.
pub fn merge_l(l_in: &[f32], mut l_out: Vec<f32>, w: usize, h: usize, weights: &BandWeights) -> Vec<f32> {
    assert_eq!((l_in.len(), l_out.len()), (w * h, w * h), "plane sizes");
    if weights.all(0.0) {
        return l_in.to_vec();
    }
    if weights.levels() == 0 {
        return l_out;
    }
    l_out.par_iter_mut().zip(l_in).for_each(|(o, &i)| {
        if !o.is_finite() {
            *o = i;
        }
    });
    let diff: Vec<f32> = l_in
        .par_iter()
        .zip(&l_out)
        .map(|(a, b)| {
            let d = a - b;
            if d.is_finite() {
                d
            } else {
                0.0
            }
        })
        .collect();
    add_correction(diff, &mut l_out, w, h, weights);
    l_out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic hash in −0.5..0.5 (white noise).
    fn noise(x: usize, y: usize, seed: u32) -> f32 {
        let mut v = (x as u32).wrapping_mul(0x9E37_79B9) ^ (y as u32).wrapping_mul(0x85EB_CA6B) ^ seed.wrapping_mul(0xC2B2_AE35);
        v ^= v >> 16;
        v = v.wrapping_mul(0x7FEB_352D);
        v ^= v >> 15;
        v = v.wrapping_mul(0x846C_A68B);
        v ^= v >> 16;
        v as f32 / u32::MAX as f32 - 0.5
    }

    /// A smooth scene (gradients, a soft disc) in 0..1.
    fn scene(w: usize, h: usize) -> Vec<f32> {
        (0..w * h)
            .map(|i| {
                let (x, y) = ((i % w) as f32 / w as f32, (i / w) as f32 / h as f32);
                let disc = (-((x - 0.6).powi(2) + (y - 0.4).powi(2)) * 30.0).exp();
                0.2 + 0.3 * x + 0.1 * (6.0 * y).sin() + 0.3 * disc
            })
            .collect()
    }

    fn energy(v: &[f32]) -> f64 {
        v.iter().map(|&x| (x as f64).powi(2)).sum::<f64>() / v.len() as f64
    }

    fn max_abs_diff(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max)
    }

    #[test]
    fn mirror_reflects_without_repeating_the_edge() {
        assert_eq!([-2, -1, 0, 4, 5, 6].map(|i| mirror(i, 5)), [2, 1, 0, 4, 3, 2]);
        // Shorter than the reach: clamped.
        assert_eq!([-8, 9].map(|i| mirror(i, 3)), [0, 0]);
        assert_eq!(mirror(-3, 1), 0);
    }

    #[test]
    fn decomposition_reconstructs_the_plane() {
        for (w, h) in [(97, 61), (5, 300), (1, 1), (3, 2)] {
            let plane: Vec<f32> =
                scene(w, h).iter().enumerate().map(|(i, &v)| v + 0.05 * noise(i % w, i / w, 3)).collect();
            let d = decompose(&plane, w, h);
            assert_eq!(d.bands.len(), LEVELS);
            let back = reconstruct(&d);
            let err = max_abs_diff(&back, &plane);
            assert!(err < 1e-6, "{w}x{h}: {err}");
        }
    }

    #[test]
    fn a_flat_plane_stays_flat() {
        let (w, h) = (40, 30);
        let plane = vec![0.123_456_7f32; w * h];
        for k in 0..LEVELS {
            assert_eq!(smooth(&plane, w, h, k), plane, "level {k}");
        }
        let d = decompose(&plane, w, h);
        assert!(d.bands.iter().flatten().all(|&b| b == 0.0));
    }

    #[test]
    fn luminance_100_and_0_are_exact() {
        let (w, h) = (64, 48);
        let l_in: Vec<f32> = (0..w * h).map(|i| 0.5 + 0.2 * noise(i % w, i / w, 1)).collect();
        let l_out = scene(w, h);
        assert_eq!(merge_l(&l_in, l_out.clone(), w, h, &BandWeights::for_luminance(1.0)), l_out);
        assert_eq!(merge_l(&l_in, l_out.clone(), w, h, &BandWeights::for_luminance(0.0)), l_in);
        assert_eq!(merge_l(&l_in, l_out.clone(), w, h, &BandWeights::uniform(1.0)), l_out);
        assert_eq!(BandWeights::for_luminance(0.5).levels(), 1);
        assert_eq!(BandWeights::for_luminance(0.1).levels(), 1);
        assert_eq!(BandWeights::for_luminance(0.05).levels(), LEVELS);
        assert_eq!(BandWeights::for_luminance(1.0).levels(), 0);
        assert_eq!(BandWeights::uniform(0.5).levels(), LEVELS);
        // Uniform weights through the full decomposition match the flat blend.
        let flat: Vec<f32> = l_in.iter().zip(&l_out).map(|(a, b)| a * 0.7 + b * 0.3).collect();
        let merged = merge_l(&l_in, l_out.clone(), w, h, &BandWeights::uniform(0.3));
        assert!(max_abs_diff(&merged, &flat) < 1e-6);
    }

    /// White noise puts most of its energy in the finest band, a smooth scene almost none. With the model's output =
    /// the clean scene and the input = scene + grain + blotches (coarse noise), Luminance 50 leaves exactly half the
    /// input's finest band of the difference (most of half the grain) and almost none of the blotches, where the flat
    /// blend leaves half of everything.
    #[test]
    fn band_energies() {
        let (w, h) = (256, 192);
        let grain: Vec<f32> = (0..w * h).map(|i| 0.04 * noise(i % w, i / w, 7)).collect();
        let d = decompose(&grain, w, h);
        let total = energy(&grain);
        let shares: Vec<f64> = d.bands.iter().map(|b| energy(b) / total).collect();
        assert!(shares[0] > 0.5, "finest band share {shares:?}");
        assert!(shares[0] > 4.0 * shares[1] && shares[1] > shares[2], "{shares:?}");
        assert!(energy(&d.residual) / total < 0.02, "{}", energy(&d.residual) / total);

        let clean = scene(w, h);
        let ds = decompose(&clean, w, h);
        assert!(energy(&ds.bands[0]) / energy(&clean) < 1e-4);

        let white: Vec<f32> = (0..w * h).map(|i| 0.2 * noise(i % w, i / w, 9)).collect();
        let blotch: Vec<f32> = smooth(&smooth(&white, w, h, 2), w, h, 3).iter().map(|v| 5.0 * v).collect();
        let l_in: Vec<f32> = (0..w * h).map(|i| clean[i] + grain[i] + blotch[i]).collect();
        let merged = merge_l(&l_in, clean.clone(), w, h, &BandWeights::for_luminance(0.5));
        let flat: Vec<f32> = l_in.iter().zip(&clean).map(|(a, b)| a * 0.5 + b * 0.5).collect();
        let left = |out: &[f32]| -> Vec<f32> { out.iter().zip(&clean).map(|(o, s)| o - s).collect() };
        let (left_m, left_f) = (left(&merged), left(&flat));
        // Exactly half the finest band of L_in − L_out.
        let diff: Vec<f32> = l_in.iter().zip(&clean).map(|(a, b)| a - b).collect();
        let half_fine: Vec<f32> = decompose(&diff, w, h).bands[0].iter().map(|v| 0.5 * v).collect();
        assert!(max_abs_diff(&left_m, &half_fine) < 1e-6);
        // Grain: the merge keeps more than half of what the flat blend keeps (energy of half the grain).
        let half_grain = 0.25 * total;
        assert!(energy(&left_m) > 0.5 * half_grain, "{} vs {half_grain}", energy(&left_m));
        // Blotches: the low frequencies of what is left (the residual of its decomposition).
        let (low_m, low_f) = (energy(&decompose(&left_m, w, h).residual), energy(&decompose(&left_f, w, h).residual));
        assert!(low_f > 1e-6 && low_m < 0.05 * low_f, "residual energy merge {low_m} vs flat {low_f}");
    }

    /// The coarse weights ramp in below Luminance 10, so Luminance 1 % (and 0.1 %) is close to 0 rather than already
    /// removing every blotch: the change from `L_in` is at most `t·max|d₀| + (t / 0.1)·max|coarse|`.
    #[test]
    fn the_merge_is_continuous_at_zero() {
        let (w, h) = (200, 150);
        let clean = scene(w, h);
        let white: Vec<f32> = (0..w * h).map(|i| 0.2 * noise(i % w, i / w, 4)).collect();
        let blotch = smooth(&smooth(&white, w, h, 2), w, h, 3);
        let l_in: Vec<f32> = (0..w * h).map(|i| clean[i] + 0.04 * noise(i % w, i / w, 2) + 5.0 * blotch[i]).collect();
        let max_d = l_in.iter().zip(&clean).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        let change = |t: f32| max_abs_diff(&merge_l(&l_in, clean.clone(), w, h, &BandWeights::for_luminance(t)), &l_in);
        let (c1, c01) = (change(0.01), change(0.001));
        assert!(c1 <= 0.12 * max_d, "luminance 1: {c1} vs max |D| {max_d}");
        assert!(c01 <= 0.012 * max_d, "luminance 0.1: {c01} vs max |D| {max_d}");
        assert!(c01 < c1);
        // From the ramp's end the coarse bands are the model's.
        assert_eq!(BandWeights::for_luminance(0.1), BandWeights { bands: [0.1, 1.0, 1.0], residual: 1.0 });
        let half = BandWeights::for_luminance(0.05);
        assert!((half.residual - 0.5).abs() < 1e-6 && half.bands[0] == 0.05);
    }

    /// A non-finite model value takes the input's before the filters: the result is finite everywhere and the same
    /// as with that pixel replaced by the input's.
    #[test]
    fn non_finite_model_values_do_not_spread() {
        let (w, h) = (64, 48);
        let l_in: Vec<f32> = (0..w * h).map(|i| 0.5 + 0.2 * noise(i % w, i / w, 1)).collect();
        let mut l_out = scene(w, h);
        let mut fixed = l_out.clone();
        for (i, v) in [(100, f32::NAN), (1000, f32::INFINITY), (2000, f32::NEG_INFINITY)] {
            l_out[i] = v;
            fixed[i] = l_in[i];
        }
        let weights = BandWeights::for_luminance(0.5);
        let merged = merge_l(&l_in, l_out, w, h, &weights);
        assert!(merged.iter().all(|v| v.is_finite()));
        assert_eq!(merged, merge_l(&l_in, fixed, w, h, &weights));
        // Also through all three levels.
        let mut l_out = scene(w, h);
        l_out[5] = f32::NAN;
        assert!(merge_l(&l_in, l_out, w, h, &BandWeights::for_luminance(0.02)).iter().all(|v| v.is_finite()));
    }
}
