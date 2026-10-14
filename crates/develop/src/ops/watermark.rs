//! Export watermark and border (workflow plan 12), composited on the final, resized export pixels.
//!
//! Both work on the encoded output values (sRGB transfer, the output profile's primaries) of an 8-bit or a 16-bit
//! frame ([`Sample`]), the way an overlay is laid over a photo in an editor: `out = out · (1 − a) + colour · a`.
//!
//! - Text is set in one of the shared book fonts (`packages/shared/fonts`, WOFF2 unpacked with `wuff` and rasterised
//!   with `ab_glyph`), one line, its em size a fraction of the photo's long edge.
//! - An image (a PNG with alpha) is scaled so its long edge is that fraction (Lanczos3, alpha premultiplied).
//! - Nine positions (corners, edge middles, centre), inset by a margin that is a fraction of the long edge; opacity
//!   multiplies the coverage or the PNG's alpha.
//! - The border adds a solid frame of `border` pixels around the photo ([`add_border`]).

use std::sync::{Arc, Mutex, OnceLock};

use ab_glyph::{point, Font, FontVec, PxScale, ScaleFont};

use crate::error::{Error, Result};

/// A sample of an export frame: 8 or 16 bits, encoded 0..1.
pub trait Sample: Copy + Send + Sync + 'static {
    fn to_unit(self) -> f32;
    fn from_unit(v: f32) -> Self;
}

impl Sample for u8 {
    #[inline]
    fn to_unit(self) -> f32 {
        self as f32 / 255.0
    }
    #[inline]
    fn from_unit(v: f32) -> Self {
        (v * 255.0 + 0.5).clamp(0.0, 255.0) as u8
    }
}

impl Sample for u16 {
    #[inline]
    fn to_unit(self) -> f32 {
        self as f32 / 65535.0
    }
    #[inline]
    fn from_unit(v: f32) -> Self {
        (v * 65535.0 + 0.5).clamp(0.0, 65535.0) as u16
    }
}

/// The shared fonts a text watermark can use (`WATERMARK_FONTS` in `packages/shared/src/export.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WatermarkFace {
    Inter,
    Fraunces,
    InstrumentSerif,
    JetBrainsMono,
}

const INTER: &[u8] = include_bytes!("../../../../packages/shared/fonts/inter-variable.woff2");
const FRAUNCES: &[u8] = include_bytes!("../../../../packages/shared/fonts/fraunces-variable.woff2");
const INSTRUMENT_SERIF: &[u8] = include_bytes!("../../../../packages/shared/fonts/instrument-serif-regular.woff2");
const JETBRAINS_MONO: &[u8] = include_bytes!("../../../../packages/shared/fonts/jetbrains-mono-variable.woff2");

/// The face unpacked once (WOFF2 → TrueType) and parsed.
fn font(face: WatermarkFace) -> Result<&'static FontVec> {
    static FONTS: [OnceLock<Option<FontVec>>; 4] = [OnceLock::new(), OnceLock::new(), OnceLock::new(), OnceLock::new()];
    let (slot, woff2) = match face {
        WatermarkFace::Inter => (0, INTER),
        WatermarkFace::Fraunces => (1, FRAUNCES),
        WatermarkFace::InstrumentSerif => (2, INSTRUMENT_SERIF),
        WatermarkFace::JetBrainsMono => (3, JETBRAINS_MONO),
    };
    FONTS[slot]
        .get_or_init(|| {
            let ttf = wuff::decompress_woff2(woff2).ok()?;
            FontVec::try_from_vec(ttf).ok()
        })
        .as_ref()
        .ok_or_else(|| Error::Invalid(format!("the watermark font {face:?} could not be read")))
}

/// Where the watermark sits (`WATERMARK_POSITIONS` in TS).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Anchor {
    TopLeft,
    Top,
    TopRight,
    Left,
    Center,
    Right,
    BottomLeft,
    Bottom,
    BottomRight,
}

impl Anchor {
    /// Horizontal and vertical alignment, 0 (start), 0.5 (middle) or 1 (end).
    fn align(self) -> (f32, f32) {
        match self {
            Anchor::TopLeft => (0.0, 0.0),
            Anchor::Top => (0.5, 0.0),
            Anchor::TopRight => (1.0, 0.0),
            Anchor::Left => (0.0, 0.5),
            Anchor::Center => (0.5, 0.5),
            Anchor::Right => (1.0, 0.5),
            Anchor::BottomLeft => (0.0, 1.0),
            Anchor::Bottom => (0.5, 1.0),
            Anchor::BottomRight => (1.0, 1.0),
        }
    }
}

/// An overlay: premultiplied colour (encoded 0..1) and coverage per pixel, `width × height`.
#[derive(Debug, Clone, PartialEq)]
pub struct Overlay {
    pub width: u32,
    pub height: u32,
    /// `width * height` RGBA, colour premultiplied by alpha.
    pub rgba: Vec<[f32; 4]>,
}

/// The advance width of `text` (one line) at an em size of `px`, with the font's `kern` table pairs.
fn line_width(font: &FontVec, text: &str, px: f32) -> f32 {
    let scaled = font.as_scaled(PxScale::from(px));
    let mut caret = 0.0f32;
    let mut last = None;
    for c in text.chars().filter(|c| !c.is_control()) {
        let id = scaled.glyph_id(c);
        if let Some(prev) = last {
            caret += scaled.kern(prev, id);
        }
        caret += scaled.h_advance(id);
        last = Some(id);
    }
    caret
}

/// `text` in `face` at an em size of `px` pixels, in `colour` (encoded 0..1): one line. Pairs are kerned only from a
/// legacy `kern` table, which is all `ab_glyph` reads (Inter and the other shared fonts kern through GPOS, so their
/// text is set unkerned). The line never exceeds `max_w × max_h` (the photo less its margins): a longer line is set
/// smaller until it fits, so the overlay stays within the photo's size. `None` for empty or blank text.
pub fn text_overlay(
    text: &str,
    face: WatermarkFace,
    px: f32,
    colour: [f32; 3],
    max_w: u32,
    max_h: u32,
) -> Result<Option<Overlay>> {
    let text = text.trim();
    if text.is_empty() || !(px >= 1.0) || max_w == 0 || max_h == 0 {
        return Ok(None);
    }
    let font = font(face)?;
    // Shrink to fit: width scales linearly with the em size; the line's height is ascent − descent.
    let mut px = px;
    let natural = line_width(font, text, px);
    if natural > max_w as f32 {
        px *= max_w as f32 / natural * 0.999;
    }
    let tall = {
        let s = font.as_scaled(PxScale::from(px));
        s.ascent() - s.descent()
    };
    if tall > max_h as f32 {
        px *= max_h as f32 / tall * 0.999;
    }
    if !(px >= 1.0) {
        return Ok(None);
    }
    let scaled = font.as_scaled(PxScale::from(px));
    let ascent = scaled.ascent();
    let height = ((ascent - scaled.descent()).ceil().max(1.0) as u32).min(max_h);
    // Lay out on the baseline at `ascent`, then rasterise each glyph into a coverage mask.
    let mut caret = 0.0f32;
    let mut glyphs = Vec::new();
    let mut last = None;
    for c in text.chars().filter(|c| !c.is_control()) {
        let id = scaled.glyph_id(c);
        if let Some(prev) = last {
            caret += scaled.kern(prev, id);
        }
        if caret >= max_w as f32 {
            break;
        }
        glyphs.push(id.with_scale_and_position(scaled.scale(), point(caret, ascent)));
        caret += scaled.h_advance(id);
        last = Some(id);
    }
    let width = (caret.ceil().max(1.0) as u32).min(max_w);
    let mut coverage = vec![0.0f32; width as usize * height as usize];
    for glyph in glyphs {
        let Some(outline) = font.outline_glyph(glyph) else { continue };
        let bounds = outline.px_bounds();
        outline.draw(|x, y, c| {
            let (px_x, px_y) = (bounds.min.x as i64 + x as i64, bounds.min.y as i64 + y as i64);
            if px_x >= 0 && px_y >= 0 && (px_x as u32) < width && (px_y as u32) < height {
                let i = px_y as usize * width as usize + px_x as usize;
                coverage[i] = (coverage[i] + c).min(1.0);
            }
        });
    }
    let rgba = coverage.into_iter().map(|a| [colour[0] * a, colour[1] * a, colour[2] * a, a]).collect();
    Ok(Some(Overlay { width, height, rgba }))
}

/// The decoded watermark PNGs and their scaled overlays, kept across the jobs of an export run (every photo of a run
/// shares one image and, at one long edge, one overlay). Small, newest last.
static DECODED: Mutex<Vec<(String, Arc<image::RgbaImage>)>> = Mutex::new(Vec::new());
static SCALED: Mutex<Vec<((String, u32, u32, u32), Arc<Overlay>)>> = Mutex::new(Vec::new());
const DECODED_KEEP: usize = 2;
const SCALED_KEEP: usize = 8;

fn remember<K: PartialEq + Clone, V: Clone>(cache: &Mutex<Vec<(K, V)>>, key: K, keep: usize, make: impl FnOnce() -> Result<V>) -> Result<V> {
    if let Some((_, v)) = cache.lock().ok().and_then(|c| c.iter().find(|(k, _)| *k == key).cloned()) {
        return Ok(v);
    }
    let value = make()?;
    if let Ok(mut c) = cache.lock() {
        c.retain(|(k, _)| *k != key);
        c.push((key, value.clone()));
        let excess = c.len().saturating_sub(keep);
        c.drain(..excess);
    }
    Ok(value)
}

/// [`image_overlay`] through a small cache keyed by `key` (the PNG's content hash) and the target size: an export
/// run decodes its watermark once, and scales it once per distinct photo size.
pub fn image_overlay_cached(key: &str, png: &[u8], long_edge: u32, max_w: u32, max_h: u32) -> Result<Arc<Overlay>> {
    let decoded = remember(&DECODED, key.to_string(), DECODED_KEEP, || decode_png(png).map(Arc::new))?;
    remember(&SCALED, (key.to_string(), long_edge, max_w, max_h), SCALED_KEEP, || {
        scale_overlay(&decoded, long_edge, max_w, max_h).map(Arc::new)
    })
}

fn decode_png(png: &[u8]) -> Result<image::RgbaImage> {
    let decoded = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|err| Error::Invalid(format!("the watermark image is not a readable PNG: {err}")))?
        .to_rgba8();
    if decoded.width() == 0 || decoded.height() == 0 {
        return Err(Error::Invalid("the watermark image is empty".into()));
    }
    Ok(decoded)
}

/// A PNG (any bit depth and colour type the `png` codec reads; sRGB assumed) scaled so its long edge is `long_edge`
/// pixels (never below 1), and smaller if needed to fit `max_w × max_h` (the photo less its margins).
pub fn image_overlay(png: &[u8], long_edge: u32, max_w: u32, max_h: u32) -> Result<Overlay> {
    scale_overlay(&decode_png(png)?, long_edge, max_w, max_h)
}

fn scale_overlay(decoded: &image::RgbaImage, long_edge: u32, max_w: u32, max_h: u32) -> Result<Overlay> {
    let (w, h) = decoded.dimensions();
    let edge = long_edge.max(1) as f64;
    let scale = (edge / w.max(h) as f64).min(max_w.max(1) as f64 / w as f64).min(max_h.max(1) as f64 / h as f64);
    let tw = ((w as f64 * scale).round() as u32).clamp(1, max_w.max(1));
    let th = ((h as f64 * scale).round() as u32).clamp(1, max_h.max(1));
    let pixel = fast_image_resize::PixelType::U8x4;
    let raw = decoded.as_raw();
    let resized;
    let data: &[u8] = if (tw, th) == (w, h) {
        raw
    } else {
        let src = fast_image_resize::images::ImageRef::new(w, h, raw, pixel).map_err(|e| Error::Resize(e.to_string()))?;
        let mut dst = fast_image_resize::images::Image::new(tw, th, pixel);
        // Alpha is premultiplied for the filter and divided out again (`ResizeOptions` default).
        let options = fast_image_resize::ResizeOptions::new()
            .resize_alg(fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Lanczos3));
        fast_image_resize::Resizer::new().resize(&src, &mut dst, &options)?;
        resized = dst.into_vec();
        &resized
    };
    let rgba = data
        .chunks_exact(4)
        .map(|p| {
            let a = p[3] as f32 / 255.0;
            [p[0] as f32 / 255.0 * a, p[1] as f32 / 255.0 * a, p[2] as f32 / 255.0 * a, a]
        })
        .collect();
    Ok(Overlay { width: tw, height: th, rgba })
}

/// The top-left corner of an `ow × oh` overlay anchored in a `w × h` image with `margin` pixels of inset.
pub fn place(w: u32, h: u32, ow: u32, oh: u32, anchor: Anchor, margin: u32) -> (i64, i64) {
    let (ax, ay) = anchor.align();
    let span = |size: u32, o: u32, a: f32| -> i64 {
        let free = size as f32 - o as f32 - 2.0 * margin as f32;
        (margin as f32 + free * a).round() as i64
    };
    (span(w, ow, ax), span(h, oh, ay))
}

/// Lay `overlay` over the interleaved RGB `data` (`w × h`) at `(x0, y0)`, its alpha times `opacity`; parts outside
/// the image are clipped.
pub fn composite<T: Sample>(data: &mut [T], w: u32, h: u32, overlay: &Overlay, x0: i64, y0: i64, opacity: f32) {
    let opacity = opacity.clamp(0.0, 1.0);
    if opacity <= 0.0 {
        return;
    }
    for oy in 0..overlay.height as i64 {
        let y = y0 + oy;
        if y < 0 || y >= h as i64 {
            continue;
        }
        for ox in 0..overlay.width as i64 {
            let x = x0 + ox;
            if x < 0 || x >= w as i64 {
                continue;
            }
            let [r, g, b, a] = overlay.rgba[oy as usize * overlay.width as usize + ox as usize];
            if a <= 0.0 {
                continue;
            }
            let a_eff = a * opacity;
            let i = (y as usize * w as usize + x as usize) * 3;
            for (c, premul) in [r, g, b].into_iter().enumerate() {
                let under = data[i + c].to_unit();
                data[i + c] = T::from_unit(under * (1.0 - a_eff) + premul * opacity);
            }
        }
    }
}

/// `data` (`w × h` RGB) inside a frame of `border` pixels of `colour` (encoded 0..1): `(w + 2b) × (h + 2b)`.
pub fn add_border<T: Sample>(data: &[T], w: u32, h: u32, border: u32, colour: [f32; 3]) -> (u32, u32, Vec<T>) {
    let (nw, nh) = (w + 2 * border, h + 2 * border);
    let fill = colour.map(T::from_unit);
    let mut out: Vec<T> = Vec::with_capacity(nw as usize * nh as usize * 3);
    for _ in 0..nw as usize * nh as usize {
        out.extend_from_slice(&fill);
    }
    let (w, b, nw) = (w as usize, border as usize, nw as usize);
    for y in 0..h as usize {
        let dst = ((y + b) * nw + b) * 3;
        out[dst..dst + w * 3].copy_from_slice(&data[y * w * 3..(y + 1) * w * 3]);
    }
    (nw as u32, nh, out)
}

/// `#rrggbb` (case-insensitive) as encoded 0..1 values; `None` when it is not one.
pub fn parse_hex(colour: &str) -> Option<[f32; 3]> {
    let hex = colour.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok().map(|v| v as f32 / 255.0);
    Some([byte(0)?, byte(2)?, byte(4)?])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_font_unpacks_and_sets_text() {
        for face in [WatermarkFace::Inter, WatermarkFace::Fraunces, WatermarkFace::InstrumentSerif, WatermarkFace::JetBrainsMono] {
            let o = text_overlay("© Jan 2026", face, 40.0, [1.0, 1.0, 1.0], 4000, 4000).unwrap().unwrap();
            assert!(o.width > 100 && o.height >= 40, "{face:?}: {}x{}", o.width, o.height);
            let ink = o.rgba.iter().filter(|p| p[3] > 0.5).count();
            assert!(ink > 200, "{face:?} has ink {ink}");
        }
        assert!(text_overlay("   ", WatermarkFace::Inter, 40.0, [1.0; 3], 4000, 4000).unwrap().is_none());
        // The shared WOFF2s are Latin subsets: © is there, Cyrillic is not (docs/DEVELOP.md says so).
        let inter = font(WatermarkFace::Inter).unwrap();
        assert_ne!(inter.glyph_id('©').0, 0);
        assert_eq!(inter.glyph_id('Ж').0, 0);
        // A line too long for the photo is set smaller so it fits; the overlay never exceeds the bounds.
        let long = "M".repeat(60);
        let o = text_overlay(&long, WatermarkFace::Inter, 1800.0, [1.0; 3], 5800, 3800).unwrap().unwrap();
        assert!(o.width <= 5800 && o.height <= 3800, "{}x{}", o.width, o.height);
        assert!(o.width > 5000, "fills the width: {}", o.width);
    }

    #[test]
    fn placement_covers_the_nine_positions() {
        assert_eq!(place(100, 80, 20, 10, Anchor::TopLeft, 5), (5, 5));
        assert_eq!(place(100, 80, 20, 10, Anchor::BottomRight, 5), (75, 65));
        assert_eq!(place(100, 80, 20, 10, Anchor::Center, 5), (40, 35));
        assert_eq!(place(100, 80, 20, 10, Anchor::Top, 0), (40, 0));
        assert_eq!(place(100, 80, 20, 10, Anchor::Left, 0), (0, 35));
    }

    #[test]
    fn composite_blends_with_opacity_and_clips() {
        let mut data = vec![0u8; 4 * 4 * 3];
        let overlay = Overlay { width: 2, height: 2, rgba: vec![[1.0, 1.0, 1.0, 1.0]; 4] };
        composite(&mut data, 4, 4, &overlay, 3, 3, 0.5);
        // Only (3, 3) is inside; half of white over black.
        assert_eq!(&data[(3 * 4 + 3) * 3..(3 * 4 + 3) * 3 + 3], &[128, 128, 128]);
        assert_eq!(data.iter().filter(|&&v| v != 0).count(), 3);
        let mut wide = vec![65535u16; 3];
        composite(&mut wide, 1, 1, &Overlay { width: 1, height: 1, rgba: vec![[0.0, 0.0, 0.0, 1.0]] }, 0, 0, 0.25);
        assert_eq!(wide, vec![49151; 3]);
    }

    #[test]
    fn border_frames_the_image() {
        let data = vec![10u8; 2 * 1 * 3];
        let (w, h, out) = add_border(&data, 2, 1, 2, [1.0, 0.0, 0.0]);
        assert_eq!((w, h), (6, 5));
        assert_eq!(&out[0..3], &[255, 0, 0]);
        let inner = (2 * 6 + 2) * 3;
        assert_eq!(&out[inner..inner + 6], &[10; 6]);
        assert_eq!(&out[inner + 6..inner + 9], &[255, 0, 0]);
        assert_eq!(parse_hex("#FF8000"), Some([1.0, 128.0 / 255.0, 0.0]));
        assert_eq!(parse_hex("ff8000"), None);
    }

    #[test]
    fn png_overlay_scales_to_the_long_edge_with_alpha() {
        let mut png = Vec::new();
        let img = image::RgbaImage::from_fn(40, 20, |x, _| image::Rgba([255, 0, 0, if x < 20 { 255 } else { 0 }]));
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let o = image_overlay(&png, 20, 1000, 1000).unwrap();
        assert_eq!((o.width, o.height), (20, 10));
        assert!(o.rgba[0][3] > 0.99 && o.rgba[0][0] > 0.99);
        assert!(o.rgba[19][3] < 0.01);
        assert!(image_overlay(b"not a png", 10, 100, 100).is_err());
        // Capped to the photo.
        let o = image_overlay(&png, 400, 100, 100).unwrap();
        assert_eq!((o.width, o.height), (100, 50));
        // Cached by key and size: the same overlay, not a new one.
        let a = image_overlay_cached("k", &png, 20, 1000, 1000).unwrap();
        let b = image_overlay_cached("k", b"ignored once cached", 20, 1000, 1000).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
    }
}
