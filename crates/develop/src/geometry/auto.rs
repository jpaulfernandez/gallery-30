//! Auto level and automatic Upright (D2.3).
//!
//! [`analyse`] runs once per image (and lens state): the segment detector ([`super::segments`]) on a
//! ≤ 1280 px luminance copy, the Level estimate, the vertical and horizontal RANSAC vanishing points
//! ([`super::vanishing`]) and the focal. [`solve_auto`] then turns an [`Analysis`] into the homography for
//! one mode, without touching pixels, so switching Level / Vertical / Full / Auto is instant.
//!
//! **Coordinates and signs.** The analysis runs on the *oriented* frame (after the user's rotate/flip,
//! before Upright), like guided Upright; segment endpoints are fractions (0..1) of it. Angles are degrees
//! in y-down pixels, positive = clockwise on screen, the sign of `crop.angle`: [`LevelResult::angle_deg`]
//! is the straighten angle to *apply* (a horizon rising 3° to the right, i.e. at −3°, gives +3°).
//!
//! **Level**: every segment's angle folded into −45..45 (a vertical tilted clockwise by θ folds to θ like
//! a horizontal), a length × contrast weighted histogram (0.1° bins, Gaussian σ 0.2°, circular), the peak
//! refined by a parabola and then the weighted mean within ±0.5°. Confidence = the weight within ±0.75° of
//! the peak over the total. When the near-horizontal class alone has a clear peak (≥ 50 % of its weight)
//! and carries ≥ 35 % of all weight, its peak wins (a horizon beats converging verticals and trees).
//! Accepted with confidence ≥ [`LEVEL_MIN_CONFIDENCE`] and either ≥ [`LEVEL_MIN_SEGMENTS`] supporting
//! segments or a support ≥ [`LEVEL_MIN_SUPPORT_FRAC`] of the long edge. With fewer than
//! [`LEVEL_MIN_SEGMENTS`] segments, macOS can fall back to Vision's horizon request (feature
//! `vision-horizon`; a stub returning `None` otherwise).
//!
//! **Vertical**: the vertical vanishing point sent to infinity along y by the shortest camera rotation
//! (`H = K R K⁻¹`), refined on the vertical inliers ([`solve_from_vanishing_points`]).
//! **Full**: both vanishing points, Gram–Schmidt (vertical exact), refined on both inlier sets.
//! Missing structure falls back Full → Vertical → Level, and the result's `correction` says which ran.
//! Full asked explicitly also falls back to Vertical when the two vanishing directions are more than
//! [`FULL_MAX_SKEW_DEG`] from orthogonal under the focal ([`Analysis::skew_deg`]).
//!
//! **Focal** (long-edge units): `√(−v₁·v₂)` from two finite vanishing points within 10 long edges of the
//! centre when it lies in 0.3..5 (and within 1.5× of the EXIF focal when there is one), else the EXIF
//! 35 mm-equivalent (`focal35 / 36`), else [`DEFAULT_FOCAL`].
//!
//! **Auto** (thresholds after LightCraft's description): with a vertical vanishing point whose correction
//! tilts the camera by at most [`AUTO_MAX_PITCH_DEG`] (20°), Full when a horizontal vanishing point needs a
//! yaw between [`AUTO_MIN_YAW_DEG`] (5°) and [`AUTO_MAX_YAW_DEG`] (25°), lies within [`AUTO_MAX_SKEW_DEG`]
//! (2°) of orthogonal and the fit's residual is at most [`AUTO_MAX_RESIDUAL_DEG`] (1°); else Vertical (same
//! residual bound); otherwise (no vertical point, a larger tilt, a poor fit or an unstable warp) Level when
//! its confidence reaches [`AUTO_MIN_LEVEL_CONFIDENCE`] (0.4) and the rotation is at least
//! [`AUTO_MIN_LEVEL_DEG`]; otherwise it declines with [`UprightError::NoStructure`] rather than guess.

use std::time::Instant;

use super::homography::Homography;
use super::segments::{analysis_luma, detect_segments, Segment, SegmentOptions};
use super::transform::{centred_units, from_centred_units};
use super::upright::{
    calibrated_focal, solve_from_vanishing_points, GuidedCorrection, UprightError, WeightedLine, DEFAULT_FOCAL,
};
use super::vanishing::{classify, find_vanishing_point, VanishingOptions, VanishingPoint};
use crate::image::LinearImage;
use crate::settings::{GuideKind, UprightMode};

/// Level: smallest peak share accepted.
pub const LEVEL_MIN_CONFIDENCE: f64 = 0.3;
/// Level: fewest supporting segments (unless their length makes up [`LEVEL_MIN_SUPPORT_FRAC`]); also the
/// segment count under which the Vision horizon fallback runs.
pub const LEVEL_MIN_SEGMENTS: usize = 3;
/// Level: a support this long (fraction of the long edge) is enough on its own (one clear horizon).
pub const LEVEL_MIN_SUPPORT_FRAC: f64 = 0.3;
/// Level histogram bin (degrees), smoothing σ (degrees), support window (± degrees), refinement window.
const LEVEL_BIN_DEG: f64 = 0.1;
const LEVEL_SMOOTH_DEG: f64 = 0.2;
const LEVEL_WINDOW_DEG: f64 = 0.75;
const LEVEL_REFINE_DEG: f64 = 0.5;
/// Dominant horizon: the horizontal class's own peak share and its share of all weight.
const HORIZON_PEAK_SHARE: f64 = 0.5;
const HORIZON_CLASS_SHARE: f64 = 0.35;

/// Auto: a vertical correction tilting the camera more than this falls back to Level.
pub const AUTO_MAX_PITCH_DEG: f64 = 20.0;
/// Auto: the horizontal correction is applied (Full) only for a yaw in this range, else Vertical.
pub const AUTO_MAX_YAW_DEG: f64 = 25.0;
pub const AUTO_MIN_YAW_DEG: f64 = 5.0;
/// Auto: Full also needs the two vanishing directions within this many degrees of orthogonal
/// ([`Analysis::skew_deg`]) and a residual of at most [`AUTO_MAX_RESIDUAL_DEG`]; Vertical the residual.
pub const AUTO_MAX_SKEW_DEG: f64 = 2.0;
pub const AUTO_MAX_RESIDUAL_DEG: f64 = 1.0;
/// Full (asked explicitly) falls back to Vertical when the vanishing directions are further than this
/// from orthogonal: the two points cannot belong to one rectangular structure under the focal.
pub const FULL_MAX_SKEW_DEG: f64 = 10.0;
/// Auto: Level alone needs this confidence and at least this rotation (degrees), else it declines.
pub const AUTO_MIN_LEVEL_CONFIDENCE: f64 = 0.4;
pub const AUTO_MIN_LEVEL_DEG: f64 = 0.05;

/// Calibration from two vanishing points: both within this many long edges of the centre, and the focal
/// in this range (long-edge units) and within this ratio of the EXIF focal.
const CALIBRATION_MAX_VP: f64 = 10.0;
const CALIBRATION_RANGE: (f64, f64) = (0.3, 5.0);
const CALIBRATION_EXIF_RATIO: f64 = 1.5;

/// Where a Level angle came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LevelSource {
    Lines,
    /// macOS Vision's horizon request (feature `vision-horizon`).
    Vision,
}

/// The Level estimate.
#[derive(Debug, Clone, PartialEq)]
pub struct LevelResult {
    /// Straighten angle to apply, degrees, positive clockwise (the sign of `crop.angle`).
    pub angle_deg: f64,
    /// Share of the segment weight within ±0.75° of the peak (0..1); Vision's own confidence for
    /// [`LevelSource::Vision`].
    pub confidence: f64,
    pub source: LevelSource,
    /// Indices of the supporting segments.
    pub support: Vec<usize>,
    /// Weighted RMS deviation of the support from the peak (degrees).
    pub residual: f64,
}

/// Where the focal came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocalSource {
    /// `√(−v₁·v₂)` from the two vanishing points.
    Calibrated,
    /// The EXIF 35 mm-equivalent focal.
    Exif,
    /// [`DEFAULT_FOCAL`] (28 mm equivalent).
    Default,
}

/// Everything [`solve_auto`] needs, computed once per image.
#[derive(Debug, Clone, PartialEq)]
pub struct Analysis {
    /// Size of the analysis copy (pixels).
    pub width: usize,
    pub height: usize,
    /// Detected segments, heaviest first.
    pub segments: Vec<Segment>,
    /// Per segment: supports the Level peak or is an inlier of a vanishing point (for display).
    pub used: Vec<bool>,
    pub level: Option<LevelResult>,
    /// In analysis pixels (see [`VanishingPoint::point`]).
    pub vertical_vp: Option<VanishingPoint>,
    pub horizontal_vp: Option<VanishingPoint>,
    /// Long-edge units.
    pub focal: f64,
    pub focal_source: FocalSource,
    /// Wall time of the analysis (milliseconds), for the dev log.
    pub elapsed_ms: f64,
}

/// The result of [`solve_auto`]: write `transform` to `upright.transform` and `focal` to `upright.focal`.
#[derive(Debug, Clone, PartialEq)]
pub struct AutoSolution {
    /// Row-major forward homography in normalised (0..1) coordinates of the oriented frame (`h8 = 1`).
    pub transform: [f64; 9],
    /// Focal used, long-edge units.
    pub focal: f64,
    /// Weighted RMS deviation (degrees) of the used segments from their axis after the correction.
    pub residual: f64,
    /// What was applied (Auto, and the fallbacks of Full and Vertical, may differ from the mode asked).
    pub correction: GuidedCorrection,
    /// 0..1: the Level peak share, or the vanishing points' score share (the smaller for Full).
    pub confidence: f64,
    /// The rotation the correction applies at the frame centre, degrees clockwise (for Level, the
    /// straighten angle).
    pub angle: f64,
    /// Per segment of the analysis: used by this correction.
    pub used: Vec<bool>,
}

/// Analyse an image (the oriented frame, any size) for automatic Upright. `exif_focal_35mm` is the EXIF
/// `FocalLengthIn35mmFilm` (or focal × crop factor), when known.
pub fn analyse(image: &LinearImage, exif_focal_35mm: Option<f64>) -> Analysis {
    let start = Instant::now();
    let opts = SegmentOptions::default();
    let (luma, w, h) = analysis_luma(image, opts.analysis_long_edge);
    let mut a = analyse_with(&luma, w, h, exif_focal_35mm, &opts, &VanishingOptions::default());
    if a.level.is_none() && a.segments.len() < LEVEL_MIN_SEGMENTS {
        if let Some((angle, confidence)) = vision_horizon(&luma, w, h) {
            a.level = Some(LevelResult {
                angle_deg: angle,
                confidence,
                source: LevelSource::Vision,
                support: Vec::new(),
                residual: 0.0,
            });
        }
    }
    a.elapsed_ms = start.elapsed().as_secs_f64() * 1e3;
    a
}

/// [`analyse`] on a linear luminance plane that is already the analysis copy (`w × h`).
pub fn analyse_luma(luma: &[f32], w: usize, h: usize, exif_focal_35mm: Option<f64>) -> Analysis {
    let start = Instant::now();
    let mut a = analyse_with(luma, w, h, exif_focal_35mm, &SegmentOptions::default(), &VanishingOptions::default());
    a.elapsed_ms = start.elapsed().as_secs_f64() * 1e3;
    a
}

fn analyse_with(
    luma: &[f32],
    w: usize,
    h: usize,
    exif_focal_35mm: Option<f64>,
    seg_opts: &SegmentOptions,
    vp_opts: &VanishingOptions,
) -> Analysis {
    let segments = detect_segments(luma, w, h, seg_opts);
    let long = w.max(h) as f64;
    let level = level_from_segments(&segments, long);
    let (vertical, horizontal) = classify(&segments, vp_opts.class_tolerance_deg);
    let (wf, hf) = (w as f64, h as f64);
    let vertical_vp = find_vanishing_point(&segments, &vertical, wf, hf, vp_opts);
    let horizontal_vp = find_vanishing_point(&segments, &horizontal, wf, hf, vp_opts);

    let exif = exif_focal_35mm.filter(|f| f.is_finite() && *f > 0.0).map(|f| f / 36.0);
    let centred = |v: &VanishingPoint| -> [f64; 3] {
        let p = v.point;
        [(p[0] - 0.5 * wf * p[2]) / long, (p[1] - 0.5 * hf * p[2]) / long, p[2]]
    };
    let near = |v: [f64; 3]| v[2].abs() > 1e-12 && (v[0] / v[2]).hypot(v[1] / v[2]) <= CALIBRATION_MAX_VP;
    let calibrated = match (&vertical_vp, &horizontal_vp) {
        (Some(a), Some(b)) => {
            let (a, b) = (centred(a), centred(b));
            (near(a) && near(b))
                .then(|| calibrated_focal(a, b))
                .flatten()
                .filter(|f| (CALIBRATION_RANGE.0..=CALIBRATION_RANGE.1).contains(f))
                .filter(|f| exif.is_none_or(|e| (f / e).max(e / f) <= CALIBRATION_EXIF_RATIO))
        }
        _ => None,
    };
    let (focal, focal_source) = match (calibrated, exif) {
        (Some(f), _) => (f, FocalSource::Calibrated),
        (None, Some(f)) => (f, FocalSource::Exif),
        (None, None) => (DEFAULT_FOCAL, FocalSource::Default),
    };

    let mut used = vec![false; segments.len()];
    for &i in level.iter().flat_map(|l| l.support.iter()) {
        used[i] = true;
    }
    for vp in [&vertical_vp, &horizontal_vp].into_iter().flatten() {
        for &i in &vp.inliers {
            used[i] = true;
        }
    }
    Analysis {
        width: w,
        height: h,
        segments,
        used,
        level,
        vertical_vp,
        horizontal_vp,
        focal,
        focal_source,
        elapsed_ms: 0.0,
    }
}

/// Fold an angle (degrees) into `[−45, 45)`.
fn fold(a: f64) -> f64 {
    (a + 45.0).rem_euclid(90.0) - 45.0
}

/// The weighted peak of folded angles: `(peak, share, support)`.
fn angle_peak(segments: &[Segment], members: &[usize]) -> Option<(f64, f64, Vec<usize>)> {
    let total: f64 = members.iter().map(|&i| segments[i].weight).sum();
    if members.is_empty() || !(total > 0.0) {
        return None;
    }
    let bins = (90.0 / LEVEL_BIN_DEG).round() as usize;
    let mut hist = vec![0.0f64; bins];
    for &i in members {
        let f = fold(segments[i].angle_deg);
        let b = (((f + 45.0) / LEVEL_BIN_DEG).floor() as isize).rem_euclid(bins as isize) as usize;
        hist[b] += segments[i].weight;
    }
    // Circular Gaussian smoothing.
    let sigma = LEVEL_SMOOTH_DEG / LEVEL_BIN_DEG;
    let radius = (3.0 * sigma).ceil() as isize;
    let kernel: Vec<f64> = (-radius..=radius).map(|k| (-0.5 * (k as f64 / sigma).powi(2)).exp()).collect();
    let smooth: Vec<f64> = (0..bins as isize)
        .map(|b| {
            kernel.iter().enumerate().map(|(k, w)| w * hist[(b + k as isize - radius).rem_euclid(bins as isize) as usize]).sum()
        })
        .collect();
    let peak_bin = (0..bins).fold(0, |best, b| if smooth[b] > smooth[best] { b } else { best });
    let (l, c, r) = (smooth[(peak_bin + bins - 1) % bins], smooth[peak_bin], smooth[(peak_bin + 1) % bins]);
    let den = l - 2.0 * c + r;
    let offset = if den < 0.0 { (0.5 * (l - r) / den).clamp(-0.5, 0.5) } else { 0.0 };
    let coarse = fold(-45.0 + (peak_bin as f64 + 0.5 + offset) * LEVEL_BIN_DEG);
    // Weighted mean within the refinement window.
    let (mut sw, mut sa) = (0.0, 0.0);
    for &i in members {
        let d = fold(fold(segments[i].angle_deg) - coarse);
        if d.abs() <= LEVEL_REFINE_DEG {
            sw += segments[i].weight;
            sa += segments[i].weight * d;
        }
    }
    let peak = if sw > 0.0 { fold(coarse + sa / sw) } else { coarse };
    let support: Vec<usize> =
        members.iter().copied().filter(|&i| fold(fold(segments[i].angle_deg) - peak).abs() <= LEVEL_WINDOW_DEG).collect();
    let share = support.iter().map(|&i| segments[i].weight).sum::<f64>() / total;
    Some((peak, share, support))
}

/// Level from the segments (see the module docs); `long` is the analysis long edge in pixels.
fn level_from_segments(segments: &[Segment], long: f64) -> Option<LevelResult> {
    let all: Vec<usize> = (0..segments.len()).collect();
    let horizontal: Vec<usize> = all.iter().copied().filter(|&i| segments[i].angle_deg.abs() < 45.0).collect();
    let total: f64 = segments.iter().map(|s| s.weight).sum();
    let h_total: f64 = horizontal.iter().map(|&i| segments[i].weight).sum();
    let combined = angle_peak(segments, &all)?;
    let chosen = match angle_peak(segments, &horizontal) {
        Some(hp) if hp.1 >= HORIZON_PEAK_SHARE && h_total >= HORIZON_CLASS_SHARE * total => hp,
        _ => combined,
    };
    let (peak, confidence, support) = chosen;
    let support_len: f64 = support.iter().map(|&i| segments[i].length_px).sum();
    if confidence < LEVEL_MIN_CONFIDENCE
        || (support.len() < LEVEL_MIN_SEGMENTS && support_len < LEVEL_MIN_SUPPORT_FRAC * long)
    {
        return None;
    }
    let (mut sw, mut s2) = (0.0, 0.0);
    for &i in &support {
        let d = fold(fold(segments[i].angle_deg) - peak);
        sw += segments[i].weight;
        s2 += segments[i].weight * d * d;
    }
    Some(LevelResult {
        angle_deg: -peak,
        confidence,
        source: LevelSource::Lines,
        support,
        residual: (s2 / sw).sqrt(),
    })
}

/// Vision's horizon (`VNDetectHorizonRequest`) on the analysis luminance: `(straighten angle in degrees
/// clockwise, confidence)`. Vision reports the horizon's own angle with y-down signs (a horizon rising to
/// the right is negative, checked on a synthetic horizon), so the straighten angle is its negative.
#[cfg(all(target_os = "macos", feature = "vision-horizon"))]
pub fn vision_horizon(luma: &[f32], w: usize, h: usize) -> Option<(f64, f64)> {
    use image::ImageEncoder;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{VNDetectHorizonRequest, VNImageRequestHandler, VNRequest};

    if w == 0 || h == 0 || luma.len() != w * h {
        return None;
    }
    let grey: Vec<u8> =
        luma.iter().map(|&v| (crate::color::transfer::linear_to_srgb(v.clamp(0.0, 1.0)) * 255.0).round() as u8).collect();
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png).write_image(&grey, w as u32, h as u32, image::ExtendedColorType::L8).ok()?;
    // SAFETY: plain Vision calls on objects we own; the request is performed synchronously.
    let (angle, confidence) = unsafe {
        let data = NSData::with_bytes(&png);
        let handler = VNImageRequestHandler::initWithData_options(VNImageRequestHandler::alloc(), &data, &NSDictionary::new());
        let request = VNDetectHorizonRequest::new();
        let as_request: &VNRequest = &request;
        handler.performRequests_error(&NSArray::from_slice(&[as_request])).ok()?;
        let observation = request.results()?.firstObject()?;
        (observation.angle() as f64, observation.confidence() as f64)
    };
    let straighten = -angle.to_degrees();
    (straighten.is_finite() && straighten.abs() <= 45.0).then_some((straighten, confidence.clamp(0.0, 1.0)))
}

/// Without the `vision-horizon` feature (or off macOS) there is no fallback.
#[cfg(not(all(target_os = "macos", feature = "vision-horizon")))]
pub fn vision_horizon(_luma: &[f32], _w: usize, _h: usize) -> Option<(f64, f64)> {
    None
}

/// A vanishing point in fractions (0..1) of the analysis frame.
fn normalised_vp(v: &VanishingPoint, a: &Analysis) -> [f64; 3] {
    let p = v.point;
    [p[0] / a.width as f64, p[1] / a.height as f64, p[2]]
}

fn lines_of(a: &Analysis, vp: &VanishingPoint, kind: GuideKind) -> Vec<WeightedLine> {
    vp.inliers
        .iter()
        .map(|&i| {
            let s = &a.segments[i];
            WeightedLine { kind, from: [s.x0, s.y0], to: [s.x1, s.y1], weight: s.weight }
        })
        .collect()
}

/// The camera tilt (pitch) the vertical correction needs and the yaw of the horizontal one, degrees.
fn tilt_angles(a: &Analysis) -> (Option<f64>, Option<f64>) {
    let pitch = a.vertical_vp.as_ref().map(|v| {
        let d = back_project(a, v);
        d[2].abs().atan2(d[1].abs()).to_degrees()
    });
    let yaw = a.horizontal_vp.as_ref().map(|v| {
        let d = back_project(a, v);
        d[2].abs().atan2(d[0].abs()).to_degrees()
    });
    (pitch, yaw)
}

impl Analysis {
    /// How far (degrees) the back-projected vertical and horizontal vanishing directions are from
    /// orthogonal under [`Analysis::focal`]; large when the two points do not belong to one rectangular
    /// structure (or the focal is wrong). `None` without both points.
    pub fn skew_deg(&self) -> Option<f64> {
        let (v, h) = (self.vertical_vp.as_ref()?, self.horizontal_vp.as_ref()?);
        let (dv, dh) = (back_project(self, v), back_project(self, h));
        let n = |d: [f64; 3]| (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        let c = (dv[0] * dh[0] + dv[1] * dh[1] + dv[2] * dh[2]) / (n(dv) * n(dh));
        Some(c.abs().clamp(0.0, 1.0).asin().to_degrees())
    }
}

/// `K⁻¹v` of a vanishing point (analysis pixels) in centred long-edge units with the analysis focal.
fn back_project(a: &Analysis, v: &VanishingPoint) -> [f64; 3] {
    let long = a.width.max(a.height) as f64;
    let p = v.point;
    let c = [(p[0] - 0.5 * a.width as f64 * p[2]) / long, (p[1] - 0.5 * a.height as f64 * p[2]) / long, p[2]];
    [c[0] / a.focal, c[1] / a.focal, c[2]]
}

/// The rotation (degrees clockwise) a normalised transform applies at the frame centre.
fn centre_angle(t: &Homography, frame_w: f64, frame_h: f64) -> f64 {
    let px = Homography::scale(1.0 / frame_w, 1.0 / frame_h).then(t).then(&Homography::scale(frame_w, frame_h));
    let c = [0.5 * frame_w, 0.5 * frame_h];
    let step = 1e-3 * frame_w.max(frame_h);
    let (a, b) = (px.apply(c), px.apply([c[0] + step, c[1]]));
    (b[1] - a[1]).atan2(b[0] - a[0]).to_degrees()
}

fn level_solution(a: &Analysis, frame_w: f64, frame_h: f64) -> Result<AutoSolution, UprightError> {
    let level = a.level.as_ref().ok_or_else(|| UprightError::NoStructure("no straight lines found".into()))?;
    let centred = Homography::rotate(level.angle_deg.to_radians());
    let t = centred_units(frame_w, frame_h).then(&centred).then(&from_centred_units(frame_w, frame_h)).normalized();
    let mut used = vec![false; a.segments.len()];
    for &i in &level.support {
        used[i] = true;
    }
    Ok(AutoSolution {
        transform: t.0,
        focal: a.focal,
        residual: level.residual,
        correction: GuidedCorrection::Level,
        confidence: level.confidence,
        angle: level.angle_deg,
        used,
    })
}

fn vp_solution(
    a: &Analysis,
    vertical: bool,
    horizontal: bool,
    frame_w: f64,
    frame_h: f64,
) -> Result<AutoSolution, UprightError> {
    let vv = if vertical { a.vertical_vp.as_ref() } else { None };
    let vh = if horizontal { a.horizontal_vp.as_ref() } else { None };
    let mut lines = Vec::new();
    let mut used = vec![false; a.segments.len()];
    let mut confidence = 1.0f64;
    if let Some(v) = vv {
        lines.extend(lines_of(a, v, GuideKind::Vertical));
        confidence = confidence.min(v.share);
    }
    if let Some(v) = vh {
        lines.extend(lines_of(a, v, GuideKind::Horizontal));
        confidence = confidence.min(v.share);
    }
    for v in [vv, vh].into_iter().flatten() {
        for &i in &v.inliers {
            used[i] = true;
        }
    }
    let s = solve_from_vanishing_points(
        &lines,
        vv.map(|v| normalised_vp(v, a)),
        vh.map(|v| normalised_vp(v, a)),
        frame_w,
        frame_h,
        Some(a.focal),
    )?;
    let angle = centre_angle(&Homography(s.transform), frame_w, frame_h);
    Ok(AutoSolution {
        transform: s.transform,
        focal: s.focal,
        residual: s.residual,
        correction: s.correction,
        confidence: confidence.clamp(0.0, 1.0),
        angle,
        used,
    })
}

/// Solve one automatic mode on an analysis, for the oriented `frame_w × frame_h` frame (any unit; the
/// analysis must come from the same frame). `Level`, `Vertical`, `Full` or `Auto`; `Off` and `Guided` are
/// [`UprightError::InvalidGuides`]. The warped area is bounded by
/// [`MAX_AREA_RATIO`](super::upright::MAX_AREA_RATIO).
pub fn solve_auto(analysis: &Analysis, mode: UprightMode, frame_w: f64, frame_h: f64) -> Result<AutoSolution, UprightError> {
    if !(frame_w > 0.0 && frame_h > 0.0 && frame_w.is_finite() && frame_h.is_finite()) {
        return Err(UprightError::InvalidGuides("empty frame".into()));
    }
    let a = analysis;
    let level = || level_solution(a, frame_w, frame_h);
    let has_v = a.vertical_vp.is_some();
    match mode {
        UprightMode::Off | UprightMode::Guided => {
            Err(UprightError::InvalidGuides("solve_auto takes Auto, Level, Vertical or Full".into()))
        }
        UprightMode::Level => level(),
        UprightMode::Vertical => {
            if has_v {
                vp_solution(a, true, false, frame_w, frame_h).or_else(|_| level())
            } else {
                level()
            }
        }
        UprightMode::Full => {
            let consistent = a.skew_deg().is_some_and(|s| s <= FULL_MAX_SKEW_DEG);
            let full = if consistent { vp_solution(a, true, true, frame_w, frame_h).ok() } else { None };
            match full {
                Some(s) => Ok(s),
                None if has_v => vp_solution(a, true, false, frame_w, frame_h).or_else(|_| level()),
                None => level(),
            }
        }
        UprightMode::Auto => {
            let (pitch, yaw) = tilt_angles(a);
            let good = |s: &AutoSolution| s.residual <= AUTO_MAX_RESIDUAL_DEG;
            if pitch.is_some_and(|p| p <= AUTO_MAX_PITCH_DEG) {
                let skew_ok = a.skew_deg().is_some_and(|s| s <= AUTO_MAX_SKEW_DEG);
                if skew_ok && yaw.is_some_and(|y| (AUTO_MIN_YAW_DEG..=AUTO_MAX_YAW_DEG).contains(&y)) {
                    if let Some(s) = vp_solution(a, true, true, frame_w, frame_h).ok().filter(good) {
                        return Ok(s);
                    }
                }
                if let Some(s) = vp_solution(a, true, false, frame_w, frame_h).ok().filter(good) {
                    return Ok(s);
                }
            }
            match &a.level {
                Some(l) if l.confidence >= AUTO_MIN_LEVEL_CONFIDENCE && l.angle_deg.abs() >= AUTO_MIN_LEVEL_DEG => level(),
                Some(l) if l.confidence >= AUTO_MIN_LEVEL_CONFIDENCE => {
                    Err(UprightError::NoStructure("already level; nothing to correct".into()))
                }
                Some(_) => Err(UprightError::NoStructure("not enough straight lines to level with confidence".into())),
                None => Err(UprightError::NoStructure("no straight lines found".into())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(target_os = "macos", feature = "vision-horizon"))]
    #[test]
    fn vision_horizon_matches_the_sign_convention() {
        // Bright sky over dark sea, the horizon rising 4° to the right: straighten by +4°.
        let (w, h) = (960usize, 720usize);
        let t = (-4f64).to_radians();
        let luma: Vec<f32> = (0..w * h)
            .map(|i| {
                let (x, y) = ((i % w) as f64 - 480.0, (i / w) as f64 - 360.0);
                if -t.sin() * x + t.cos() * y < 0.0 { 0.6 } else { 0.08 }
            })
            .collect();
        let (angle, confidence) = vision_horizon(&luma, w, h).expect("Vision found no horizon");
        assert!((angle - 4.0).abs() < 0.5, "{angle} ({confidence})");
    }

    #[test]
    fn folding() {
        assert_eq!(fold(0.0), 0.0);
        assert!((fold(92.0) - 2.0).abs() < 1e-12);
        assert!((fold(-88.0) - 2.0).abs() < 1e-12);
        assert!((fold(44.0) - 44.0).abs() < 1e-12);
        assert!((fold(46.0) + 44.0).abs() < 1e-12);
    }
}
