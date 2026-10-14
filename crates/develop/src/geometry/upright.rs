//! Upright (D2.2: guided mode). The solver turns the user's guide lines into one homography that the UI
//! stores in `upright.transform`; renders only read that matrix ([`super::transform::upright_matrix`]).
//!
//! **Coordinates.** Guide endpoints are fractions (0..1) of the *oriented* frame (after rotate/flip,
//! before Upright and the manual Transform). The UI keeps guides in the transformed frame like masks;
//! map them back with [`super::remap::remap_points`]`(pts, &perspective_matrix(..), &identity)` first.
//! Internally everything runs in centred long-edge units ([`super::transform::centred_units`]: origin at
//! the frame centre, long edge 1), where `K = diag(f, f, 1)` is a pinhole camera with the principal point
//! at the centre and `f` in long-edge units.
//!
//! **Model.** The correction is a virtual camera rotation `H = K · R · K⁻¹` (a conjugate rotation keeps
//! lines straight), followed by [`recentre_and_rescale`] so the frame centre stays put and the centre
//! lines keep their length. `R` comes in closed form from the vanishing points of the guide pairs
//! (cross products of the homogeneous lines) and the single guides' back-projected planes; Nelder–Mead
//! ([`super::nelder_mead`]) then refines it on the length-weighted squared deviation of the warped guides
//! from their axis, and the warped frame area is bounded (4× the original, darktable's bound).
//!
//! | Guides | Correction | `R` |
//! |---|---|---|
//! | 2H | Level (+ horizontal convergence): the horizontals become parallel and horizontal | shortest rotation taking the horizontal vanishing direction to x |
//! | 2V | Vertical (+ level): the verticals become parallel and vertical | shortest rotation taking the vertical vanishing direction to y |
//! | 2H+2V | Full | both vanishing directions, Gram–Schmidt (vertical kept exact); `f² = −v₁·v₂` when the two vanishing points are finite and the product is negative |
//! | 2V+1H | Full | vertical from the pair; horizontal = the direction in the single guide's plane orthogonal to it (as 2V when that guide runs through the vertical vanishing point) |
//! | 2H+1V | Full | horizontal from the pair; vertical likewise |
//! | 1V+1H | Full | the smallest rotation with the vertical in the vertical guide's plane and the horizontal in the horizontal guide's plane, orthogonal (1-D search) |
//!
//! Anything else is [`UprightError::InvalidGuides`]. Without calibration the focal is the caller's
//! (`upright.focal`, e.g. from EXIF) or [`DEFAULT_FOCAL`]. For 2H+2V when the rotation model cannot fit
//! all four lines (uncalibrated focal), a four-point DLT of the guides' quad onto a rectangle (sized from
//! the rotation solution) is tried and kept when its residual is lower.

use super::homography::Homography;
use super::nelder_mead;
use super::transform::{centred_units, conjugate_rotation, from_centred_units, pitch_yaw, recentre_and_rescale};
use crate::settings::{GuideKind, UprightGuide};

/// The 28 mm-equivalent focal in long-edge units: a 36 mm long edge at 28 mm gives `f = 28 / 36 ≈ 0.78`
/// long edges (a 75° horizontal field of view), the usual phone/wide default.
pub const DEFAULT_FOCAL: f64 = 28.0 / 36.0;
/// A focal from calibration (`f² = −v₁·v₂`) is used only within this range (long-edge units).
pub const CALIBRATED_FOCAL_RANGE: (f64, f64) = (0.2, 10.0);
/// The warped frame may cover at most this many times the original area.
pub const MAX_AREA_RATIO: f64 = 4.0;
/// Regulariser on the Nelder–Mead rotation increment, so under-determined combinations (2H, 2V) keep
/// the minimal closed-form rotation.
const REGULARISER: f64 = 1e-9;
/// Regulariser of the automatic solve ([`solve_from_vanishing_points`]): many noisy segments leave a
/// residual floor, and an under-determined direction (the yaw for Vertical alone, the pitch for Level
/// alone) would otherwise drift to fit the noise. A 1° drift costs about 3·10⁻⁸, a 0.01° RMS gain.
const AUTO_REGULARISER: f64 = 1e-4;
/// Residual (degrees) below which the 2H+2V rotation solution is accepted without trying the DLT.
const DLT_FALLBACK_RESIDUAL: f64 = 0.01;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum UprightError {
    /// Not one of Lightroom's combinations (2H, 2V, 2H+2V, 2H+1V, 2V+1H, 1V+1H), a guide with no length,
    /// two guides on one line, or a degenerate configuration.
    #[error("invalid guides: {0}")]
    InvalidGuides(String),
    /// The correction would turn the frame inside out or blow it up past [`MAX_AREA_RATIO`].
    #[error("unstable correction: {0}")]
    Unstable(String),
    /// Automatic Upright (D2.3) found too little structure to correct with confidence (e.g. "no straight
    /// lines found"); the UI shows the message instead of a guess.
    #[error("{0}")]
    NoStructure(String),
}

/// What a guide combination corrects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuidedCorrection {
    /// 2H.
    Level,
    /// 2V.
    Vertical,
    /// 2H+2V, 2H+1V, 2V+1H, 1V+1H.
    Full,
}

/// The solver's result: write `transform` to `upright.transform` and `focal` to `upright.focal`.
#[derive(Debug, Clone, PartialEq)]
pub struct GuidedSolution {
    /// Row-major forward homography in normalised (0..1) coordinates of the oriented frame (`h8 = 1`).
    pub transform: [f64; 9],
    /// Focal used, long-edge units (calibrated, the caller's, or [`DEFAULT_FOCAL`]).
    pub focal: f64,
    /// Length-weighted RMS angle (degrees) between the warped guides and their axis.
    pub residual: f64,
    pub correction: GuidedCorrection,
}

/// Validate the combination: `(horizontal count, vertical count, correction)`.
pub fn guide_combination(guides: &[UprightGuide]) -> Result<(usize, usize, GuidedCorrection), UprightError> {
    let nh = guides.iter().filter(|g| g.kind == GuideKind::Horizontal).count();
    let nv = guides.len() - nh;
    let correction = match (nh, nv) {
        (2, 0) => GuidedCorrection::Level,
        (0, 2) => GuidedCorrection::Vertical,
        (2, 2) | (2, 1) | (1, 2) | (1, 1) => GuidedCorrection::Full,
        _ => {
            return Err(UprightError::InvalidGuides(format!(
                "{nh} horizontal and {nv} vertical guides; use 2H, 2V, 2H+2V, 2H+1V, 2V+1H or 1V+1H"
            )))
        }
    };
    Ok((nh, nv, correction))
}

type V3 = [f64; 3];
type M3 = [[f64; 3]; 3];

fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}

fn unit(a: V3, what: &str) -> Result<V3, UprightError> {
    let n = norm(a);
    if !(n > 1e-12) || !n.is_finite() {
        return Err(UprightError::InvalidGuides(format!("degenerate guides ({what})")));
    }
    Ok([a[0] / n, a[1] / n, a[2] / n])
}

fn mat_mul(a: &M3, b: &M3) -> M3 {
    std::array::from_fn(|r| std::array::from_fn(|c| a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c]))
}

/// The shortest rotation taking the unit vector `a` onto the unit vector `b` (`a·b > −1`), Rodrigues.
fn shortest_arc(a: V3, b: V3) -> M3 {
    let v = cross(a, b);
    let c = dot(a, b);
    let k = 1.0 / (1.0 + c);
    let vx: M3 = [[0.0, -v[2], v[1]], [v[2], 0.0, -v[0]], [-v[1], v[0], 0.0]];
    let vx2 = mat_mul(&vx, &vx);
    std::array::from_fn(|r| std::array::from_fn(|col| (r == col) as u8 as f64 + vx[r][col] + k * vx2[r][col]))
}

/// The rotation increment Nelder–Mead searches: `R_z(roll) · R_x(pitch) · R_y(yaw)`.
fn increment(p: &[f64; 3]) -> M3 {
    let (s, c) = p[2].sin_cos();
    let rz: M3 = [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]];
    mat_mul(&rz, &pitch_yaw(p[0], p[1]))
}

/// A guide in centred long-edge units.
struct Line {
    kind: GuideKind,
    from: [f64; 2],
    to: [f64; 2],
    /// Length (the weight).
    weight: f64,
    /// Homogeneous line `from × to`, scaled so `(l0, l1)` is a unit normal.
    l: V3,
}

/// Length-weighted mean of `sin²` of the warped guides' deviation from their axis (`None` when an
/// endpoint maps through infinity).
fn mean_sin2(h: &Homography, lines: &[Line]) -> Option<f64> {
    let m = &h.0;
    let (mut sum, mut wsum) = (0.0, 0.0);
    for line in lines {
        for p in [line.from, line.to] {
            let w = m[6] * p[0] + m[7] * p[1] + m[8];
            if !(w > 1e-12) {
                return None;
            }
        }
        let (a, b) = (h.apply(line.from), h.apply(line.to));
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len2 = dx * dx + dy * dy;
        if !(len2 > 0.0) || !len2.is_finite() {
            return None;
        }
        let off = match line.kind {
            GuideKind::Vertical => dx * dx,
            GuideKind::Horizontal => dy * dy,
        };
        sum += line.weight * off / len2;
        wsum += line.weight;
    }
    Some(sum / wsum)
}

/// Weighted RMS deviation in degrees.
fn residual_degrees(h: &Homography, lines: &[Line]) -> f64 {
    let (mut sum, mut wsum) = (0.0, 0.0);
    for line in lines {
        let (a, b) = (h.apply(line.from), h.apply(line.to));
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let dev = match line.kind {
            GuideKind::Vertical => dx.abs().atan2(dy.abs()),
            GuideKind::Horizontal => dy.abs().atan2(dx.abs()),
        };
        sum += line.weight * dev * dev;
        wsum += line.weight;
    }
    (sum / wsum).sqrt().to_degrees()
}

/// Reject a correction that maps a frame corner through infinity or covers more than
/// [`MAX_AREA_RATIO`] times the frame.
fn check_stable(h: &Homography, extent: (f64, f64)) -> Result<(), UprightError> {
    let (hw, hh) = (0.5 * extent.0, 0.5 * extent.1);
    let m = &h.0;
    let corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    let wc = m[8];
    for p in corners {
        let w = m[6] * p[0] + m[7] * p[1] + m[8];
        if !(w * wc > 0.0) || w.abs() < 1e-9 * wc.abs() {
            return Err(UprightError::Unstable("a frame corner maps through infinity".into()));
        }
    }
    let q = corners.map(|p| h.apply(p));
    let area = 0.5 * (0..4).map(|i| q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1]).sum::<f64>().abs();
    let ratio = area / (extent.0 * extent.1);
    if !ratio.is_finite() || ratio > MAX_AREA_RATIO {
        return Err(UprightError::Unstable(format!("the warped frame covers {ratio:.2}× the original")));
    }
    Ok(())
}

/// Solve guided Upright for `guides` (endpoints in fractions of the oriented `frame_w × frame_h` frame,
/// any unit). `focal` (long-edge units) is used when calibration is not possible; `None` means
/// [`DEFAULT_FOCAL`]. The result's transform is recentred and rescaled, ready to store.
pub fn solve_guided(
    guides: &[UprightGuide],
    frame_w: f64,
    frame_h: f64,
    focal: Option<f64>,
) -> Result<GuidedSolution, UprightError> {
    let (nh, nv, correction) = guide_combination(guides)?;
    if !(frame_w > 0.0 && frame_h > 0.0 && frame_w.is_finite() && frame_h.is_finite()) {
        return Err(UprightError::InvalidGuides("empty frame".into()));
    }
    let long = frame_w.max(frame_h);
    let extent = (frame_w / long, frame_h / long);
    let to_c = centred_units(frame_w, frame_h);

    let mut lines = Vec::with_capacity(guides.len());
    for g in guides {
        if !g.from.iter().chain(g.to.iter()).all(|v| v.is_finite()) {
            return Err(UprightError::InvalidGuides(format!("guide {} is not finite", g.id)));
        }
        let (from, to) = (to_c.apply(g.from), to_c.apply(g.to));
        let weight = ((to[0] - from[0]).powi(2) + (to[1] - from[1]).powi(2)).sqrt();
        if !(weight > 1e-6) {
            return Err(UprightError::InvalidGuides(format!("guide {} has no length", g.id)));
        }
        let l = cross([from[0], from[1], 1.0], [to[0], to[1], 1.0]);
        let n = l[0].hypot(l[1]);
        lines.push(Line { kind: g.kind, from, to, weight, l: [l[0] / n, l[1] / n, l[2] / n] });
    }
    let of_kind = |k: GuideKind| lines.iter().filter(move |l| l.kind == k).collect::<Vec<_>>();
    let (hs, vs) = (of_kind(GuideKind::Horizontal), of_kind(GuideKind::Vertical));
    // Vanishing point of a pair (homogeneous; z ≈ 0 when the lines are parallel).
    let vanishing = |pair: &[&Line], what: &str| -> Result<V3, UprightError> {
        let v = cross(pair[0].l, pair[1].l);
        if norm(v) < 1e-9 {
            return Err(UprightError::InvalidGuides(format!("the two {what} guides lie on one line")));
        }
        Ok(v)
    };
    let vv = (nv == 2).then(|| vanishing(&vs, "vertical")).transpose()?;
    let vh = (nh == 2).then(|| vanishing(&hs, "horizontal")).transpose()?;

    // Focal: calibration from two finite orthogonal vanishing points, else the caller's, else 28 mm.
    let mut f = focal.filter(|f| f.is_finite() && *f > 0.0).unwrap_or(DEFAULT_FOCAL);
    if let (Some(a), Some(b)) = (vv, vh) {
        if let Some(fc) = calibrated_focal(a, b) {
            f = fc;
        }
    }

    // Closed-form rotation. Directions are K⁻¹v (points) and planes Kᵀl (lines).
    let dir = |v: V3| direction(v, f);
    let plane = |l: V3| [f * l[0], f * l[1], l[2]];
    let r0: M3 = match (nh, nv) {
        (0, 2) | (2, 0) | (2, 2) => rotation_from_vanishing(vv, vh, f)?,
        (1, 2) => {
            let dv = toward(unit(dir(vv.unwrap()), "vertical vanishing point")?, 1);
            match orthogonal_in_plane(plane(hs[0].l), dv) {
                Some(dh) => frame_rotation(dh, dv)?,
                // The horizontal guide runs through the vertical vanishing point: it says nothing more.
                None => shortest_arc(dv, [0.0, 1.0, 0.0]),
            }
        }
        (2, 1) => {
            let dh = toward(unit(dir(vh.unwrap()), "horizontal vanishing point")?, 0);
            match orthogonal_in_plane(plane(vs[0].l), dh) {
                Some(dv) => frame_rotation(dh, dv)?,
                None => shortest_arc(dh, [1.0, 0.0, 0.0]),
            }
        }
        _ => one_and_one(unit(plane(vs[0].l), "vertical guide")?, unit(plane(hs[0].l), "horizontal guide")?)?,
    };

    // Refine the rotation on the weighted residuals.
    let (rotation, rotation_ok) = refine_rotation(&r0, f, &lines, extent, REGULARISER);
    let mut best = rotation_ok.clone().ok().map(|_| (rotation, residual_degrees(&rotation, &lines)));

    // 2H+2V that the rotation model cannot fit: the guides' quad onto a rectangle.
    if nh == 2 && nv == 2 && best.map_or(true, |b| b.1 > DLT_FALLBACK_RESIDUAL) {
        if let Some(dlt) = quad_to_rectangle(&hs, &vs, &rotation, extent) {
            if check_stable(&dlt, extent).is_ok() && mean_sin2(&dlt, &lines).is_some() {
                let r = residual_degrees(&dlt, &lines);
                if best.map_or(true, |b| r < b.1) {
                    best = Some((dlt, r));
                }
            }
        }
    }
    let (h, residual) = match best {
        Some(b) => b,
        None => return Err(rotation_ok.unwrap_err()),
    };
    let transform = to_c.then(&h).then(&from_centred_units(frame_w, frame_h)).normalized();
    if !transform.0.iter().all(|v| v.is_finite()) {
        return Err(UprightError::Unstable("non-finite transform".into()));
    }
    Ok(GuidedSolution { transform: transform.0, focal: f, residual, correction })
}

/// Focal (centred long-edge units) from two vanishing points of orthogonal directions (centred long-edge
/// units, homogeneous): `√(−v₁·v₂)` when both are finite, the product is negative and the result lies in
/// [`CALIBRATED_FOCAL_RANGE`].
pub fn calibrated_focal(a: [f64; 3], b: [f64; 3]) -> Option<f64> {
    let finite = |v: V3| v[2].abs() > 1e-9 * v[0].hypot(v[1]);
    if finite(a) && finite(b) {
        let p = (a[0] / a[2]) * (b[0] / b[2]) + (a[1] / a[2]) * (b[1] / b[2]);
        if p < 0.0 {
            let fc = (-p).sqrt();
            if (CALIBRATED_FOCAL_RANGE.0..=CALIBRATED_FOCAL_RANGE.1).contains(&fc) {
                return Some(fc);
            }
        }
    }
    None
}

/// The back-projected direction `K⁻¹v` of an image point (homogeneous, centred long-edge units).
fn direction(v: V3, f: f64) -> V3 {
    [v[0] / f, v[1] / f, v[2]]
}

/// `d` or `−d`, whichever has a non-negative component on `axis`.
fn toward(d: V3, axis: usize) -> V3 {
    if d[axis] < 0.0 {
        [-d[0], -d[1], -d[2]]
    } else {
        d
    }
}

/// The rotation whose rows are the horizontal direction, the vertical direction and their cross product.
fn frame_rotation(dh: V3, dv: V3) -> Result<M3, UprightError> {
    let r1 = toward(unit(dh, "horizontal direction")?, 0);
    let r2 = toward(unit(dv, "vertical direction")?, 1);
    Ok([r1, r2, cross(r1, r2)])
}

/// Closed-form rotation from the vertical and/or horizontal vanishing point (centred long-edge units):
/// the shortest rotation taking the one direction to its axis, or both with Gram–Schmidt (vertical exact).
fn rotation_from_vanishing(vv: Option<V3>, vh: Option<V3>, f: f64) -> Result<M3, UprightError> {
    match (vv, vh) {
        (Some(vv), None) => Ok(shortest_arc(toward(unit(direction(vv, f), "vertical vanishing point")?, 1), [0.0, 1.0, 0.0])),
        (None, Some(vh)) => {
            Ok(shortest_arc(toward(unit(direction(vh, f), "horizontal vanishing point")?, 0), [1.0, 0.0, 0.0]))
        }
        (Some(vv), Some(vh)) => {
            let dv = unit(direction(vv, f), "vertical vanishing point")?;
            let dh = unit(direction(vh, f), "horizontal vanishing point")?;
            let k = dot(dh, dv);
            frame_rotation([dh[0] - k * dv[0], dh[1] - k * dv[1], dh[2] - k * dv[2]], dv)
        }
        (None, None) => Err(UprightError::InvalidGuides("no vanishing point".into())),
    }
}

/// Nelder–Mead refinement of `r0` on the weighted residuals of `lines`, recentred and rescaled, with the
/// stability check of the result.
fn refine_rotation(
    r0: &M3,
    f: f64,
    lines: &[Line],
    extent: (f64, f64),
    regulariser: f64,
) -> (Homography, Result<(), UprightError>) {
    let objective = |p: &[f64; 3]| {
        let h = conjugate_rotation(mat_mul(&increment(p), r0), f);
        let reg = regulariser * (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
        mean_sin2(&h, lines).map_or(1e3, |c| c + reg)
    };
    let (delta, _) = nelder_mead::minimize(objective, [0.0; 3], 0.01, 1e-30, 1e-12);
    let rotation = recentre_and_rescale(&conjugate_rotation(mat_mul(&increment(&delta), r0), f), extent);
    let ok = check_stable(&rotation, extent);
    (rotation, ok)
}

/// A weighted line for [`solve_from_vanishing_points`]: endpoints in fractions (0..1) of the oriented
/// frame, the axis it should end up on, and its weight (automatic Upright uses length × contrast).
#[derive(Debug, Clone, PartialEq)]
pub struct WeightedLine {
    pub kind: GuideKind,
    pub from: [f64; 2],
    pub to: [f64; 2],
    pub weight: f64,
}

/// The rotation solve behind automatic Upright (D2.3), shared with [`solve_guided`]: `R` in closed form
/// from the vertical and/or horizontal vanishing point (homogeneous, in fractions (0..1) of the oriented
/// `frame_w × frame_h` frame; `[x, y, 0]` is a point at infinity), `H = K R K⁻¹` with `focal` (long-edge
/// units; `None` = [`DEFAULT_FOCAL`]; no calibration here, see [`calibrated_focal`]), Nelder–Mead refinement
/// on the weighted deviation of `lines` from their axis (with a stronger pull toward the closed form than
/// the guided solve, since the lines are noisy), recentred and rescaled, warped area bounded.
/// Vertical only → [`GuidedCorrection::Vertical`], horizontal only → `Level`, both → `Full`.
pub fn solve_from_vanishing_points(
    lines: &[WeightedLine],
    vertical: Option<[f64; 3]>,
    horizontal: Option<[f64; 3]>,
    frame_w: f64,
    frame_h: f64,
    focal: Option<f64>,
) -> Result<GuidedSolution, UprightError> {
    if !(frame_w > 0.0 && frame_h > 0.0 && frame_w.is_finite() && frame_h.is_finite()) {
        return Err(UprightError::InvalidGuides("empty frame".into()));
    }
    let correction = match (vertical, horizontal) {
        (Some(_), Some(_)) => GuidedCorrection::Full,
        (Some(_), None) => GuidedCorrection::Vertical,
        (None, Some(_)) => GuidedCorrection::Level,
        (None, None) => return Err(UprightError::NoStructure("no vanishing point".into())),
    };
    let long = frame_w.max(frame_h);
    let extent = (frame_w / long, frame_h / long);
    let to_c = centred_units(frame_w, frame_h);
    let to_centred = |v: [f64; 3]| -> V3 {
        let m = &to_c.0;
        [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], v[2]]
    };
    let mut ls = Vec::with_capacity(lines.len());
    for g in lines {
        if !(g.from.iter().chain(g.to.iter()).all(|v| v.is_finite()) && g.weight.is_finite() && g.weight > 0.0) {
            continue;
        }
        let (from, to) = (to_c.apply(g.from), to_c.apply(g.to));
        let l = cross([from[0], from[1], 1.0], [to[0], to[1], 1.0]);
        let n = l[0].hypot(l[1]);
        if !(n > 1e-12) {
            continue;
        }
        ls.push(Line { kind: g.kind, from, to, weight: g.weight, l: [l[0] / n, l[1] / n, l[2] / n] });
    }
    if ls.is_empty() {
        return Err(UprightError::NoStructure("no lines to fit".into()));
    }
    let f = focal.filter(|f| f.is_finite() && *f > 0.0).unwrap_or(DEFAULT_FOCAL);
    let r0 = rotation_from_vanishing(vertical.map(to_centred), horizontal.map(to_centred), f)?;
    let (h, ok) = refine_rotation(&r0, f, &ls, extent, AUTO_REGULARISER);
    ok?;
    let residual = residual_degrees(&h, &ls);
    let transform = to_c.then(&h).then(&from_centred_units(frame_w, frame_h)).normalized();
    if !transform.0.iter().all(|v| v.is_finite()) {
        return Err(UprightError::Unstable("non-finite transform".into()));
    }
    Ok(GuidedSolution { transform: transform.0, focal: f, residual, correction })
}

/// The unit direction in the plane with normal `n` that is orthogonal to the unit vector `d` (`n × d`),
/// or `None` when `n` is nearly parallel to `d` (ill-conditioned: `|n̂ × d| < 0.05`).
fn orthogonal_in_plane(n: V3, d: V3) -> Option<V3> {
    let nn = norm(n);
    let c = cross([n[0] / nn, n[1] / nn, n[2] / nn], d);
    let k = norm(c);
    (k >= 0.05).then(|| [c[0] / k, c[1] / k, c[2] / k])
}

/// Samples of the 1V+1H search over the vertical guide's plane, then golden-section steps.
const ONE_AND_ONE_SAMPLES: usize = 360;
const ONE_AND_ONE_REFINE: usize = 80;

/// 1V+1H: the vertical direction lies in the vertical guide's plane (unit normal `nv`), the horizontal
/// one in the horizontal guide's plane (`nh`) and orthogonal to it: a one-parameter family. Pick the
/// member with the smallest rotation (largest trace), by sampling the angle along the plane's great
/// circle and refining with golden-section search.
fn one_and_one(nv: V3, nh: V3) -> Result<M3, UprightError> {
    // Basis of the plane: `a` = the camera's y axis projected into it, `b` = nv × a.
    let a = unit([-nv[1] * nv[0], 1.0 - nv[1] * nv[1], -nv[1] * nv[2]], "vertical guide along the optical axis")?;
    let b = cross(nv, a);
    let rotation_at = |t: f64| -> Option<M3> {
        let (s, c) = t.sin_cos();
        let dv = [c * a[0] + s * b[0], c * a[1] + s * b[1], c * a[2] + s * b[2]];
        let dv = if dv[1] < 0.0 { [-dv[0], -dv[1], -dv[2]] } else { dv };
        let dh = orthogonal_in_plane(nh, dv)?;
        let dh = if dh[0] < 0.0 { [-dh[0], -dh[1], -dh[2]] } else { dh };
        Some([dh, dv, cross(dh, dv)])
    };
    let score = |t: f64| rotation_at(t).map_or(f64::NEG_INFINITY, |r| r[0][0] + r[1][1] + r[2][2]);
    let step = std::f64::consts::PI / ONE_AND_ONE_SAMPLES as f64;
    // t and t + π give the same direction up to sign, so half a turn covers the family.
    let start = -std::f64::consts::FRAC_PI_2;
    let (mut best_t, mut best) = (0.0, f64::NEG_INFINITY);
    for i in 0..ONE_AND_ONE_SAMPLES {
        let t = start + i as f64 * step;
        let v = score(t);
        if v > best {
            best = v;
            best_t = t;
        }
    }
    if !best.is_finite() {
        return Err(UprightError::InvalidGuides("the vertical and horizontal guides are degenerate".into()));
    }
    let (mut lo, mut hi) = (best_t - step, best_t + step);
    let g = 0.5 * (5f64.sqrt() - 1.0);
    let (mut x1, mut x2) = (hi - g * (hi - lo), lo + g * (hi - lo));
    let (mut f1, mut f2) = (score(x1), score(x2));
    for _ in 0..ONE_AND_ONE_REFINE {
        if f1 >= f2 {
            hi = x2;
            x2 = x1;
            f2 = f1;
            x1 = hi - g * (hi - lo);
            f1 = score(x1);
        } else {
            lo = x1;
            x1 = x2;
            f1 = f2;
            x2 = lo + g * (hi - lo);
            f2 = score(x2);
        }
    }
    let t = 0.5 * (lo + hi);
    let t = if score(t) >= best { t } else { best_t };
    rotation_at(t).ok_or_else(|| UprightError::InvalidGuides("the vertical and horizontal guides are degenerate".into()))
}

/// Four-point DLT from the corners of the quad the two horizontal and two vertical guides form onto an
/// axis-aligned rectangle with the size and centre the rotation solution `guess` gives that quad, then
/// recentred and rescaled.
fn quad_to_rectangle(hs: &[&Line], vs: &[&Line], guess: &Homography, extent: (f64, f64)) -> Option<Homography> {
    let mean = |l: &Line, k: usize| 0.5 * (l.from[k] + l.to[k]);
    let (top, bottom) = if mean(hs[0], 1) <= mean(hs[1], 1) { (hs[0], hs[1]) } else { (hs[1], hs[0]) };
    let (left, right) = if mean(vs[0], 0) <= mean(vs[1], 0) { (vs[0], vs[1]) } else { (vs[1], vs[0]) };
    let meet = |a: &Line, b: &Line| -> Option<[f64; 2]> {
        let p = cross(a.l, b.l);
        (p[2].abs() > 1e-12).then(|| [p[0] / p[2], p[1] / p[2]])
    };
    let src = [meet(top, left)?, meet(top, right)?, meet(bottom, right)?, meet(bottom, left)?];
    let q = src.map(|p| guess.apply(p));
    let d = |a: [f64; 2], b: [f64; 2]| ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
    let w = 0.5 * (d(q[0], q[1]) + d(q[3], q[2]));
    let h = 0.5 * (d(q[0], q[3]) + d(q[1], q[2]));
    let cx = 0.25 * (q[0][0] + q[1][0] + q[2][0] + q[3][0]);
    let cy = 0.25 * (q[0][1] + q[1][1] + q[2][1] + q[3][1]);
    if !(w > 0.0 && h > 0.0 && cx.is_finite() && cy.is_finite()) {
        return None;
    }
    let dst = [[cx - w / 2.0, cy - h / 2.0], [cx + w / 2.0, cy - h / 2.0], [cx + w / 2.0, cy + h / 2.0], [cx - w / 2.0, cy + h / 2.0]];
    let dlt = Homography::from_four_points(src, dst)?;
    Some(recentre_and_rescale(&dlt, extent))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guide(kind: GuideKind, from: [f64; 2], to: [f64; 2]) -> UprightGuide {
        UprightGuide { id: format!("{kind:?}{from:?}"), kind, from, to }
    }

    #[test]
    fn combinations() {
        use GuideKind::{Horizontal as H, Vertical as V};
        let g = |k| guide(k, [0.1, 0.1], [0.2, 0.9]);
        assert_eq!(guide_combination(&[g(H), g(H)]).unwrap().2, GuidedCorrection::Level);
        assert_eq!(guide_combination(&[g(V), g(V)]).unwrap().2, GuidedCorrection::Vertical);
        for set in [vec![g(H), g(H), g(V), g(V)], vec![g(H), g(V)], vec![g(V), g(V), g(H)], vec![g(H), g(H), g(V)]] {
            assert_eq!(guide_combination(&set).unwrap().2, GuidedCorrection::Full);
        }
        for set in [vec![], vec![g(H)], vec![g(V)], vec![g(V), g(V), g(V)], vec![g(H), g(H), g(H), g(V)], vec![g(H); 5]] {
            assert!(matches!(guide_combination(&set), Err(UprightError::InvalidGuides(_))));
        }
    }

    #[test]
    fn parallel_verticals_are_left_alone() {
        let gs = [guide(GuideKind::Vertical, [0.3, 0.1], [0.3, 0.9]), guide(GuideKind::Vertical, [0.7, 0.2], [0.7, 0.8])];
        let s = solve_guided(&gs, 600.0, 400.0, None).unwrap();
        for (a, b) in s.transform.iter().zip(Homography::identity().0.iter()) {
            assert!((a - b).abs() < 1e-9, "{:?}", s.transform);
        }
        assert!(s.residual < 1e-6);
    }

    #[test]
    fn rodrigues_is_a_rotation() {
        let a = [0.3, 0.9, 0.1];
        let n = norm(a);
        let a = [a[0] / n, a[1] / n, a[2] / n];
        let r = shortest_arc(a, [0.0, 1.0, 0.0]);
        let ra = [dot(r[0], a), dot(r[1], a), dot(r[2], a)];
        assert!((ra[0]).abs() < 1e-12 && (ra[1] - 1.0).abs() < 1e-12 && ra[2].abs() < 1e-12);
    }
}
