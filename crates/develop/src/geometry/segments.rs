//! Line segments for automatic Upright (D2.3): a clean-room, edge-drawing style detector (after the
//! published descriptions of EDLines and ELSED; no code from LSD, darktable or RawTherapee).
//!
//! 1. **Analysis copy** ([`analysis_luma`]): Rec.2020 luminance, downscaled so the long edge is at most
//!    [`SegmentOptions::analysis_long_edge`] (a triangle-filtered resize; never upscaled).
//! 2. **Edge enhancement**: gamma 0.45 on the luminance, then a mild unsharp mask.
//! 3. **Gradients**: Sobel (normalised to a unit-step derivative), magnitude and orientation; thin edges by
//!    non-maximum suppression across the gradient. The edge threshold adapts to noise
//!    (`max(min_gradient, noise_factor · median magnitude)`), anchors need `anchor_factor` times more.
//!    Pixels in the border band ([`SegmentOptions::border_frac`] of the long edge) are ignored, so frame
//!    edges, vignettes and scan borders never make segments.
//! 4. **Edge drawing**: from the strongest unvisited anchor, walk both ways along the edge (perpendicular
//!    to the gradient) to the strongest 8-neighbour ahead whose orientation stays within
//!    [`SegmentOptions::angle_tolerance_deg`] of the anchor's, giving a pixel chain.
//! 5. **Line fit**: each chain is cut into pieces by an incremental total-least-squares fit (sub-pixel
//!    edge positions from a parabola across the gradient) that grows while every new point stays within
//!    [`SegmentOptions::max_deviation_px`] of the line.
//! 6. **Merge**: collinear pieces (angle within [`SegmentOptions::merge_angle_deg`], all endpoints within
//!    [`SegmentOptions::merge_distance_px`] of the merged line, gap at most a quarter of the shorter piece
//!    or 4 px) are joined; pieces shorter than [`SegmentOptions::min_length_frac`] of the long edge are
//!    dropped.
//!
//! Each segment's weight is `length_px × contrast` (contrast = the mean gradient magnitude along it, in
//! gamma-encoded luminance per pixel); the output is sorted by weight, heaviest first.

use fast_image_resize as fr;
use rayon::prelude::*;

use crate::color::matrix::REC2020_LUMA;
use crate::image::LinearImage;
use crate::local::blur::{downsample_mean, gaussian_blurred, reduced_size};

/// Tuning of [`detect_segments`] and [`analysis_luma`]. The defaults are what automatic Upright uses.
#[derive(Debug, Clone, PartialEq)]
pub struct SegmentOptions {
    /// Long edge of the analysis copy (pixels); larger images are downscaled to it.
    pub analysis_long_edge: u32,
    /// Gamma applied to the luminance before the gradients.
    pub gamma: f32,
    /// Unsharp mask amount and σ (pixels) on the gamma-encoded luminance.
    pub unsharp_amount: f32,
    pub unsharp_sigma: f32,
    /// Floor of the edge threshold (gamma-encoded luminance per pixel).
    pub min_gradient: f32,
    /// The edge threshold is at least this many times the median gradient magnitude (noise).
    pub noise_factor: f32,
    /// Anchors need this many times the edge threshold.
    pub anchor_factor: f32,
    /// Largest orientation change along an edge chain (degrees).
    pub angle_tolerance_deg: f64,
    /// Largest distance of a chain point from its fitted line (pixels).
    pub max_deviation_px: f64,
    /// Shortest segment kept, as a fraction of the long edge.
    pub min_length_frac: f64,
    /// Edge pixels within this fraction of the long edge from the border are ignored.
    pub border_frac: f64,
    /// Collinear merge: largest angle between two pieces (degrees) and endpoint distance (pixels).
    pub merge_angle_deg: f64,
    pub merge_distance_px: f64,
}

impl Default for SegmentOptions {
    fn default() -> Self {
        Self {
            analysis_long_edge: 1280,
            gamma: 0.45,
            unsharp_amount: 0.5,
            unsharp_sigma: 1.5,
            min_gradient: 0.012,
            noise_factor: 4.0,
            anchor_factor: 2.0,
            angle_tolerance_deg: 22.5,
            max_deviation_px: 1.0,
            min_length_frac: 0.025,
            border_frac: 0.02,
            merge_angle_deg: 1.5,
            merge_distance_px: 1.5,
        }
    }
}

/// A detected line segment.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    /// Endpoints in fractions (0..1) of the analysed frame (x of the width, y of the height). `p0` is the
    /// left end (the top end when vertical).
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    /// The same endpoints in analysis pixels (continuous: pixel `i` spans `[i, i + 1)`), aspect-correct.
    pub p0: [f64; 2],
    pub p1: [f64; 2],
    /// Length in analysis pixels.
    pub length_px: f64,
    /// Mean gradient magnitude along the segment (gamma-encoded luminance per pixel).
    pub contrast: f64,
    /// Direction in degrees, `(−90, 90]`: `atan2(dy, dx)` in y-down pixels, so positive turns clockwise
    /// from the +x axis on screen (the sign of `crop.angle`). Horizontal 0, vertical 90.
    pub angle_deg: f64,
    /// `length_px × contrast`.
    pub weight: f64,
}

impl Segment {
    fn from_points(p0: [f64; 2], p1: [f64; 2], contrast: f64, w: usize, h: usize) -> Segment {
        let (mut a, mut b) = (p0, p1);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        if dx < 0.0 || (dx == 0.0 && dy < 0.0) {
            std::mem::swap(&mut a, &mut b);
        }
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let length_px = dx.hypot(dy);
        let mut angle_deg = dy.atan2(dx).to_degrees();
        if angle_deg <= -90.0 {
            angle_deg += 180.0;
        }
        let (wf, hf) = (w as f64, h as f64);
        Segment {
            x0: a[0] / wf,
            y0: a[1] / hf,
            x1: b[0] / wf,
            y1: b[1] / hf,
            p0: a,
            p1: b,
            length_px,
            contrast,
            angle_deg,
            weight: length_px * contrast,
        }
    }

    /// Midpoint in analysis pixels.
    pub fn midpoint(&self) -> [f64; 2] {
        [0.5 * (self.p0[0] + self.p1[0]), 0.5 * (self.p0[1] + self.p1[1])]
    }
}

/// Rec.2020 luminance of `image`, downscaled (triangle filter) so the long edge is at most `long_edge`.
/// Returns `(plane, width, height)`.
pub fn analysis_luma(image: &LinearImage, long_edge: u32) -> (Vec<f32>, usize, usize) {
    let (w, h) = (image.width as usize, image.height as usize);
    let y: Vec<f32> = image
        .data
        .par_chunks_exact(3)
        .map(|p| REC2020_LUMA[0] * p[0] + REC2020_LUMA[1] * p[1] + REC2020_LUMA[2] * p[2])
        .collect();
    let long = w.max(h);
    if long_edge == 0 || long <= long_edge as usize || w == 0 || h == 0 {
        return (y, w, h);
    }
    let scale = long_edge as f64 / long as f64;
    let (tw, th) = (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1));
    match resize_plane(&y, w as u32, h as u32, tw, th) {
        Some(out) => (out, tw as usize, th as usize),
        None => {
            let factor = long.div_ceil(long_edge as usize);
            let (lw, lh) = reduced_size(w, h, factor);
            (downsample_mean(&y, w, h, factor), lw, lh)
        }
    }
}

fn resize_plane(plane: &[f32], w: u32, h: u32, tw: u32, th: u32) -> Option<Vec<f32>> {
    let src: Vec<fr::pixels::F32> = plane.iter().map(|&v| fr::pixels::F32::new(v)).collect();
    let src = fr::images::TypedImageRef::new(w, h, &src).ok()?;
    let mut dst = fr::images::TypedImage::<fr::pixels::F32>::new(tw, th);
    let options = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Bilinear));
    fr::Resizer::new().resize_typed(&src, &mut dst, &options).ok()?;
    Some(dst.pixels().iter().map(|p| p.0).collect())
}

/// The 8-neighbourhood, counter-clockwise from +x.
const NEIGHBOURS: [(i32, i32); 8] = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)];
/// Fewest chain points a line piece is fitted on.
const MIN_PIECE_POINTS: usize = 10;
/// After this many chain points the walk direction follows the chain instead of the anchor.
const FOLLOW_AFTER: f64 = 6.0;

/// Gradient planes of the enhanced luminance.
struct Gradients {
    w: usize,
    h: usize,
    gx: Vec<f32>,
    gy: Vec<f32>,
    mag: Vec<f32>,
}

impl Gradients {
    fn new(plane: &[f32], w: usize, h: usize) -> Gradients {
        let mut gx = vec![0.0f32; w * h];
        let mut gy = vec![0.0f32; w * h];
        gx.par_chunks_mut(w).zip(gy.par_chunks_mut(w)).enumerate().for_each(|(y, (rx, ry))| {
            let rows = [y.saturating_sub(1), y, (y + 1).min(h - 1)].map(|r| &plane[r * w..(r + 1) * w]);
            for x in 0..w {
                let (l, r) = (x.saturating_sub(1), (x + 1).min(w - 1));
                rx[x] = ((rows[0][r] - rows[0][l]) + 2.0 * (rows[1][r] - rows[1][l]) + (rows[2][r] - rows[2][l])) / 8.0;
                ry[x] = ((rows[2][l] - rows[0][l]) + 2.0 * (rows[2][x] - rows[0][x]) + (rows[2][r] - rows[0][r])) / 8.0;
            }
        });
        let mag = gx.par_iter().zip(gy.par_iter()).map(|(a, b)| (a * a + b * b).sqrt()).collect();
        Gradients { w, h, gx, gy, mag }
    }

    /// Bilinear magnitude at continuous pixel-index coordinates (clamped).
    fn mag_at(&self, x: f64, y: f64) -> f64 {
        let x = x.clamp(0.0, (self.w - 1) as f64);
        let y = y.clamp(0.0, (self.h - 1) as f64);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.w - 1), (y0 + 1).min(self.h - 1));
        let (fx, fy) = (x - x0 as f64, y - y0 as f64);
        let m = |xx: usize, yy: usize| self.mag[yy * self.w + xx] as f64;
        (m(x0, y0) * (1.0 - fx) + m(x1, y0) * fx) * (1.0 - fy) + (m(x0, y1) * (1.0 - fx) + m(x1, y1) * fx) * fy
    }

    /// Line orientation (radians, mod π) at pixel `i`: perpendicular to the gradient.
    fn orientation(&self, i: usize) -> f64 {
        (self.gy[i] as f64).atan2(self.gx[i] as f64) + std::f64::consts::FRAC_PI_2
    }

    /// Sub-pixel edge position of pixel `i` (continuous coordinates, centre at `+0.5`): a parabola through
    /// the magnitude at ±1 pixel along the gradient.
    fn subpixel(&self, i: usize) -> [f64; 2] {
        let (x, y) = ((i % self.w) as f64, (i / self.w) as f64);
        let m0 = self.mag[i] as f64;
        let (gx, gy) = (self.gx[i] as f64 / m0, self.gy[i] as f64 / m0);
        let (mm, mp) = (self.mag_at(x - gx, y - gy), self.mag_at(x + gx, y + gy));
        let den = mm - 2.0 * m0 + mp;
        let t = if den < -1e-12 { (0.5 * (mm - mp) / den).clamp(-0.5, 0.5) } else { 0.0 };
        [x + 0.5 + t * gx, y + 0.5 + t * gy]
    }
}

/// Distance between two line orientations modulo π, in `[0, π/2]`.
fn orientation_diff(a: f64, b: f64) -> f64 {
    let d = (a - b).rem_euclid(std::f64::consts::PI);
    d.min(std::f64::consts::PI - d)
}

/// Incremental total-least-squares line fit (sums relative to an origin for stability).
#[derive(Clone, Copy)]
struct Fit {
    o: [f64; 2],
    n: f64,
    sx: f64,
    sy: f64,
    sxx: f64,
    sxy: f64,
    syy: f64,
}

impl Fit {
    fn new(o: [f64; 2]) -> Fit {
        Fit { o, n: 0.0, sx: 0.0, sy: 0.0, sxx: 0.0, sxy: 0.0, syy: 0.0 }
    }

    fn add(&mut self, p: [f64; 2]) {
        let (x, y) = (p[0] - self.o[0], p[1] - self.o[1]);
        self.n += 1.0;
        self.sx += x;
        self.sy += y;
        self.sxx += x * x;
        self.sxy += x * y;
        self.syy += y * y;
    }

    /// `(centroid, unit direction)`.
    fn line(&self) -> ([f64; 2], [f64; 2]) {
        let (mx, my) = (self.sx / self.n, self.sy / self.n);
        let a = self.sxx / self.n - mx * mx;
        let b = self.sxy / self.n - mx * my;
        let c = self.syy / self.n - my * my;
        let t = 0.5 * (2.0 * b).atan2(a - c);
        ([mx + self.o[0], my + self.o[1]], [t.cos(), t.sin()])
    }

    fn distance(line: &([f64; 2], [f64; 2]), p: [f64; 2]) -> f64 {
        let (c, d) = line;
        ((p[0] - c[0]) * d[1] - (p[1] - c[1]) * d[0]).abs()
    }

    fn project(line: &([f64; 2], [f64; 2]), p: [f64; 2]) -> [f64; 2] {
        let (c, d) = line;
        let t = (p[0] - c[0]) * d[0] + (p[1] - c[1]) * d[1];
        [c[0] + t * d[0], c[1] + t * d[1]]
    }
}

/// A fitted piece before merging.
#[derive(Clone)]
struct Piece {
    p0: [f64; 2],
    p1: [f64; 2],
    contrast: f64,
    alive: bool,
}

impl Piece {
    fn len(&self) -> f64 {
        (self.p1[0] - self.p0[0]).hypot(self.p1[1] - self.p0[1])
    }

    fn dir(&self) -> [f64; 2] {
        let l = self.len().max(1e-12);
        [(self.p1[0] - self.p0[0]) / l, (self.p1[1] - self.p0[1]) / l]
    }

    fn orientation(&self) -> f64 {
        (self.p1[1] - self.p0[1]).atan2(self.p1[0] - self.p0[0])
    }
}

/// Detect line segments in a linear luminance plane (`w × h`, row-major). See the module docs.
pub fn detect_segments(luma: &[f32], w: usize, h: usize, opts: &SegmentOptions) -> Vec<Segment> {
    assert_eq!(luma.len(), w * h, "luma plane has the wrong length");
    if w < 8 || h < 8 {
        return Vec::new();
    }
    // Edge enhancement: gamma, then a mild unsharp mask.
    let gamma = opts.gamma;
    let t: Vec<f32> = luma.par_iter().map(|&v| v.max(0.0).powf(gamma)).collect();
    let enhanced: Vec<f32> = if opts.unsharp_amount > 0.0 && opts.unsharp_sigma > 0.0 {
        let blurred = gaussian_blurred(&t, w, h, opts.unsharp_sigma);
        let a = opts.unsharp_amount;
        t.par_iter().zip(blurred.par_iter()).map(|(v, b)| v + a * (v - b)).collect()
    } else {
        t
    };
    let g = Gradients::new(&enhanced, w, h);

    // Noise-adaptive thresholds from the median magnitude (a strided sample is plenty).
    let mut sample: Vec<f32> = g.mag.iter().step_by(3).copied().collect();
    let mid = sample.len() / 2;
    let median = if sample.is_empty() { 0.0 } else { *sample.select_nth_unstable_by(mid, f32::total_cmp).1 };
    let low = opts.min_gradient.max(opts.noise_factor * median);
    let high = low * opts.anchor_factor;

    // Thin edges (non-maximum suppression across the gradient), outside the border band.
    let long = w.max(h) as f64;
    let band = ((opts.border_frac * long).ceil() as usize).max(2);
    let mut edge = vec![false; w * h];
    if w > 2 * band && h > 2 * band {
        edge.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            if y < band || y >= h - band {
                return;
            }
            for x in band..w - band {
                let i = y * w + x;
                let m = g.mag[i];
                if m < low {
                    continue;
                }
                let (ax, ay) = (g.gx[i].abs(), g.gy[i].abs());
                // Quantise the gradient direction to 0°, 45°, 90°, 135°.
                let (dx, dy): (isize, isize) = if ax >= 2.414 * ay {
                    (1, 0)
                } else if ay >= 2.414 * ax {
                    (0, 1)
                } else if (g.gx[i] > 0.0) == (g.gy[i] > 0.0) {
                    (1, 1)
                } else {
                    (1, -1)
                };
                let j0 = (i as isize - dy * w as isize - dx) as usize;
                let j1 = (i as isize + dy * w as isize + dx) as usize;
                row[x] = m > g.mag[j0] && m >= g.mag[j1];
            }
        });
    }

    // Anchors, strongest first.
    let mut anchors: Vec<usize> = (0..w * h).filter(|&i| edge[i] && g.mag[i] >= high).collect();
    anchors.sort_by(|&a, &b| g.mag[b].total_cmp(&g.mag[a]).then(a.cmp(&b)));

    let tol = opts.angle_tolerance_deg.to_radians();
    let mut visited = vec![false; w * h];
    let mut pieces: Vec<Piece> = Vec::new();
    let mut forward = Vec::new();
    let mut backward = Vec::new();
    let mut chain: Vec<usize> = Vec::new();
    for &a in &anchors {
        if visited[a] {
            continue;
        }
        visited[a] = true;
        let theta = g.orientation(a);
        let d = [theta.cos(), theta.sin()];
        walk(&g, &edge, &mut visited, a, d, theta, tol, &mut forward);
        walk(&g, &edge, &mut visited, a, [-d[0], -d[1]], theta, tol, &mut backward);
        if forward.len() + backward.len() + 1 < MIN_PIECE_POINTS {
            continue;
        }
        chain.clear();
        chain.extend(backward.iter().rev());
        chain.push(a);
        chain.extend(forward.iter());
        fit_chain(&g, &chain, opts.max_deviation_px, &mut pieces);
    }

    merge_pieces(&mut pieces, opts);
    let min_len = opts.min_length_frac * long;
    let mut out: Vec<Segment> = pieces
        .into_iter()
        .filter(|p| p.alive && p.len() >= min_len)
        .map(|p| Segment::from_points(p.p0, p.p1, p.contrast, w, h))
        .collect();
    out.sort_by(|a, b| b.weight.total_cmp(&a.weight).then(a.x0.total_cmp(&b.x0)).then(a.y0.total_cmp(&b.y0)));
    out
}

/// Walk from `start` along `d0`, appending the chain's pixels to `out` (cleared first).
#[allow(clippy::too_many_arguments)]
fn walk(g: &Gradients, edge: &[bool], visited: &mut [bool], start: usize, d0: [f64; 2], theta: f64, tol: f64, out: &mut Vec<usize>) {
    out.clear();
    let (w, h) = (g.w as i32, g.h as i32);
    let (sx, sy) = ((start % g.w) as i32, (start / g.w) as i32);
    let (mut x, mut y) = (sx, sy);
    let mut d = d0;
    loop {
        let mut best: Option<(usize, f32)> = None;
        for (dx, dy) in NEIGHBOURS {
            let len = if dx != 0 && dy != 0 { std::f64::consts::SQRT_2 } else { 1.0 };
            if (dx as f64 * d[0] + dy as f64 * d[1]) / len < 0.5 {
                continue;
            }
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= w || ny >= h {
                continue;
            }
            let j = ny as usize * g.w + nx as usize;
            if !edge[j] || visited[j] || orientation_diff(g.orientation(j), theta) > tol {
                continue;
            }
            if best.is_none_or(|b| g.mag[j] > b.1) {
                best = Some((j, g.mag[j]));
            }
        }
        let Some((j, _)) = best else { break };
        visited[j] = true;
        out.push(j);
        x = (j % g.w) as i32;
        y = (j / g.w) as i32;
        let (ex, ey) = ((x - sx) as f64, (y - sy) as f64);
        let n = ex.hypot(ey);
        if n >= FOLLOW_AFTER {
            d = [ex / n, ey / n];
        }
    }
}

/// Cut a pixel chain into straight pieces (EDLines-style incremental fit).
fn fit_chain(g: &Gradients, chain: &[usize], max_dev: f64, pieces: &mut Vec<Piece>) {
    let pts: Vec<[f64; 2]> = chain.iter().map(|&i| g.subpixel(i)).collect();
    let n = pts.len();
    let mut i = 0;
    while n - i >= MIN_PIECE_POINTS {
        let mut fit = Fit::new(pts[i]);
        for p in &pts[i..i + MIN_PIECE_POINTS] {
            fit.add(*p);
        }
        let mut line = fit.line();
        if pts[i..i + MIN_PIECE_POINTS].iter().any(|&p| Fit::distance(&line, p) > max_dev) {
            i += 1;
            continue;
        }
        let mut end = i + MIN_PIECE_POINTS;
        while end < n && Fit::distance(&line, pts[end]) <= max_dev {
            fit.add(pts[end]);
            line = fit.line();
            end += 1;
        }
        let contrast = chain[i..end].iter().map(|&k| g.mag[k] as f64).sum::<f64>() / (end - i) as f64;
        pieces.push(Piece {
            p0: Fit::project(&line, pts[i]),
            p1: Fit::project(&line, pts[end - 1]),
            contrast,
            alive: true,
        });
        i = end;
    }
}

/// Join collinear pieces in place (dead pieces get `alive = false`).
fn merge_pieces(pieces: &mut [Piece], opts: &SegmentOptions) {
    pieces.sort_by(|a, b| b.len().total_cmp(&a.len()));
    let max_angle = opts.merge_angle_deg.to_radians();
    let max_dist = opts.merge_distance_px;
    for i in 0..pieces.len() {
        if !pieces[i].alive {
            continue;
        }
        loop {
            let mut merged_any = false;
            for j in 0..pieces.len() {
                if j == i || !pieces[j].alive {
                    continue;
                }
                if orientation_diff(pieces[i].orientation(), pieces[j].orientation()) > max_angle {
                    continue;
                }
                if let Some(m) = try_merge(&pieces[i], &pieces[j], max_dist) {
                    pieces[i] = m;
                    pieces[j].alive = false;
                    merged_any = true;
                }
            }
            if !merged_any {
                break;
            }
        }
    }
}

fn try_merge(a: &Piece, b: &Piece, max_dist: f64) -> Option<Piece> {
    let da = a.dir();
    let ca = [0.5 * (a.p0[0] + a.p1[0]), 0.5 * (a.p0[1] + a.p1[1])];
    let la = (ca, da);
    // Quick rejection: b's endpoints must lie near a's line.
    if Fit::distance(&la, b.p0) > 2.0 * max_dist || Fit::distance(&la, b.p1) > 2.0 * max_dist {
        return None;
    }
    // Gap along a's direction.
    let t = |p: [f64; 2]| (p[0] - ca[0]) * da[0] + (p[1] - ca[1]) * da[1];
    let (a0, a1) = (t(a.p0).min(t(a.p1)), t(a.p0).max(t(a.p1)));
    let (b0, b1) = (t(b.p0).min(t(b.p1)), t(b.p0).max(t(b.p1)));
    let gap = (b0 - a1).max(a0 - b1).max(0.0);
    let (lena, lenb) = (a.len(), b.len());
    if gap > (0.25 * lena.min(lenb)).max(4.0) {
        return None;
    }
    // The length-weighted line through both.
    let db = b.dir();
    let s = if da[0] * db[0] + da[1] * db[1] < 0.0 { -1.0 } else { 1.0 };
    let dir = [lena * da[0] + s * lenb * db[0], lena * da[1] + s * lenb * db[1]];
    let dn = dir[0].hypot(dir[1]);
    if !(dn > 0.0) {
        return None;
    }
    let dir = [dir[0] / dn, dir[1] / dn];
    let cb = [0.5 * (b.p0[0] + b.p1[0]), 0.5 * (b.p0[1] + b.p1[1])];
    let wsum = lena + lenb;
    let c = [(lena * ca[0] + lenb * cb[0]) / wsum, (lena * ca[1] + lenb * cb[1]) / wsum];
    let line = (c, dir);
    let ends = [a.p0, a.p1, b.p0, b.p1];
    if ends.iter().any(|&p| Fit::distance(&line, p) > max_dist) {
        return None;
    }
    let tt = |p: [f64; 2]| (p[0] - c[0]) * dir[0] + (p[1] - c[1]) * dir[1];
    let (tmin, tmax) = ends.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &p| (lo.min(tt(p)), hi.max(tt(p))));
    Some(Piece {
        p0: [c[0] + tmin * dir[0], c[1] + tmin * dir[1]],
        p1: [c[0] + tmax * dir[0], c[1] + tmax * dir[1]],
        contrast: (lena * a.contrast + lenb * b.contrast) / wsum,
        alive: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Antialiased plane: `f(x, y)` averaged over a 4×4 grid per pixel.
    fn render(w: usize, h: usize, f: impl Fn(f64, f64) -> f32 + Sync) -> Vec<f32> {
        let mut out = vec![0.0f32; w * h];
        out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
            for (x, v) in row.iter_mut().enumerate() {
                let mut s = 0.0;
                for sy in 0..4 {
                    for sx in 0..4 {
                        s += f(x as f64 + (sx as f64 + 0.5) / 4.0, y as f64 + (sy as f64 + 0.5) / 4.0);
                    }
                }
                *v = s / 16.0;
            }
        });
        out
    }

    /// A grid of dark bars (4 px wide) on a mid background, rotated by `deg` about the centre.
    fn grid(w: usize, h: usize, deg: f64, rows: usize, cols: usize) -> Vec<f32> {
        let (s, c) = deg.to_radians().sin_cos();
        let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0);
        let (sw, sh) = (w as f64 * 0.8 / cols as f64, h as f64 * 0.8 / rows as f64);
        render(w, h, move |x, y| {
            // Undo the rotation: picture coordinates.
            let (dx, dy) = (x - cx, y - cy);
            let (u, v) = (c * dx + s * dy, -s * dx + c * dy);
            let bar = |t: f64, step: f64, n: usize| {
                (0..n).any(|k| {
                    let centre = (k as f64 - (n as f64 - 1.0) / 2.0) * step;
                    (t - centre).abs() < 2.0
                })
            };
            let inside = u.abs() < w as f64 * 0.42 && v.abs() < h as f64 * 0.42;
            if inside && (bar(u, sw, cols) || bar(v, sh, rows)) {
                0.03
            } else {
                0.25
            }
        })
    }

    fn classify(segs: &[Segment], deg: f64) -> (Vec<f64>, Vec<f64>) {
        let (mut hs, mut vs) = (Vec::new(), Vec::new());
        for s in segs {
            let a = s.angle_deg - deg;
            let a = (a + 90.0).rem_euclid(180.0) - 90.0;
            if a.abs() < 45.0 {
                hs.push(a);
            } else {
                vs.push(if a > 0.0 { a - 90.0 } else { a + 90.0 });
            }
        }
        (hs, vs)
    }

    #[test]
    fn grid_gives_horizontal_and_vertical_segments() {
        for deg in [0.0, 7.0] {
            let (w, h) = (960, 720);
            let plane = grid(w, h, deg, 4, 6);
            let segs = detect_segments(&plane, w, h, &SegmentOptions::default());
            let (hs, vs) = classify(&segs, deg);
            // Each bar has two edges.
            assert_eq!(hs.len(), 8, "angle {deg}: horizontal {hs:?}");
            assert_eq!(vs.len(), 12, "angle {deg}: vertical {vs:?}");
            for a in hs.iter().chain(vs.iter()) {
                assert!(a.abs() < 0.3, "angle {deg}: deviation {a}");
            }
            // Bars span the grid (0.84 of the frame) minus the cross bars.
            for s in &segs {
                assert!(s.length_px > 0.5 * h as f64, "{s:?}");
                assert!((s.weight - s.length_px * s.contrast).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn noise_gives_no_segments() {
        let (w, h) = (800, 600);
        let mut state = 0x9e3779b97f4a7c15u64;
        let plane: Vec<f32> = (0..w * h)
            .map(|_| {
                // Sum of uniforms: roughly Gaussian, σ ≈ 0.03 about 0.2.
                let mut s = 0.0;
                for _ in 0..4 {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    s += (state >> 11) as f64 / (1u64 << 53) as f64;
                }
                (0.2 + 0.06 * (s - 2.0)) as f32
            })
            .collect();
        let segs = detect_segments(&plane, w, h, &SegmentOptions::default());
        assert!(segs.is_empty(), "{} segments, first {:?}", segs.len(), segs.first());
    }

    #[test]
    fn border_band_is_ignored() {
        // A step exactly along the frame edge region only.
        let (w, h) = (400, 300);
        let plane = render(w, h, |x, _| if x < 5.0 { 0.0 } else { 0.4 });
        assert!(detect_segments(&plane, w, h, &SegmentOptions::default()).is_empty());
    }
}
