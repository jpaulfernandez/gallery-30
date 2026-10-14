//! The sRGB transfer functions (IEC 61966-2-1), also used by Display P3.

use std::sync::OnceLock;

/// Encoded sRGB → linear (the inverse OETF, commonly called the EOTF). Odd-symmetric for negatives.
#[inline]
pub fn srgb_to_linear(v: f32) -> f32 {
    let a = v.abs();
    let l = if a <= 0.04045 { a / 12.92 } else { ((a + 0.055) / 1.055).powf(2.4) };
    l.copysign(v)
}

/// Linear → encoded sRGB. Odd-symmetric for negatives.
#[inline]
pub fn linear_to_srgb(v: f32) -> f32 {
    let a = v.abs();
    let e = if a <= 0.003_130_8 { a * 12.92 } else { 1.055 * a.powf(1.0 / 2.4) - 0.055 };
    e.copysign(v)
}

/// Linear value of each 8-bit sRGB code, computed in `f64`.
pub fn srgb_u8_lut() -> &'static [f32; 256] {
    static LUT: OnceLock<[f32; 256]> = OnceLock::new();
    LUT.get_or_init(|| {
        std::array::from_fn(|i| {
            let v = i as f64 / 255.0;
            (if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }) as f32
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_reference_points() {
        assert!((linear_to_srgb(0.18) - 0.4613).abs() < 1e-3);
        assert!((linear_to_srgb(1.0) - 1.0).abs() < 1e-6);
        assert_eq!(srgb_to_linear(0.0), 0.0);
        for i in 0..=255u32 {
            let v = i as f32 / 255.0;
            let back = linear_to_srgb(srgb_to_linear(v));
            assert!((back - v).abs() < 1e-5, "{i}: {back}");
            assert!((srgb_u8_lut()[i as usize] - srgb_to_linear(v)).abs() < 1e-6);
        }
        assert_eq!(linear_to_srgb(-0.18), -linear_to_srgb(0.18));
    }
}
