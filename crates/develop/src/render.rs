//! Entry points for previews and exports, JPEG encoding (tagged with the output profile) and Exif copying.

use std::cell::OnceCell;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use turbojpeg::{Compressor, PixelFormat, Subsamp};

use crate::color::OutputProfile;
use crate::cpu::masked::union_needs;
use crate::cpu::{develop_with_masks, develop_with_masks16, one_shot_blend, LocalBlend, Params, RenderOptions};
use crate::decode::{fit, resize_linear};
use crate::error::Result;
use crate::geometry::{warp, GeometryPlan, Quality};
use crate::gpu::{self, Tiling};
use crate::image::{ImageMeta, LinearImage, Rgb16Image, Rgb8Image};
use crate::jpeg_markers;
use crate::local::PrePasses;
use crate::settings::DevelopSettings;

impl RenderOptions {
    /// The default options for `meta`'s source: the display look on for camera RAW (a scene-referred decode
    /// needs a tone curve to look like a photo; plan D6.1), off for JPEG, PNG and HEIC (already rendered by the
    /// camera or app). The settings have no field to switch it; pass explicit options to override.
    pub fn for_image(meta: &ImageMeta) -> Self {
        Self { look: meta.is_raw, ..Self::default() }
    }
}

/// Quality at and above which [`encode_jpeg`] keeps full chroma (4:4:4), for exports.
pub const FULL_CHROMA_QUALITY: u8 = 95;

/// Develop without geometry (the image is already in its output framing), with the masks on its grid.
fn develop_prepared(image: &LinearImage, params: &Params, blend: Option<&LocalBlend>) -> Rgb8Image {
    let pre = PrePasses::new();
    let needs = union_needs(params.needs(), blend.map(LocalBlend::needs));
    develop_with_masks(image, &pre.prepare(image, &needs), params, blend)
}

/// Develop the whole image at its own resolution (the export path). The output is the cropped size
/// ([`crate::geometry::developed_size`]); the geometry resamples with [`Quality::for_size`] of the image.
/// Runs on the GPU when one is available (tiled above [`crate::gpu::TILE_SIZE`]), else on the CPU in one
/// piece.
///
/// Uses [`RenderOptions::for_image`]: the display look is on for RAW input, off otherwise.
pub fn render_full(image: &LinearImage, settings: &DevelopSettings) -> Result<Rgb8Image> {
    render_full_with(image, settings, Quality::for_size(image.width, image.height))
}

/// [`render_full`] with an explicit resampling quality for the geometry.
pub fn render_full_with(image: &LinearImage, settings: &DevelopSettings, quality: Quality) -> Result<Rgb8Image> {
    render_full_with_options(image, settings, quality, &RenderOptions::for_image(&image.meta))
}

/// [`render_full_with`] with explicit [`RenderOptions`] (display look, backend).
pub fn render_full_with_options(
    image: &LinearImage,
    settings: &DevelopSettings,
    quality: Quality,
    options: &RenderOptions,
) -> Result<Rgb8Image> {
    let params = Params::for_image(settings, options, &image.meta);
    let plan = GeometryPlan::new(&settings.geometry, image.width, image.height, None);
    let warped = OnceCell::new();
    let input = || if plan.is_identity() { image } else { warped.get_or_init(|| warp(image, &plan, quality)) };
    // Masks are rasterised on the CPU for both backends (range components read the CPU warp).
    let blend = one_shot_blend(settings, &params, &plan, || Ok(input()))?;
    if let Some(ctx) = gpu::context_for(options).filter(|_| gpu::fits_masks(blend.as_ref()) && gpu::supports(settings)) {
        if let Some(out) = gpu::render_once(ctx, image, settings, options, quality, None, Tiling::Auto, blend.as_ref()) {
            return Ok(out);
        }
    }
    Ok(develop_prepared(input(), &params, blend.as_ref()))
}

/// [`render_full_with_options`] into 16 bits per channel (no dither), for the export's TIFF and HEIC (workflow plan
/// 12). Always on the CPU (the reference; the GPU path writes 8-bit), so it is slower than an 8-bit full render.
pub fn render_full16_with_options(
    image: &LinearImage,
    settings: &DevelopSettings,
    quality: Quality,
    options: &RenderOptions,
) -> Result<Rgb16Image> {
    let params = Params::for_image(settings, options, &image.meta);
    let plan = GeometryPlan::new(&settings.geometry, image.width, image.height, None);
    let warped = OnceCell::new();
    let input = || if plan.is_identity() { image } else { warped.get_or_init(|| warp(image, &plan, quality)) };
    let blend = one_shot_blend(settings, &params, &plan, || Ok(input()))?;
    let prepared = input();
    let pre = PrePasses::new();
    let needs = union_needs(params.needs(), blend.as_ref().map(LocalBlend::needs));
    Ok(develop_with_masks16(prepared, &pre.prepare(prepared, &needs), &params, blend.as_ref()))
}

/// Develop and encode a preview JPEG whose long edge is at most `long_edge`. A larger image is
/// downscaled first, in linear light: cheaper than developing at full size, and equivalent because
/// every neighbourhood radius scales with the image. Prefer decoding at the right size up front
/// (`decode_file(path, Some(long_edge))`) and keeping a [`crate::Developer`] for repeated renders.
///
/// With a geometry, the long edge applies to the cropped output and the image is warped straight into
/// that size (one resample, [`Quality::Preview`]).
///
/// Uses [`RenderOptions::for_image`]: the display look is on for RAW input, off otherwise.
pub fn render_preview(image: &LinearImage, settings: &DevelopSettings, long_edge: u32, quality: u8) -> Result<Vec<u8>> {
    render_preview_with(image, settings, long_edge, quality, &RenderOptions::for_image(&image.meta))
}

/// [`render_preview`] with explicit [`RenderOptions`] (display look, backend, output profile); the JPEG is tagged
/// with `options.output`'s profile.
pub fn render_preview_with(
    image: &LinearImage,
    settings: &DevelopSettings,
    long_edge: u32,
    quality: u8,
    options: &RenderOptions,
) -> Result<Vec<u8>> {
    encode_jpeg_as(&render_preview_image_with(image, settings, long_edge, options)?, quality, options.output)
}

/// [`render_preview_with`] before the encode: the developed preview pixels (for a preview mode drawn over them,
/// plan 53).
pub fn render_preview_image_with(
    image: &LinearImage,
    settings: &DevelopSettings,
    long_edge: u32,
    options: &RenderOptions,
) -> Result<Rgb8Image> {
    let edge = long_edge.max(1);
    let identity = GeometryPlan::new(&settings.geometry, image.width, image.height, None).is_identity();
    let (w, h) = fit(image.width, image.height, edge);
    if identity && (w, h) == (image.width, image.height) {
        let quality_full = Quality::for_size(image.width, image.height);
        return render_full_with_options(image, settings, quality_full, options);
    }
    let params = Params::for_image(settings, options, &image.meta);
    // The preview grid: the crop fitted to the long edge (a plain resize without geometry).
    let plan = GeometryPlan::new(&settings.geometry, image.width, image.height, Some(edge));
    let small: OnceCell<LinearImage> = OnceCell::new();
    let input = || -> Result<&LinearImage> {
        if let Some(s) = small.get() {
            return Ok(s);
        }
        let s = if identity { resize_linear(image.clone(), w, h)? } else { warp(image, &plan, Quality::Preview) };
        Ok(small.get_or_init(|| s))
    };
    let blend = one_shot_blend(settings, &params, &plan, &input)?;
    if let Some(ctx) = gpu::context_for(options).filter(|_| gpu::fits_masks(blend.as_ref()) && gpu::supports(settings)) {
        let target = Some(edge);
        if let Some(out) = gpu::render_once(ctx, image, settings, options, Quality::Preview, target, Tiling::Auto, blend.as_ref()) {
            return Ok(out);
        }
    }
    Ok(develop_prepared(input()?, &params, blend.as_ref()))
}

/// A compact sRGB ICC profile ([`OutputProfile::icc`]: v4.3 matrix/TRC, parametric sRGB curve).
pub fn srgb_icc() -> &'static [u8] {
    OutputProfile::Srgb.icc()
}

/// A compact Display P3 ICC profile ([`OutputProfile::icc`]), for renders with [`RenderOptions::output`] P3.
pub fn display_p3_icc() -> &'static [u8] {
    OutputProfile::DisplayP3.icc()
}

/// Encode as JPEG, tagged with an sRGB ICC profile. 4:2:0 chroma below quality
/// [`FULL_CHROMA_QUALITY`], 4:4:4 at or above it.
pub fn encode_jpeg(image: &Rgb8Image, quality: u8) -> Result<Vec<u8>> {
    encode_jpeg_as(image, quality, OutputProfile::Srgb)
}

/// [`encode_jpeg`] tagged with `profile`'s ICC profile: pass the [`RenderOptions::output`] the image was rendered
/// with, so the webview and browsers colour-manage it.
pub fn encode_jpeg_as(image: &Rgb8Image, quality: u8, profile: OutputProfile) -> Result<Vec<u8>> {
    let mut compressor = Compressor::new()?;
    compressor.set_quality(quality.clamp(1, 100) as i32)?;
    compressor.set_subsamp(if quality >= FULL_CHROMA_QUALITY { Subsamp::None } else { Subsamp::Sub2x2 })?;
    let (width, height) = (image.width as usize, image.height as usize);
    let img = turbojpeg::Image { pixels: image.data.as_slice(), width, pitch: width * 3, height, format: PixelFormat::RGB };
    let mut bytes = compressor.compress_to_vec(img)?;
    jpeg_markers::insert_icc(&mut bytes, profile.icc());
    Ok(bytes)
}

/// Copy the Exif of `src` into `jpeg` (output of [`encode_jpeg`]) as an APP1 segment, with its Orientation reset
/// to 1 because rendered pixels are already upright. `src` is a JPEG (its APP1 segment is copied as is) or a
/// HEIC/HEIF file (the Exif item is read from the container with `kamadak-exif`). Returns whether anything was
/// copied (`false` for a source without Exif or any other format, e.g. a PNG).
pub fn copy_exif(src: &Path, jpeg: &mut Vec<u8>) -> Result<bool> {
    // The Exif segment of a JPEG sits in the first 64 KiB after the other headers; never read the whole file.
    let mut head = Vec::new();
    File::open(src)?.take(512 * 1024).read_to_end(&mut head)?;
    let Some(mut exif) = (if is_heif(&head) { heif_exif(src) } else { jpeg_markers::read_exif(&head) }) else {
        return Ok(false);
    };
    jpeg_markers::reset_orientation(&mut exif);
    Ok(jpeg_markers::insert_exif(jpeg, &exif))
}

/// Whether `head` starts with an ISO-BMFF `ftyp` box naming a HEIF-family brand.
fn is_heif(head: &[u8]) -> bool {
    head.get(4..8) == Some(b"ftyp") && head.get(8..12).is_some_and(|brand| {
        matches!(brand, b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"hevm" | b"hevs" | b"mif1" | b"msf1")
    })
}

/// The Exif of a HEIF file as an APP1 payload (`Exif\0\0` and the TIFF data), if it has any.
fn heif_exif(src: &Path) -> Option<Vec<u8>> {
    let mut reader = std::io::BufReader::new(File::open(src).ok()?);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(exif.buf());
    Some(payload)
}
