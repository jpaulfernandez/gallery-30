//! Colour in Oklab/OKLCH: the eight-band colour mix, vibrance and saturation, done in one round trip.
//!
//! **Colour mix**: eight normalised Gaussian hue bands with the centre/width table from the plan
//! (red 358/35, orange 25/45, ...). Those degrees are the familiar HSV hue wheel of sRGB (red 0, yellow
//! 60, green 120, ...), not OKLCH angles (pure sRGB red sits at OKLCH 29°), so each pixel's OKLCH hue
//! is first mapped to its wheel hue through a table built from the sRGB hue circle; band weights are
//! computed there and normalised to sum to 1. The bands then rotate the OKLCH hue (±[`MAX_HUE_SHIFT`]°),
//! scale chroma (×0..2) and scale `L` (±[`LUM_STRENGTH`], faded out for near-greys).
//!
//! **Vibrance** scales `C` by `1 + v·(1 − C/C_ref)^1.25` (weak colours move most), damped by up to
//! [`SKIN_DAMPING`] around skin hues when boosting. **Saturation** scales `C` by `1 + s`.
//!
//! Everything about the mix is a function of hue alone, so it is baked per render into a 720-bin table;
//! the per-pixel cost is one Oklab round trip, an `atan2` and a table lookup. Greys (C ≈ 0) are left
//! untouched.

use std::sync::OnceLock;

use super::smoothstep;
use crate::color::matrix::{self, apply_f32};
use crate::color::oklab::{oklab_to_oklch, Oklab};
use crate::color::transfer::srgb_to_linear;
use crate::settings::{Color, HueBand};

/// `(band, centre, width)` in wheel degrees; σ = width / 3, so a band fades to about a third at the
/// edges of its width.
pub const BANDS: [(HueBand, f32, f32); 8] = [
    (HueBand::Red, 358.0, 35.0),
    (HueBand::Orange, 25.0, 45.0),
    (HueBand::Yellow, 60.0, 40.0),
    (HueBand::Green, 115.0, 90.0),
    (HueBand::Aqua, 180.0, 60.0),
    (HueBand::Blue, 225.0, 60.0),
    (HueBand::Purple, 280.0, 55.0),
    (HueBand::Magenta, 330.0, 50.0),
];
/// OKLCH hue rotation at a band's hue ±100.
pub const MAX_HUE_SHIFT: f32 = 30.0;
/// Relative change of Oklab `L` at a band's luminance ±100.
pub const LUM_STRENGTH: f32 = 0.3;
/// Chroma at which vibrance stops acting (about the most saturated sRGB colours).
pub const VIBRANCE_CHROMA_REF: f32 = 0.32;
/// OKLCH hue and σ of the skin-tone dampener, and how much of a vibrance boost it removes.
pub const SKIN_HUE: f32 = 55.0;
pub const SKIN_SIGMA: f32 = 20.0;
pub const SKIN_DAMPING: f32 = 0.6;

pub(crate) const BINS: usize = 720;
pub(crate) const BIN_DEG: f32 = 360.0 / BINS as f32;

/// Wheel hue (sRGB HSV degrees) for OKLCH hue bins of [`BIN_DEG`].
fn wheel_table() -> &'static [f32] {
    static TABLE: OnceLock<Vec<f32>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let ok = Oklab::new();
        let m = matrix::to_f32(&matrix::srgb_to_rec2020());
        // OKLCH hue along the fully saturated sRGB hue circle, unwrapped to increase monotonically.
        let steps = 7200;
        let mut pairs: Vec<(f32, f32)> = Vec::with_capacity(steps + 1);
        let mut offset = 0.0;
        for i in 0..=steps {
            let wheel = i as f32 * 360.0 / steps as f32;
            let rgb = hsv_to_rgb(wheel);
            let lin = apply_f32(&m, srgb_to_linear(rgb[0]), srgb_to_linear(rgb[1]), srgb_to_linear(rgb[2]));
            let mut h = oklab_to_oklch(ok.to_lab(lin))[2] + offset;
            if let Some(&(prev, _)) = pairs.last() {
                if h < prev - 180.0 {
                    offset += 360.0;
                    h += 360.0;
                }
                // Oklab bends slightly backwards between wheel 230 and 240 (pure blue); keep the
                // table invertible.
                h = h.max(prev + 1e-4);
            }
            pairs.push((h, wheel));
        }
        let start = pairs[0].0;
        (0..BINS)
            .map(|i| {
                let mut h = i as f32 * BIN_DEG;
                if h < start {
                    h += 360.0;
                }
                let j = pairs.partition_point(|p| p.0 <= h).clamp(1, pairs.len() - 1);
                let ((h0, w0), (h1, w1)) = (pairs[j - 1], pairs[j]);
                let f = if h1 > h0 { (h - h0) / (h1 - h0) } else { 0.0 };
                (w0 + (w1 - w0) * f).rem_euclid(360.0)
            })
            .collect()
    })
}

/// Fully saturated, full-value sRGB (encoded) of an HSV hue in degrees (0..360).
pub(crate) fn hsv_to_rgb(h: f32) -> [f32; 3] {
    let h6 = (h / 60.0).rem_euclid(6.0);
    let x = 1.0 - (h6 % 2.0 - 1.0).abs();
    match h6 as u32 {
        0 => [1.0, x, 0.0],
        1 => [x, 1.0, 0.0],
        2 => [0.0, 1.0, x],
        3 => [0.0, x, 1.0],
        4 => [x, 0.0, 1.0],
        _ => [1.0, 0.0, x],
    }
}

/// Signed angular distance in degrees, -180..180.
fn angle_diff(a: f32, b: f32) -> f32 {
    (a - b + 540.0).rem_euclid(360.0) - 180.0
}

/// Normalised band weights at a wheel hue.
pub fn band_weights(wheel: f32) -> [f32; 8] {
    let mut w = BANDS.map(|(_, centre, width)| (-0.5 * (angle_diff(wheel, centre) / (width / 3.0)).powi(2)).exp());
    let sum: f32 = w.iter().sum();
    for v in &mut w {
        *v /= sum;
    }
    w
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct HueEntry {
    pub(crate) cos: f32,
    pub(crate) sin: f32,
    /// Chroma multiplier from the mix.
    pub(crate) sat: f32,
    /// Mix luminance amount, -1..1.
    pub(crate) lum: f32,
    /// Vibrance boost factor, 1 away from skin.
    pub(crate) skin: f32,
}

#[derive(Debug, Clone)]
pub struct ColorParams {
    oklab: Oklab,
    pub(crate) bins: Vec<HueEntry>,
    pub(crate) vibrance: f32,
    pub(crate) saturation: f32,
}

impl ColorParams {
    pub fn new(color: &Color) -> Option<Self> {
        let mix_default = HueBand::ALL.iter().all(|&b| *color.mix.band(b) == Default::default());
        if mix_default && color.vibrance == 0.0 && color.saturation == 0.0 {
            return None;
        }
        Some(Self::always(color))
    }

    /// The parameters even when every colour control is at its default (an identity mix), for pixels whose
    /// local saturation or hue is set while the global colour pass is skipped.
    pub fn always(color: &Color) -> Self {
        let table = wheel_table();
        let unit = |v: f64| (v / 100.0).clamp(-1.0, 1.0) as f32;
        let bins = (0..BINS)
            .map(|i| {
                let w = band_weights(table[i]);
                let (mut dh, mut sat, mut lum) = (0.0, 0.0, 0.0);
                for (k, (band, _, _)) in BANDS.iter().enumerate() {
                    let m = color.mix.band(*band);
                    dh += w[k] * unit(m.hue) * MAX_HUE_SHIFT;
                    sat += w[k] * unit(m.saturation);
                    lum += w[k] * unit(m.luminance);
                }
                let (sin, cos) = dh.to_radians().sin_cos();
                let skin_d = angle_diff(i as f32 * BIN_DEG, SKIN_HUE) / SKIN_SIGMA;
                let skin = 1.0 - SKIN_DAMPING * (-0.5 * skin_d * skin_d).exp();
                HueEntry { cos, sin, sat: 1.0 + sat, lum, skin }
            })
            .collect();
        Self { oklab: Oklab::new(), bins, vibrance: unit(color.vibrance), saturation: unit(color.saturation) }
    }

    #[inline]
    fn entry(&self, hue: f32) -> HueEntry {
        let p = hue / BIN_DEG;
        let i = (p as usize) % BINS;
        let j = (i + 1) % BINS;
        let f = p - p.floor();
        let (a, b) = (self.bins[i], self.bins[j]);
        let mix = |x: f32, y: f32| x + (y - x) * f;
        HueEntry { cos: mix(a.cos, b.cos), sin: mix(a.sin, b.sin), sat: mix(a.sat, b.sat), lum: mix(a.lum, b.lum), skin: mix(a.skin, b.skin) }
    }
}

/// Colour mix on one Oklab pixel with chroma `c`: returns the rotated `(a, b)`, the chroma multiplier
/// and the new `L`.
#[inline]
fn color_mix(l: f32, a: f32, b: f32, c: f32, e: &HueEntry) -> (f32, f32, f32, f32) {
    let (a2, b2) = (a * e.cos - b * e.sin, a * e.sin + b * e.cos);
    let l2 = l * (1.0 + LUM_STRENGTH * e.lum * smoothstep(0.0, 0.08, c));
    (a2, b2, e.sat, l2)
}

/// Vibrance chroma multiplier for chroma `c` (`v` in -1..1).
#[inline]
pub fn vibrance(c: f32, v: f32, skin: f32) -> f32 {
    if v == 0.0 {
        return 1.0;
    }
    let weight = (1.0 - (c / VIBRANCE_CHROMA_REF).min(1.0)).powf(1.25);
    1.0 + v * weight * if v > 0.0 { skin } else { 1.0 }
}

/// Saturation chroma multiplier (`s` in -1..1).
#[inline]
pub fn saturation(s: f32) -> f32 {
    1.0 + s
}

pub fn color(row: &mut [f32], p: &ColorParams) {
    let sat = saturation(p.saturation);
    for px in row.chunks_exact_mut(3) {
        color_px(px, p, sat, None);
    }
}

/// The OKLCH hue rotation in degrees of a local Hue value (−100..100, clamped): ±[`MAX_HUE_SHIFT`].
#[inline]
pub fn local_hue_degrees(hue: f32) -> f32 {
    (hue / 100.0).clamp(-1.0, 1.0) * MAX_HUE_SHIFT
}

/// Colour on one RGB triple: `sat` is the saturation multiplier ([`saturation`]); `rotate` an extra OKLCH hue
/// rotation as `(cos, sin)` after the mix (a mask's Hue; positive turns red towards yellow).
#[inline]
pub fn color_px(px: &mut [f32], p: &ColorParams, sat: f32, rotate: Option<(f32, f32)>) {
    let [l, a, b] = p.oklab.to_lab([px[0], px[1], px[2]]);
    let c = a.hypot(b);
    if c < 1e-5 {
        return;
    }
    let mut hue = b.atan2(a).to_degrees();
    if hue < 0.0 {
        hue += 360.0;
    }
    let e = p.entry(hue);
    let (mut a2, mut b2, mix_sat, l2) = color_mix(l, a, b, c, &e);
    if let Some((cos, sin)) = rotate {
        (a2, b2) = (a2 * cos - b2 * sin, a2 * sin + b2 * cos);
    }
    let scale = (mix_sat * vibrance(c, p.vibrance, e.skin) * sat).max(0.0);
    px.copy_from_slice(&p.oklab.to_rgb([l2, a2 * scale, b2 * scale]));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::HueMix;

    #[test]
    fn wheel_table_maps_primaries() {
        let t = wheel_table();
        let ok = Oklab::new();
        let m = matrix::to_f32(&matrix::srgb_to_rec2020());
        // Pure blue sits where Oklab's hue is nearly flat along the wheel (wheel 220..250 spans only
        // 6 OKLCH degrees), so it gets a looser tolerance; it still lands in the blue band.
        for (rgb, want, tol) in [
            ([1.0f32, 0.0, 0.0], 0.0f32, 1.5),
            ([1.0, 1.0, 0.0], 60.0, 1.5),
            ([0.0, 1.0, 0.0], 120.0, 1.5),
            ([0.0, 1.0, 1.0], 180.0, 1.5),
            ([0.0, 0.0, 1.0], 240.0, 15.0),
            ([1.0, 0.0, 1.0], 300.0, 1.5),
        ] {
            let [_, _, h] = oklab_to_oklch(ok.to_lab(apply_f32(&m, rgb[0], rgb[1], rgb[2])));
            let wheel = t[(h / BIN_DEG).round() as usize % BINS];
            assert!(angle_diff(wheel, want).abs() < tol, "{rgb:?}: {wheel}");
        }
        let blue = band_weights(t[(264.05 / BIN_DEG) as usize]);
        assert!(blue[5] > 0.5, "{blue:?}");
        assert!(t.windows(2).filter(|w| w[1] < w[0]).count() <= 1, "one wrap only");
    }

    #[test]
    fn weights_are_normalised_and_local() {
        let w = band_weights(120.0);
        assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-5);
        assert!(w[0] < 1e-6, "red weight at green {}", w[0]);
        assert!(band_weights(0.0)[0] > 0.6);
    }

    #[test]
    fn saturation_minus_100_is_grey() {
        let p = ColorParams::new(&Color { saturation: -100.0, ..Color::default() }).unwrap();
        let mut px = [0.6f32, 0.2, 0.05];
        color(&mut px, &p);
        assert!((px[0] - px[1]).abs() < 1e-4 && (px[1] - px[2]).abs() < 1e-4, "{px:?}");
    }

    #[test]
    fn red_hue_shift_leaves_green() {
        let mut c = Color::default();
        c.mix.red = HueMix { hue: 100.0, saturation: 0.0, luminance: 0.0 };
        let p = ColorParams::new(&c).unwrap();
        let m = matrix::to_f32(&matrix::srgb_to_rec2020());
        let green = apply_f32(&m, 0.0, 1.0, 0.0);
        let mut px = green;
        color(&mut px, &p);
        for i in 0..3 {
            assert!((px[i] - green[i]).abs() < 1e-4, "{px:?} vs {green:?}");
        }
        let red = apply_f32(&m, 0.8, 0.02, 0.02);
        let mut px = red;
        color(&mut px, &p);
        assert!(px[1] > red[1] + 0.01, "red should move towards orange: {px:?}");
    }

    #[test]
    fn vibrance_favours_weak_colours() {
        assert!(vibrance(0.05, 1.0, 1.0) > vibrance(0.25, 1.0, 1.0));
        assert!(vibrance(0.05, 1.0, 0.4) < vibrance(0.05, 1.0, 1.0));
        assert_eq!(vibrance(0.1, 0.0, 1.0), 1.0);
    }
}
