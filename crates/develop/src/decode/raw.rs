//! Camera RAW → [`LinearImage`] through `rawler` (D6.1, feature `raw`; plan section 4.4).
//!
//! Pipeline (the plan's default "process version" without camera profiles):
//!
//! 1. `rawler` decodes the sensor data (about 870 models: CR2/CR3, ARW, NEF, RAF incl. X-Trans, ORF, RW2, PEF,
//!    DNG, ...), with its black and white levels.
//! 2. Black/white level: values scaled to 0..1 per channel (`RawImage::apply_scaling`).
//! 3. As-shot white balance on the mosaic: each sensel times `1 / as_shot_neutral` of its colour (the camera's WB
//!    multipliers normalised so the smallest is 1), then clipped at 1. Balancing before demosaicing gives the
//!    demosaic hue-consistent input; the clip turns sensels past the first channel's saturation into white
//!    (dcraw's `-H 0`) instead of magenta. There is no highlight reconstruction.
//! 4. Demosaic: `rawler`'s PPG for Bayer, bilinear for X-Trans; active area and default crop.
//! 5. Colour, solved through the matrix ([`CameraColor`]): the white is the chromaticity whose camera neutral is
//!    the as-shot neutral (DNG `NeutralToXY`, the colour matrix interpolated by that white's temperature), camera
//!    → XYZ by the inverted matrix, CAT16 from that white to D65, XYZ → Rec.2020. White-balanced `(1, 1, 1)` maps
//!    to Rec.2020 `(1, 1, 1)`: a neutral that just saturates is diffuse white. Out-of-gamut (negative) values are
//!    left as they are; the output stage gamut-maps.
//! 6. `BaselineExposure` (DNG files; [`DEFAULT_BASELINE_EXPOSURE`] for proprietary formats, whose per-model
//!    value lives in Adobe's database, and DNGs without the tag) as a `2^BE` gain.
//! 7. Downscale to `max_long_edge` (linear Lanczos3), then the orientation from the file's metadata.
//!
//! The default display look is not applied here: [`ImageMeta::is_raw`] turns it on in
//! `RenderOptions::for_image`, which `render_full` and `render_preview` use.
//!
//! Cost: `rawler` has no reduced-resolution decode (nothing like JPEG's DCT scaling), so even a small proxy
//! decodes, demosaics and colour-converts the full sensor, then downscales. Peak memory is about 20 bytes per
//! sensel (≈ 0.5 GB for 24 MP). The editor makes RAW proxies from the embedded preview first ([`raw_info`],
//! [`embedded_preview`]: metadata and the camera's JPEG, no sensor decode).
//!
//! Not handled: 4-colour CFAs (CYGM, RGBE), monochrome sensors, lens corrections (DNG opcodes, maker notes),
//! camera profiles (DCP, `ForwardMatrix`, `ProfileHueSatMap`, `ProfileToneCurve`), `AnalogBalance` and
//! `CameraCalibration`.

use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::sync::Arc;

use rawler::decoders::{Decoder, RawDecodeParams, RawMetadata, WellKnownIFD};
use rawler::formats::tiff::Rational;
use rawler::imgop::develop::{Intermediate, ProcessingStep, RawDevelop};
use rawler::rawimage::RawPhotometricInterpretation;
use rawler::rawsource::RawSource;
use rawler::tags::DngTag;
use rawler::{RawImage, RawImageData, RawlerError};
use rayon::prelude::*;

use super::{fit_linear, orient};
use crate::color::camera::{illuminant_temperature, CameraColor, CameraMatrix};
use crate::color::matrix::{self, Mat3};
use crate::error::{Error, Result};
use crate::image::{ImageMeta, LinearImage};

/// A decoded RAW and what was read from the file.
#[derive(Debug, Clone)]
pub struct RawDecoded {
    /// Linear Rec.2020 (D65), as-shot white balance, `BaselineExposure` applied, upright. Its
    /// [`meta`](LinearImage::meta) carries `is_raw`, the as-shot `(Kelvin, tint)` and [`CameraData::color`].
    pub image: LinearImage,
    pub camera: CameraData,
}

/// Camera metadata of a RAW file.
#[derive(Debug, Clone)]
pub struct CameraData {
    pub make: String,
    pub model: String,
    /// ISO speed, when recorded.
    pub iso: Option<u32>,
    /// Exposure time in seconds.
    pub exposure_time: Option<f64>,
    pub f_number: Option<f64>,
    /// EXIF orientation 1..=8 applied to [`RawDecoded::image`].
    pub orientation: u32,
    /// The as-shot camera neutral (RGB, max channel 1): DNG `AsShotNeutral`, or the inverse of the maker's WB
    /// multipliers. The neutral of D65 when the file has none.
    pub as_shot_neutral: [f32; 3],
    /// The white balance multipliers applied (`1 / as_shot_neutral`, smallest 1).
    pub wb_multipliers: [f32; 3],
    /// The file's colour matrices (XYZ → camera, row-major) with their EXIF `LightSource` code
    /// (21 = D65, 17 = standard light A, ...). Empty when the camera had none (then the camera is taken as
    /// linear sRGB).
    pub color_matrices: Vec<(u16, [[f32; 3]; 3])>,
    /// Black levels subtracted (raw units, per CFA position or channel).
    pub black_level: Vec<f32>,
    /// White levels the data was normalised by (raw units, per channel).
    pub white_level: Vec<f32>,
    /// DNG `BaselineExposure` in EV ([`DEFAULT_BASELINE_EXPOSURE`] when absent), applied as a `2^BE` gain.
    pub baseline_exposure: f32,
    /// Matrices and neutral as used for the colour conversion and white balance (shared with the image's meta).
    pub color: Arc<CameraColor>,
}

/// The as-shot white balance of `camera` as `(Kelvin, tint)` (Robertson; tint on Lightroom's scale): the camera
/// neutral → XYZ through the interpolated colour matrix → xy → CCT and tint. `WhiteBalance::Absolute` at these
/// values renders like the as-shot decode.
pub fn camera_as_shot_kelvin_tint(camera: &CameraData) -> (f64, f64) {
    camera.color.as_shot_temperature()
}

/// Decode a camera RAW file to linear Rec.2020, as-shot white balance, upright, with its long edge at most
/// `max_long_edge` when given (decoded at full size, then downscaled: see the module notes on cost).
pub fn decode_raw(path: &Path, max_long_edge: Option<u32>) -> Result<RawDecoded> {
    // rawler has `todo!()`s and panics on unusual files; never let one take down the caller.
    match panic::catch_unwind(AssertUnwindSafe(|| decode_raw_inner(path, max_long_edge))) {
        Ok(result) => result,
        Err(_) => Err(Error::Invalid(format!("{}: the RAW decoder failed (unsupported variant)", path.display()))),
    }
}

fn rawler_error(err: RawlerError) -> Error {
    match err {
        RawlerError::Unsupported { .. } => Error::Unsupported(format!("RAW: {err}")),
        other => Error::Invalid(format!("RAW: {other}")),
    }
}

fn rational(r: &Rational) -> Option<f64> {
    (r.d != 0).then(|| r.n as f64 / r.d as f64)
}

/// Exposure (EV) applied to RAW files that carry no DNG `BaselineExposure` (every proprietary format, whose
/// per-model value lives in Adobe's database, and DNGs without the tag). Measured against the cameras' own
/// JPEGs on the ON1 sample set (Canon, Nikon, Sony; mean luminance with the display look on): without it the
/// as-shot renders were 0.3 to 1.4 EV darker (median 1.15); see `crates/develop/README.md` (RAW).
pub const DEFAULT_BASELINE_EXPOSURE: f32 = 1.0;

/// DNG `BaselineExposure` (root IFD), `None` when absent or not a DNG.
fn baseline_exposure(decoder: &dyn Decoder) -> Option<f32> {
    decoder
        .ifd(WellKnownIFD::VirtualDngRootTags)
        .ok()
        .flatten()
        .and_then(|ifd| ifd.get_entry(DngTag::BaselineExposure).and_then(|e| e.value.get_f32(0).ok().flatten()))
        .filter(|v| v.is_finite() && v.abs() < 10.0)
}

fn orientation(raw: &RawImage, md: Option<&RawMetadata>) -> u32 {
    md.and_then(|m| m.exif.orientation)
        .map(u32::from)
        .filter(|o| (1..=8).contains(o))
        .or_else(|| Some(raw.orientation.to_u16() as u32).filter(|o| (1..=8).contains(o)))
        .unwrap_or(1)
}

/// The camera's 3×3 colour matrices with their illuminant codes.
fn color_matrices(raw: &RawImage) -> Vec<(u16, [[f32; 3]; 3])> {
    let mut out: Vec<(u16, [[f32; 3]; 3])> = raw
        .color_matrix
        .iter()
        .filter(|(_, m)| m.len() == 9)
        .map(|(illu, m)| (u16::from(*illu), [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]]))
        .collect();
    out.sort_by_key(|(code, _)| *code);
    out
}

fn camera_color(matrices: &[(u16, [[f32; 3]; 3])], neutral: Option<[f64; 3]>) -> CameraColor {
    let to_f64 = |m: &[[f32; 3]; 3]| -> Mat3 { m.map(|row| row.map(f64::from)) };
    let mut list: Vec<CameraMatrix> = matrices
        .iter()
        .filter_map(|(code, m)| illuminant_temperature(*code).map(|t| CameraMatrix { temperature: t, xyz_to_camera: to_f64(m) }))
        .collect();
    if list.is_empty() {
        // Matrices with an unknown illuminant: take the first as daylight.
        list.extend(matrices.first().map(|(_, m)| CameraMatrix { temperature: 6500.0, xyz_to_camera: to_f64(m) }));
    }
    CameraColor::new(list.clone(), neutral)
        .or_else(|| {
            log::warn!("RAW: no colour matrix; treating the camera as linear sRGB");
            CameraColor::new(vec![CameraMatrix { temperature: 6500.0, xyz_to_camera: matrix::xyz_to_srgb() }], neutral)
        })
        .expect("a fixed matrix is always usable")
}

/// White-balance (multiply by `mult[colour]`) and clip at 1 the black/white-scaled data, before demosaicing.
fn balance_mosaic(raw: &mut RawImage, mult: [f32; 3]) -> Result<()> {
    let (width, cpp) = (raw.width, raw.cpp);
    let cfa = match &raw.photometric {
        RawPhotometricInterpretation::Cfa(config) => Some(config.cfa.clone()),
        _ => None,
    };
    let RawImageData::Float(data) = &mut raw.data else {
        return Err(Error::Invalid("RAW: data not scaled".into()));
    };
    match cfa {
        Some(cfa) => data.par_chunks_mut(width * cpp).enumerate().for_each(|(row, line)| {
            for (col, v) in line.iter_mut().enumerate() {
                let m = mult.get(cfa.color_at(row, col)).copied().unwrap_or(1.0);
                *v = (*v * m).min(1.0);
            }
        }),
        None => data.par_chunks_mut(3).for_each(|px| {
            for (v, m) in px.iter_mut().zip(mult) {
                *v = (*v * m).min(1.0);
            }
        }),
    }
    Ok(())
}

fn decode_raw_inner(path: &Path, max_long_edge: Option<u32>) -> Result<RawDecoded> {
    let source = RawSource::new(path)?;
    let decoder = rawler::get_decoder(&source).map_err(rawler_error)?;
    let params = RawDecodeParams::default();
    let mut raw = decoder.raw_image(&source, &params, false).map_err(rawler_error)?;
    let md = decoder.raw_metadata(&source, &params).ok();
    let baseline_exposure = baseline_exposure(decoder.as_ref()).unwrap_or(DEFAULT_BASELINE_EXPOSURE);
    drop(decoder);
    drop(source);

    match &raw.photometric {
        RawPhotometricInterpretation::Cfa(config) if config.cfa.is_rgb() && raw.cpp == 1 => {}
        RawPhotometricInterpretation::LinearRaw if raw.cpp == 3 => {}
        RawPhotometricInterpretation::Cfa(config) => {
            return Err(Error::Unsupported(format!("RAW: {}-colour sensor ({})", config.cfa.unique_colors(), config.cfa.name)))
        }
        _ => return Err(Error::Unsupported("RAW: monochrome or non-RGB sensor".into())),
    }

    let matrices = color_matrices(&raw);
    let wb = raw.wb_coeffs;
    let neutral = (wb[..3].iter().all(|v| v.is_finite() && *v > 0.0))
        .then(|| [1.0 / wb[0] as f64, 1.0 / wb[1] as f64, 1.0 / wb[2] as f64]);
    let color = Arc::new(camera_color(&matrices, neutral));
    let n = color.as_shot_neutral;
    let mult = [(1.0 / n[0]) as f32, (1.0 / n[1]) as f32, (1.0 / n[2]) as f32];
    let black_level = raw.blacklevel.as_vec();
    let white_level: Vec<f32> = raw.whitelevel.0.iter().map(|&v| v as f32).collect();
    let orientation = orientation(&raw, md.as_ref());

    raw.apply_scaling().map_err(rawler_error)?;
    balance_mosaic(&mut raw, mult)?;
    let steps = [ProcessingStep::Demosaic, ProcessingStep::FujiRotate, ProcessingStep::CropActiveArea, ProcessingStep::CropDefault];
    let intermediate = RawDevelop::new_with(&steps).develop_intermediate(&raw).map_err(rawler_error)?;
    let (make, model) = (raw.clean_make.clone(), raw.clean_model.clone());
    drop(raw);
    let Intermediate::ThreeColor(pixels) = intermediate else {
        return Err(Error::Unsupported("RAW: the demosaic did not produce RGB".into()));
    };

    let (w, h) = (pixels.dim().w, pixels.dim().h);
    let gain = 2f64.powf(baseline_exposure as f64);
    let m = matrix::to_f32(&color.balanced_to_rec2020().map(|row| row.map(|v| v * gain)));
    let mut data = vec![0.0f32; w * h * 3];
    data.par_chunks_mut(w.max(1) * 3).zip(pixels.pixels().par_chunks(w.max(1))).for_each(|(dst, src)| {
        for (d, s) in dst.chunks_exact_mut(3).zip(src) {
            d.copy_from_slice(&matrix::apply_f32(&m, s[0], s[1], s[2]));
        }
    });
    drop(pixels);

    let (w, h) = (w as u32, h as u32);
    let image = fit_linear(LinearImage::new(w, h, data), (w, h), max_long_edge)?;
    let meta = ImageMeta { is_raw: true, as_shot: Some(color.as_shot_temperature()), camera: Some(color.clone()), noise_sigma: None };
    let image = orient(image, orientation).with_meta(meta);

    let exif = md.as_ref().map(|m| &m.exif);
    let iso = exif.and_then(|e| e.iso_speed_ratings.map(u32::from).or(e.iso_speed).or(e.recommended_exposure_index));
    let camera = CameraData {
        make,
        model,
        iso,
        exposure_time: exif.and_then(|e| e.exposure_time.as_ref()).and_then(rational),
        f_number: exif.and_then(|e| e.fnumber.as_ref()).and_then(rational),
        orientation,
        as_shot_neutral: n.map(|v| v as f32),
        wb_multipliers: mult,
        color_matrices: matrices,
        black_level,
        white_level,
        baseline_exposure,
        color,
    };
    Ok(RawDecoded { image, camera })
}

// ---------- metadata and embedded previews (the editor's scan) ----------

/// What the editor's scan needs from a RAW file without decoding the sensor data ([`raw_info`]).
#[derive(Debug, Clone, PartialEq)]
pub struct RawInfo {
    /// Upright size of the full-resolution [`decode_raw`] output (active area and default crop, then the
    /// orientation).
    pub width: u32,
    pub height: u32,
    /// EXIF orientation 1..=8 that [`decode_raw`] applies (and that the embedded previews need).
    pub orientation: u32,
    /// The as-shot white balance as `(Kelvin, tint)`, as in [`camera_as_shot_kelvin_tint`].
    pub as_shot: (f64, f64),
}

/// The size, orientation and as-shot white balance of a RAW file, read from its metadata only (rawler's
/// "dummy" decode: no sensor data is decompressed, a few milliseconds). Errors for the same files
/// [`decode_raw`] rejects, and for Fujifilm's 45°-rotated sensors, whose output size only the full decode knows.
pub fn raw_info(path: &Path) -> Result<RawInfo> {
    match panic::catch_unwind(AssertUnwindSafe(|| raw_info_inner(path))) {
        Ok(result) => result,
        Err(_) => Err(Error::Invalid(format!("{}: the RAW decoder failed (unsupported variant)", path.display()))),
    }
}

fn raw_info_inner(path: &Path) -> Result<RawInfo> {
    let source = RawSource::new(path)?;
    let decoder = rawler::get_decoder(&source).map_err(rawler_error)?;
    let params = RawDecodeParams::default();
    let raw = decoder.raw_image(&source, &params, true).map_err(rawler_error)?;
    let md = decoder.raw_metadata(&source, &params).ok();
    match &raw.photometric {
        RawPhotometricInterpretation::Cfa(config) if config.cfa.is_rgb() && raw.cpp == 1 => {}
        RawPhotometricInterpretation::LinearRaw if raw.cpp == 3 => {}
        _ => return Err(Error::Unsupported("RAW: not an RGB sensor".into())),
    }
    if raw.fuji_rotation_width.is_some() {
        return Err(Error::Unsupported("RAW: rotated sensor; size known after decoding".into()));
    }
    // decode_raw crops the active area while demosaicing, then the default crop (inside the active area).
    let area = raw.crop_area.or(raw.active_area);
    let (w, h) = area.map_or((raw.width, raw.height), |r| (r.d.w, r.d.h));
    let orientation = orientation(&raw, md.as_ref());
    let wb = raw.wb_coeffs;
    let neutral = (wb[..3].iter().all(|v| v.is_finite() && *v > 0.0))
        .then(|| [1.0 / wb[0] as f64, 1.0 / wb[1] as f64, 1.0 / wb[2] as f64]);
    let color = camera_color(&color_matrices(&raw), neutral);
    let (w, h) = (w as u32, h as u32);
    let (width, height) = if (5..=8).contains(&orientation) { (h, w) } else { (w, h) };
    Ok(RawInfo { width, height, orientation, as_shot: color.as_shot_temperature() })
}

/// A JPEG the camera embedded in the RAW file, decoded to 8-bit sRGB. Stored like the sensor data: apply
/// [`RawInfo::orientation`] to view it upright. Its framing can differ slightly from the default crop.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddedPreview {
    pub width: u32,
    pub height: u32,
    /// Interleaved RGB, `width * height * 3` bytes.
    pub rgb: Vec<u8>,
}

/// The camera's embedded preview of a RAW file when one with a long edge of at least `min_long_edge` exists:
/// rawler's preview image (the large JPEG most formats carry), else its full-size image, else its thumbnail.
/// `None` when there is none that large or it cannot be read.
pub fn embedded_preview(path: &Path, min_long_edge: u32) -> Option<EmbeddedPreview> {
    panic::catch_unwind(AssertUnwindSafe(|| embedded_preview_inner(path, min_long_edge))).ok().flatten()
}

fn embedded_preview_inner(path: &Path, min_long_edge: u32) -> Option<EmbeddedPreview> {
    let source = RawSource::new(path).ok()?;
    let decoder = rawler::get_decoder(&source).ok()?;
    let params = RawDecodeParams::default();
    let big_enough = |img: &::image::DynamicImage| img.width().max(img.height()) >= min_long_edge;
    let image = decoder
        .preview_image(&source, &params)
        .ok()
        .flatten()
        .filter(big_enough)
        .or_else(|| decoder.full_image(&source, &params).ok().flatten().filter(big_enough))
        .or_else(|| decoder.thumbnail_image(&source, &params).ok().flatten().filter(big_enough))?;
    let rgb = image.to_rgb8();
    let (width, height) = rgb.dimensions();
    Some(EmbeddedPreview { width, height, rgb: rgb.into_raw() })
}
