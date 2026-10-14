//! Export (workflow plan 11): a developed photo as a new file, resized, sharpened for screen and encoded.
//!
//! The editor develops the photo at full resolution exactly as a full render does ([`crate::render_full_with_options`]
//! on the source or its denoise intermediate), then [`finish`] fits it to the preset's long edge (Lanczos3 on the
//! 8-bit output, never upscaling) and applies the output sharpening, and [`encode`] writes JPEG, PNG or WebP tagged
//! with the output profile's ICC, with the Exif the preset asks for. At the developed size with sharpening off and
//! JPEG quality 95 the result is byte for byte the full render of `render_develop_full` (same pixels, same encoder).
//!
//! Plan 12 adds AVIF (`ravif`, 10-bit AV1, sRGB only), HEIC (ImageIO, 10-bit, macOS with `heic-imageio`) and TIFF
//! (16 bits per channel, Deflate) to [`ExportFormat`], and a watermark and a border to [`ExportOptions`]. TIFF and HEIC
//! are developed into 16 bits per channel ([`crate::render::render_full16_with_options`], the CPU path) so they keep
//! more than the 8-bit render: [`ExportFrame`] holds either. [`finish`] then fits the photo to the long edge (less the
//! border), sharpens it, lays the watermark on it ([`crate::ops::watermark`]) and frames it. `Original` is not encoded
//! here: the editor copies the source and writes an XMP sidecar next to it.

use std::io::Cursor;
use std::path::Path;

use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::color::transfer::{linear_to_srgb, srgb_to_linear, srgb_u8_lut};
use crate::color::OutputProfile;
use crate::cpu::RenderOptions;
use crate::decode::fit;
use crate::error::{Error, Result};
use crate::geometry::Quality;
use crate::image::{LinearImage, Rgb16Image, Rgb8Image};
use crate::jpeg_markers;
use crate::local::prepass::sharpen_planes;
use crate::local::reference_scale;
use crate::ops::sharpen::sharpen_px;
use crate::render::{copy_exif, encode_jpeg_as, render_full_with_options};
use crate::settings::DevelopSettings;

/// Output formats (`EXPORT_FORMATS` in `packages/shared/src/export.ts`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    #[default]
    Jpeg,
    Png,
    Webp,
    /// 10-bit AV1 in an AVIF container (`ravif`).
    Avif,
    /// 10-bit HEVC through ImageIO: macOS with the `heic-imageio` feature only ([`heic_supported`]).
    Heic,
    /// 16 bits per channel, Deflate with the horizontal predictor.
    Tiff,
    /// The source file as is, plus an XMP sidecar (the editor's `export_photo`); nothing to encode.
    Original,
}

impl ExportFormat {
    /// The file extension, without the dot (`EXPORT_EXTENSIONS` in TS); empty for [`ExportFormat::Original`], which
    /// keeps the source's.
    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Jpeg => "jpg",
            ExportFormat::Png => "png",
            ExportFormat::Webp => "webp",
            ExportFormat::Avif => "avif",
            ExportFormat::Heic => "heic",
            ExportFormat::Tiff => "tif",
            ExportFormat::Original => "",
        }
    }

    /// Developed into 16 bits per channel ([`ExportFrame::Rgb16`]) rather than 8.
    pub fn is_16_bit(self) -> bool {
        matches!(self, ExportFormat::Heic | ExportFormat::Tiff)
    }

    /// Lossy: `quality` decides the bytes.
    pub fn has_quality(self) -> bool {
        matches!(self, ExportFormat::Jpeg | ExportFormat::Webp | ExportFormat::Avif | ExportFormat::Heic)
    }

    /// Carries Exif (or TIFF tags): `metadata` decides the bytes. PNG, WebP and AVIF carry the profile only.
    pub fn has_metadata(self) -> bool {
        matches!(self, ExportFormat::Jpeg | ExportFormat::Heic | ExportFormat::Tiff)
    }
}

/// Whether this build can write HEIC (macOS with the `heic-imageio` feature); the dialog hides it otherwise.
pub const fn heic_supported() -> bool {
    cfg!(all(target_os = "macos", feature = "heic-imageio"))
}

/// What a watermark shows (`WatermarkSchema.kind`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WatermarkKind {
    #[default]
    Text,
    Image,
}

/// The shared fonts a text watermark is set in (`WATERMARK_FONTS`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WatermarkFont {
    #[default]
    Inter,
    Fraunces,
    InstrumentSerif,
    JetbrainsMono,
}

impl WatermarkFont {
    fn face(self) -> crate::ops::watermark::WatermarkFace {
        use crate::ops::watermark::WatermarkFace as F;
        match self {
            WatermarkFont::Inter => F::Inter,
            WatermarkFont::Fraunces => F::Fraunces,
            WatermarkFont::InstrumentSerif => F::InstrumentSerif,
            WatermarkFont::JetbrainsMono => F::JetBrainsMono,
        }
    }
}

/// Nine positions (`WATERMARK_POSITIONS`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WatermarkPosition {
    TopLeft,
    Top,
    TopRight,
    Left,
    Center,
    Right,
    BottomLeft,
    Bottom,
    #[default]
    BottomRight,
}

impl WatermarkPosition {
    fn anchor(self) -> crate::ops::watermark::Anchor {
        use crate::ops::watermark::Anchor as A;
        match self {
            WatermarkPosition::TopLeft => A::TopLeft,
            WatermarkPosition::Top => A::Top,
            WatermarkPosition::TopRight => A::TopRight,
            WatermarkPosition::Left => A::Left,
            WatermarkPosition::Center => A::Center,
            WatermarkPosition::Right => A::Right,
            WatermarkPosition::BottomLeft => A::BottomLeft,
            WatermarkPosition::Bottom => A::Bottom,
            WatermarkPosition::BottomRight => A::BottomRight,
        }
    }
}

/// A watermark (`WatermarkSchema`): text or an imported PNG, laid over the photo after the resize. Sizes are
/// fractions of the photo's long edge (the border not included).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Watermark {
    pub kind: WatermarkKind,
    pub text: String,
    pub font: WatermarkFont,
    /// `#rrggbb`, the text colour.
    pub colour: String,
    /// SHA-256 (hex) of the imported PNG (`<appdata>/watermarks/<sha256>.png`), for `kind: image`.
    pub image: Option<String>,
    /// The PNG's original file name, shown in the dialog.
    pub image_name: Option<String>,
    /// Text em size, or the image's long edge, as a fraction of the photo's long edge.
    pub size: f64,
    /// 0..1.
    pub opacity: f64,
    pub position: WatermarkPosition,
    /// Inset from the photo's edges, a fraction of its long edge.
    pub margin: f64,
}

impl Default for Watermark {
    fn default() -> Self {
        Self {
            kind: WatermarkKind::Text,
            text: String::new(),
            font: WatermarkFont::Inter,
            colour: "#ffffff".into(),
            image: None,
            image_name: None,
            size: 0.03,
            opacity: 0.7,
            position: WatermarkPosition::BottomRight,
            margin: 0.02,
        }
    }
}

/// Border width unit (`BorderSchema.unit`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BorderUnit {
    Px,
    #[default]
    Percent,
}

/// A solid border around the photo (`BorderSchema`). With a long edge the photo is fitted to the long edge less both
/// borders, so the file keeps the preset's long edge; without one the border adds to the developed size. Percent is
/// of the file's long edge (the preset's long edge, else the photo's).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Border {
    pub width: f64,
    pub unit: BorderUnit,
    /// `#rrggbb`.
    pub colour: String,
}

impl Default for Border {
    fn default() -> Self {
        Self { width: 2.0, unit: BorderUnit::Percent, colour: "#ffffff".into() }
    }
}

impl Border {
    /// The border in pixels for a file whose long edge is `long_edge`.
    pub fn pixels(&self, long_edge: u32) -> u32 {
        let px = match self.unit {
            BorderUnit::Px => self.width,
            BorderUnit::Percent => self.width / 100.0 * long_edge as f64,
        };
        if px.is_finite() && px > 0.0 {
            px.round() as u32
        } else {
            0
        }
    }
}

/// Which Exif goes into the file (`ExportMetadataSchema`). PNG and WebP carry none.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportMetadata {
    /// The source's Exif, Orientation reset to 1 ([`copy_exif`]).
    #[default]
    All,
    /// Only Copyright and Artist.
    Copyright,
    None,
}

/// Output sharpening for screen (`OutputSharpenSchema`), at the target size.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputSharpen {
    #[default]
    Off,
    Low,
    Standard,
    High,
}

/// The encode options of an export preset (`ExportOptionsSchema`). Missing fields take their defaults and unknown
/// ones are ignored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    pub format: ExportFormat,
    /// 1 to 100 (JPEG, WebP).
    pub quality: u8,
    /// Long edge in pixels; `None` keeps the developed size. Never upscales.
    pub long_edge: Option<u32>,
    pub colour: OutputProfile,
    pub metadata: ExportMetadata,
    pub sharpen: OutputSharpen,
    /// Absent when off (so presets without one keep their plan 11 hash).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watermark: Option<Watermark>,
    /// Absent when off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border: Option<Border>,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            format: ExportFormat::Jpeg,
            quality: 90,
            long_edge: None,
            colour: OutputProfile::Srgb,
            metadata: ExportMetadata::All,
            sharpen: OutputSharpen::Off,
            watermark: None,
            border: None,
        }
    }
}

/// A developed photo on its way to the encoder: 8 bits per channel, or 16 for TIFF and HEIC.
#[derive(Debug, Clone, PartialEq)]
pub enum ExportFrame {
    Rgb8(Rgb8Image),
    Rgb16(Rgb16Image),
}

impl ExportFrame {
    pub fn size(&self) -> (u32, u32) {
        match self {
            ExportFrame::Rgb8(i) => (i.width, i.height),
            ExportFrame::Rgb16(i) => (i.width, i.height),
        }
    }
}

/// What [`finish`] needs besides the options: the watermark PNG's bytes, when the watermark is an image.
#[derive(Debug, Clone, Default)]
pub struct ExportAssets {
    pub watermark_png: Option<Vec<u8>>,
}

impl ExportAssets {
    /// The PNG's bytes (cached by the options' `image` hash, which the editor checks the bytes against).
    fn watermark(&self) -> Option<&[u8]> {
        self.watermark_png.as_deref()
    }
}

/// Develop `image` at full resolution (as a full render does, [`RenderOptions`] given) and fit it to `long_edge`.
/// The editor calls [`finish`] on its own full render instead (it adds the AI mask source and the cancel checks).
pub fn render_to_size(
    image: &LinearImage,
    settings: &DevelopSettings,
    long_edge: Option<u32>,
    options: &RenderOptions,
) -> Result<Rgb8Image> {
    let quality = Quality::for_size(image.width, image.height);
    fit_to(render_full_with_options(image, settings, quality, options)?, long_edge)
}

/// `rendered` (a full-resolution render in `options.colour`) fitted to the long edge (less the border), sharpened for
/// screen, watermarked and framed by the border. Sharpening comes before the watermark and the border so neither gets
/// halos. Without a watermark or a border this is [`fit_to`] and [`output_sharpen`] alone (plan 11's bytes).
pub fn finish(rendered: ExportFrame, options: &ExportOptions, assets: &ExportAssets) -> Result<ExportFrame> {
    let (w0, h0) = rendered.size();
    let file_edge = options.long_edge.filter(|e| *e > 0);
    let border = options.border.as_ref().map_or(0, |b| b.pixels(file_edge.unwrap_or(w0.max(h0))));
    // The photo leaves room for the border on both sides, so the file keeps the preset's long edge.
    let photo_edge = file_edge.map(|e| e.saturating_sub(2 * border).max(1));
    let mut frame = match rendered {
        ExportFrame::Rgb8(image) => {
            let mut out = fit_to(image, photo_edge)?;
            output_sharpen(&mut out, options.sharpen, options.colour);
            ExportFrame::Rgb8(out)
        }
        ExportFrame::Rgb16(image) => {
            let mut out = fit_to16(image, photo_edge)?;
            output_sharpen16(&mut out, options.sharpen, options.colour);
            ExportFrame::Rgb16(out)
        }
    };
    if let Some(watermark) = &options.watermark {
        apply_watermark(&mut frame, watermark, assets)?;
    }
    if let Some(b) = options.border.as_ref().filter(|_| border > 0) {
        let colour = crate::ops::watermark::parse_hex(&b.colour)
            .ok_or_else(|| Error::Invalid(format!("Invalid border colour {:?}", b.colour)))?;
        frame = match frame {
            ExportFrame::Rgb8(i) => {
                let (w, h, data) = crate::ops::watermark::add_border(&i.data, i.width, i.height, border, colour);
                ExportFrame::Rgb8(Rgb8Image::new(w, h, data))
            }
            ExportFrame::Rgb16(i) => {
                let (w, h, data) = crate::ops::watermark::add_border(&i.data, i.width, i.height, border, colour);
                ExportFrame::Rgb16(Rgb16Image::new(w, h, data))
            }
        };
    }
    Ok(frame)
}

/// Lay `watermark` over the photo: text in its font and colour, or the imported PNG (`assets.watermark_png`).
fn apply_watermark(frame: &mut ExportFrame, watermark: &Watermark, assets: &ExportAssets) -> Result<()> {
    use crate::ops::watermark::{composite, image_overlay_cached, parse_hex, place, text_overlay};
    let (w, h) = frame.size();
    let long = w.max(h) as f64;
    let size = (watermark.size.clamp(0.0, 1.0) * long) as f32;
    let margin = ((watermark.margin.clamp(0.0, 0.5) * long).round() as u32).min(w.min(h).saturating_sub(1) / 2);
    // The overlay never exceeds the photo less its margins.
    let (max_w, max_h) = (w - 2 * margin, h - 2 * margin);
    let overlay = match watermark.kind {
        WatermarkKind::Text => {
            let colour = parse_hex(&watermark.colour)
                .ok_or_else(|| Error::Invalid(format!("Invalid watermark colour {:?}", watermark.colour)))?;
            text_overlay(&watermark.text, watermark.font.face(), size, colour, max_w, max_h)?.map(std::sync::Arc::new)
        }
        WatermarkKind::Image => {
            let png = assets.watermark().ok_or_else(|| {
                Error::Invalid("The watermark image is missing; choose it again in the Export dialog".into())
            })?;
            let key = watermark.image.as_deref().unwrap_or_default();
            Some(image_overlay_cached(key, png, size.round().max(1.0) as u32, max_w, max_h)?)
        }
    };
    let Some(overlay) = overlay else { return Ok(()) };
    let (x, y) = place(w, h, overlay.width, overlay.height, watermark.position.anchor(), margin);
    let opacity = watermark.opacity as f32;
    match frame {
        ExportFrame::Rgb8(i) => composite(&mut i.data, w, h, &overlay, x, y, opacity),
        ExportFrame::Rgb16(i) => composite(&mut i.data, w, h, &overlay, x, y, opacity),
    }
    Ok(())
}

/// [`fit_to`] for a 16-bit frame (Lanczos3 on the encoded 16-bit values).
pub fn fit_to16(image: Rgb16Image, long_edge: Option<u32>) -> Result<Rgb16Image> {
    let Some(edge) = long_edge.filter(|e| *e > 0) else { return Ok(image) };
    let (w, h) = fit(image.width, image.height, edge);
    if (w, h) == (image.width, image.height) {
        return Ok(image);
    }
    let pixel = fast_image_resize::PixelType::U16x3;
    let bytes: &[u8] = bytemuck::cast_slice(&image.data);
    let src = fast_image_resize::images::ImageRef::new(image.width, image.height, bytes, pixel)
        .map_err(|err| Error::Resize(err.to_string()))?;
    let mut dst = fast_image_resize::images::Image::new(w, h, pixel);
    let options = fast_image_resize::ResizeOptions::new()
        .resize_alg(fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Lanczos3));
    fast_image_resize::Resizer::new().resize(&src, &mut dst, &options)?;
    Ok(Rgb16Image::new(w, h, bytemuck::pod_collect_to_vec(dst.buffer())))
}

/// `image` scaled so its long edge is at most `long_edge` (Lanczos3 on the encoded 8-bit values, like the publish
/// sizes); unchanged when it already fits or `long_edge` is `None`.
pub fn fit_to(image: Rgb8Image, long_edge: Option<u32>) -> Result<Rgb8Image> {
    let Some(edge) = long_edge.filter(|e| *e > 0) else { return Ok(image) };
    let (w, h) = fit(image.width, image.height, edge);
    if (w, h) == (image.width, image.height) {
        return Ok(image);
    }
    let pixel = fast_image_resize::PixelType::U8x3;
    let src = fast_image_resize::images::ImageRef::new(image.width, image.height, &image.data, pixel)
        .map_err(|err| Error::Resize(err.to_string()))?;
    let mut dst = fast_image_resize::images::Image::new(w, h, pixel);
    let options = fast_image_resize::ResizeOptions::new()
        .resize_alg(fast_image_resize::ResizeAlg::Convolution(fast_image_resize::FilterType::Lanczos3));
    fast_image_resize::Resizer::new().resize(&src, &mut dst, &options)?;
    Ok(Rgb8Image::new(w, h, dst.into_vec()))
}

/// Gain, σ in output pixels, fine/coarse mix and masking of each sharpening level (the develop sharpen op's terms).
fn sharpen_terms(level: OutputSharpen) -> Option<(f32, f32, f32, f32)> {
    match level {
        OutputSharpen::Off => None,
        OutputSharpen::Low => Some((0.30, 0.6, 0.75, 0.15)),
        OutputSharpen::Standard => Some((0.55, 0.6, 0.75, 0.15)),
        OutputSharpen::High => Some((0.85, 0.7, 0.75, 0.15)),
    }
}

/// Output sharpening for screen: the develop sharpen op ([`sharpen_px`] on `log2 Y` planes) run on the final pixels
/// with a radius in output pixels, so it is the same strength whatever the export size. `profile` is the space the
/// pixels are encoded in (its luminance row weighs the channels).
pub fn output_sharpen(image: &mut Rgb8Image, level: OutputSharpen, profile: OutputProfile) {
    let Some((amount, sigma_px, detail, masking)) = sharpen_terms(level) else { return };
    let (w, h) = (image.width as usize, image.height as usize);
    if w < 3 || h < 3 {
        return;
    }
    let lut = srgb_u8_lut();
    let mut linear: Vec<f32> = image.data.par_iter().map(|&v| lut[v as usize]).collect();
    sharpen_linear(&mut linear, w, h, (amount, sigma_px, detail, masking), profile);
    image
        .data
        .par_iter_mut()
        .zip(linear.par_iter())
        .for_each(|(out, &v)| *out = (linear_to_srgb(v.clamp(0.0, 1.0)) * 255.0).round() as u8);
}

/// [`output_sharpen`] on a 16-bit frame.
pub fn output_sharpen16(image: &mut Rgb16Image, level: OutputSharpen, profile: OutputProfile) {
    let Some(terms) = sharpen_terms(level) else { return };
    let (w, h) = (image.width as usize, image.height as usize);
    if w < 3 || h < 3 {
        return;
    }
    let mut linear: Vec<f32> = image.data.par_iter().map(|&v| srgb_to_linear(v as f32 / 65535.0)).collect();
    sharpen_linear(&mut linear, w, h, terms, profile);
    image
        .data
        .par_iter_mut()
        .zip(linear.par_iter())
        .for_each(|(out, &v)| *out = (linear_to_srgb(v.clamp(0.0, 1.0)) * 65535.0).round() as u16);
}

/// The output sharpening of linear output RGB (`w × h`, interleaved), in place.
fn sharpen_linear(linear: &mut [f32], w: usize, h: usize, terms: (f32, f32, f32, f32), profile: OutputProfile) {
    let (amount, sigma_px, detail, masking) = terms;
    let row = profile.to_xyz()[1];
    let weights = [row[0] as f32, row[1] as f32, row[2] as f32];
    let log_y: Vec<f32> = linear
        .par_chunks_exact(3)
        .map(|p| ((weights[0] * p[0] + weights[1] * p[1] + weights[2] * p[2]).max(0.0) + 1e-4).log2())
        .collect();
    // `sharpen_planes` takes a radius in reference pixels; this one is in output pixels.
    let radius_ref = sigma_px / reference_scale(w, h).max(1e-3);
    let planes = sharpen_planes(&log_y, w, h, radius_ref);
    linear.par_chunks_exact_mut(3).enumerate().for_each(|(i, px)| {
        sharpen_px(px, planes.fine[i], planes.coarse[i], planes.edges[i], amount, detail, masking);
    });
}

impl ExportFrame {
    /// The frame at 8 bits per channel (a 16-bit one rounded).
    pub fn to_rgb8(&self) -> std::borrow::Cow<'_, Rgb8Image> {
        match self {
            ExportFrame::Rgb8(i) => std::borrow::Cow::Borrowed(i),
            ExportFrame::Rgb16(i) => std::borrow::Cow::Owned(Rgb8Image::new(
                i.width,
                i.height,
                i.data.par_iter().map(|&v| ((v as u32 + 128) / 257) as u8).collect(),
            )),
        }
    }

    /// The frame at 16 bits per channel (an 8-bit one widened exactly, `v · 257`).
    pub fn to_rgb16(&self) -> std::borrow::Cow<'_, Rgb16Image> {
        match self {
            ExportFrame::Rgb16(i) => std::borrow::Cow::Borrowed(i),
            ExportFrame::Rgb8(i) => std::borrow::Cow::Owned(Rgb16Image::new(
                i.width,
                i.height,
                i.data.par_iter().map(|&v| v as u16 * 257).collect(),
            )),
        }
    }
}

/// Encode `frame` (pixels in `options.colour`) in `options.format`, tagged with the profile (an ICC profile; AVIF
/// is sRGB in its AV1 header), plus the Exif of `exif_source` that `options.metadata` asks for (JPEG, HEIC; TIFF
/// gets the descriptive TIFF tags). A frame of the other bit depth is converted.
pub fn encode(frame: &ExportFrame, options: &ExportOptions, exif_source: Option<&Path>) -> Result<Vec<u8>> {
    let quality = options.quality.clamp(1, 100);
    match options.format {
        ExportFormat::Png => encode_png(&frame.to_rgb8(), options.colour),
        ExportFormat::Webp => encode_webp(&frame.to_rgb8(), quality, options.colour),
        ExportFormat::Avif => encode_avif(&frame.to_rgb8(), quality, options.colour),
        ExportFormat::Tiff => encode_tiff(&frame.to_rgb16(), options.colour, options.metadata, exif_source),
        ExportFormat::Heic => encode_heic(&frame.to_rgb16(), quality, options.colour, options.metadata, exif_source),
        ExportFormat::Original => Err(Error::Invalid("An Original export is a copy of the source, not an encode".into())),
        ExportFormat::Jpeg => {
            let image = &*frame.to_rgb8();
            let mut bytes = encode_jpeg_as(image, quality, options.colour)?;
            if let Some(src) = exif_source {
                match options.metadata {
                    ExportMetadata::All => {
                        // A JPEG's or HEIF's Exif is copied as is; other sources (RAW, PNG) are rewritten.
                        if !copy_exif(src, &mut bytes)? {
                            if let Some(payload) = descriptive_exif(src) {
                                jpeg_markers::insert_exif(&mut bytes, &payload);
                            }
                        }
                    }
                    ExportMetadata::Copyright => {
                        if let Some(payload) = copyright_exif(src) {
                            jpeg_markers::insert_exif(&mut bytes, &payload);
                        }
                    }
                    ExportMetadata::None => {}
                }
            }
            Ok(bytes)
        }
    }
}

/// rav1e speed preset for AVIF (1 slow .. 10 fast): 6 keeps a 24 MP export to seconds, not minutes.
const AVIF_SPEED: u8 = 6;

/// An AVIF: 10-bit AV1 (4:4:4, BT.601 full range, from `ravif`), sRGB only. ravif writes BT.709 primaries and the
/// sRGB transfer into the AV1 sequence header (and leaves the `colr` box out, which decoders read the same way) and
/// has no way to set other primaries, so a Display P3 AVIF would say P3 in one place and sRGB in another: AVIF is
/// sRGB (the dialog offers no Display P3 for it).
pub fn encode_avif(image: &Rgb8Image, quality: u8, profile: OutputProfile) -> Result<Vec<u8>> {
    if profile != OutputProfile::Srgb {
        return Err(Error::Invalid("AVIF export is sRGB only; choose sRGB or another format".into()));
    }
    let pixels: Vec<ravif::RGB8> = image.data.chunks_exact(3).map(|p| ravif::RGB8::new(p[0], p[1], p[2])).collect();
    let (w, h) = (image.width as usize, image.height as usize);
    let encoded = ravif::Encoder::new()
        .with_quality(quality.clamp(1, 100) as f32)
        .with_speed(AVIF_SPEED)
        .with_bit_depth(ravif::BitDepth::Ten)
        .encode_rgb(ravif::Img::new(pixels.as_slice(), w, h))
        .map_err(|err| Error::Invalid(format!("AVIF encode failed: {err}")))?;
    Ok(encoded.avif_file)
}

/// A TIFF value of type UNDEFINED (the ICC profile tag's type).
struct Undefined<'a>(&'a [u8]);

impl tiff::encoder::TiffValue for Undefined<'_> {
    const BYTE_LEN: u8 = 1;
    const FIELD_TYPE: tiff::tags::Type = tiff::tags::Type::UNDEFINED;
    fn count(&self) -> usize {
        self.0.len()
    }
    fn data(&self) -> std::borrow::Cow<'_, [u8]> {
        std::borrow::Cow::Borrowed(self.0)
    }
}

/// A 16-bit RGB TIFF (Deflate, horizontal predictor) with the profile's ICC (tag 34675) and, unless `metadata` is
/// none, the source's Copyright and Artist (`copyright`) or its descriptive TIFF tags (`all`: also make, model,
/// software, date, description). The Exif sub-IFD (exposure, lens, GPS) is not written.
pub fn encode_tiff(
    image: &Rgb16Image,
    profile: OutputProfile,
    metadata: ExportMetadata,
    exif_source: Option<&Path>,
) -> Result<Vec<u8>> {
    use tiff::encoder::{colortype::RGB16, compression::DeflateLevel, Compression, Predictor, TiffEncoder};
    use tiff::tags::Tag;
    let tiff_err = |err: tiff::TiffError| Error::Invalid(format!("TIFF encode failed: {err}"));
    let tags: Vec<(u16, String)> = match (metadata, exif_source) {
        (ExportMetadata::None, _) | (_, None) => Vec::new(),
        (ExportMetadata::Copyright, Some(src)) => ascii_tags(src, &[exif::Tag::Artist, exif::Tag::Copyright]),
        (ExportMetadata::All, Some(src)) => ascii_tags(src, &DESCRIPTIVE_TIFF_TAGS),
    };
    let mut out = Cursor::new(Vec::new());
    let mut encoder = TiffEncoder::new(&mut out)
        .map_err(tiff_err)?
        .with_compression(Compression::Deflate(DeflateLevel::Balanced))
        .with_predictor(Predictor::Horizontal);
    let mut img = encoder.new_image::<RGB16>(image.width, image.height).map_err(tiff_err)?;
    img.encoder().write_tag(Tag::IccProfile, Undefined(profile.icc())).map_err(tiff_err)?;
    for (number, text) in &tags {
        img.encoder().write_tag(Tag::from_u16_exhaustive(*number), text.as_str()).map_err(tiff_err)?;
    }
    img.write_data(&image.data).map_err(tiff_err)?;
    Ok(out.into_inner())
}

/// A HEIC (10-bit, through ImageIO) with the profile and the Exif `metadata` asks for.
#[cfg(all(target_os = "macos", feature = "heic-imageio"))]
pub fn encode_heic(
    image: &Rgb16Image,
    quality: u8,
    profile: OutputProfile,
    metadata: ExportMetadata,
    exif_source: Option<&Path>,
) -> Result<Vec<u8>> {
    heic::encode_heic(image, quality, profile, metadata, exif_source)
}

/// HEIC export needs ImageIO (macOS, feature `heic-imageio`).
#[cfg(not(all(target_os = "macos", feature = "heic-imageio")))]
pub fn encode_heic(
    _image: &Rgb16Image,
    _quality: u8,
    _profile: OutputProfile,
    _metadata: ExportMetadata,
    _exif_source: Option<&Path>,
) -> Result<Vec<u8>> {
    Err(Error::Unsupported("HEIC export needs macOS".into()))
}

#[cfg(all(target_os = "macos", feature = "heic-imageio"))]
#[path = "export_heic.rs"]
pub mod heic;

/// The ASCII values of `tags` in the primary IFD of `src`'s Exif (any container `kamadak-exif` reads), as TIFF tag
/// numbers and text, in the order given.
fn ascii_tags(src: &Path, tags: &[exif::Tag]) -> Vec<(u16, String)> {
    let Ok(file) = std::fs::File::open(src) else { return Vec::new() };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file)) else { return Vec::new() };
    tags.iter()
        .filter_map(|tag| {
            let field = exif.get_field(*tag, exif::In::PRIMARY)?;
            let exif::Value::Ascii(parts) = &field.value else { return None };
            let text = parts
                .iter()
                .map(|p| String::from_utf8_lossy(p).trim_end_matches('\0').to_string())
                .filter(|s| !s.trim().is_empty())
                .collect::<Vec<_>>()
                .join("; ");
            (!text.is_empty()).then_some((tag.number(), text))
        })
        .collect()
}

/// The source's Copyright and Artist (primary IFD), if any.
pub fn copyright_strings(src: &Path) -> (Option<String>, Option<String>) {
    let tags = ascii_tags(src, &[exif::Tag::Copyright, exif::Tag::Artist]);
    let get = |tag: exif::Tag| tags.iter().find(|(n, _)| *n == tag.number()).map(|(_, t)| t.clone());
    (get(exif::Tag::Copyright), get(exif::Tag::Artist))
}

/// A PNG (8-bit RGB) with the profile's ICC in `iCCP`.
pub fn encode_png(image: &Rgb8Image, profile: OutputProfile) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = PngEncoder::new(&mut out);
    encoder
        .set_icc_profile(profile.icc().to_vec())
        .map_err(|err| Error::Invalid(format!("PNG ICC profile: {err}")))?;
    encoder.write_image(&image.data, image.width, image.height, ExtendedColorType::Rgb8)?;
    Ok(out)
}

/// A lossy WebP (libwebp) at `quality`, in an extended (`VP8X`) container with the profile's ICC in `ICCP`.
pub fn encode_webp(image: &Rgb8Image, quality: u8, profile: OutputProfile) -> Result<Vec<u8>> {
    if image.width > 16383 || image.height > 16383 {
        return Err(Error::Invalid(format!(
            "WebP is limited to 16383 pixels a side; this photo is {} x {} (set a long edge)",
            image.width, image.height
        )));
    }
    let encoded = webp::Encoder::from_rgb(&image.data, image.width, image.height)
        .encode_simple(false, quality as f32)
        .map_err(|err| Error::Invalid(format!("WebP encode failed: {err:?}")))?;
    with_icc(&encoded, image.width, image.height, profile.icc())
}

/// Rewrap a simple WebP (`RIFF` + `VP8 `/`VP8L` chunk) as an extended one carrying `icc`.
fn with_icc(simple: &[u8], width: u32, height: u32, icc: &[u8]) -> Result<Vec<u8>> {
    if simple.len() < 12 || &simple[0..4] != b"RIFF" || &simple[8..12] != b"WEBP" {
        return Err(Error::Invalid("libwebp returned no WebP data".into()));
    }
    let image_chunks = &simple[12..];
    let mut body = Vec::with_capacity(image_chunks.len() + icc.len() + 32);
    body.extend_from_slice(b"WEBP");
    // VP8X: flags (ICC 0x20), 3 reserved bytes, canvas width - 1 and height - 1 as 24-bit little endian.
    body.extend_from_slice(b"VP8X");
    body.extend_from_slice(&10u32.to_le_bytes());
    body.extend_from_slice(&[0x20, 0, 0, 0]);
    body.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
    body.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
    body.extend_from_slice(b"ICCP");
    body.extend_from_slice(&(icc.len() as u32).to_le_bytes());
    body.extend_from_slice(icc);
    if icc.len() % 2 == 1 {
        body.push(0);
    }
    body.extend_from_slice(image_chunks);
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// An APP1 Exif payload (`Exif\0\0` + TIFF) holding only the Copyright and Artist of `src` (any container
/// `kamadak-exif` reads: JPEG, HEIF, PNG, WebP and TIFF-based RAW), or `None` when it has neither.
pub fn copyright_exif(src: &Path) -> Option<Vec<u8>> {
    rewritten_exif(src, |f| {
        f.ifd_num == exif::In::PRIMARY && (f.tag == exif::Tag::Copyright || f.tag == exif::Tag::Artist)
    })
}

/// The primary image's own tags a rewritten Exif keeps (a RAW's primary IFD also describes its sensor data).
const DESCRIPTIVE_TIFF_TAGS: [exif::Tag; 7] = [
    exif::Tag::Make,
    exif::Tag::Model,
    exif::Tag::Software,
    exif::Tag::DateTime,
    exif::Tag::Artist,
    exif::Tag::Copyright,
    exif::Tag::ImageDescription,
];

/// The Exif of a source that is not a JPEG or HEIF (a RAW, a PNG) rewritten as an APP1 payload: its descriptive
/// primary tags, the Exif sub-IFD (exposure, dates, lens; no maker note) and GPS; no thumbnail, no orientation (the
/// pixels are upright).
pub fn descriptive_exif(src: &Path) -> Option<Vec<u8>> {
    rewritten_exif(src, |f| {
        if f.ifd_num != exif::In::PRIMARY {
            return false;
        }
        match f.tag.context() {
            exif::Context::Tiff => DESCRIPTIVE_TIFF_TAGS.contains(&f.tag),
            exif::Context::Exif => f.tag != exif::Tag::MakerNote,
            exif::Context::Gps => true,
            _ => false,
        }
    })
}

/// The fields of `src`'s Exif that `keep` accepts, written as an APP1 payload (`Exif\0\0` + TIFF); `None` when it has
/// no Exif, none is kept, or the fields cannot be written.
fn rewritten_exif(src: &Path, keep: impl Fn(&exif::Field) -> bool) -> Option<Vec<u8>> {
    let mut reader = std::io::BufReader::new(std::fs::File::open(src).ok()?);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;
    let fields: Vec<&exif::Field> = exif.fields().filter(|f| keep(f)).collect();
    if fields.is_empty() {
        return None;
    }
    let mut writer = exif::experimental::Writer::new();
    for field in &fields {
        writer.push_field(field);
    }
    let mut tiff = Cursor::new(Vec::new());
    writer.write(&mut tiff, false).ok()?;
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(&tiff.into_inner());
    Some(payload)
}

/// Bumped with `EXPORT_ENGINE_VERSION` in `packages/shared/src/export.ts` whenever an export writes different bytes
/// for the same options and develop hash; part of [`preset_hash`].
pub const EXPORT_ENGINE_VERSION: &str = "export/1";

/// The export cache key of `options` (16 hex digits), equal to `presetHash` in `packages/shared/src/export.ts`: SHA-256
/// of the canonical JSON of the options without what the format ignores (`quality` for PNG and TIFF, `metadata` for
/// PNG, WebP and AVIF, everything but the format for Original; an absent watermark or border is not in the JSON, so
/// plan 11's hashes stand), a newline and [`EXPORT_ENGINE_VERSION`]. Options this build does not know are not in it, so the editor and
/// this crate must learn a new option together (the editor's hash then differs and `export_photo` refuses it).
pub fn preset_hash(options: &ExportOptions) -> String {
    use sha2::{Digest, Sha256};
    let mut value = serde_json::to_value(options).expect("export options always serialise");
    if options.format == ExportFormat::Original {
        // A copy of the source: nothing else decides the bytes.
        value = serde_json::json!({ "format": "original" });
    }
    if let serde_json::Value::Object(map) = &mut value {
        if !options.format.has_quality() {
            map.remove("quality");
        }
        if !options.format.has_metadata() {
            map.remove("metadata");
        }
        // The watermark's file name never reaches the pixels; nor do the fields of the kind not in use.
        if let (Some(serde_json::Value::Object(w)), Some(watermark)) = (map.get_mut("watermark"), &options.watermark) {
            w.remove("imageName");
            let unused: &[&str] = match watermark.kind {
                WatermarkKind::Image => &["text", "font", "colour"],
                WatermarkKind::Text => &["image"],
            };
            for key in unused {
                w.remove(*key);
            }
        }
    }
    let input = format!("{}\n{}", crate::canonical_json(&value), EXPORT_ENGINE_VERSION);
    hex::encode(Sha256::digest(input.as_bytes()))[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: u32, h: u32) -> Rgb8Image {
        let data = (0..h)
            .flat_map(|y| (0..w).flat_map(move |x| [(x * 255 / w) as u8, (y * 255 / h) as u8, ((x ^ y) & 0xff) as u8]))
            .collect();
        Rgb8Image::new(w, h, data)
    }

    #[test]
    fn options_read_the_schema_shape_and_ignore_unknown_fields() {
        let o: ExportOptions = serde_json::from_str(
            r#"{"format":"webp","quality":80,"longEdge":2048,"colour":"display-p3","metadata":"copyright","sharpen":"standard","watermark":{"text":"x"}}"#,
        )
        .unwrap();
        assert_eq!(o.format, ExportFormat::Webp);
        assert_eq!(o.long_edge, Some(2048));
        assert_eq!(o.colour, OutputProfile::DisplayP3);
        assert_eq!(o.metadata, ExportMetadata::Copyright);
        assert_eq!(o.sharpen, OutputSharpen::Standard);
        let d: ExportOptions = serde_json::from_str(r#"{"longEdge":null}"#).unwrap();
        assert_eq!(d, ExportOptions::default());
        assert!(serde_json::from_str::<ExportOptions>(r#"{"format":"gif"}"#).is_err());
        assert_eq!(ExportFormat::Jpeg.extension(), "jpg");
    }

    #[test]
    fn preset_hash_matches_the_editor() {
        // The same values as `presetHash` in packages/shared/src/export.test.ts.
        assert_eq!(preset_hash(&ExportOptions::default()), "f41a1742bb388ad2");
        let webp: ExportOptions = serde_json::from_str(
            r#"{"format":"webp","quality":80,"longEdge":2048,"colour":"display-p3","sharpen":"standard"}"#,
        )
        .unwrap();
        assert_eq!(preset_hash(&webp), "3e88c31eda227aa2");
        let png = |quality| ExportOptions { format: ExportFormat::Png, quality, ..ExportOptions::default() };
        assert_eq!(preset_hash(&png(10)), preset_hash(&png(90)));
        let none = ExportOptions { metadata: ExportMetadata::None, ..ExportOptions::default() };
        assert_ne!(preset_hash(&none), preset_hash(&ExportOptions::default()));
    }

    #[test]
    fn fit_never_upscales_and_keeps_the_aspect() {
        let img = gradient(300, 200);
        let same = fit_to(img.clone(), Some(400)).unwrap();
        assert_eq!(same, img);
        assert_eq!(fit_to(img.clone(), None).unwrap(), img);
        let small = fit_to(img, Some(150)).unwrap();
        assert_eq!((small.width, small.height), (150, 100));
        let tall = fit_to(gradient(200, 300), Some(150)).unwrap();
        assert_eq!((tall.width, tall.height), (100, 150));
    }

    #[test]
    fn output_sharpening_raises_edge_contrast_and_leaves_flat_areas() {
        // A step edge: left half 64, right half 192.
        let (w, h) = (64u32, 32u32);
        let data: Vec<u8> = (0..h).flat_map(|_| (0..w).flat_map(|x| [if x < w / 2 { 64u8 } else { 192 }; 3])).collect();
        let base = Rgb8Image::new(w, h, data);
        let mut sharp = base.clone();
        output_sharpen(&mut sharp, OutputSharpen::High, OutputProfile::Srgb);
        let at = |img: &Rgb8Image, x: u32| img.pixel(x, h / 2)[0] as i32;
        // Darker just before the edge, brighter just after; far away unchanged.
        assert!(at(&sharp, w / 2 - 1) < at(&base, w / 2 - 1));
        assert!(at(&sharp, w / 2) > at(&base, w / 2));
        assert_eq!(at(&sharp, 2), 64);
        assert_eq!(at(&sharp, w - 3), 192);
        let mut off = base.clone();
        output_sharpen(&mut off, OutputSharpen::Off, OutputProfile::Srgb);
        assert_eq!(off, base);
    }

    #[test]
    fn png_and_webp_decode_back_with_their_profile() {
        let img = gradient(97, 61);
        let png = encode_png(&img, OutputProfile::DisplayP3).unwrap();
        let mut decoder = image::codecs::png::PngDecoder::new(Cursor::new(&png)).unwrap();
        use image::ImageDecoder;
        assert_eq!(decoder.dimensions(), (97, 61));
        assert_eq!(decoder.icc_profile().unwrap().unwrap(), OutputProfile::DisplayP3.icc());
        let mut pixels = vec![0u8; decoder.total_bytes() as usize];
        decoder.read_image(&mut pixels).unwrap();
        assert_eq!(pixels, img.data, "PNG is lossless");

        let webp = encode_webp(&img, 85, OutputProfile::Srgb).unwrap();
        assert_eq!(&webp[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(webp[4..8].try_into().unwrap()) as usize, webp.len() - 8);
        assert_eq!(&webp[12..16], b"VP8X");
        assert_eq!(&webp[30..34], b"ICCP");
        let decoded = webp::Decoder::new(&webp).decode().expect("libwebp reads the extended file");
        assert_eq!((decoded.width(), decoded.height()), (97, 61));
        // The ICC chunk holds the profile.
        let icc = OutputProfile::Srgb.icc();
        assert_eq!(&webp[38..38 + icc.len()], icc);
    }

    #[test]
    fn all_metadata_from_a_tiff_based_source_is_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let ascii = |t: &[u8]| exif::Value::Ascii(vec![t.to_vec()]);
        let fields = [
            exif::Field { tag: exif::Tag::Make, ifd_num: exif::In::PRIMARY, value: ascii(b"NIKON") },
            exif::Field { tag: exif::Tag::Orientation, ifd_num: exif::In::PRIMARY, value: exif::Value::Short(vec![6]) },
            exif::Field { tag: exif::Tag::ImageWidth, ifd_num: exif::In::PRIMARY, value: exif::Value::Long(vec![6000]) },
            exif::Field {
                tag: exif::Tag::DateTimeOriginal,
                ifd_num: exif::In::PRIMARY,
                value: ascii(b"2026:10:03 14:05:00"),
            },
        ];
        let mut writer = exif::experimental::Writer::new();
        for f in &fields {
            writer.push_field(f);
        }
        let mut tiff = Cursor::new(Vec::new());
        writer.write(&mut tiff, false).unwrap();
        let src = dir.path().join("raw.nef");
        std::fs::write(&src, tiff.into_inner()).unwrap();
        let bytes = encode(&ExportFrame::Rgb8(gradient(40, 30)), &ExportOptions::default(), Some(&src)).unwrap();
        let read = exif::Reader::new().read_from_container(&mut Cursor::new(&bytes)).unwrap();
        assert!(read.get_field(exif::Tag::Make, exif::In::PRIMARY).is_some());
        assert!(read.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY).is_some());
        // Sensor layout and orientation are not the exported image's.
        assert!(read.get_field(exif::Tag::Orientation, exif::In::PRIMARY).is_none());
        assert!(read.get_field(exif::Tag::ImageWidth, exif::In::PRIMARY).is_none());
    }

    #[test]
    fn jpeg_metadata_options() {
        let dir = tempfile::tempdir().unwrap();
        // A source JPEG with Copyright, Artist and Make in its Exif.
        let fields = [
            exif::Field {
                tag: exif::Tag::Copyright,
                ifd_num: exif::In::PRIMARY,
                value: exif::Value::Ascii(vec![b"(c) Jan".to_vec()]),
            },
            exif::Field { tag: exif::Tag::Artist, ifd_num: exif::In::PRIMARY, value: exif::Value::Ascii(vec![b"Jan".to_vec()]) },
            exif::Field { tag: exif::Tag::Make, ifd_num: exif::In::PRIMARY, value: exif::Value::Ascii(vec![b"FUJIFILM".to_vec()]) },
        ];
        let mut writer = exif::experimental::Writer::new();
        for f in &fields {
            writer.push_field(f);
        }
        let mut tiff = Cursor::new(Vec::new());
        writer.write(&mut tiff, false).unwrap();
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff.into_inner());
        let img = gradient(40, 30);
        let mut src = encode_jpeg_as(&img, 90, OutputProfile::Srgb).unwrap();
        assert!(jpeg_markers::insert_exif(&mut src, &payload));
        let src_path = dir.path().join("src.jpg");
        std::fs::write(&src_path, &src).unwrap();

        let read = |bytes: &[u8]| exif::Reader::new().read_from_container(&mut Cursor::new(bytes)).ok();
        let opts = |metadata| ExportOptions { metadata, ..ExportOptions::default() };
        let all = encode(&ExportFrame::Rgb8(img.clone()), &opts(ExportMetadata::All), Some(&src_path)).unwrap();
        let all = read(&all).unwrap();
        assert!(all.get_field(exif::Tag::Make, exif::In::PRIMARY).is_some());
        let copyright = encode(&ExportFrame::Rgb8(img.clone()), &opts(ExportMetadata::Copyright), Some(&src_path)).unwrap();
        let copyright = read(&copyright).unwrap();
        assert!(copyright.get_field(exif::Tag::Make, exif::In::PRIMARY).is_none());
        let c = copyright.get_field(exif::Tag::Copyright, exif::In::PRIMARY).unwrap();
        assert!(c.display_value().to_string().contains("(c) Jan"));
        assert!(copyright.get_field(exif::Tag::Artist, exif::In::PRIMARY).is_some());
        let none = encode(&ExportFrame::Rgb8(img.clone()), &opts(ExportMetadata::None), Some(&src_path)).unwrap();
        assert!(read(&none).is_none());
    }

    // ---- Workflow plan 12 ----

    /// A JPEG source with Copyright, Artist and Make, for the metadata tests.
    fn source_with_exif(dir: &Path) -> std::path::PathBuf {
        let ascii = |t: &[u8]| exif::Value::Ascii(vec![t.to_vec()]);
        let fields = [
            exif::Field { tag: exif::Tag::Copyright, ifd_num: exif::In::PRIMARY, value: ascii(b"(c) Jan") },
            exif::Field { tag: exif::Tag::Artist, ifd_num: exif::In::PRIMARY, value: ascii(b"Jan") },
            exif::Field { tag: exif::Tag::Make, ifd_num: exif::In::PRIMARY, value: ascii(b"FUJIFILM") },
        ];
        let mut writer = exif::experimental::Writer::new();
        for f in &fields {
            writer.push_field(f);
        }
        let mut tiff = Cursor::new(Vec::new());
        writer.write(&mut tiff, false).unwrap();
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff.into_inner());
        let mut src = encode_jpeg_as(&gradient(40, 30), 90, OutputProfile::Srgb).unwrap();
        assert!(jpeg_markers::insert_exif(&mut src, &payload));
        let path = dir.join("src.jpg");
        std::fs::write(&path, &src).unwrap();
        path
    }

    /// The `colr` nclx colour primaries of an AVIF, if it has the box.
    fn avif_primaries(bytes: &[u8]) -> Option<u16> {
        let at = bytes.windows(8).position(|w| w == b"colrnclx")?;
        Some(u16::from_be_bytes([bytes[at + 8], bytes[at + 9]]))
    }

    /// The `ispe` size of an AVIF.
    fn avif_size(bytes: &[u8]) -> (u32, u32) {
        let at = bytes.windows(4).position(|w| w == b"ispe").unwrap();
        let be = |i: usize| u32::from_be_bytes(bytes[i..i + 4].try_into().unwrap());
        (be(at + 8), be(at + 12))
    }

    #[test]
    fn new_formats_and_options_keep_the_plan_11_hashes_and_hash_what_matters() {
        // Absent watermark and border leave the plan 11 values (also pinned in export.test.ts).
        assert_eq!(preset_hash(&ExportOptions::default()), "f41a1742bb388ad2");
        let tiff = |quality| ExportOptions { format: ExportFormat::Tiff, quality, ..ExportOptions::default() };
        assert_eq!(preset_hash(&tiff(10)), preset_hash(&tiff(90)));
        let avif = |metadata| ExportOptions { format: ExportFormat::Avif, metadata, ..ExportOptions::default() };
        assert_eq!(preset_hash(&avif(ExportMetadata::All)), preset_hash(&avif(ExportMetadata::None)));
        let heic = |metadata| ExportOptions { format: ExportFormat::Heic, metadata, ..ExportOptions::default() };
        assert_ne!(preset_hash(&heic(ExportMetadata::All)), preset_hash(&heic(ExportMetadata::None)));
        let original = |long_edge| ExportOptions { format: ExportFormat::Original, long_edge, ..ExportOptions::default() };
        assert_eq!(preset_hash(&original(None)), preset_hash(&original(Some(800))));
        let marked = ExportOptions { watermark: Some(Watermark { text: "© Jan".into(), ..Watermark::default() }), ..ExportOptions::default() };
        assert_ne!(preset_hash(&marked), preset_hash(&ExportOptions::default()));
        let framed = ExportOptions { border: Some(Border::default()), ..ExportOptions::default() };
        assert_ne!(preset_hash(&framed), preset_hash(&ExportOptions::default()));
        // The same values as `presetHash` in packages/shared/src/export.test.ts.
        let full: ExportOptions = serde_json::from_str(
            r##"{"format":"tiff","quality":90,"longEdge":3000,"colour":"display-p3","metadata":"copyright","sharpen":"off",
            "watermark":{"kind":"text","text":"© Jan","font":"fraunces","colour":"#ffffff","image":null,"imageName":null,"size":0.04,"opacity":0.5,"position":"bottom-left","margin":0.02},
            "border":{"width":2.5,"unit":"percent","colour":"#000000"}}"##,
        )
        .unwrap();
        assert_eq!(preset_hash(&full), "9c77f4b4907ad2c8");
        // The file name never counts, nor the fields of the other kind.
        let named = |name: &str, text: &str| ExportOptions {
            watermark: Some(Watermark {
                kind: WatermarkKind::Image,
                image: Some("ab".repeat(32)),
                image_name: Some(name.into()),
                text: text.into(),
                ..Watermark::default()
            }),
            ..ExportOptions::default()
        };
        assert_eq!(preset_hash(&named("a.png", "x")), preset_hash(&named("b.png", "y")));
        assert_eq!(preset_hash(&original(None)), "21d61ae3a1acf283");
    }

    #[test]
    fn avif_decodes_back_with_its_size_and_primaries() {
        let img = gradient(97, 61);
        let srgb = encode_avif(&img, 80, OutputProfile::Srgb).unwrap();
        assert_eq!(&srgb[4..12], b"ftypavif");
        assert_eq!(avif_size(&srgb), (97, 61));
        // ravif's default nclx (BT.709, sRGB transfer) is implied: no box.
        assert_eq!(avif_primaries(&srgb), None);
        // sRGB only: ravif cannot signal other primaries in the AV1 sequence header.
        assert!(encode_avif(&img, 80, OutputProfile::DisplayP3).is_err());
        #[cfg(all(target_os = "macos", feature = "heic-imageio"))]
        {
            let probe = heic::probe(&srgb).expect("ImageIO decodes the AVIF");
            assert_eq!((probe.width, probe.height), (97, 61));
            assert!(probe.space.as_deref().is_some_and(|s| s.to_uppercase().contains("SRGB")), "{:?}", probe.space);
        }
    }

    /// The AVIF encode time of a 24 MP photo (for the plan's Status line): `cargo test --release -p photobook-develop
    /// avif_encode_time -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn avif_encode_time_24mp() {
        let img = Rgb8Image::new(
            6000,
            4000,
            (0..4000u32).flat_map(|y| (0..6000u32).flat_map(move |x| [(x / 24) as u8, (y / 16) as u8, ((x ^ y) & 0xff) as u8])).collect(),
        );
        let start = std::time::Instant::now();
        let bytes = encode_avif(&img, 70, OutputProfile::Srgb).unwrap();
        eprintln!("AVIF 6000x4000 q70 speed {AVIF_SPEED}: {:?}, {} bytes", start.elapsed(), bytes.len());
    }

    #[test]
    fn tiff_is_16_bit_with_its_profile_and_tags() {
        let dir = tempfile::tempdir().unwrap();
        let src = source_with_exif(dir.path());
        let data: Vec<u16> = (0..61u32 * 97 * 3).map(|i| (i * 37 % 65536) as u16).collect();
        let img = Rgb16Image::new(97, 61, data.clone());
        let bytes = encode_tiff(&img, OutputProfile::DisplayP3, ExportMetadata::Copyright, Some(&src)).unwrap();
        let mut decoder = tiff::decoder::Decoder::new(Cursor::new(&bytes)).unwrap();
        assert_eq!(decoder.dimensions().unwrap(), (97, 61));
        assert_eq!(decoder.colortype().unwrap(), tiff::ColorType::RGB(16));
        assert_eq!(decoder.get_tag_u8_vec(tiff::tags::Tag::IccProfile).unwrap(), OutputProfile::DisplayP3.icc());
        match decoder.read_image().unwrap() {
            tiff::decoder::DecodingResult::U16(pixels) => assert_eq!(pixels, data, "lossless"),
            other => panic!("not 16-bit: {other:?}"),
        }
        let read = exif::Reader::new().read_from_container(&mut Cursor::new(&bytes)).unwrap();
        let c = read.get_field(exif::Tag::Copyright, exif::In::PRIMARY).unwrap();
        assert!(c.display_value().to_string().contains("(c) Jan"));
        assert!(read.get_field(exif::Tag::Artist, exif::In::PRIMARY).is_some());
        assert!(read.get_field(exif::Tag::Make, exif::In::PRIMARY).is_none());
        let all = encode_tiff(&img, OutputProfile::Srgb, ExportMetadata::All, Some(&src)).unwrap();
        let read = exif::Reader::new().read_from_container(&mut Cursor::new(&all)).unwrap();
        assert!(read.get_field(exif::Tag::Make, exif::In::PRIMARY).is_some());
        let none = encode_tiff(&img, OutputProfile::Srgb, ExportMetadata::None, Some(&src)).unwrap();
        let read = exif::Reader::new().read_from_container(&mut Cursor::new(&none)).unwrap();
        assert!(read.get_field(exif::Tag::Copyright, exif::In::PRIMARY).is_none());
    }

    #[cfg(all(target_os = "macos", feature = "heic-imageio"))]
    #[test]
    fn heic_is_10_bit_with_its_profile_and_keeps_copyright_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        let src = source_with_exif(dir.path());
        let img = ExportFrame::Rgb8(gradient(97, 61)).to_rgb16().into_owned();
        let read = |bytes: &[u8]| exif::Reader::new().read_from_container(&mut Cursor::new(bytes)).ok();
        for (profile, name) in [(OutputProfile::Srgb, "SRGB"), (OutputProfile::DisplayP3, "P3")] {
            let bytes = encode_heic(&img, 80, profile, ExportMetadata::Copyright, Some(&src)).unwrap();
            let probe = heic::probe(&bytes).expect("ImageIO decodes the HEIC");
            assert_eq!((probe.width, probe.height, probe.bits), (97, 61, 10));
            assert!(probe.space.as_deref().is_some_and(|s| s.contains(name)), "{:?}", probe.space);
            let exif = read(&bytes).expect("the HEIC has Exif");
            let c = exif.get_field(exif::Tag::Copyright, exif::In::PRIMARY).unwrap();
            assert!(c.display_value().to_string().contains("(c) Jan"));
            assert!(exif.get_field(exif::Tag::Artist, exif::In::PRIMARY).is_some());
            assert!(exif.get_field(exif::Tag::Make, exif::In::PRIMARY).is_none());
        }
        let all = encode_heic(&img, 80, OutputProfile::Srgb, ExportMetadata::All, Some(&src)).unwrap();
        let exif = read(&all).expect("all keeps the Exif");
        assert!(exif.get_field(exif::Tag::Make, exif::In::PRIMARY).is_some());
        let none = encode_heic(&img, 80, OutputProfile::Srgb, ExportMetadata::None, Some(&src)).unwrap();
        assert!(read(&none).is_none_or(|e| e.get_field(exif::Tag::Copyright, exif::In::PRIMARY).is_none()));
    }

    #[test]
    fn a_16_bit_render_matches_the_8_bit_one() {
        let image = LinearImage::new(64, 40, (0..64 * 40 * 3).map(|i| (i % 193) as f32 / 192.0).collect());
        let settings: DevelopSettings = serde_json::from_str(r#"{"version":1,"light":{"exposure":0.3,"contrast":20}}"#).unwrap();
        let options = RenderOptions { backend: crate::RenderBackend::Cpu, ..RenderOptions::default() };
        let eight = render_full_with_options(&image, &settings, Quality::Export, &options).unwrap();
        let sixteen = crate::render::render_full16_with_options(&image, &settings, Quality::Export, &options).unwrap();
        assert_eq!((sixteen.width, sixteen.height), (eight.width, eight.height));
        let worst = eight.data.iter().zip(&sixteen.data).map(|(&a, &b)| (a as f32 - b as f32 / 257.0).abs()).fold(0.0, f32::max);
        // The 8-bit render is dithered by up to half a level.
        assert!(worst <= 1.0, "differs by {worst}");
    }

    #[test]
    fn watermark_lands_at_its_position_with_its_opacity() {
        let black = ExportFrame::Rgb8(Rgb8Image::new(200, 100, vec![0; 200 * 100 * 3]));
        let watermark = Watermark {
            text: "MMM".into(),
            size: 0.1,
            opacity: 0.5,
            position: WatermarkPosition::BottomRight,
            margin: 0.05,
            ..Watermark::default()
        };
        let options = ExportOptions { watermark: Some(watermark.clone()), ..ExportOptions::default() };
        let ExportFrame::Rgb8(out) = finish(black.clone(), &options, &ExportAssets::default()).unwrap() else { panic!() };
        assert_eq!((out.width, out.height), (200, 100));
        let lit: Vec<(u32, u32)> =
            (0..100).flat_map(|y| (0..200).map(move |x| (x, y))).filter(|&(x, y)| out.pixel(x, y)[0] > 0).collect();
        assert!(!lit.is_empty());
        // Bottom right, inside the 10 px margin; half of white at most.
        assert!(lit.iter().all(|&(x, y)| x >= 120 && x < 190 && y >= 60 && y < 90), "{lit:?}");
        let max = lit.iter().map(|&(x, y)| out.pixel(x, y)[0]).max().unwrap();
        assert!((126..=129).contains(&max), "opacity 0.5 gives {max}");
        // Top left mirrors it.
        let options = ExportOptions {
            watermark: Some(Watermark { position: WatermarkPosition::TopLeft, ..watermark.clone() }),
            ..ExportOptions::default()
        };
        let ExportFrame::Rgb8(out) = finish(black.clone(), &options, &ExportAssets::default()).unwrap() else { panic!() };
        assert!((0..100).flat_map(|y| (0..200).map(move |x| (x, y))).filter(|&(x, y)| out.pixel(x, y)[0] > 0).all(|(x, y)| x >= 10 && x < 80 && y >= 10 && y < 40));
        // An image watermark needs its PNG.
        let options = ExportOptions {
            watermark: Some(Watermark { kind: WatermarkKind::Image, image: Some("ab".repeat(32)), ..watermark }),
            ..ExportOptions::default()
        };
        assert!(finish(black, &options, &ExportAssets::default()).is_err());
    }

    #[test]
    fn border_keeps_the_long_edge_and_frames_the_photo() {
        let grey = ExportFrame::Rgb16(Rgb16Image::new(400, 200, vec![30000; 400 * 200 * 3]));
        let options = ExportOptions {
            long_edge: Some(200),
            border: Some(Border { width: 5.0, unit: BorderUnit::Percent, colour: "#ff0000".into() }),
            ..ExportOptions::default()
        };
        let ExportFrame::Rgb16(out) = finish(grey.clone(), &options, &ExportAssets::default()).unwrap() else { panic!() };
        // 10 px each side: the photo is fitted to 180 px and the file is 200 px wide.
        assert_eq!((out.width, out.height), (200, 110));
        assert_eq!(out.pixel(0, 0), [65535, 0, 0]);
        assert_eq!(out.pixel(9, 55), [65535, 0, 0]);
        assert_eq!(out.pixel(10, 10), [30000; 3]);
        assert_eq!(out.pixel(189, 99), [30000; 3]);
        assert_eq!(out.pixel(190, 100), [65535, 0, 0]);
        // In pixels without a long edge: added around the developed size.
        let options = ExportOptions {
            border: Some(Border { width: 3.0, unit: BorderUnit::Px, colour: "#000000".into() }),
            ..ExportOptions::default()
        };
        assert_eq!(finish(grey, &options, &ExportAssets::default()).unwrap().size(), (406, 206));
    }
}
