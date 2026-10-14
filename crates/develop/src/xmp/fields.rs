//! The `crs:` field tables shared by the reader and the writer, and the EXIF-orientation remaps.
//!
//! Lightroom records crop, Upright and the Transform sliders in the **recorded** frame (the pixels as
//! stored, before `tiff:Orientation`); our geometry lives in the **oriented** frame (decode applies the
//! EXIF orientation first). `P_o` below is the normalised map recorded → oriented for EXIF orientation
//! `o`, and every remap here is a change of coordinates through it.

use crate::geometry::Homography;
use crate::settings::{
    ColorMix, CropRect, DevelopSettings, HueBand, HueMix, ManualTransform, Rotation,
};

/// A setting reachable from a `crs:` scalar that maps one-to-one (same range and scale).
pub(crate) type Slot = fn(&mut DevelopSettings) -> &mut f64;

/// `crs:` scalar fields that copy straight across: `(name, slot)`.
pub(crate) const SCALARS: &[(&str, Slot)] = &[
    ("Exposure2012", |s| &mut s.light.exposure),
    ("Contrast2012", |s| &mut s.light.contrast),
    ("Highlights2012", |s| &mut s.light.highlights),
    ("Shadows2012", |s| &mut s.light.shadows),
    ("Whites2012", |s| &mut s.light.whites),
    ("Blacks2012", |s| &mut s.light.blacks),
    ("Texture", |s| &mut s.detail.texture),
    ("Clarity2012", |s| &mut s.detail.clarity),
    ("Dehaze", |s| &mut s.detail.dehaze),
    ("Vibrance", |s| &mut s.color.vibrance),
    ("Saturation", |s| &mut s.color.saturation),
    ("ParametricShadows", |s| &mut s.curve.parametric.shadows),
    ("ParametricDarks", |s| &mut s.curve.parametric.darks),
    ("ParametricLights", |s| &mut s.curve.parametric.lights),
    ("ParametricHighlights", |s| &mut s.curve.parametric.highlights),
    ("Sharpness", |s| &mut s.detail.sharpen.amount),
    ("SharpenRadius", |s| &mut s.detail.sharpen.radius),
    ("SharpenDetail", |s| &mut s.detail.sharpen.detail),
    ("SharpenEdgeMasking", |s| &mut s.detail.sharpen.masking),
];

/// The parametric splits: `crs:` stores 0..100, we store 0..1.
pub(crate) const SPLITS: [&str; 3] = ["ParametricShadowSplit", "ParametricMidtoneSplit", "ParametricHighlightSplit"];

/// The four point curves: `(crs name, accessor)`; luma is the composite curve.
pub(crate) const CURVES: [&str; 4] = ["ToneCurvePV2012", "ToneCurvePV2012Red", "ToneCurvePV2012Green", "ToneCurvePV2012Blue"];

pub(crate) fn curve_mut(s: &mut DevelopSettings, i: usize) -> &mut Vec<[f64; 2]> {
    match i {
        0 => &mut s.curve.luma,
        1 => &mut s.curve.red,
        2 => &mut s.curve.green,
        _ => &mut s.curve.blue,
    }
}

/// `crs:` band names in [`HueBand::ALL`] order.
pub(crate) const BAND_NAMES: [&str; 8] = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"];

pub(crate) fn band_mut(mix: &mut ColorMix, band: HueBand) -> &mut HueMix {
    match band {
        HueBand::Red => &mut mix.red,
        HueBand::Orange => &mut mix.orange,
        HueBand::Yellow => &mut mix.yellow,
        HueBand::Green => &mut mix.green,
        HueBand::Aqua => &mut mix.aqua,
        HueBand::Blue => &mut mix.blue,
        HueBand::Purple => &mut mix.purple,
        HueBand::Magenta => &mut mix.magenta,
    }
}

/// The 24 colour-mixer fields: `(crs name, band, 0 hue / 1 saturation / 2 luminance)`.
pub(crate) fn mix_fields() -> Vec<(String, HueBand, usize)> {
    let mut out = Vec::with_capacity(24);
    for (k, kind) in ["Hue", "Saturation", "Luminance"].iter().enumerate() {
        for (band, name) in HueBand::ALL.iter().zip(BAND_NAMES) {
            out.push((format!("{kind}Adjustment{name}"), *band, k));
        }
    }
    out
}

pub(crate) fn mix_value(mix: &mut HueMix, k: usize) -> &mut f64 {
    match k {
        0 => &mut mix.hue,
        1 => &mut mix.saturation,
        _ => &mut mix.luminance,
    }
}

/// `PerspectiveUpright` values in order (0 off, 1 auto, 2 full, 3 level, 4 vertical, 5 guided).
pub(crate) const UPRIGHT_MODES: [crate::settings::UprightMode; 6] = {
    use crate::settings::UprightMode::*;
    [Off, Auto, Full, Level, Vertical, Guided]
};

/// Pre-PV2012 basic-panel fields: present only in legacy (PV2003/PV2010) settings.
pub(crate) const LEGACY_FIELDS: &[&str] =
    &["Exposure", "Brightness", "Contrast", "Shadows", "FillLight", "HighlightRecovery", "Clarity", "ToneCurve"];

/// Lightroom panels with no counterpart here: `(field, value that means "unused", reason)`. A field whose
/// value differs from the unused value is reported as dropped. `None` means "any value is a use".
pub(crate) const UNSUPPORTED: &[(&str, Option<&str>, &str)] = &[
    ("LuminanceSmoothing", Some("0"), "denoise is model-based here; turn on AI Denoise instead"),
    ("ColorNoiseReduction", Some("0"), "denoise is model-based here; turn on AI Denoise instead"),
    ("ConvertToGrayscale", Some("False"), "no black-and-white mode in Develop; use a preset or the bw filter"),
    ("GrainAmount", Some("0"), "grain is not supported"),
    ("PostCropVignetteAmount", Some("0"), "post-crop vignetting is not supported"),
    ("VignetteAmount", Some("0"), "lens vignetting correction is not supported"),
    ("LensProfileEnable", Some("0"), "lens profile corrections are not supported"),
    ("LensManualDistortionAmount", Some("0"), "manual distortion correction is not supported"),
    ("AutoLateralCA", Some("0"), "chromatic aberration removal is not supported"),
    ("DefringePurpleAmount", Some("0"), "defringe is not supported"),
    ("DefringeGreenAmount", Some("0"), "defringe is not supported"),
    ("SplitToningShadowSaturation", Some("0"), "split toning / colour grading is not supported"),
    ("SplitToningHighlightSaturation", Some("0"), "split toning / colour grading is not supported"),
    ("ColorGradeShadowSat", Some("0"), "colour grading is not supported"),
    ("ColorGradeMidtoneSat", Some("0"), "colour grading is not supported"),
    ("ColorGradeHighlightSat", Some("0"), "colour grading is not supported"),
    ("ColorGradeGlobalSat", Some("0"), "colour grading is not supported"),
    ("ShadowTint", Some("0"), "camera calibration is not supported"),
    ("RedHue", Some("0"), "camera calibration is not supported"),
    ("RedSaturation", Some("0"), "camera calibration is not supported"),
    ("GreenHue", Some("0"), "camera calibration is not supported"),
    ("GreenSaturation", Some("0"), "camera calibration is not supported"),
    ("BlueHue", Some("0"), "camera calibration is not supported"),
    ("BlueSaturation", Some("0"), "camera calibration is not supported"),
    ("RetouchAreas", None, "spot removal is not imported"),
    ("Look", None, "creative profiles (Looks) are not imported"),
];

/// Local-adjustment containers; each is reported with its correction count.
pub(crate) const MASK_FIELDS: &[&str] =
    &["MaskGroupBasedCorrections", "GradientBasedCorrections", "CircularGradientBasedCorrections", "PaintBasedCorrections"];

/// Whether an EXIF orientation value is one of the eight defined ones.
pub fn is_valid_orientation(orientation: u8) -> bool {
    (1..=8).contains(&orientation)
}

/// `P_o`: normalised map from the recorded frame to the oriented (displayed) frame for EXIF orientation
/// `o` (1 identity, 2 mirror x, 3 rotate 180, 4 mirror y, 5 transpose, 6 rotate 90° clockwise,
/// 7 transverse, 8 rotate 270° clockwise). Unknown values are the identity.
pub fn orientation_map(orientation: u8) -> Homography {
    let m = |a: f64, b: f64, c: f64, d: f64, e: f64, f: f64| Homography([a, b, c, d, e, f, 0.0, 0.0, 1.0]);
    match orientation {
        2 => m(-1.0, 0.0, 1.0, 0.0, 1.0, 0.0),  // (1 − u, v)
        3 => m(-1.0, 0.0, 1.0, 0.0, -1.0, 1.0), // (1 − u, 1 − v)
        4 => m(1.0, 0.0, 0.0, 0.0, -1.0, 1.0),  // (u, 1 − v)
        5 => m(0.0, 1.0, 0.0, 1.0, 0.0, 0.0),   // (v, u)
        6 => m(0.0, -1.0, 1.0, 1.0, 0.0, 0.0),  // (1 − v, u)
        7 => m(0.0, -1.0, 1.0, -1.0, 0.0, 1.0), // (1 − v, 1 − u)
        8 => m(0.0, 1.0, 0.0, -1.0, 0.0, 1.0),  // (v, 1 − u)
        _ => Homography::identity(),
    }
}

/// The orientation whose map is the inverse of `orientation`'s (6 ↔ 8; the others are involutions).
pub fn inverse_orientation(orientation: u8) -> u8 {
    match orientation {
        6 => 8,
        8 => 6,
        o if is_valid_orientation(o) => o,
        _ => 1,
    }
}

/// Orientations 5..8 swap width and height.
pub fn orientation_swaps_axes(orientation: u8) -> bool {
    (5..=8).contains(&orientation)
}

/// Orientations 2, 4, 5 and 7 mirror the image (they flip the sense of rotations).
pub fn orientation_mirrors(orientation: u8) -> bool {
    matches!(orientation, 2 | 4 | 5 | 7)
}

/// The 2×2 linear part of `P_o`, acting on direction vectors.
fn linear(orientation: u8) -> [f64; 4] {
    let m = orientation_map(orientation).0;
    [m[0], m[1], m[3], m[4]]
}

fn apply_linear(a: [f64; 4], [x, y]: [f64; 2]) -> [f64; 2] {
    [a[0] * x + a[1] * y, a[2] * x + a[3] * y]
}

/// Remap a crop from the recorded frame into the oriented frame: the rectangle's corners go through
/// `P_o` (it stays axis-aligned, its width and height swap for 5..8) and the straighten angle keeps its
/// sign except under a mirror. Its own inverse is the same call with [`inverse_orientation`].
pub fn remap_crop_for_orientation(rect: &CropRect, angle: f64, orientation: u8) -> (CropRect, f64) {
    let p = orientation_map(orientation);
    let a = p.apply([rect.x, rect.y]);
    let b = p.apply([rect.x + rect.w, rect.y + rect.h]);
    let (x0, x1) = (a[0].min(b[0]), a[0].max(b[0]));
    let (y0, y1) = (a[1].min(b[1]), a[1].max(b[1]));
    let angle = if orientation_mirrors(orientation) { -angle } else { angle };
    // `0.0 - 0.0` style results can produce `-0`; keep the JSON clean.
    let clean = |v: f64| if v == 0.0 { 0.0 } else { v };
    (CropRect { x: clean(x0), y: clean(y0), w: clean(x1 - x0), h: clean(y1 - y0) }, clean(angle))
}

/// Remap the manual Transform sliders from the recorded frame into the oriented frame.
///
/// Keystone is treated as the vector `(Horizontal, Vertical)` pointing at the side that grows (positive
/// Horizontal enlarges the right side, positive Vertical the bottom, as in our matrix) and the offsets as
/// the vector `(X, Y)`; both go through the linear part of `P_o`. So for orientation 6 our Horizontal is
/// −Vertical and our Vertical is +Horizontal; for 8 Horizontal is +Vertical and Vertical is −Horizontal;
/// for 3 both negate. Rotate negates under a mirror; Aspect negates when the axes swap; Scale is kept.
pub fn remap_transform_sliders(t: &ManualTransform, orientation: u8) -> ManualTransform {
    let a = linear(orientation);
    let [h, v] = apply_linear(a, [t.horizontal, t.vertical]);
    let [x, y] = apply_linear(a, [t.offset_x, t.offset_y]);
    let clean = |v: f64| if v == 0.0 { 0.0 } else { v };
    ManualTransform {
        vertical: clean(v),
        horizontal: clean(h),
        rotate: clean(if orientation_mirrors(orientation) { -t.rotate } else { t.rotate }),
        aspect: clean(if orientation_swaps_axes(orientation) { -t.aspect } else { t.aspect }),
        scale: t.scale,
        offset_x: clean(x),
        offset_y: clean(y),
    }
}

/// Re-express a normalised forward homography of the recorded frame in the oriented frame:
/// `P_o · H · P_o⁻¹`, normalised so `h22 = 1`.
pub fn remap_upright_transform(m: [f64; 9], orientation: u8) -> [f64; 9] {
    let p = orientation_map(orientation);
    let p_inv = orientation_map(inverse_orientation(orientation));
    p_inv.then(&Homography(m)).then(&p).normalized().0.map(|v| if v == 0.0 { 0.0 } else { v })
}

/// The user rotate and flips (`geometry.rotate`, `flipH`, `flipV`) that turn a file decoded with its own
/// EXIF orientation `file_orientation` into the orientation the sidecar records (`xmp_orientation`), for
/// the case where the photo was rotated in Lightroom and only the sidecar knows. `(R0, false, false)`
/// when they agree. Flips are expressed as `flipH` (plus a rotation), never `flipV`.
pub fn orientation_change(file_orientation: u8, xmp_orientation: u8) -> (Rotation, bool, bool) {
    use crate::geometry::orientation::{flip_matrix, rotation_matrix};
    let want = orientation_map(inverse_orientation(file_orientation)).then(&orientation_map(xmp_orientation));
    for rotation in [Rotation::R0, Rotation::R90, Rotation::R180, Rotation::R270] {
        for flip_h in [false, true] {
            let o = rotation_matrix(rotation).then(&flip_matrix(flip_h, false));
            if o.0.iter().zip(want.0.iter()).all(|(a, b)| (a - b).abs() < 1e-12) {
                return (rotation, flip_h, false);
            }
        }
    }
    (Rotation::R0, false, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverse_orientation_inverts() {
        for o in 1..=8u8 {
            let id = orientation_map(o).then(&orientation_map(inverse_orientation(o)));
            assert_eq!(id, Homography::identity(), "orientation {o}");
        }
    }

    #[test]
    fn orientation_6_matches_our_r90() {
        use crate::geometry::orientation::rotation_matrix;
        assert_eq!(orientation_map(6), rotation_matrix(Rotation::R90));
        assert_eq!(orientation_map(8), rotation_matrix(Rotation::R270));
        assert_eq!(orientation_map(3), rotation_matrix(Rotation::R180));
    }

    #[test]
    fn orientation_change_cases() {
        assert_eq!(orientation_change(1, 1), (Rotation::R0, false, false));
        assert_eq!(orientation_change(1, 6), (Rotation::R90, false, false));
        assert_eq!(orientation_change(6, 1), (Rotation::R270, false, false));
        assert_eq!(orientation_change(6, 3), (Rotation::R90, false, false));
        assert_eq!(orientation_change(1, 2), (Rotation::R0, true, false));
    }

    #[test]
    fn mix_fields_are_24() {
        let f = mix_fields();
        assert_eq!(f.len(), 24);
        assert_eq!(f[0].0, "HueAdjustmentRed");
        assert_eq!(f[23].0, "LuminanceAdjustmentMagenta");
    }
}
