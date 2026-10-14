//! One rasteriser per mask shape, onto a `width × height` output grid. Values are 0..1, sampled at pixel
//! centres (`x + 0.5`, `y + 0.5`).
//!
//! Vector shapes (linear, radial, brush) are stored in fractions of the **transformed, uncropped frame**
//! and reach the grid through `frame_to_output` (normalised frame → output pixels,
//! [`crate::GeometryPlan::frame_to_output_matrix`]). Distances are measured in *frame-metric* units: frame
//! pixels scaled to output pixels ([`FrameGrid`]), so a circle drawn on screen stays a circle whatever the
//! frame aspect, the crop, the straighten angle or the output resolution.
//!
//! Range shapes (luminance, colour) read the **input** image (the decoded, warped picture before any
//! develop adjustment) on the same grid, so they do not move while sliders are dragged.

use rayon::prelude::*;

use crate::color::matrix::{self, REC2020_LUMA};
use crate::color::oklab::Oklab;
use crate::color::transfer::{linear_to_srgb, srgb_to_linear};
use crate::geometry::Homography;
use crate::image::LinearImage;
use crate::settings::{BrushStroke, Point};

/// One mask channel on an output grid: `width * height` values in 0..1, row-major.
#[derive(Debug, Clone, PartialEq)]
pub struct MaskPlane {
    pub width: u32,
    pub height: u32,
    pub data: Vec<f32>,
}

impl MaskPlane {
    pub fn new(width: u32, height: u32, data: Vec<f32>) -> Self {
        assert_eq!(data.len(), width as usize * height as usize, "MaskPlane data has the wrong length");
        Self { width, height, data }
    }

    pub fn filled(width: u32, height: u32, value: f32) -> Self {
        Self { width, height, data: vec![value; width as usize * height as usize] }
    }

    pub fn zeros(width: u32, height: u32) -> Self {
        Self::filled(width, height, 0.0)
    }

    #[inline]
    pub fn get(&self, x: u32, y: u32) -> f32 {
        self.data[y as usize * self.width as usize + x as usize]
    }

    /// Bilinear sample at continuous output coordinates (pixel `i` spans `[i, i + 1)`), edges clamped.
    pub fn sample(&self, x: f64, y: f64) -> f32 {
        if self.data.is_empty() {
            return 0.0;
        }
        let (w, h) = (self.width as usize, self.height as usize);
        let fx = (x - 0.5).clamp(0.0, (w - 1) as f64);
        let fy = (y - 0.5).clamp(0.0, (h - 1) as f64);
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        let (tx, ty) = ((fx - x0 as f64) as f32, (fy - y0 as f64) as f32);
        let at = |x: usize, y: usize| self.data[y * w + x];
        let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
        let bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
        top + (bottom - top) * ty
    }

    /// Bilinear resize to `width × height` (pixel centres aligned). Returns a clone when the size matches.
    pub fn resized(&self, width: u32, height: u32) -> MaskPlane {
        if (width, height) == (self.width, self.height) {
            return self.clone();
        }
        let (sx, sy) = (self.width as f64 / width.max(1) as f64, self.height as f64 / height.max(1) as f64);
        let mut out = MaskPlane::zeros(width, height);
        out.data.par_chunks_mut(width.max(1) as usize).enumerate().for_each(|(y, row)| {
            let v = (y as f64 + 0.5) * sy;
            for (x, o) in row.iter_mut().enumerate() {
                *o = self.sample((x as f64 + 0.5) * sx, v);
            }
        });
        out
    }

    /// Largest value (0 for an empty plane).
    pub fn max_value(&self) -> f32 {
        self.data.iter().copied().fold(0.0, f32::max)
    }
}

/// `smoothstep(e0, e1, x)`: 0 at or below `e0`, 1 at or above `e1`, `3t² − 2t³` between.
#[inline]
pub(crate) fn smoothstep(e0: f64, e1: f64, x: f64) -> f64 {
    if e1 <= e0 {
        return if x < e0 { 0.0 } else { 1.0 };
    }
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The output grid of one render plus the frame → output map, with the frame-metric scale.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameGrid {
    pub width: u32,
    pub height: u32,
    /// Normalised frame → output pixels.
    pub to_output: Homography,
    /// Output pixels → normalised frame.
    pub to_frame: Homography,
    /// The frame's width and height in output pixels (the Jacobian column lengths of `to_output` at the
    /// frame point under the output centre; constant for the similarity a [`crate::GeometryPlan`] gives).
    pub frame_w_px: f64,
    pub frame_h_px: f64,
}

impl FrameGrid {
    /// `None` when the map is singular or not finite.
    pub fn new(width: u32, height: u32, frame_to_output: &Homography) -> Option<FrameGrid> {
        let to_frame = frame_to_output.invert()?.normalized();
        let centre = to_frame.apply([width as f64 / 2.0, height as f64 / 2.0]);
        let [a, b, c, d] = frame_to_output.jacobian(centre);
        let (fw, fh) = (a.hypot(c), b.hypot(d));
        (fw.is_finite() && fh.is_finite() && fw > 0.0 && fh > 0.0).then_some(FrameGrid {
            width,
            height,
            to_output: frame_to_output.normalized(),
            to_frame,
            frame_w_px: fw,
            frame_h_px: fh,
        })
    }

    /// The frame's short side in output pixels: the length unit of brush sizes, mask feather and grow.
    pub fn short_side_px(&self) -> f64 {
        self.frame_w_px.min(self.frame_h_px)
    }

    /// Frame fractions → frame-metric coordinates (output-pixel scale, frame axes).
    #[inline]
    pub fn metric(&self, p: Point) -> [f64; 2] {
        [p[0] * self.frame_w_px, p[1] * self.frame_h_px]
    }

    /// Frame-metric coordinates of output pixel `(x, y)`'s centre.
    #[inline]
    pub fn pixel_metric(&self, x: usize, y: usize) -> [f64; 2] {
        self.metric(self.to_frame.apply([x as f64 + 0.5, y as f64 + 0.5]))
    }

    /// Evaluate `f(frame-metric point)` at every pixel centre, rows in parallel.
    fn map_pixels(&self, f: impl Fn([f64; 2]) -> f64 + Sync) -> MaskPlane {
        let mut plane = MaskPlane::zeros(self.width, self.height);
        if self.width == 0 || self.height == 0 {
            return plane;
        }
        plane.data.par_chunks_mut(self.width as usize).enumerate().for_each(|(y, row)| {
            for (x, o) in row.iter_mut().enumerate() {
                *o = f(self.pixel_metric(x, y)) as f32;
            }
        });
        plane
    }
}

/// Linear gradient: 0 at and before `from`, 1 at and after `to`, smoothstep between (so the middle line
/// is exactly 0.5), measured along `from → to` in frame-metric units (the lines are perpendicular to it on
/// screen). Points are fractions of the transformed frame. A zero-length gradient gives an empty plane.
pub fn rasterise_linear(width: u32, height: u32, frame_to_output: &Homography, from: Point, to: Point) -> MaskPlane {
    let Some(grid) = FrameGrid::new(width, height, frame_to_output) else { return MaskPlane::zeros(width, height) };
    let (a, b) = (grid.metric(from), grid.metric(to));
    let d = [b[0] - a[0], b[1] - a[1]];
    let len2 = d[0] * d[0] + d[1] * d[1];
    if !(len2 > 1e-12) {
        return MaskPlane::zeros(width, height);
    }
    grid.map_pixels(|p| smoothstep(0.0, 1.0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / len2))
}

/// Radial gradient: an ellipse at `center` with semi-axes `radii` (fractions of the frame width and
/// height, measured along the ellipse's own axes in frame-metric units), turned by `angle` degrees
/// (positive = clockwise on screen, the first axis at `angle`; same convention as
/// [`crate::geometry::remap_geometry_vectors`]). 1 inside, 0 outside; `feather` 0..100 is the band
/// *inside* the edge, as a fraction of the normalised radius, over which it falls from 1 to 0 (smoothstep):
/// feather 50 is full strength out to half the radii. Feather 0 is a hard edge.
pub fn rasterise_radial(
    width: u32,
    height: u32,
    frame_to_output: &Homography,
    center: Point,
    radii: Point,
    angle: f64,
    feather: f64,
) -> MaskPlane {
    let Some(grid) = FrameGrid::new(width, height, frame_to_output) else { return MaskPlane::zeros(width, height) };
    let (ra, rb) = (radii[0] * grid.frame_w_px, radii[1] * grid.frame_h_px);
    if !(ra > 0.0 && rb > 0.0) || !angle.is_finite() {
        return MaskPlane::zeros(width, height);
    }
    let c = grid.metric(center);
    let (s, co) = angle.to_radians().sin_cos();
    let f = (feather / 100.0).clamp(0.0, 1.0);
    grid.map_pixels(|p| {
        let (dx, dy) = (p[0] - c[0], p[1] - c[1]);
        let (u, v) = (dx * co + dy * s, -dx * s + dy * co);
        let r = ((u / ra).powi(2) + (v / rb).powi(2)).sqrt();
        if f <= 0.0 {
            if r <= 1.0 {
                1.0
            } else {
                0.0
            }
        } else {
            1.0 - smoothstep(1.0 - f, 1.0, r)
        }
    })
}

/// One round dab in output pixels.
#[derive(Debug, Clone, Copy)]
struct Dab {
    x: f64,
    y: f64,
    /// Coverage is 1 inside `inner`, 0 outside `outer`, smoothstep between.
    inner: f64,
    outer: f64,
}

/// Dabs along one stroke, in output pixels.
fn stroke_dabs(grid: &FrameGrid, stroke: &BrushStroke) -> Vec<Dab> {
    let size = (stroke.size / 100.0).clamp(0.0, 1.0);
    let soft = (stroke.feather / 100.0).clamp(0.0, 1.0);
    // Centre (output px) and radius (output px) per point; the radius follows the local Jacobian.
    let pts: Vec<([f64; 2], f64)> = stroke
        .points
        .iter()
        .filter(|p| p[0].is_finite() && p[1].is_finite())
        .filter_map(|&p| {
            let q = grid.to_output.apply(p);
            let [a, b, c, d] = grid.to_output.jacobian(p);
            let short = a.hypot(c).min(b.hypot(d));
            let r = (size * short / 2.0).max(0.5);
            (q[0].is_finite() && q[1].is_finite() && r.is_finite()).then_some((q, r))
        })
        .collect();
    let dab = |q: [f64; 2], r: f64| {
        // Soft edge = `feather` of the radius; never narrower than 1 px (centred on the radius) to antialias.
        let band = r * soft;
        let outer = r + 0.5 * (1.0 - band).max(0.0);
        Dab { x: q[0], y: q[1], inner: outer - band.max(1.0), outer }
    };
    let mut dabs = Vec::new();
    if let Some(&(q, r)) = pts.first() {
        dabs.push(dab(q, r));
    }
    for w in pts.windows(2) {
        let ((q0, r0), (q1, r1)) = (w[0], w[1]);
        let len = (q1[0] - q0[0]).hypot(q1[1] - q0[1]);
        // Spacing a quarter of the dab diameter (r / 2), at least half a pixel.
        let spacing = (r0.min(r1) / 2.0).max(0.5);
        let n = (len / spacing).ceil().max(1.0) as usize;
        for k in 1..=n {
            let t = k as f64 / n as f64;
            dabs.push(dab([q0[0] + (q1[0] - q0[0]) * t, q0[1] + (q1[1] - q0[1]) * t], r0 + (r1 - r0) * t));
        }
    }
    dabs
}

/// Brush strokes: round dabs along each polyline (`points` in fractions of the transformed frame) spaced a
/// quarter of the dab diameter apart.
///
/// - `size` 0..100: the dab **diameter** as a percentage of the frame's short side (in output pixels the
///   radius is `size/100 · short / 2`, the short side taken from the local Jacobian at each point).
/// - `feather` 0..100: the soft edge as a fraction of the radius (smoothstep from `r·(1 − feather/100)` to
///   `r`); the edge is never narrower than one pixel.
/// - `flow` 0..100: each dab's opacity. Dabs **combine by max**, within a stroke and across strokes, so
///   overlapping dabs and strokes never build up past `flow` (no over-darkening at overlaps or slow spots).
/// - `erase`: the stroke's coverage (max over its dabs, times flow) is subtracted, saturating at 0.
///
/// Strokes apply in order.
pub fn rasterise_brush(width: u32, height: u32, frame_to_output: &Homography, strokes: &[BrushStroke]) -> MaskPlane {
    let mut plane = MaskPlane::zeros(width, height);
    let Some(grid) = FrameGrid::new(width, height, frame_to_output) else { return plane };
    if width == 0 || height == 0 {
        return plane;
    }
    struct Prepared {
        dabs: Vec<Dab>,
        flow: f32,
        erase: bool,
        y0: f64,
        y1: f64,
    }
    let prepared: Vec<Prepared> = strokes
        .iter()
        .filter_map(|s| {
            let dabs = stroke_dabs(&grid, s);
            let flow = (s.flow / 100.0).clamp(0.0, 1.0) as f32;
            if dabs.is_empty() || flow <= 0.0 {
                return None;
            }
            let y0 = dabs.iter().map(|d| d.y - d.outer).fold(f64::INFINITY, f64::min);
            let y1 = dabs.iter().map(|d| d.y + d.outer).fold(f64::NEG_INFINITY, f64::max);
            Some(Prepared { dabs, flow, erase: s.erase, y0, y1 })
        })
        .collect();
    let w = width as usize;
    plane.data.par_chunks_mut(w).enumerate().for_each_init(
        || vec![0.0f32; w],
        |scratch, (y, row)| {
            let cy = y as f64 + 0.5;
            for stroke in &prepared {
                if cy < stroke.y0 || cy > stroke.y1 {
                    continue;
                }
                let (mut lo, mut hi) = (w, 0usize);
                for d in &stroke.dabs {
                    let dy = cy - d.y;
                    if dy.abs() >= d.outer {
                        continue;
                    }
                    let half = (d.outer * d.outer - dy * dy).sqrt();
                    let x0 = (d.x - half - 0.5).floor().max(0.0) as usize;
                    let x1 = ((d.x + half - 0.5).ceil().max(-1.0) as isize + 1).clamp(0, w as isize) as usize;
                    for (x, s) in scratch.iter_mut().enumerate().take(x1).skip(x0) {
                        let dist = (x as f64 + 0.5 - d.x).hypot(dy);
                        let c = 1.0 - smoothstep(d.inner, d.outer, dist);
                        if c as f32 > *s {
                            *s = c as f32;
                        }
                    }
                    lo = lo.min(x0);
                    hi = hi.max(x1);
                }
                if lo >= hi {
                    continue;
                }
                for (o, s) in row[lo..hi].iter_mut().zip(&mut scratch[lo..hi]) {
                    let c = *s * stroke.flow;
                    *o = if stroke.erase { (*o - c).max(0.0) } else { o.max(c) };
                    *s = 0.0;
                }
            }
        },
    );
    plane
}

/// The luminance plane range masks read: Rec.2020 `Y` of the **input** image (the decoded, warped picture
/// before any develop adjustment, so it does not move while sliders are dragged), clamped to 0..1 and
/// sRGB-encoded so the range is perceptual (0.5 is a mid tone, mid grey 0.18 sits at about 0.46).
pub fn luminance_plane(image: &LinearImage) -> Vec<f32> {
    let [kr, kg, kb] = REC2020_LUMA;
    image.data.par_chunks_exact(3).map(|p| linear_to_srgb((kr * p[0] + kg * p[1] + kb * p[2]).clamp(0.0, 1.0))).collect()
}

/// Luminance range over `luma` (from [`luminance_plane`], `width × height`): 1 for `lo <= Y <= hi`
/// (`range` is swapped when reversed), falling to 0 over `feather/100 · 0.25` luminance units *outside* each
/// end (smoothstep). Feather 0 is a hard range.
pub fn rasterise_luminance(width: u32, height: u32, luma: &[f32], range: [f64; 2], feather: f64) -> MaskPlane {
    assert_eq!(luma.len(), width as usize * height as usize, "luminance plane has the wrong size");
    let (lo, hi) = if range[0] <= range[1] { (range[0], range[1]) } else { (range[1], range[0]) };
    let e = (feather / 100.0).clamp(0.0, 1.0) * 0.25;
    let data = luma
        .par_iter()
        .map(|&y| {
            let y = y as f64;
            if e <= 0.0 {
                return if (lo..=hi).contains(&y) { 1.0 } else { 0.0 };
            }
            (smoothstep(lo - e, lo, y) * (1.0 - smoothstep(hi, hi + e, y))) as f32
        })
        .collect();
    MaskPlane::new(width, height, data)
}

/// `#rrggbb`, `rrggbb`, `#rgb` or `rgb` → sRGB-encoded 0..1. `None` for anything else.
pub fn parse_hex_color(s: &str) -> Option<[f32; 3]> {
    let h = s.trim().trim_start_matches('#');
    if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let v = |s: &str| u8::from_str_radix(s, 16).ok().map(|v| v as f32 / 255.0);
    match h.len() {
        6 => Some([v(&h[0..2])?, v(&h[2..4])?, v(&h[4..6])?]),
        3 => {
            let d = |i: usize| v(&h[i..i + 1]).map(|x| x * 17.0);
            Some([d(0)?, d(1)?, d(2)?])
        }
        _ => None,
    }
}

/// Oklab distance scale σ for a colour range `tolerance` 0..100: `0.02 + 0.13 · tolerance/100` (0.02 at 0,
/// 0.085 at the default 50, 0.15 at 100; Oklab L runs 0..1, a saturated red to green is about 0.47).
pub fn color_sigma(tolerance: f64) -> f32 {
    (0.02 + 0.13 * (tolerance / 100.0).clamp(0.0, 1.0)) as f32
}

/// Colour range over `image` (the input image on the output grid, linear Rec.2020): the max over `samples`
/// (hex sRGB colours, invalid ones ignored) of a Gaussian falloff `exp(−d²/2σ²)` of the Oklab distance `d`
/// to the sample, with σ = [`color_sigma`]`(tolerance)`. `d` weights the lightness difference by one half,
/// so the same colour in shade or light is still picked. The Gaussian is rescaled to reach exactly 0 at 3σ
/// (`(g − e^−4.5) / (1 − e^−4.5)`), so far colours are 0, not merely small. No valid sample → empty.
pub fn rasterise_color(image: &LinearImage, samples: &[String], tolerance: f64) -> MaskPlane {
    let ok = Oklab::new();
    let to_2020 = matrix::to_f32(&matrix::srgb_to_rec2020());
    let targets: Vec<[f32; 3]> = samples
        .iter()
        .filter_map(|s| parse_hex_color(s))
        .map(|c| {
            let lin = c.map(srgb_to_linear);
            ok.to_lab(matrix::apply_f32(&to_2020, lin[0], lin[1], lin[2]))
        })
        .collect();
    if targets.is_empty() {
        return MaskPlane::zeros(image.width, image.height);
    }
    let sigma = color_sigma(tolerance);
    let inv = 1.0 / (2.0 * sigma * sigma);
    let cut = (-4.5f32).exp();
    let data = image
        .data
        .par_chunks_exact(3)
        .map(|p| {
            let [l, a, b] = ok.to_lab([p[0], p[1], p[2]]);
            let mut best = 0.0f32;
            for t in &targets {
                let dl = 0.5 * (l - t[0]);
                let d2 = dl * dl + (a - t[1]).powi(2) + (b - t[2]).powi(2);
                let g = ((-d2 * inv).exp() - cut) / (1.0 - cut);
                best = best.max(g);
            }
            best.clamp(0.0, 1.0)
        })
        .collect();
    MaskPlane::new(image.width, image.height, data)
}
