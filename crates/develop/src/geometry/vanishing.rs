//! Vanishing points for automatic Upright (D2.3): per-direction RANSAC over [`Segment`]s.
//!
//! - **Classes** ([`LineClass::of`]): a segment within [`VanishingOptions::class_tolerance_deg`] (30°) of the
//!   horizontal axis is near-horizontal, within 30° of the vertical axis near-vertical, anything else is
//!   ignored.
//! - **Hypotheses**: [`VanishingOptions::runs`] (400) two-segment hypotheses, segments drawn with probability
//!   proportional to their weight (the heaviest [`VanishingOptions::hypothesis_segments`] only), the
//!   vanishing point being the cross product of the two homogeneous lines. A finite candidate inside the
//!   frame is rejected (such lines do not converge toward a vertical or horizontal vanishing direction,
//!   e.g. the depth lines of a one-point perspective).
//! - **Inliers** (Tardif's criterion): the line from the candidate through the segment's midpoint; the
//!   distance of the segment's endpoints from it, in analysis pixels, must stay below
//!   `min(max_inlier_px, max(0.5, ½·length·tan(max_inlier_deg)))` (2 px, or 2° for short segments).
//!   Score = `Σ weight · (1 − (d / threshold)²)` over the inliers (MSAC-style).
//! - **Refinement**: weighted least squares on the inliers' lines (the eigenvector of the smallest
//!   eigenvalue of `Σ w·l·lᵀ`, lines with unit normals in centred long-edge units), re-scored, repeated
//!   [`VanishingOptions::refine_iterations`] times while it stays outside the frame.
//! - **Acceptance**: at least [`VanishingOptions::min_inliers`] inliers whose lengths add up to
//!   [`VanishingOptions::min_inlier_length_frac`] of the long edge, and a score of at least
//!   [`VanishingOptions::min_score_share`] of the class's total weight. Otherwise `None`.
//!
//! The random sequence is a fixed-seed SplitMix64, so results are deterministic.

use nalgebra::{Matrix3, SymmetricEigen};

use super::segments::Segment;

/// Which axis a segment should end up on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineClass {
    Horizontal,
    Vertical,
}

impl LineClass {
    /// The class of a segment whose direction is within `tolerance_deg` of an axis.
    pub fn of(segment: &Segment, tolerance_deg: f64) -> Option<LineClass> {
        let a = segment.angle_deg.abs();
        if a <= tolerance_deg {
            Some(LineClass::Horizontal)
        } else if a >= 90.0 - tolerance_deg {
            Some(LineClass::Vertical)
        } else {
            None
        }
    }
}

/// Tuning of [`find_vanishing_point`]. The defaults are what automatic Upright uses.
#[derive(Debug, Clone, PartialEq)]
pub struct VanishingOptions {
    /// Segments within this angle of an axis belong to its class (degrees).
    pub class_tolerance_deg: f64,
    /// Number of two-segment hypotheses.
    pub runs: usize,
    /// Hypotheses are drawn from this many of the heaviest segments.
    pub hypothesis_segments: usize,
    /// Inlier distance cap (analysis pixels) and the angular cap for short segments (degrees).
    pub max_inlier_px: f64,
    pub max_inlier_deg: f64,
    /// Acceptance: fewest inliers, their total length as a fraction of the long edge, and the score as a
    /// fraction of the class's total weight.
    pub min_inliers: usize,
    pub min_inlier_length_frac: f64,
    pub min_score_share: f64,
    /// Least-squares refinement rounds.
    pub refine_iterations: usize,
    /// Seed of the hypothesis sampler.
    pub seed: u64,
}

impl Default for VanishingOptions {
    fn default() -> Self {
        Self {
            class_tolerance_deg: 30.0,
            runs: 400,
            hypothesis_segments: 200,
            max_inlier_px: 2.0,
            max_inlier_deg: 2.0,
            min_inliers: 3,
            min_inlier_length_frac: 0.5,
            min_score_share: 0.25,
            refine_iterations: 3,
            seed: 0x5eed_2d3,
        }
    }
}

/// A vanishing point and its support.
#[derive(Debug, Clone, PartialEq)]
pub struct VanishingPoint {
    /// Homogeneous point in analysis pixels (continuous coordinates, origin at the top-left corner), unit
    /// length, `z ≥ 0`; `z ≈ 0` is a point at infinity (parallel lines) in direction `(x, y)`.
    pub point: [f64; 3],
    /// Indices (into the segment list) of the inliers.
    pub inliers: Vec<usize>,
    /// MSAC score (`Σ weight · (1 − (d / threshold)²)`).
    pub score: f64,
    /// `score` over the total weight of the candidate segments (0..1).
    pub share: f64,
}

/// The candidate indices of each class: `(vertical, horizontal)`.
pub fn classify(segments: &[Segment], tolerance_deg: f64) -> (Vec<usize>, Vec<usize>) {
    let (mut v, mut h) = (Vec::new(), Vec::new());
    for (i, s) in segments.iter().enumerate() {
        match LineClass::of(s, tolerance_deg) {
            Some(LineClass::Vertical) => v.push(i),
            Some(LineClass::Horizontal) => h.push(i),
            None => {}
        }
    }
    (v, h)
}

type V3 = [f64; 3];

fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn unit3(a: V3) -> Option<V3> {
    let n = dot(a, a).sqrt();
    (n > 1e-300 && n.is_finite()).then(|| [a[0] / n, a[1] / n, a[2] / n])
}

/// SplitMix64.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// One candidate segment in centred long-edge units.
struct Cand {
    index: usize,
    /// One endpoint and the midpoint.
    a: [f64; 2],
    m: [f64; 2],
    /// Line with a unit normal.
    l: V3,
    weight: f64,
    length: f64,
    /// Inlier threshold, centred long-edge units.
    threshold: f64,
}

struct Frame {
    /// Centre (pixels) and the long edge (pixels).
    cx: f64,
    cy: f64,
    long: f64,
    /// Half extent in centred long-edge units.
    hw: f64,
    hh: f64,
}

impl Frame {
    fn inside(&self, v: V3) -> bool {
        if v[2].abs() <= 1e-9 * v[0].hypot(v[1]) {
            return false;
        }
        let (x, y) = (v[0] / v[2], v[1] / v[2]);
        x.abs() <= self.hw && y.abs() <= self.hh
    }
}

/// Distance of the candidate's endpoints from the line through `v` and its midpoint (centred long-edge
/// units), or `None` when `v` sits on the midpoint.
fn tardif(v: V3, c: &Cand) -> Option<f64> {
    let l = cross(v, [c.m[0], c.m[1], 1.0]);
    let n = l[0].hypot(l[1]);
    if !(n > 1e-15) {
        return None;
    }
    Some((l[0] * c.a[0] + l[1] * c.a[1] + l[2]).abs() / n)
}

/// `(score, inliers)` of `v`.
fn evaluate(v: V3, cands: &[Cand]) -> (f64, Vec<usize>) {
    let mut score = 0.0;
    let mut inliers = Vec::new();
    for (k, c) in cands.iter().enumerate() {
        if let Some(d) = tardif(v, c) {
            if d <= c.threshold {
                let r = d / c.threshold;
                score += c.weight * (1.0 - r * r);
                inliers.push(k);
            }
        }
    }
    (score, inliers)
}

/// Weighted least-squares vanishing point of the given candidates' lines.
fn least_squares(cands: &[Cand], members: &[usize]) -> Option<V3> {
    let mut a = Matrix3::<f64>::zeros();
    for &k in members {
        let l = cands[k].l;
        let w = cands[k].weight;
        for r in 0..3 {
            for c in 0..3 {
                a[(r, c)] += w * l[r] * l[c];
            }
        }
    }
    let eig = SymmetricEigen::new(a);
    let (k, _) = eig.eigenvalues.iter().enumerate().fold((0, f64::INFINITY), |b, (i, &e)| if e < b.1 { (i, e) } else { b });
    let v = eig.eigenvectors.column(k);
    unit3([v[0], v[1], v[2]])
}

/// RANSAC vanishing point of the segments `candidates` (indices into `segments`, normally one class from
/// [`classify`]) in a `width × height` analysis frame (pixels). See the module docs.
pub fn find_vanishing_point(
    segments: &[Segment],
    candidates: &[usize],
    width: f64,
    height: f64,
    opts: &VanishingOptions,
) -> Option<VanishingPoint> {
    if candidates.len() < 2 || !(width > 0.0 && height > 0.0) {
        return None;
    }
    let long = width.max(height);
    let frame = Frame { cx: 0.5 * width, cy: 0.5 * height, long, hw: 0.5 * width / long, hh: 0.5 * height / long };
    let to_c = |p: [f64; 2]| [(p[0] - frame.cx) / long, (p[1] - frame.cy) / long];
    let tan = opts.max_inlier_deg.to_radians().tan();
    let mut cands: Vec<Cand> = Vec::with_capacity(candidates.len());
    for &i in candidates {
        let s = &segments[i];
        let (a, b) = (to_c(s.p0), to_c(s.p1));
        let l = cross([a[0], a[1], 1.0], [b[0], b[1], 1.0]);
        let n = l[0].hypot(l[1]);
        if !(n > 1e-15) || !(s.weight > 0.0) {
            continue;
        }
        let threshold_px = opts.max_inlier_px.min((0.5 * s.length_px * tan).max(0.5));
        cands.push(Cand {
            index: i,
            a,
            m: [0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])],
            l: [l[0] / n, l[1] / n, l[2] / n],
            weight: s.weight,
            length: s.length_px,
            threshold: threshold_px / long,
        });
    }
    if cands.len() < 2 {
        return None;
    }
    let total: f64 = cands.iter().map(|c| c.weight).sum();

    // Hypotheses from the heaviest segments, drawn by weight.
    let mut order: Vec<usize> = (0..cands.len()).collect();
    order.sort_by(|&x, &y| cands[y].weight.total_cmp(&cands[x].weight).then(x.cmp(&y)));
    order.truncate(opts.hypothesis_segments.max(2));
    let mut cumulative = Vec::with_capacity(order.len());
    let mut acc = 0.0;
    for &k in &order {
        acc += cands[k].weight;
        cumulative.push(acc);
    }
    let mut rng = Rng(opts.seed);
    let draw = |rng: &mut Rng| {
        let t = rng.unit() * acc;
        order[cumulative.partition_point(|&c| c <= t).min(order.len() - 1)]
    };
    let mut best: Option<(f64, V3, Vec<usize>)> = None;
    for _ in 0..opts.runs {
        let i = draw(&mut rng);
        let mut j = draw(&mut rng);
        let mut tries = 0;
        while j == i && tries < 8 {
            j = draw(&mut rng);
            tries += 1;
        }
        if j == i {
            continue;
        }
        let Some(v) = unit3(cross(cands[i].l, cands[j].l)) else { continue };
        if frame.inside(v) {
            continue;
        }
        let (score, inliers) = evaluate(v, &cands);
        if best.as_ref().is_none_or(|b| score > b.0) {
            best = Some((score, v, inliers));
        }
    }
    let (mut score, mut v, mut inliers) = best?;

    // Weighted least-squares refinement on the inliers.
    for _ in 0..opts.refine_iterations {
        if inliers.len() < 2 {
            break;
        }
        let Some(r) = least_squares(&cands, &inliers) else { break };
        if frame.inside(r) {
            break;
        }
        let (s, inl) = evaluate(r, &cands);
        if s < 0.95 * score || inl.len() < 2 {
            break;
        }
        let same = inl == inliers;
        (score, v, inliers) = (s, r, inl);
        if same {
            break;
        }
    }

    let length: f64 = inliers.iter().map(|&k| cands[k].length).sum();
    let share = score / total;
    if inliers.len() < opts.min_inliers
        || length < opts.min_inlier_length_frac * frame.long
        || share < opts.min_score_share
    {
        return None;
    }

    // Back to analysis pixels: (X, Y, Z) centred long-edge → (L·X + cx·Z, L·Y + cy·Z, Z).
    let p = unit3([long * v[0] + frame.cx * v[2], long * v[1] + frame.cy * v[2], v[2]])?;
    let flip = if p[2].abs() > 1e-12 {
        p[2] < 0.0
    } else if p[0].abs() >= p[1].abs() {
        p[0] < 0.0
    } else {
        p[1] < 0.0
    };
    let p = if flip { [-p[0], -p[1], -p[2]] } else { p };
    let mut idx: Vec<usize> = inliers.iter().map(|&k| cands[k].index).collect();
    idx.sort_unstable();
    Some(VanishingPoint { point: p, inliers: idx, score, share })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(p0: [f64; 2], p1: [f64; 2]) -> Segment {
        let (dx, dy) = (p1[0] - p0[0], p1[1] - p0[1]);
        let mut a = dy.atan2(dx).to_degrees();
        if a <= -90.0 {
            a += 180.0;
        }
        if a > 90.0 {
            a -= 180.0;
        }
        let len = dx.hypot(dy);
        Segment {
            x0: p0[0] / 1000.0,
            y0: p0[1] / 750.0,
            x1: p1[0] / 1000.0,
            y1: p1[1] / 750.0,
            p0,
            p1,
            length_px: len,
            contrast: 0.1,
            angle_deg: a,
            weight: len * 0.1,
        }
    }

    #[test]
    fn converging_lines_meet_above_the_frame() {
        // Lines through (500, −2000) from points along the bottom, plus clutter.
        let vp = [500.0, -2000.0];
        let mut segs: Vec<Segment> = (0..8)
            .map(|k| {
                let x = 100.0 + 110.0 * k as f64;
                let bottom = [x, 700.0];
                let t = 0.6;
                let top = [bottom[0] + t * (vp[0] - bottom[0]) * 0.2, bottom[1] + t * (vp[1] - bottom[1]) * 0.2];
                seg(top, bottom)
            })
            .collect();
        segs.push(seg([300.0, 300.0], [320.0, 500.0]));
        segs.push(seg([700.0, 200.0], [660.0, 420.0]));
        let (v, _) = classify(&segs, 30.0);
        assert_eq!(v.len(), 10);
        let r = find_vanishing_point(&segs, &v, 1000.0, 750.0, &VanishingOptions::default()).unwrap();
        assert_eq!(r.inliers, (0..8).collect::<Vec<_>>());
        let (x, y) = (r.point[0] / r.point[2], r.point[1] / r.point[2]);
        assert!((x - vp[0]).abs() < 1e-6 && (y - vp[1]).abs() < 1e-6, "{x} {y}");
    }

    #[test]
    fn parallel_lines_give_a_point_at_infinity_and_inside_is_rejected() {
        let segs: Vec<Segment> = (0..5).map(|k| seg([100.0 + 150.0 * k as f64, 100.0], [100.0 + 150.0 * k as f64, 650.0])).collect();
        let all: Vec<usize> = (0..5).collect();
        let r = find_vanishing_point(&segs, &all, 1000.0, 750.0, &VanishingOptions::default()).unwrap();
        assert!(r.point[2].abs() < 1e-9 && (r.point[1].abs() - 1.0).abs() < 1e-9, "{:?}", r.point);
        // Lines radiating from the frame centre: no acceptable vanishing point.
        let star: Vec<Segment> = (0..6)
            .map(|k| {
                let a = (60.0 + 12.0 * k as f64).to_radians();
                let (c, s) = (a.cos(), a.sin());
                seg([500.0 + 100.0 * c, 375.0 + 100.0 * s], [500.0 + 350.0 * c, 375.0 + 350.0 * s])
            })
            .collect();
        let six: Vec<usize> = (0..6).collect();
        assert!(find_vanishing_point(&star, &six, 1000.0, 750.0, &VanishingOptions::default()).is_none());
        assert!(find_vanishing_point(&segs[..1], &[0], 1000.0, 750.0, &VanishingOptions::default()).is_none());
    }
}
