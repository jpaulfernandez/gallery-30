//! Preview modes (plan 53, Cull's *Assist* overlays): focus peak and zebra, drawn over an 8-bit develop output.
//!
//! A preview mode is view-only. It runs after the develop output, on the 8-bit pixels the preview would show, and is
//! never part of [`crate::develop_hash`], the canonical settings, a cache key or a full render: the settings have no
//! field for it, and only the editor's `render_develop_preview` takes it, as an argument beside the settings.
//!
//! This CPU path is the reference; the GPU pass (`gpu::preview_mode`, `shaders/preview_mode.wgsl`) uses the same
//! integer maths and must match it exactly. [`apply_preview_mode`] picks the backend like a render does
//! ([`RenderOptions::backend`], `PHOTOBOOK_FORCE_CPU`).
//!
//! - **Focus peak**: the Rec. 709 luma of each pixel, `Y = (54 R + 183 G + 19 B + 128) >> 8`, and its 4-neighbour
//!   Laplacian `|4 Y - Y(left) - Y(right) - Y(up) - Y(down)|` (edges clamp); a pixel at or above [`PEAK_THRESHOLD`]
//!   is painted [`PEAK_COLOR`] (the brass accent) at [`PEAK_ALPHA`] percent.
//! - **Zebra**: diagonal stripes, [`ZEBRA_STRIPE`] px wide, over pixels with any channel at or above
//!   [`crate::stats::CLIP_HIGH`] (dark stripes running one way) and, dimmer, over pixels with every channel at or below
//!   [`crate::stats::CLIP_LOW`] (light stripes running the other way): the per-pixel form of plan 41's clip shares.
//! - Both at once ([`apply_preview_modes`]): each test reads the plain pixels; focus peak is painted first, then zebra
//!   over it, so neither mode sees the other's paint.

use rayon::prelude::*;

use crate::cpu::RenderOptions;
use crate::gpu;
use crate::image::Rgb8Image;
use crate::stats::{CLIP_HIGH, CLIP_LOW};

/// A view-only overlay on a preview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PreviewMode {
    FocusPeak,
    Zebra,
}

impl PreviewMode {
    /// The mode named `value` (`"focus-peak"`, `"zebra"`), as the editor sends it.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "focus-peak" => Some(Self::FocusPeak),
            "zebra" => Some(Self::Zebra),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::FocusPeak => "focus-peak",
            Self::Zebra => "zebra",
        }
    }

    /// The mode's bit in the flags the GPU pass reads.
    pub(crate) fn bit(self) -> u32 {
        match self {
            Self::FocusPeak => 1,
            Self::Zebra => 2,
        }
    }
}

/// Luma weights out of 256 (Rec. 709: 0.2126, 0.7152, 0.0722).
pub const LUMA_WEIGHTS: [u32; 3] = [54, 183, 19];
/// The 4-neighbour Laplacian of the luma (0..=1020) at or above which a pixel is an in-focus edge.
pub const PEAK_THRESHOLD: u32 = 64;
/// The accent, `oklch(0.80 0.11 80)` in sRGB.
pub const PEAK_COLOR: [u8; 3] = [227, 182, 103];
/// How much of the peak colour covers an edge pixel, percent.
pub const PEAK_ALPHA: u32 = 60;
/// Width of one zebra stripe, px (the period is twice this).
pub const ZEBRA_STRIPE: u32 = 4;
/// The highlight stripes: this colour at this percent.
pub const ZEBRA_HIGH_COLOR: [u8; 3] = [0, 0, 0];
pub const ZEBRA_HIGH_ALPHA: u32 = 70;
/// The shadow stripes (the dimmer set).
pub const ZEBRA_LOW_COLOR: [u8; 3] = [255, 255, 255];
pub const ZEBRA_LOW_ALPHA: u32 = 35;

#[inline]
fn mix(src: u8, color: u8, alpha: u32) -> u8 {
    ((src as u32 * (100 - alpha) + color as u32 * alpha + 50) / 100) as u8
}

#[inline]
fn paint(px: &mut [u8], color: [u8; 3], alpha: u32) {
    for c in 0..3 {
        px[c] = mix(px[c], color[c], alpha);
    }
}

#[inline]
fn luma(px: &[u8]) -> u32 {
    (LUMA_WEIGHTS[0] * px[0] as u32 + LUMA_WEIGHTS[1] * px[1] as u32 + LUMA_WEIGHTS[2] * px[2] as u32 + 128) >> 8
}

/// Whether pixel `(x, y)` lies on a highlight stripe (running down to the left).
#[inline]
pub(crate) fn high_stripe(x: u32, y: u32) -> bool {
    ((x + y) / ZEBRA_STRIPE) % 2 == 0
}

/// Whether pixel `(x, y)` of an image `height` tall lies on a shadow stripe (running down to the right).
#[inline]
pub(crate) fn low_stripe(x: u32, y: u32, height: u32) -> bool {
    ((x + height - 1 - y) / ZEBRA_STRIPE) % 2 == 0
}

/// The bit flags of `modes` (focus peak 1, zebra 2).
pub(crate) fn mode_bits(modes: &[PreviewMode]) -> u32 {
    modes.iter().fold(0, |bits, m| bits | m.bit())
}

/// `image` with `mode` drawn over it on the CPU (the reference).
pub fn apply_preview_mode_cpu(image: &Rgb8Image, mode: PreviewMode) -> Rgb8Image {
    apply_preview_modes_cpu(image, &[mode])
}

/// `image` with every mode of `modes` drawn over it on the CPU (the reference): each test reads the plain pixels, focus
/// peak is painted first and zebra over it. The order of `modes` does not matter.
pub fn apply_preview_modes_cpu(image: &Rgb8Image, modes: &[PreviewMode]) -> Rgb8Image {
    let (w, h) = (image.width as usize, image.height as usize);
    let mut out = image.data.clone();
    let bits = mode_bits(modes);
    if w == 0 || h == 0 || bits == 0 {
        return Rgb8Image::new(image.width, image.height, out);
    }
    let peak = bits & PreviewMode::FocusPeak.bit() != 0;
    let zebra = bits & PreviewMode::Zebra.bit() != 0;
    let lum: Vec<u32> = if peak { image.data.chunks_exact(3).map(luma).collect() } else { Vec::new() };
    out.par_chunks_mut(w * 3).enumerate().for_each(|(y, row)| {
        let up = y.saturating_sub(1);
        let down = (y + 1).min(h - 1);
        for x in 0..w {
            let px = &mut row[x * 3..x * 3 + 3];
            let plain = &image.data[(y * w + x) * 3..(y * w + x) * 3 + 3];
            if peak {
                let left = x.saturating_sub(1);
                let right = (x + 1).min(w - 1);
                let c = lum[y * w + x] as i32;
                let around = lum[y * w + left] + lum[y * w + right] + lum[up * w + x] + lum[down * w + x];
                if (4 * c - around as i32).unsigned_abs() >= PEAK_THRESHOLD {
                    paint(px, PEAK_COLOR, PEAK_ALPHA);
                }
            }
            if zebra {
                let max = plain[0].max(plain[1]).max(plain[2]);
                let (x, y) = (x as u32, y as u32);
                if max >= CLIP_HIGH {
                    if high_stripe(x, y) {
                        paint(px, ZEBRA_HIGH_COLOR, ZEBRA_HIGH_ALPHA);
                    }
                } else if max <= CLIP_LOW && low_stripe(x, y, image.height) {
                    paint(px, ZEBRA_LOW_COLOR, ZEBRA_LOW_ALPHA);
                }
            }
        }
    });
    Rgb8Image::new(image.width, image.height, out)
}

/// `image` with `mode` drawn over it: on the GPU when `options` gets one (as a render does), else on the CPU. Any GPU
/// error falls back to the CPU, with the same pixels.
pub fn apply_preview_mode(image: &Rgb8Image, mode: PreviewMode, options: &RenderOptions) -> Rgb8Image {
    apply_preview_modes(image, &[mode], options)
}

/// [`apply_preview_modes_cpu`] on the GPU when `options` gets one, else on the CPU (also on any GPU error).
pub fn apply_preview_modes(image: &Rgb8Image, modes: &[PreviewMode], options: &RenderOptions) -> Rgb8Image {
    if modes.is_empty() {
        return image.clone();
    }
    if let Some(out) = gpu::context_for(options).and_then(|ctx| gpu::preview_modes(ctx, image, modes)) {
        return out;
    }
    apply_preview_modes_cpu(image, modes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(w: u32, h: u32, rgb: [u8; 3]) -> Rgb8Image {
        Rgb8Image::new(w, h, rgb.repeat((w * h) as usize))
    }

    #[test]
    fn names_round_trip() {
        for mode in [PreviewMode::FocusPeak, PreviewMode::Zebra] {
            assert_eq!(PreviewMode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(PreviewMode::parse("none"), None);
    }

    #[test]
    fn focus_peak_marks_an_edge_and_leaves_flat_areas() {
        // Left half black, right half white: the two columns at the step are edges.
        let (w, h) = (8u32, 4u32);
        let mut img = flat(w, h, [0, 0, 0]);
        for y in 0..h {
            for x in w / 2..w {
                let i = ((y * w + x) * 3) as usize;
                img.data[i..i + 3].copy_from_slice(&[255, 255, 255]);
            }
        }
        let out = apply_preview_mode_cpu(&img, PreviewMode::FocusPeak);
        let at = |x: u32, y: u32| {
            let i = ((y * w + x) * 3) as usize;
            [out.data[i], out.data[i + 1], out.data[i + 2]]
        };
        assert_eq!(at(0, 1), [0, 0, 0]);
        assert_eq!(at(7, 1), [255, 255, 255]);
        assert_eq!(at(3, 1), [mix(0, 227, 60), mix(0, 182, 60), mix(0, 103, 60)]);
        assert_eq!(at(4, 1), [mix(255, 227, 60), mix(255, 182, 60), mix(255, 103, 60)]);
        // A flat image has no edge.
        let grey = flat(5, 5, [120, 130, 140]);
        assert_eq!(apply_preview_mode_cpu(&grey, PreviewMode::FocusPeak), grey);
    }

    #[test]
    fn zebra_stripes_only_clipped_pixels() {
        let mid = flat(16, 16, [128, 128, 128]);
        assert_eq!(apply_preview_mode_cpu(&mid, PreviewMode::Zebra), mid);
        let white = flat(16, 16, [255, 250, 10]);
        let out = apply_preview_mode_cpu(&white, PreviewMode::Zebra);
        let changed = out.data.chunks_exact(3).filter(|p| p[0] != 255).count();
        assert_eq!(changed, 128, "half the pixels are on a stripe");
        assert_eq!(&out.data[..3], &[mix(255, 0, 70), mix(250, 0, 70), mix(10, 0, 70)]);
        let black = flat(16, 16, [5, 0, 3]);
        let out = apply_preview_mode_cpu(&black, PreviewMode::Zebra);
        assert_eq!(out.data.chunks_exact(3).filter(|p| p[0] != 5).count(), 128);
        assert!(out.data.chunks_exact(3).all(|p| p[0] == 5 || p[0] == mix(5, 255, 35)));
        // A dark pixel with one channel above the low clip is not striped.
        let shadow = flat(4, 4, [6, 0, 0]);
        assert_eq!(apply_preview_mode_cpu(&shadow, PreviewMode::Zebra), shadow);
    }

    #[test]
    fn both_modes_test_the_plain_pixels() {
        // A white block on black: its edge pixels are peaked and also clipped; zebra decides on the plain pixel, so a
        // peaked white pixel on a stripe is striped over the peak colour.
        let (w, h) = (8u32, 8u32);
        let mut img = flat(w, h, [0, 0, 0]);
        for y in 0..h {
            for x in 4..w {
                let i = ((y * w + x) * 3) as usize;
                img.data[i..i + 3].copy_from_slice(&[255, 255, 255]);
            }
        }
        let both = apply_preview_modes_cpu(&img, &[PreviewMode::Zebra, PreviewMode::FocusPeak]);
        let (x, y) = (4u32, 4u32);
        assert!(high_stripe(x, y));
        let i = ((y * w + x) * 3) as usize;
        let peaked = mix(255, PEAK_COLOR[0], PEAK_ALPHA);
        assert_eq!(both.data[i], mix(peaked, ZEBRA_HIGH_COLOR[0], ZEBRA_HIGH_ALPHA));
        assert_eq!(apply_preview_modes_cpu(&img, &[]), img);
    }

    #[test]
    fn an_empty_image_stays_empty() {
        let empty = Rgb8Image::new(0, 0, Vec::new());
        assert_eq!(apply_preview_mode_cpu(&empty, PreviewMode::FocusPeak), empty);
    }
}
