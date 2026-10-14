//! Embedded ICC input profiles through `moxcms`.
//!
//! A profile is used only when it parses, describes RGB, and is not sRGB-like (sRGB colorants and a
//! transfer curve close to sRGB's at mid-grey): those take the exact analytic sRGB path instead, so
//! camera JPEGs tagged sRGB decode bit-for-bit like untagged ones. Unparseable, grey or CMYK profiles
//! are ignored (the pixels are taken as sRGB), like most browsers do.

use moxcms::{ColorProfile, DataColorSpace, Layout, RenderingIntent, ToneReprCurve, TransformOptions};
use rayon::prelude::*;

use crate::error::Result;

/// The profile to transform with, or `None` to treat the pixels as sRGB.
pub(super) fn input_profile(icc: Option<&[u8]>) -> Option<ColorProfile> {
    let profile = ColorProfile::new_from_slice(icc?).ok()?;
    if profile.color_space != DataColorSpace::Rgb || is_srgb_like(&profile) {
        return None;
    }
    Some(profile)
}

fn is_srgb_like(p: &ColorProfile) -> bool {
    let srgb = ColorProfile::new_srgb();
    let near = |a: moxcms::Xyzd, b: moxcms::Xyzd| (a.x - b.x).abs() < 0.003 && (a.y - b.y).abs() < 0.003 && (a.z - b.z).abs() < 0.003;
    if !p.is_matrix_shaper()
        || !near(p.red_colorant, srgb.red_colorant)
        || !near(p.green_colorant, srgb.green_colorant)
        || !near(p.blue_colorant, srgb.blue_colorant)
    {
        return false;
    }
    // sRGB decodes 0.5 to 0.2140; gamma 2.2 gives 0.2176.
    [&p.red_trc, &p.green_trc, &p.blue_trc]
        .iter()
        .all(|trc| trc.as_ref().and_then(trc_at_half).is_some_and(|v| (v - 0.2140).abs() < 0.01))
}

/// A tone curve evaluated at 0.5.
fn trc_at_half(trc: &ToneReprCurve) -> Option<f64> {
    let x = 0.5f64;
    match trc {
        ToneReprCurve::Lut(t) if t.is_empty() => Some(x),
        ToneReprCurve::Lut(t) if t.len() == 1 => Some(x.powf(t[0] as f64 / 256.0)),
        ToneReprCurve::Lut(t) => {
            let p = x * (t.len() - 1) as f64;
            let i = p.floor() as usize;
            let f = p - i as f64;
            let at = |k: usize| t[k.min(t.len() - 1)] as f64 / 65535.0;
            Some(at(i) * (1.0 - f) + at(i + 1) * f)
        }
        ToneReprCurve::Parametric(p) => {
            let p: Vec<f64> = p.iter().map(|&v| v as f64).collect();
            Some(match p.len() {
                1 => x.powf(p[0]),
                3 => {
                    if x >= -p[2] / p[1] {
                        (p[1] * x + p[2]).powf(p[0])
                    } else {
                        0.0
                    }
                }
                4 => {
                    if x >= -p[2] / p[1] {
                        (p[1] * x + p[2]).powf(p[0]) + p[3]
                    } else {
                        p[3]
                    }
                }
                5 => {
                    if x >= p[4] {
                        (p[1] * x + p[2]).powf(p[0])
                    } else {
                        p[3] * x
                    }
                }
                7 => {
                    if x >= p[4] {
                        (p[1] * x + p[2]).powf(p[0]) + p[5]
                    } else {
                        p[3] * x + p[6]
                    }
                }
                _ => return None,
            })
        }
    }
}

/// Linear Rec.2020 (D65) as an ICC destination: BT.2020 colorants with identity curves.
fn linear_rec2020() -> ColorProfile {
    let mut p = ColorProfile::new_bt2020();
    let linear = ToneReprCurve::Lut(Vec::new());
    p.red_trc = Some(linear.clone());
    p.green_trc = Some(linear.clone());
    p.blue_trc = Some(linear);
    p.cicp = None;
    p
}

/// Encoded RGB in 0..1 under `profile` → linear Rec.2020.
pub(super) fn to_linear_rec2020(encoded: &[f32], width: usize, profile: &ColorProfile) -> Result<Vec<f32>> {
    let options = TransformOptions {
        rendering_intent: RenderingIntent::Perceptual,
        prefer_fixed_point: false,
        ..TransformOptions::default()
    };
    let transform = profile.create_transform_f32(Layout::Rgb, &linear_rec2020(), Layout::Rgb, options)?;
    let mut out = vec![0.0f32; encoded.len()];
    out.par_chunks_mut(width * 3)
        .zip(encoded.par_chunks(width * 3))
        .try_for_each(|(dst, src)| transform.transform(src, dst))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::{matrix, transfer};

    #[test]
    fn srgb_profiles_take_the_analytic_path() {
        let srgb = ColorProfile::new_srgb().encode().unwrap();
        assert!(input_profile(Some(&srgb)).is_none());
        assert!(input_profile(Some(b"not a profile")).is_none());
        let p3 = ColorProfile::new_display_p3().encode().unwrap();
        assert!(input_profile(Some(&p3)).is_some());
    }

    #[test]
    fn display_p3_matches_the_analytic_conversion() {
        let p3 = input_profile(Some(&ColorProfile::new_display_p3().encode().unwrap())).unwrap();
        let samples: Vec<f32> = [[1.0f32, 0.0, 0.0], [0.0, 1.0, 0.0], [0.2, 0.4, 0.8], [0.5, 0.5, 0.5], [0.05, 0.9, 0.3]]
            .concat();
        let out = to_linear_rec2020(&samples, samples.len() / 3, &p3).unwrap();
        let m = matrix::p3_to_rec2020();
        for (enc, got) in samples.chunks(3).zip(out.chunks(3)) {
            let lin = enc.iter().map(|&v| transfer::srgb_to_linear(v) as f64).collect::<Vec<_>>();
            let want = matrix::apply(&m, [lin[0], lin[1], lin[2]]);
            for c in 0..3 {
                assert!((got[c] as f64 - want[c]).abs() < 2e-3, "{enc:?}: {got:?} vs {want:?}");
            }
        }
    }
}
