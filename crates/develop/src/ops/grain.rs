//! Film grain (workflow plan 17): monochrome value noise added to the display-referred (sRGB-encoded) output, the
//! last thing before the 8-bit dither.
//!
//! The noise is a function of position in **reference pixels**: a frame whose long edge is
//! [`GRAIN_REFERENCE_EDGE`] px. Pixel `(x, y)` of a `w × h` render samples the field at `(x, y) · 2048 / max(w, h)`
//! (its top-left corner), so a proxy and a full render sample the same grain field relative to the frame: at exactly
//! twice the size, full-render pixel `(2x, 2y)` samples the very point proxy pixel `(x, y)` does; at other ratios
//! (the 1600 px proxy against a 6000 px export) the two are statistically alike (same spread and grain size relative
//! to the frame), not pixel for pixel.
//!
//! The field: two octaves of value noise (an integer hash of the lattice point and [`GRAIN_SEED`], smootherstep
//! interpolation), the coarse one at the grain size (Size 0..100 → [`MIN_CELL`]..[`MAX_CELL`] reference px) and the
//! fine one at half that, weighted by Roughness; normalised to a roughly unit spread. It is scaled by a midtone
//! weight `4·Y'(1 − Y')` of the encoded luma, so blacks and whites stay clean, and by Amount ([`GRAIN_STRENGTH`] of
//! the encoded range at 100). Integer hashing (no float noise) keeps it exact in the WGSL port (plan 19, `gpu/shaders/chain.wgsl`).

use crate::settings::Grain;

/// Long edge of the reference frame grain positions are measured in.
pub const GRAIN_REFERENCE_EDGE: f32 = 2048.0;
/// Encoded amplitude (times the unit-spread field) at Amount 100 and full midtone weight.
pub const GRAIN_STRENGTH: f32 = 0.12;
/// Grain cell size in reference px at Size 0 and 100.
pub const MIN_CELL: f32 = 0.5;
pub const MAX_CELL: f32 = 4.0;
/// Seed of the grain hash (one fixed pattern; it is a texture, not a signal).
pub const GRAIN_SEED: u32 = 0x9e37_79b9;
/// Seed of the fine octave (the WGSL port in `gpu/shaders/chain.wgsl` reads both seeds from the prelude).
pub const GRAIN_FINE_SEED: u32 = GRAIN_SEED ^ 0x85eb_ca6b;
/// Scales two-octave value noise (each octave's spread ≈ 0.3 with smootherstep) to about unit spread.
const FIELD_NORM: f32 = 2.6;
/// Rec.709 luma weights for the encoded output values.
pub(crate) const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

#[derive(Debug, Clone)]
pub struct GrainParams {
    /// Encoded amplitude.
    pub(crate) amplitude: f32,
    /// 1 / coarse cell size, per reference px.
    pub(crate) freq: f32,
    /// Fine octave weight, 0..1.
    pub(crate) rough: f32,
    /// Normalisation of the two octaves.
    pub(crate) norm: f32,
}

impl GrainParams {
    /// `None` at Amount 0.
    pub fn new(g: &Grain) -> Option<Self> {
        if g.amount <= 0.0 {
            return None;
        }
        let unit = |x: f64| (x / 100.0).clamp(0.0, 1.0) as f32;
        let rough = unit(g.roughness);
        Some(Self {
            amplitude: unit(g.amount) * GRAIN_STRENGTH,
            freq: 1.0 / (MIN_CELL + (MAX_CELL - MIN_CELL) * unit(g.size)),
            rough,
            norm: FIELD_NORM / (1.0 + rough * rough).sqrt(),
        })
    }

    /// Reference px per pixel of a `w × h` render.
    pub fn scale_for(w: u32, h: u32) -> f32 {
        GRAIN_REFERENCE_EDGE / w.max(h).max(1) as f32
    }

    /// The grain field at reference position `(u, v)`, roughly unit spread.
    #[inline]
    pub fn field(&self, u: f32, v: f32) -> f32 {
        let (fu, fv) = (u * self.freq, v * self.freq);
        let coarse = value_noise(fu, fv, GRAIN_SEED);
        let fine = if self.rough > 0.0 { value_noise(2.0 * fu, 2.0 * fv, GRAIN_FINE_SEED) } else { 0.0 };
        (coarse + self.rough * fine) * self.norm
    }

    /// Add grain to one encoded output triple at pixel `(x, y)`; `scale` from [`Self::scale_for`].
    #[inline]
    pub fn apply(&self, enc: &mut [f32; 3], x: u32, y: u32, scale: f32) {
        let luma = (LUMA[0] * enc[0] + LUMA[1] * enc[1] + LUMA[2] * enc[2]).clamp(0.0, 1.0);
        let weight = 4.0 * luma * (1.0 - luma);
        let n = self.field(x as f32 * scale, y as f32 * scale) * self.amplitude * weight;
        for c in enc.iter_mut() {
            *c += n;
        }
    }
}

/// Uniform −1..1 from a lattice point.
#[inline]
fn lattice(ix: i32, iy: i32, seed: u32) -> f32 {
    let mut h = (ix as u32).wrapping_mul(0x8da6_b343) ^ (iy as u32).wrapping_mul(0xd816_3841) ^ seed;
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    (h >> 8) as f32 / (1u32 << 23) as f32 - 1.0
}

#[inline]
fn smootherstep(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

/// Value noise: the lattice values around `(u, v)` blended with smootherstep weights.
#[inline]
fn value_noise(u: f32, v: f32, seed: u32) -> f32 {
    let (x0, y0) = (u.floor(), v.floor());
    let (ix, iy) = (x0 as i32, y0 as i32);
    let (tx, ty) = (smootherstep(u - x0), smootherstep(v - y0));
    let top = lattice(ix, iy, seed) + (lattice(ix + 1, iy, seed) - lattice(ix, iy, seed)) * tx;
    let bottom = lattice(ix, iy + 1, seed) + (lattice(ix + 1, iy + 1, seed) - lattice(ix, iy + 1, seed)) * tx;
    top + (bottom - top) * ty
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> GrainParams {
        GrainParams::new(&Grain { amount: 50.0, ..Grain::default() }).unwrap()
    }

    #[test]
    fn identity_at_default() {
        assert!(GrainParams::new(&Grain::default()).is_none());
    }

    #[test]
    fn deterministic_and_zero_mean() {
        let p = params();
        let a: Vec<f32> = (0..4000).map(|i| p.field(i as f32 * 0.7, (i / 63) as f32 * 1.3)).collect();
        let b: Vec<f32> = (0..4000).map(|i| p.field(i as f32 * 0.7, (i / 63) as f32 * 1.3)).collect();
        assert_eq!(a, b);
        let mean = a.iter().sum::<f32>() / a.len() as f32;
        let spread = (a.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / a.len() as f32).sqrt();
        assert!(mean.abs() < 0.1, "mean {mean}");
        assert!((0.5..2.0).contains(&spread), "spread {spread}");
    }

    #[test]
    fn same_reference_point_same_grain() {
        let p = params();
        let (full, proxy) = (GrainParams::scale_for(4096, 2730), GrainParams::scale_for(2048, 1365));
        for (x, y) in [(0u32, 0u32), (17, 5), (1000, 600), (2047, 1364)] {
            let (mut a, mut b) = ([0.4f32; 3], [0.4f32; 3]);
            p.apply(&mut a, 2 * x, 2 * y, full);
            p.apply(&mut b, x, y, proxy);
            assert_eq!(a, b, "{x} {y}");
        }
    }

    /// The 1600 px proxy and a 4000 px export (not an integer ratio) sample the same field: over the same part of the
    /// frame the grain's spread agrees within 10 %.
    #[test]
    fn proxy_and_export_have_the_same_spread() {
        for size in [0.0, 25.0, 100.0] {
            let p = GrainParams::new(&Grain { amount: 50.0, size, ..Grain::default() }).unwrap();
            let spread = |long: u32| {
                let scale = GrainParams::scale_for(long, long * 2 / 3);
                let n = long / 4; // the top-left quarter of the width, a square
                let vals: Vec<f32> =
                    (0..n).flat_map(|y| (0..n).map(move |x| (x, y))).map(|(x, y)| p.field(x as f32 * scale, y as f32 * scale)).collect();
                let m = vals.iter().sum::<f32>() / vals.len() as f32;
                (vals.iter().map(|v| (v - m) * (v - m)).sum::<f32>() / vals.len() as f32).sqrt()
            };
            let (proxy, export) = (spread(1600), spread(4000));
            assert!((proxy / export - 1.0).abs() < 0.1, "size {size}: proxy {proxy} export {export}");
        }
    }

    #[test]
    fn spares_black_and_white() {
        let p = params();
        for v in [0.0f32, 1.0] {
            let mut px = [v; 3];
            p.apply(&mut px, 12, 34, 1.0);
            assert_eq!(px, [v; 3]);
        }
    }
}
