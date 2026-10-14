//! Tiled inference for fixed-shape image models (D5.1): the tile grid over a reflect-padded image, tile extraction
//! and the overlap blend.
//!
//! - [`tile_plan`] pads the image (reflection, conceptually: nothing is copied) to at least one tile and to a multiple
//!   of the model's stride, then lays square tiles of the model's size over it. Tiles overlap by at least `overlap`
//!   pixels; the leftover is spread evenly, so every seam gets about the same overlap and the last tile ends exactly
//!   at the padded edge.
//! - [`Blender`] accumulates the model's outputs with a separable raised-cosine window (chaiNNer's crossfade is the
//!   reference idea): inside a tile the weight is 1, and over the `overlap` pixels next to a neighbouring tile it
//!   rises as `½ − ½·cos(π·(i + ½)/overlap)`. Sides on the padded image's border get no ramp. Each pixel is divided by
//!   its accumulated weight, so overlaps of any width blend to a partition of unity. Accumulation is `f64` and only a
//!   band of one tile row is held, so a constant comes back exactly and memory stays at one tile row.
//! - [`blend_tiles`] is the all-at-once form (tests, small images).
//!
//! Planes are channel-major (`CHW`, what NCHW models take and return); images are interleaved RGB.

/// One tile, in padded-image coordinates (`x`, `y` may be past the image: those pixels are reflected).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tile {
    pub x: usize,
    pub y: usize,
    /// Always the plan's tile size.
    pub size: usize,
}

/// The tile grid of an image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TilePlan {
    /// The image's size.
    pub width: usize,
    pub height: usize,
    /// The padded size: at least `tile`, a multiple of `multiple`. The image sits at the top-left; the padding on
    /// the right and bottom is the image reflected about its last row/column.
    pub padded_width: usize,
    pub padded_height: usize,
    pub tile: usize,
    pub overlap: usize,
    /// Row-major (all tiles of the first row, then the next row).
    pub tiles: Vec<Tile>,
}

/// Lay `tile`-sized tiles overlapping by at least `overlap` over a `w × h` image reflect-padded to a multiple of
/// `multiple` (and to at least one tile). Panics if `tile` is not a positive multiple of `multiple` or `overlap` is
/// not below half a tile.
pub fn tile_plan(w: usize, h: usize, tile: usize, overlap: usize, multiple: usize) -> TilePlan {
    assert!(tile > 0 && multiple > 0 && tile % multiple == 0, "tile {tile} must be a multiple of {multiple}");
    assert!(overlap * 2 < tile, "overlap {overlap} must be under half the tile {tile}");
    assert!(w > 0 && h > 0, "empty image");
    let pad = |n: usize| n.div_ceil(multiple).max(1) * multiple;
    let (padded_width, padded_height) = (pad(w).max(tile), pad(h).max(tile));
    let xs = positions(padded_width, tile, overlap);
    let ys = positions(padded_height, tile, overlap);
    let tiles = ys.iter().flat_map(|&y| xs.iter().map(move |&x| Tile { x, y, size: tile })).collect();
    TilePlan { width: w, height: h, padded_width, padded_height, tile, overlap, tiles }
}

/// Tile origins along one axis of `len ≥ tile`: the first at 0, the last at `len − tile`, evenly spaced with a
/// stride of at most `tile − overlap`.
fn positions(len: usize, tile: usize, overlap: usize) -> Vec<usize> {
    if len <= tile {
        return vec![0];
    }
    let span = len - tile;
    let stride = tile - overlap;
    let n = span.div_ceil(stride) + 1;
    (0..n).map(|i| ((i * span) as f64 / (n - 1) as f64).round() as usize).collect()
}

/// Reflect a padded coordinate into `0..n` (mirror about the edge pixel, `… 2 1 0 1 2 …`; period `2(n − 1)`).
#[inline]
pub fn reflect(i: usize, n: usize) -> usize {
    if n <= 1 {
        return 0;
    }
    let period = 2 * (n - 1);
    let m = i % period;
    if m < n {
        m
    } else {
        period - m
    }
}

impl TilePlan {
    /// The tile's pixels as a `3 × tile × tile` plane, read from the interleaved RGB `image` (this plan's size)
    /// through `map` (per pixel), reflected where the tile reaches into the padding.
    pub fn extract(&self, image: &[f32], tile: &Tile, map: impl Fn([f32; 3]) -> [f32; 3] + Sync) -> Vec<f32> {
        use rayon::prelude::*;
        assert_eq!(image.len(), self.width * self.height * 3, "image size does not match the plan");
        let n = tile.size;
        let mut out = vec![0.0f32; 3 * n * n];
        let (r_plane, rest) = out.split_at_mut(n * n);
        let (g_plane, b_plane) = rest.split_at_mut(n * n);
        r_plane
            .par_chunks_mut(n)
            .zip(g_plane.par_chunks_mut(n))
            .zip(b_plane.par_chunks_mut(n))
            .enumerate()
            .for_each(|(ty, ((r, g), b))| {
                let sy = reflect(tile.y + ty, self.height);
                let row = &image[sy * self.width * 3..(sy + 1) * self.width * 3];
                for tx in 0..n {
                    let sx = reflect(tile.x + tx, self.width);
                    let [pr, pg, pb] = map([row[sx * 3], row[sx * 3 + 1], row[sx * 3 + 2]]);
                    r[tx] = pr;
                    g[tx] = pg;
                    b[tx] = pb;
                }
            });
        out
    }

    /// The blend window of `tile` along one axis: ramps only on sides that have a neighbour.
    fn window(&self, origin: usize, padded: usize) -> Vec<f64> {
        let n = self.tile;
        let ramp = |i: usize| 0.5 - 0.5 * (std::f64::consts::PI * (i as f64 + 0.5) / self.overlap as f64).cos();
        (0..n)
            .map(|i| {
                let mut w = 1.0;
                if self.overlap > 0 && origin > 0 && i < self.overlap {
                    w *= ramp(i);
                }
                if self.overlap > 0 && origin + n < padded && i >= n - self.overlap {
                    w *= ramp(n - 1 - i);
                }
                w
            })
            .collect()
    }
}

/// Accumulates tile outputs into the (unpadded) image, one band of tile rows at a time. Feed tiles in plan order.
pub struct Blender<'a> {
    plan: &'a TilePlan,
    /// Interleaved RGB output, `width × height × 3`.
    out: Vec<f32>,
    /// Weighted sums and weights for padded rows `base..base + rows`, padded width wide.
    acc: Vec<f64>,
    weight: Vec<f64>,
    base: usize,
    next: usize,
}

impl<'a> Blender<'a> {
    pub fn new(plan: &'a TilePlan) -> Self {
        let rows = plan.tile.min(plan.padded_height);
        Self {
            plan,
            out: vec![0.0; plan.width * plan.height * 3],
            acc: vec![0.0; rows * plan.padded_width * 3],
            weight: vec![0.0; rows * plan.padded_width],
            base: 0,
            next: 0,
        }
    }

    /// Add the model's output for tile `index` (the next one in plan order): a `3 × tile × tile` plane.
    pub fn add(&mut self, index: usize, output: &[f32]) {
        assert_eq!(index, self.next, "tiles must be added in plan order");
        self.next += 1;
        let plan = self.plan;
        let tile = plan.tiles[index];
        let n = tile.size;
        assert_eq!(output.len(), 3 * n * n, "tile output has the wrong size");
        if tile.y > self.base {
            self.flush(tile.y);
        }
        let wx = plan.window(tile.x, plan.padded_width);
        let wy = plan.window(tile.y, plan.padded_height);
        let pw = plan.padded_width;
        for (ty, &wyv) in wy.iter().enumerate() {
            let row = tile.y + ty - self.base;
            for (tx, &wxv) in wx.iter().enumerate() {
                let w = wyv * wxv;
                let p = row * pw + tile.x + tx;
                self.weight[p] += w;
                for c in 0..3 {
                    self.acc[p * 3 + c] += w * output[c * n * n + ty * n + tx] as f64;
                }
            }
        }
    }

    /// Write out padded rows `base..upto` (no later tile touches them) and slide the band down.
    fn flush(&mut self, upto: usize) {
        let plan = self.plan;
        let pw = plan.padded_width;
        let cap = self.weight.len() / pw;
        let rows = upto - self.base;
        assert!(rows <= cap, "tile rows must overlap");
        for r in 0..rows {
            let y = self.base + r;
            if y >= plan.height {
                continue;
            }
            for x in 0..plan.width {
                let p = r * pw + x;
                let w = self.weight[p];
                let o = (y * plan.width + x) * 3;
                for c in 0..3 {
                    self.out[o + c] = if w > 0.0 { (self.acc[p * 3 + c] / w) as f32 } else { 0.0 };
                }
            }
        }
        let keep = cap - rows;
        self.acc.copy_within(rows * pw * 3.., 0);
        self.weight.copy_within(rows * pw.., 0);
        self.acc[keep * pw * 3..].fill(0.0);
        self.weight[keep * pw..].fill(0.0);
        self.base = upto;
    }

    /// The blended image, interleaved RGB at the plan's (unpadded) size. Panics if tiles are missing.
    pub fn finish(mut self) -> Vec<f32> {
        assert_eq!(self.next, self.plan.tiles.len(), "not every tile was added");
        let end = self.base + self.weight.len() / self.plan.padded_width;
        self.flush(end);
        self.out
    }
}

/// Blend every tile's output (`3 × tile × tile` planes, in plan order) into an interleaved RGB image.
pub fn blend_tiles(outputs: &[Vec<f32>], plan: &TilePlan) -> Vec<f32> {
    let mut blender = Blender::new(plan);
    for (i, out) in outputs.iter().enumerate() {
        blender.add(i, out);
    }
    blender.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_cover_the_padded_image_with_enough_overlap() {
        let plan = tile_plan(1000, 300, 512, 48, 16);
        assert_eq!((plan.padded_width, plan.padded_height), (1008, 512));
        let xs: Vec<usize> = plan.tiles.iter().filter(|t| t.y == 0).map(|t| t.x).collect();
        // Two tiles would overlap by only 16 px: three, evenly spread.
        assert_eq!(xs, vec![0, 248, 496]);
        assert_eq!(plan.tiles.len(), 3);
        let big = tile_plan(6000, 4000, 512, 48, 16);
        let xs: Vec<usize> = big.tiles.iter().filter(|t| t.y == 0).map(|t| t.x).collect();
        assert_eq!(*xs.last().unwrap() + 512, big.padded_width);
        for pair in xs.windows(2) {
            assert!(pair[0] + 512 - pair[1] >= 48, "{pair:?}");
        }
        assert_eq!(tile_plan(512, 512, 512, 48, 16).tiles.len(), 1);
        assert_eq!(tile_plan(10, 7, 512, 48, 16).tiles, vec![Tile { x: 0, y: 0, size: 512 }]);
    }

    #[test]
    fn reflects_about_the_edge_pixel() {
        assert_eq!((0..8).map(|i| reflect(i, 4)).collect::<Vec<_>>(), vec![0, 1, 2, 3, 2, 1, 0, 1]);
        assert_eq!(reflect(5, 1), 0);
    }
}
