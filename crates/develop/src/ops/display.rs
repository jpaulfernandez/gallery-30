//! The display transform's optional fixed look: a sigmoid from scene-linear to display-linear on
//! luminance (RGB rescaled by `Y'/Y`, so hue holds and the gamut mapper takes bright saturated colours
//! towards white), `y = x^a / (x^a + K)` with mid-grey 0.18 fixed (0.46 once sRGB-encoded) and a log-log
//! slope of 1.1 there, rolling off to 1 for very bright values.
//!
//! It is **off by default** ([`crate::RenderOptions::look`]): with it on, diffuse white (1.0) lands at
//! 0.69 linear (217 in 8 bit), so an unedited JPEG would not come back unchanged, and the plan's "every
//! slider at its default is a no-op" check wins. Display-referred inputs (JPEG, PNG) already carry a
//! look; this is for scene-referred input (RAW, D6) and a future setting.

use crate::color::matrix::REC2020_LUMA;

/// Exponent `a`; the slope at mid-grey is `a · (1 − 0.18)`.
pub const LOOK_POWER: f32 = 1.1 / 0.82;
pub const MID_GREY: f32 = 0.18;

/// The sigmoid on a linear value.
#[inline]
pub fn look_curve(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let k = MID_GREY.powf(LOOK_POWER) * (1.0 / MID_GREY - 1.0);
    let p = x.powf(LOOK_POWER);
    p / (p + k)
}

pub fn display_look(row: &mut [f32]) {
    for px in row.chunks_exact_mut(3) {
        let y = REC2020_LUMA[0] * px[0] + REC2020_LUMA[1] * px[1] + REC2020_LUMA[2] * px[2];
        if y <= 1e-7 {
            continue;
        }
        let ratio = look_curve(y) / y;
        px[0] *= ratio;
        px[1] *= ratio;
        px[2] *= ratio;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::transfer::linear_to_srgb;

    #[test]
    fn mid_grey_maps_to_046_encoded() {
        assert!((look_curve(0.18) - 0.18).abs() < 1e-6);
        assert!((linear_to_srgb(look_curve(0.18)) - 0.46).abs() < 0.005);
        assert!(look_curve(100.0) < 1.0 && look_curve(100.0) > 0.98);
        let mut prev = 0.0;
        for i in 1..1000 {
            let y = look_curve(i as f32 / 100.0);
            assert!(y > prev);
            prev = y;
        }
    }
}
