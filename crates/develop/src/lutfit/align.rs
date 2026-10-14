//! Lining up the developed RAW with the camera JPEG (workflow plan 22): a similarity search (one scale, a
//! translation) on high-passed luma, coarse to fine, then a small translation per tile so lens corrections the camera
//! applied to its JPEG (and not to our RAW decode) move the edges by a pixel or two at most.
//!
//! Coordinates are continuous (pixel `i` covers `i..i + 1`, its centre is `i + 0.5`). A source point `p` maps to the
//! target at `target_centre + scale · (p − source_centre) + offset + tile_offset(p)`.

use rayon::prelude::*;

/// Alignments scoring below this (the normalised cross-correlation of the high-passed luma) are rejected: the JPEG
/// is not the same shot, or it is cropped, rotated or distorted differently.
pub const MIN_SCORE: f32 = 0.5;
/// Largest scale difference searched (a RAW decode and its JPEG differ by a few border pixels, not more).
const SCALE_SPAN: f32 = 0.03;
/// Largest offset searched, as a fraction of the long edge.
const OFFSET_SPAN: f32 = 0.03;
/// Long edge of the coarsest level of the search.
const COARSE_EDGE: usize = 192;
/// Tiles of the local refinement along the long and the short edge.
const TILES: (usize, usize) = (4, 3);
/// Largest per-tile offset, in working pixels.
const TILE_SPAN: f32 = 3.0;

/// How the target lines up with the source.
#[derive(Debug, Clone, PartialEq)]
pub struct Alignment {
    pub scale: f32,
    /// Global offset in target pixels.
    pub offset: [f32; 2],
    /// Normalised cross-correlation of the high-passed luma at the global alignment (1 is a perfect match).
    pub score: f32,
    pub source_centre: [f32; 2],
    pub target_centre: [f32; 2],
    /// Tile grid over the source (columns, rows) and each tile's extra offset, row-major.
    pub grid: (usize, usize),
    pub tile_size: [f32; 2],
    pub tile_offsets: Vec<[f32; 2]>,
}

impl Default for Alignment {
    fn default() -> Self {
        Alignment {
            scale: 1.0,
            offset: [0.0; 2],
            score: 0.0,
            source_centre: [0.0; 2],
            target_centre: [0.0; 2],
            grid: (1, 1),
            tile_size: [f32::MAX; 2],
            tile_offsets: vec![[0.0; 2]],
        }
    }
}

impl Alignment {
    /// Where the source point `(x, y)` (continuous coordinates) is in the target.
    pub fn map(&self, x: f32, y: f32) -> (f32, f32) {
        let tx = ((x / self.tile_size[0]) as usize).min(self.grid.0 - 1);
        let ty = ((y / self.tile_size[1]) as usize).min(self.grid.1 - 1);
        let local = self.tile_offsets[ty * self.grid.0 + tx];
        (
            self.target_centre[0] + self.scale * (x - self.source_centre[0]) + self.offset[0] + local[0],
            self.target_centre[1] + self.scale * (y - self.source_centre[1]) + self.offset[1] + local[1],
        )
    }
}

/// One level of the search: luma box-shrunk by `factor`, high-passed.
struct Level {
    w: usize,
    h: usize,
    factor: f32,
    hp: Vec<f32>,
}

fn box_blur(plane: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0.0f32; plane.len()];
    let mut out = vec![0.0f32; plane.len()];
    tmp.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let src = &plane[y * w..(y + 1) * w];
        for (x, v) in row.iter_mut().enumerate() {
            let (a, b) = (x.saturating_sub(r), (x + r).min(w - 1));
            *v = src[a..=b].iter().sum::<f32>() / (b - a + 1) as f32;
        }
    });
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let (a, b) = (y.saturating_sub(r), (y + r).min(h - 1));
        for (x, v) in row.iter_mut().enumerate() {
            let mut s = 0.0;
            for yy in a..=b {
                s += tmp[yy * w + x];
            }
            *v = s / (b - a + 1) as f32;
        }
    });
    out
}

fn level(luma: &[f32], w: usize, h: usize, factor: usize) -> Level {
    let f = factor.max(1);
    let (lw, lh) = ((w / f).max(1), (h / f).max(1));
    let small: Vec<f32> = if f == 1 {
        luma.to_vec()
    } else {
        (0..lw * lh)
            .into_par_iter()
            .map(|i| {
                let (x, y) = (i % lw, i / lw);
                let mut s = 0.0;
                for yy in y * f..((y + 1) * f).min(h) {
                    for xx in x * f..((x + 1) * f).min(w) {
                        s += luma[yy * w + xx];
                    }
                }
                s / (f * f) as f32
            })
            .collect()
    };
    let blur = box_blur(&small, lw, lh, 2);
    let hp = small.iter().zip(&blur).map(|(a, b)| a - b).collect();
    Level { w: lw, h: lh, factor: f as f32, hp }
}

/// Bilinear sample at continuous `(x, y)`, `None` outside the pixel centres.
#[inline]
fn sample(plane: &[f32], w: usize, h: usize, x: f32, y: f32) -> Option<f32> {
    let (u, v) = (x - 0.5, y - 0.5);
    if !(u >= 0.0 && v >= 0.0 && u <= (w - 1) as f32 && v <= (h - 1) as f32) {
        return None;
    }
    let (x0, y0) = ((u as usize).min(w.saturating_sub(2)), (v as usize).min(h.saturating_sub(2)));
    let (fx, fy) = (u - x0 as f32, v - y0 as f32);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let top = plane[y0 * w + x0] * (1.0 - fx) + plane[y0 * w + x1] * fx;
    let bottom = plane[y1 * w + x0] * (1.0 - fx) + plane[y1 * w + x1] * fx;
    Some(top * (1.0 - fy) + bottom * fy)
}

/// What one candidate is scored with.
struct Pair<'a> {
    src: &'a Level,
    tgt: &'a Level,
    /// Centres in this level's pixels.
    sc: [f32; 2],
    tc: [f32; 2],
}

impl Pair<'_> {
    /// NCC over the source region `[x0, x1) × [y0, y1)` (level pixels) every `stride` pixels, for `scale` and an
    /// offset in level pixels; −1 when less than half of the region lands in the target or it has no structure.
    fn score(&self, scale: f32, t: [f32; 2], region: [usize; 4], stride: usize) -> f32 {
        let [x0, y0, x1, y1] = region;
        let (mut sa, mut sb, mut sab, mut saa, mut sbb) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
        let (mut n, mut seen) = (0usize, 0usize);
        for y in (y0..y1).step_by(stride) {
            let qy = self.tc[1] + scale * (y as f32 + 0.5 - self.sc[1]) + t[1];
            for x in (x0..x1).step_by(stride) {
                seen += 1;
                let qx = self.tc[0] + scale * (x as f32 + 0.5 - self.sc[0]) + t[0];
                let Some(b) = sample(&self.tgt.hp, self.tgt.w, self.tgt.h, qx, qy) else { continue };
                let a = self.src.hp[y * self.src.w + x];
                let (a, b) = (a as f64, b as f64);
                sa += a;
                sb += b;
                sab += a * b;
                saa += a * a;
                sbb += b * b;
                n += 1;
            }
        }
        if n < 16 || n * 2 < seen {
            return -1.0;
        }
        let nf = n as f64;
        let cov = sab - sa * sb / nf;
        let (va, vb) = (saa - sa * sa / nf, sbb - sb * sb / nf);
        if va <= 1e-9 * nf || vb <= 1e-9 * nf {
            return -1.0;
        }
        (cov / (va * vb).sqrt()) as f32
    }

    /// The best of a grid of scales and offsets (offsets in source working pixels, converted to this level).
    #[allow(clippy::too_many_arguments)]
    fn search(
        &self,
        scale: f32,
        offset: [f32; 2],
        s_span: f32,
        s_step: f32,
        t_span: f32,
        t_step: f32,
        region: [usize; 4],
        stride: usize,
    ) -> (f32, [f32; 2], f32) {
        let steps = |span: f32, step: f32| -> Vec<f32> {
            let k = (span / step).round() as i32;
            (-k..=k).map(|i| i as f32 * step).collect()
        };
        let scales = steps(s_span, s_step);
        let shifts = steps(t_span, t_step);
        let mut candidates = Vec::with_capacity(scales.len() * shifts.len() * shifts.len());
        for &ds in &scales {
            for &dy in &shifts {
                for &dx in &shifts {
                    candidates.push((scale + ds, [offset[0] + dx, offset[1] + dy]));
                }
            }
        }
        let f = self.src.factor;
        candidates
            .into_par_iter()
            .map(|(s, t)| (s, t, self.score(s, [t[0] / f, t[1] / f], region, stride)))
            .reduce(
                || (scale, offset, f32::MIN),
                |a, b| {
                    // Ties go to the smaller change, so a flat score never drifts.
                    let closer = (b.0 - scale).abs() + (b.1[0] - offset[0]).abs() + (b.1[1] - offset[1]).abs()
                        < (a.0 - scale).abs() + (a.1[0] - offset[0]).abs() + (a.1[1] - offset[1]).abs();
                    if b.2 > a.2 || (b.2 == a.2 && closer) {
                        b
                    } else {
                        a
                    }
                },
            )
    }
}

/// Line up `target` with `source` (both luma planes at about the same size). See the module docs.
pub fn align(source: &[f32], sw: usize, sh: usize, target: &[f32], tw: usize, th: usize) -> Alignment {
    align_with(source, sw, sh, target, tw, th, &|| false).expect("never cancelled")
}

/// [`align`], polling `cancelled` between passes and tiles (the error is [`super::CANCELLED`]).
pub fn align_with(
    source: &[f32],
    sw: usize,
    sh: usize,
    target: &[f32],
    tw: usize,
    th: usize,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> crate::error::Result<Alignment> {
    let stop = || -> crate::error::Result<()> {
        if cancelled() {
            Err(crate::error::Error::Invalid(super::CANCELLED.into()))
        } else {
            Ok(())
        }
    };
    let long = sw.max(sh);
    let coarse = long.div_ceil(COARSE_EDGE).max(1);
    let middle = coarse.div_ceil(3).max(1);
    let source_centre = [sw as f32 / 2.0, sh as f32 / 2.0];
    let target_centre = [tw as f32 / 2.0, th as f32 / 2.0];
    let mut scale = 1.0f32;
    let mut offset = [0.0f32; 2];
    let mut score = -1.0f32;
    // (factor, scale span, scale step, offset span, offset step, stride): the whole range on the coarse level, then
    // around the previous best; the last pass is sub-pixel.
    let plan = [
        (coarse, SCALE_SPAN, 0.005, OFFSET_SPAN * long as f32, coarse as f32, 1usize),
        (middle, 0.006, 0.002, 1.5 * coarse as f32, (middle as f32 / 2.0).max(0.5), 2),
        (1, 0.002, 0.001, (1.5 * middle as f32).max(1.0), 0.5, 3),
        (1, 0.0, 1.0, 0.5, 0.125, 2),
    ];
    let mut levels: Vec<(usize, Level, Level)> = Vec::new();
    for (i, &(factor, s_span, s_step, t_span, t_step, stride)) in plan.iter().enumerate() {
        if i == 1 && middle == coarse {
            continue;
        }
        stop()?;
        if !levels.iter().any(|(f, _, _)| *f == factor) {
            levels.push((factor, level(source, sw, sh, factor), level(target, tw, th, factor)));
        }
        let (_, src, tgt) = levels.iter().find(|(f, _, _)| *f == factor).expect("level just built");
        let f = src.factor;
        let sc = [source_centre[0] / f, source_centre[1] / f];
        let tc = [target_centre[0] / f, target_centre[1] / f];
        let pair = Pair { src, tgt, sc, tc };
        (scale, offset, score) = pair.search(scale, offset, s_span, s_step, t_span, t_step, [0, 0, src.w, src.h], stride);
    }
    let fine = levels.into_iter().find(|(f, _, _)| *f == 1).map(|(_, s, t)| (s, t));
    let mut alignment =
        Alignment { scale, offset, score, source_centre, target_centre, ..Alignment::default() };
    // Per-tile offsets on the working level, kept only where the tile has structure and lines up well.
    if let Some((src, tgt)) = fine {
        let grid = if sw >= sh { TILES } else { (TILES.1, TILES.0) };
        let tile_size = [sw as f32 / grid.0 as f32, sh as f32 / grid.1 as f32];
        let pair = Pair { src: &src, tgt: &tgt, sc: source_centre, tc: target_centre };
        let mut tiles: Vec<[f32; 2]> = Vec::with_capacity(grid.0 * grid.1);
        for k in 0..grid.0 * grid.1 {
            stop()?;
            tiles.push({
                let (tx, ty) = (k % grid.0, k / grid.0);
                let region = [
                    (tx as f32 * tile_size[0]) as usize,
                    (ty as f32 * tile_size[1]) as usize,
                    (((tx + 1) as f32 * tile_size[0]) as usize).min(sw),
                    (((ty + 1) as f32 * tile_size[1]) as usize).min(sh),
                ];
                let (_, t, s) = pair.search(scale, offset, 0.0, 1.0, TILE_SPAN, 0.25, region, 2);
                if s >= MIN_SCORE.max(score - 0.15) {
                    [t[0] - offset[0], t[1] - offset[1]]
                } else {
                    [0.0; 2]
                }
            });
        }
        alignment.grid = grid;
        alignment.tile_size = tile_size;
        alignment.tile_offsets = tiles;
    }
    Ok(alignment)
}
