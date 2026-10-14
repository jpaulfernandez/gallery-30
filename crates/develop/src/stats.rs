//! Photo stats for the cull (plan 38, CULL_PLAN 4.4 and 5): six technical numbers and a perceptual hash of a photo,
//! computed once on its 8-bit display-referred proxy (upright, long edge 1600 px) so grouping and the lenses are pure
//! functions over the folder index. Not render maths: nothing here touches the develop hash.
//!
//! - **Sharpness**: the Laplacian's variance per tile of a [`TILE_GRID`] × [`TILE_GRID`] grid, less the variance
//!   pixel noise alone gives it (`20 σ²` for the 4-neighbour Laplacian). `sharpness` is the mean over the tiles,
//!   `sharpness_max` the sharpest tile's (so a portrait with sharp eyes and a soft background is not soft) and
//!   `sharpest_tile` that tile's index, row-major. σ is the caller's when known, else estimated per tile with
//!   Immerkær's operator and taken from the lower quartile of the tiles (flat ones say the most about noise).
//! - **Motion**: structure-tensor anisotropy, `1 − λmin / λmax`, 0 to 1. Each textured tile's gradient tensor is
//!   normalised to unit trace and the tensors are summed, so the result is high only when most of the frame is
//!   streaked the same way (a pan), and is scaled down when fewer than half the tiles have texture.
//! - **Clipping**: `clip_high` is the share of pixels with any channel ≥ 250, `clip_low` of pixels with every
//!   channel ≤ 5; `median_lum` is the median Rec. 709 luma, 0 to 1.
//! - **phash**: the DCT perceptual hash (`image_hasher` Median + DCT, the pHash recipe: each of the 8 × 8 lowest
//!   frequencies of a 16 × 16 DCT against their median), 64 bits, compared by Hamming distance.
//!
//! - **palette** (plan 56): five colours of the photo as sRGB hex, most of the picture first: k-means in Oklab
//!   over the image box-averaged to [`PALETTE_EDGE`] px, seeded deterministically (k-means++ with a fixed seed), so
//!   a backfill of the same proxy gives the same five colours. The storytelling sorts (colour, warmth) read it.
//!
//! They rank and explain; they never decide (CULL_PLAN 4.4): thresholds live in the editor.

use serde::{Deserialize, Serialize};

/// Tiles per side of the sharpness grid; `sharpest_tile` is `row * TILE_GRID + column` over the upright proxy.
pub const TILE_GRID: usize = 8;

/// A channel value at or above this counts as clipped highlights.
pub const CLIP_HIGH: u8 = 250;
/// Every channel at or below this counts as crushed shadows.
pub const CLIP_LOW: u8 = 5;

/// The technical numbers of one photo (see the module notes). Rounded so the index stays small.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoStats {
    /// Mean noise-corrected Laplacian variance over the tiles (8-bit levels²).
    pub sharpness: f32,
    /// The sharpest tile's noise-corrected Laplacian variance.
    pub sharpness_max: f32,
    /// Index of the sharpest tile, `row * TILE_GRID + column`.
    pub sharpest_tile: u32,
    /// Structure-tensor anisotropy, 0 (isotropic) to 1 (every edge one way).
    pub motion: f32,
    /// Share of pixels with any channel ≥ [`CLIP_HIGH`].
    pub clip_high: f32,
    /// Share of pixels with every channel ≤ [`CLIP_LOW`].
    pub clip_low: f32,
    /// Median Rec. 709 luma, 0 to 1.
    pub median_lum: f32,
}

/// Rec. 709 luma of interleaved 8-bit RGB (integer weights 54, 183, 19 out of 256).
pub fn luma(rgb: &[u8]) -> Vec<u8> {
    rgb.chunks_exact(3)
        .map(|p| ((54 * p[0] as u32 + 183 * p[1] as u32 + 19 * p[2] as u32 + 128) >> 8) as u8)
        .collect()
}

/// Per-tile sums of one pass over the gray image.
#[derive(Default, Clone, Copy)]
struct Tile {
    n: u64,
    lap: i64,
    lap2: i64,
    /// Σ |Immerkær operator|.
    noise: i64,
    jxx: i64,
    jyy: i64,
    jxy: i64,
}

/// The stats of an upright 8-bit photo: `gray` is its luma ([`luma`]), `rgb` the interleaved pixels, `w` × `h`.
/// `sigma` is the noise σ in 8-bit levels of this image when known; `None` estimates it.
pub fn photo_stats(gray: &[u8], rgb: &[u8], w: u32, h: u32, sigma: Option<f32>) -> PhotoStats {
    let (w, h) = (w as usize, h as usize);
    assert_eq!(gray.len(), w * h, "gray is w × h");
    assert_eq!(rgb.len(), w * h * 3, "rgb is w × h × 3");
    let (clip_high, clip_low, median_lum) = levels(gray, rgb);
    let mut stats = PhotoStats { clip_high, clip_low, median_lum, ..PhotoStats::default() };
    if w < 3 || h < 3 {
        return stats;
    }
    let tiles = tile_sums(gray, w, h);

    // Immerkær: σ = sqrt(π / 2) / 6 · mean |N|.
    let tile_sigma = |t: &Tile| (std::f64::consts::FRAC_PI_2).sqrt() / 6.0 * t.noise as f64 / t.n.max(1) as f64;
    let sigma = match sigma {
        Some(s) => s as f64,
        None => {
            let mut sigmas: Vec<f64> = tiles.iter().filter(|t| t.n > 0).map(tile_sigma).collect();
            sigmas.sort_by(f64::total_cmp);
            sigmas.get(sigmas.len() / 4).copied().unwrap_or(0.0)
        }
    };
    let noise_var = sigma * sigma;

    // Sharpness.
    let corrected: Vec<f64> = tiles
        .iter()
        .map(|t| {
            if t.n == 0 {
                return 0.0;
            }
            let n = t.n as f64;
            let mean = t.lap as f64 / n;
            (t.lap2 as f64 / n - mean * mean - 20.0 * noise_var).max(0.0)
        })
        .collect();
    let (best, best_value) =
        corrected.iter().copied().enumerate().fold((0, 0.0), |acc, (i, v)| if v > acc.1 { (i, v) } else { acc });
    stats.sharpness = round(corrected.iter().sum::<f64>() / corrected.len() as f64, 100.0);
    stats.sharpness_max = round(best_value, 100.0);
    stats.sharpest_tile = best as u32;

    // Motion: central differences carry 2 σ² of noise per axis.
    let (mut sxx, mut syy, mut sxy, mut textured) = (0.0f64, 0.0f64, 0.0f64, 0usize);
    for t in tiles.iter().filter(|t| t.n > 0) {
        let n = t.n as f64;
        let xx = (t.jxx as f64 / n - 2.0 * noise_var).max(0.0);
        let yy = (t.jyy as f64 / n - 2.0 * noise_var).max(0.0);
        let xy = t.jxy as f64 / n;
        let trace = xx + yy;
        // A tile counts as textured above a gradient RMS of about 4 levels plus the noise's.
        if trace < 16.0 + 8.0 * noise_var {
            continue;
        }
        sxx += xx / trace;
        syy += yy / trace;
        sxy += xy / trace;
        textured += 1;
    }
    if textured > 0 {
        // λmax − λmin over λmax + λmin; then 1 − λmin / λmax = 2c / (1 + c).
        let coherence = ((sxx - syy).powi(2) + 4.0 * sxy * sxy).sqrt() / (sxx + syy);
        let anisotropy = 2.0 * coherence / (1.0 + coherence);
        let coverage = (textured as f64 / tiles.len() as f64 / 0.5).min(1.0);
        stats.motion = round((anisotropy * coverage).clamp(0.0, 1.0), 1000.0);
    }
    stats
}

fn round(v: f64, scale: f64) -> f32 {
    ((v * scale).round() / scale) as f32
}

/// Clip shares and the median luma.
fn levels(gray: &[u8], rgb: &[u8]) -> (f32, f32, f32) {
    let n = gray.len().max(1) as f64;
    let (mut high, mut low) = (0usize, 0usize);
    for p in rgb.chunks_exact(3) {
        let max = p[0].max(p[1]).max(p[2]);
        high += (max >= CLIP_HIGH) as usize;
        low += (max <= CLIP_LOW) as usize;
    }
    let mut histogram = [0usize; 256];
    for &g in gray {
        histogram[g as usize] += 1;
    }
    let half = gray.len().div_ceil(2);
    let mut seen = 0;
    let mut median = 0;
    for (v, &count) in histogram.iter().enumerate() {
        seen += count;
        if seen >= half {
            median = v;
            break;
        }
    }
    (round(high as f64 / n, 10_000.0), round(low as f64 / n, 10_000.0), round(median as f64 / 255.0, 10_000.0))
}

/// One pass over the interior pixels: Laplacian, Immerkær noise operator and gradient tensor, summed per tile.
fn tile_sums(gray: &[u8], w: usize, h: usize) -> Vec<Tile> {
    let mut tiles = vec![Tile::default(); TILE_GRID * TILE_GRID];
    let col_start = |tx: usize| (tx * w / TILE_GRID).max(1);
    let col_end = |tx: usize| ((tx + 1) * w / TILE_GRID).min(w - 1);
    for y in 1..h - 1 {
        let ty = y * TILE_GRID / h;
        let (up, row, down) = (&gray[(y - 1) * w..y * w], &gray[y * w..(y + 1) * w], &gray[(y + 1) * w..(y + 2) * w]);
        for tx in 0..TILE_GRID {
            let (x0, x1) = (col_start(tx), col_end(tx));
            if x0 >= x1 {
                continue;
            }
            let mut t = Tile::default();
            for x in x0..x1 {
                let c = row[x] as i32;
                let (l, r, u, d) = (row[x - 1] as i32, row[x + 1] as i32, up[x] as i32, down[x] as i32);
                let lap = l + r + u + d - 4 * c;
                // Immerkær's mask, [1 -2 1]ᵀ ⊗ [1 -2 1].
                let second = |line: &[u8]| line[x - 1] as i32 - 2 * line[x] as i32 + line[x + 1] as i32;
                let noise = second(up) - 2 * second(row) + second(down);
                let (gx, gy) = (r - l, d - u);
                t.lap += lap as i64;
                t.lap2 += (lap * lap) as i64;
                t.noise += noise.unsigned_abs() as i64;
                t.jxx += (gx * gx) as i64;
                t.jyy += (gy * gy) as i64;
                t.jxy += (gx * gy) as i64;
            }
            t.n = (x1 - x0) as u64;
            let acc = &mut tiles[ty * TILE_GRID + tx];
            acc.n += t.n;
            acc.lap += t.lap;
            acc.lap2 += t.lap2;
            acc.noise += t.noise;
            acc.jxx += t.jxx;
            acc.jyy += t.jyy;
            acc.jxy += t.jxy;
        }
    }
    tiles
}

/// Side of the box-averaged image the hash is taken from (`image_hasher` then resizes it to 16 × 16 for the DCT).
const HASH_INPUT: usize = 64;

/// The 64-bit DCT perceptual hash of a gray image `w` × `h` (any aspect ratio: it is squeezed to a square first).
/// Compare two with `(a ^ b).count_ones()`.
pub fn phash(gray: &[u8], w: u32, h: u32) -> u64 {
    let (w, h) = (w as usize, h as usize);
    assert_eq!(gray.len(), w * h, "gray is w × h");
    if w == 0 || h == 0 {
        return 0;
    }
    // Box average onto HASH_INPUT × HASH_INPUT, so the hasher's resize (its default Lanczos3 filter) works on 4 K
    // pixels, not 1.7 M.
    let mut sums = vec![0u64; HASH_INPUT * HASH_INPUT];
    let mut counts = vec![0u64; HASH_INPUT * HASH_INPUT];
    for y in 0..h {
        let by = y * HASH_INPUT / h;
        let row = &gray[y * w..(y + 1) * w];
        for (x, &v) in row.iter().enumerate() {
            let i = by * HASH_INPUT + x * HASH_INPUT / w;
            sums[i] += v as u64;
            counts[i] += 1;
        }
    }
    let small: Vec<u8> =
        sums.iter().zip(&counts).map(|(&s, &c)| (s + c / 2).checked_div(c).unwrap_or(0) as u8).collect();
    let image = image::GrayImage::from_raw(HASH_INPUT as u32, HASH_INPUT as u32, small).expect("sized buffer");
    let hasher = image_hasher::HasherConfig::with_bytes_type::<[u8; 8]>()
        .hash_alg(image_hasher::HashAlg::Median)
        .preproc_dct()
        .to_hasher();
    u64::from_be_bytes(*hasher.hash_image(&image).as_bytes().first_chunk::<8>().expect("8-byte hash"))
}

/// Long edge the palette is computed at (the thumbnail's size: colour needs no detail), px.
pub const PALETTE_EDGE: usize = 240;
/// Colours in a palette.
pub const PALETTE_SIZE: usize = 5;
/// Lloyd iterations at most (it usually settles in fewer).
const PALETTE_ITERATIONS: usize = 12;

/// sRGB 8-bit to linear light.
fn srgb_to_linear(c: u8) -> f32 {
    let c = c as f32 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear light to sRGB 8-bit.
fn linear_to_srgb(c: f32) -> u8 {
    let c = c.clamp(0.0, 1.0);
    let v = if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 };
    (v * 255.0).round().clamp(0.0, 255.0) as u8
}

/// Linear sRGB to Oklab (Björn Ottosson's matrices).
fn linear_to_oklab([r, g, b]: [f32; 3]) -> [f32; 3] {
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

/// Oklab to linear sRGB.
fn oklab_to_linear([l, a, b]: [f32; 3]) -> [f32; 3] {
    let l_ = (l + 0.396_337_78 * a + 0.215_803_76 * b).powi(3);
    let m_ = (l - 0.105_561_346 * a - 0.063_854_17 * b).powi(3);
    let s_ = (l - 0.089_484_18 * a - 1.291_485_5 * b).powi(3);
    [
        4.076_741_7 * l_ - 3.307_711_6 * m_ + 0.230_969_94 * s_,
        -1.268_438 * l_ + 2.609_757_4 * m_ - 0.341_319_38 * s_,
        -0.004_196_086_3 * l_ - 0.703_418_6 * m_ + 1.707_614_7 * s_,
    ]
}

fn dist2(a: &[f32; 3], b: &[f32; 3]) -> f32 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)
}

/// The five-colour palette of interleaved 8-bit sRGB `rgb`, `w` × `h` (see the module notes): `#rrggbb` strings,
/// the largest cluster first (ties by lightness, light first). A flat image gives five equal colours; an empty
/// one an empty list.
pub fn palette(rgb: &[u8], w: u32, h: u32) -> Vec<String> {
    let (w, h) = (w as usize, h as usize);
    assert_eq!(rgb.len(), w * h * 3, "rgb is w × h × 3");
    if w == 0 || h == 0 {
        return Vec::new();
    }
    // Box-average onto at most PALETTE_EDGE on the long edge, in linear light, then to Oklab.
    let scale = (PALETTE_EDGE as f32 / w.max(h) as f32).min(1.0);
    let (sw, sh) = (((w as f32 * scale).round() as usize).max(1), ((h as f32 * scale).round() as usize).max(1));
    let lut: Vec<f32> = (0..=255u8).map(srgb_to_linear).collect();
    let mut sums = vec![[0f32; 3]; sw * sh];
    let mut counts = vec![0u32; sw * sh];
    for y in 0..h {
        let row = (y * sh / h) * sw;
        for x in 0..w {
            let i = row + x * sw / w;
            let p = &rgb[(y * w + x) * 3..(y * w + x) * 3 + 3];
            for c in 0..3 {
                sums[i][c] += lut[p[c] as usize];
            }
            counts[i] += 1;
        }
    }
    let points: Vec<[f32; 3]> = sums
        .iter()
        .zip(&counts)
        .filter(|(_, &n)| n > 0)
        .map(|(s, &n)| linear_to_oklab([s[0] / n as f32, s[1] / n as f32, s[2] / n as f32]))
        .collect();

    // k-means++ seeding with a fixed xorshift seed: deterministic for the same pixels.
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut centres: Vec<[f32; 3]> = Vec::with_capacity(PALETTE_SIZE);
    centres.push(points[(next() * points.len() as f64) as usize % points.len()]);
    let mut nearest: Vec<f32> = points.iter().map(|p| dist2(p, &centres[0])).collect();
    while centres.len() < PALETTE_SIZE {
        let total: f64 = nearest.iter().map(|&d| d as f64).sum();
        let pick = if total > 0.0 {
            let mut target = next() * total;
            let mut at = points.len() - 1;
            for (i, &d) in nearest.iter().enumerate() {
                target -= d as f64;
                if target <= 0.0 {
                    at = i;
                    break;
                }
            }
            at
        } else {
            0
        };
        let c = points[pick];
        for (d, p) in nearest.iter_mut().zip(&points) {
            *d = d.min(dist2(p, &c));
        }
        centres.push(c);
    }

    // Lloyd's iterations.
    let mut labels = vec![0usize; points.len()];
    let mut sizes = [0usize; PALETTE_SIZE];
    for _ in 0..PALETTE_ITERATIONS {
        let mut moved = false;
        let mut acc = [[0f64; 3]; PALETTE_SIZE];
        sizes = [0; PALETTE_SIZE];
        for (p, label) in points.iter().zip(labels.iter_mut()) {
            let mut best = (0, f32::MAX);
            for (k, c) in centres.iter().enumerate() {
                let d = dist2(p, c);
                if d < best.1 {
                    best = (k, d);
                }
            }
            if *label != best.0 {
                *label = best.0;
                moved = true;
            }
            sizes[best.0] += 1;
            for c in 0..3 {
                acc[best.0][c] += p[c] as f64;
            }
        }
        for k in 0..PALETTE_SIZE {
            if sizes[k] > 0 {
                let n = sizes[k] as f64;
                centres[k] = [(acc[k][0] / n) as f32, (acc[k][1] / n) as f32, (acc[k][2] / n) as f32];
            }
        }
        if !moved {
            break;
        }
    }

    let mut order: Vec<usize> = (0..PALETTE_SIZE).collect();
    order.sort_by(|&a, &b| sizes[b].cmp(&sizes[a]).then(centres[b][0].total_cmp(&centres[a][0])));
    order
        .into_iter()
        .map(|k| {
            let [r, g, b] = oklab_to_linear(centres[k]);
            format!("#{:02x}{:02x}{:02x}", linear_to_srgb(r), linear_to_srgb(g), linear_to_srgb(b))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic textured gray image (sum of sines at many angles plus hashed noise), as RGB.
    fn texture(w: usize, h: usize) -> Vec<u8> {
        let mut rgb = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f32, y as f32);
                let mut v = 0.0;
                for k in 0..7 {
                    let a = k as f32 * 0.45;
                    v += ((fx * a.cos() + fy * a.sin()) * (0.3 + 0.11 * k as f32)).sin();
                }
                let g = (128.0 + v * 15.0).clamp(0.0, 255.0) as u8;
                rgb.extend_from_slice(&[g, g, g]);
            }
        }
        rgb
    }

    #[test]
    fn levels_count_clips_and_the_median() {
        let mut rgb = vec![128u8; 100 * 3];
        rgb[..3].copy_from_slice(&[255, 10, 10]); // any channel high
        rgb[3..6].copy_from_slice(&[0, 0, 5]); // every channel low
        rgb[6..9].copy_from_slice(&[0, 0, 6]); // not low
        let gray = luma(&rgb);
        let s = photo_stats(&gray, &rgb, 10, 10, Some(0.0));
        assert_eq!((s.clip_high, s.clip_low), (0.01, 0.01));
        assert!((s.median_lum - 128.0 / 255.0).abs() < 0.002, "{}", s.median_lum);
    }

    #[test]
    fn a_flat_image_has_no_sharpness_or_motion() {
        let rgb = vec![90u8; 64 * 48 * 3];
        let s = photo_stats(&luma(&rgb), &rgb, 64, 48, None);
        assert_eq!((s.sharpness, s.sharpness_max, s.motion), (0.0, 0.0, 0.0));
    }

    #[test]
    fn sharpest_tile_is_where_the_detail_is() {
        let (w, h) = (160, 120);
        let tex = texture(w, h);
        let mut rgb = vec![120u8; w * h * 3];
        // Texture only in the tile at column 5, row 2.
        for y in 2 * h / 8 + 1..3 * h / 8 - 1 {
            for x in 5 * w / 8 + 1..6 * w / 8 - 1 {
                let i = (y * w + x) * 3;
                rgb[i..i + 3].copy_from_slice(&tex[i..i + 3]);
            }
        }
        let s = photo_stats(&luma(&rgb), &rgb, w as u32, h as u32, None);
        assert_eq!(s.sharpest_tile, 2 * 8 + 5);
        assert!(s.sharpness_max > 4.0 * s.sharpness, "{s:?}");
    }

    #[test]
    fn phash_is_stable_under_small_changes_and_differs_across_scenes() {
        let (w, h) = (200, 150);
        // A low-frequency scene: a diagonal ramp and a bright disc off centre.
        let a: Vec<u8> = (0..w * h)
            .map(|i| {
                let (x, y) = ((i % w) as f32, (i / w) as f32);
                let disc = if (x - 60.0).powi(2) + (y - 50.0).powi(2) < 900.0 { 80.0 } else { 0.0 };
                (40.0 + x * 0.5 + y * 0.3 + disc) as u8
            })
            .collect();
        let brighter: Vec<u8> = a.iter().map(|&v| v.saturating_add(6)).collect();
        let mut flipped = a.clone();
        for row in flipped.chunks_exact_mut(w) {
            row.reverse();
        }
        let ha = phash(&a, w as u32, h as u32);
        assert!((ha ^ phash(&brighter, w as u32, h as u32)).count_ones() <= 4);
        assert!((ha ^ phash(&flipped, w as u32, h as u32)).count_ones() > 16);
        assert!((ha ^ phash(&luma(&texture(w, h)), w as u32, h as u32)).count_ones() > 16);
    }

    #[test]
    fn palette_finds_the_dominant_colours_in_order() {
        // Three quarters blue sky over a quarter of orange sand, at 400 × 300.
        let (w, h) = (400usize, 300usize);
        let mut rgb = Vec::with_capacity(w * h * 3);
        for y in 0..h {
            for _ in 0..w {
                rgb.extend_from_slice(if y < h * 3 / 4 { &[40, 90, 200] } else { &[230, 140, 40] });
            }
        }
        let p = palette(&rgb, w as u32, h as u32);
        assert_eq!(p.len(), PALETTE_SIZE);
        assert_eq!(p[0], "#285ac8", "{p:?}");
        assert!(p.contains(&"#e68c28".to_string()), "{p:?}");
        // Deterministic: the same pixels give the same palette.
        assert_eq!(p, palette(&rgb, w as u32, h as u32));
    }

    #[test]
    fn palette_of_a_flat_image_is_that_colour() {
        let rgb = vec![128u8; 30 * 20 * 3];
        assert_eq!(palette(&rgb, 30, 20), vec!["#808080".to_string(); PALETTE_SIZE]);
        assert!(palette(&[], 0, 0).is_empty());
    }

    #[test]
    fn oklab_round_trips() {
        for rgb in [[0u8, 0, 0], [255, 255, 255], [255, 0, 0], [12, 200, 77]] {
            let lab = linear_to_oklab(rgb.map(srgb_to_linear));
            assert_eq!(oklab_to_linear(lab).map(linear_to_srgb), rgb);
        }
    }
}
