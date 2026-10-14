//! Decoding to [`LinearImage`]: linear Rec.2020 (D65), `f32`, upright.
//!
//! - JPEG through libjpeg-turbo (`turbojpeg`), DCT-scaled to the smallest scale whose long edge still
//!   covers the requested size, like the editor's proxies.
//! - PNG (8 or 16 bit) through `image`, alpha composited over white in the encoded values (what a
//!   browser shows).
//! - Camera RAW (`.dng .cr2 .cr3 .arw .raf .nef ...`, see [`RAW_EXTENSIONS`]) through `rawler`, behind the `raw`
//!   feature ([`raw`]); the image carries the camera's white balance data in [`LinearImage::meta`].
//! - HEIC/HEIF (`.heic .heif .hif`) through ImageIO on macOS, behind the `heic-imageio` feature ([`heic`], D6.2):
//!   decoded at the file's bit depth into extended linear sRGB half floats by CoreGraphics (the file's ICC or nclx
//!   colour applied by ColorSync), then to Rec.2020. Without the feature, or on other platforms,
//!   [`Error::Unsupported`] (the editor then converts it with `sips`).
//!
//! Colour: an embedded ICC profile (JPEG APP2, PNG iCCP) that is not sRGB-like is applied with `moxcms`
//! into linear Rec.2020; otherwise the pixels are taken as sRGB (inverse transfer function, then the
//! BT.709 → BT.2020 matrix). PNG gAMA/cHRM/cICP chunks are ignored.
//!
//! When `max_long_edge` is set and the decoded image is still larger, it is downscaled to fit with
//! Lanczos3 **in linear light** (`f32`), before orientation is applied. The result is never upscaled.

#[cfg(all(target_os = "macos", feature = "heic-imageio"))]
pub mod heic;
// Workflow plan 23: camera make, model and ISO for the noise profiles.
mod camera_meta;
mod icc;
mod jpeg;
mod png;
#[cfg(feature = "raw")]
pub mod raw;

use std::io::{BufRead, Seek};
use std::path::Path;

use fast_image_resize as fr;
use rayon::prelude::*;

use crate::color::{matrix, transfer};
use crate::error::{Error, Result};
use crate::image::LinearImage;

pub use jpeg::decode_jpeg;
pub use camera_meta::{camera_exif, clean_make, clean_model, CameraExif, Gps};
// Workflow plan 22: the Fujifilm film simulation tag (Match camera JPEG's suggestion).
pub use camera_meta::{film_simulation, film_tag, FilmTag};
#[cfg(feature = "raw")]
pub use raw::{camera_as_shot_kelvin_tint, decode_raw, CameraData, RawDecoded};

/// Camera RAW extensions (lower case) [`decode_file`] sends to the RAW decoder. The editor's scan should use the
/// same list.
pub const RAW_EXTENSIONS: &[&str] =
    &["dng", "cr2", "cr3", "crw", "arw", "srf", "sr2", "raf", "nef", "nrw", "orf", "rw2", "rwl", "pef", "srw", "erf", "3fr", "fff", "iiq", "mos", "mef", "mrw", "kdc", "dcr", "x3f"];

/// True when `path`'s extension is one of [`RAW_EXTENSIONS`].
pub fn is_raw_path(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    RAW_EXTENSIONS.contains(&ext.as_str())
}

/// Decode `path` (JPEG, PNG, HEIC/HEIF on macOS or camera RAW, by extension) to linear Rec.2020, upright, with its long edge at most
/// `max_long_edge` when given. RAW needs the `raw` feature (else [`Error::Unsupported`]); a RAW image's
/// [`LinearImage::meta`] carries its as-shot white balance and camera matrices.
pub fn decode_file(path: &Path, max_long_edge: Option<u32>) -> Result<LinearImage> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    let result = match ext.as_str() {
        "jpg" | "jpeg" | "jpe" | "jfif" => std::fs::read(path).map_err(Error::from).and_then(|b| decode_jpeg(&b, max_long_edge)),
        "png" => png::decode_png(path, max_long_edge),
        #[cfg(feature = "raw")]
        e if RAW_EXTENSIONS.contains(&e) => raw::decode_raw(path, max_long_edge).map(|r| r.image),
        #[cfg(not(feature = "raw"))]
        e if RAW_EXTENSIONS.contains(&e) => Err(Error::Unsupported(format!("{} (built without RAW support)", path.display()))),
        #[cfg(all(target_os = "macos", feature = "heic-imageio"))]
        "heic" | "heif" | "hif" => heic::decode_heic(path, max_long_edge),
        #[cfg(not(all(target_os = "macos", feature = "heic-imageio")))]
        "heic" | "heif" | "hif" => Err(Error::Unsupported(format!("{} (convert HEIC to JPEG first)", path.display()))),
        _ => Err(Error::Unsupported(format!("{} (not a JPEG, PNG, HEIC or RAW file)", path.display()))),
    };
    result.map_err(|err| match err {
        Error::Unsupported(_) => err,
        other => Error::Invalid(format!("{}: {other}", path.display())),
    })
}

/// EXIF orientation 1..=8 (1 when absent or unreadable).
pub(crate) fn exif_orientation<R: BufRead + Seek>(reader: &mut R) -> u32 {
    exif::Reader::new()
        .read_from_container(reader)
        .ok()
        .and_then(|exif| exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)))
        .filter(|o| (1..=8).contains(o))
        .unwrap_or(1)
}

/// 8-bit sRGB-encoded RGB → linear Rec.2020.
pub(crate) fn srgb8_to_linear(pixels: &[u8], width: usize) -> Vec<f32> {
    let lut = transfer::srgb_u8_lut();
    let m = matrix::to_f32(&matrix::srgb_to_rec2020());
    let mut out = vec![0.0f32; pixels.len()];
    out.par_chunks_mut(width * 3).zip(pixels.par_chunks(width * 3)).for_each(|(dst, src)| {
        for (d, s) in dst.chunks_exact_mut(3).zip(src.chunks_exact(3)) {
            d.copy_from_slice(&matrix::apply_f32(&m, lut[s[0] as usize], lut[s[1] as usize], lut[s[2] as usize]));
        }
    });
    out
}

/// sRGB-encoded RGB in 0..1 → linear Rec.2020, in place.
pub(crate) fn srgb_f32_to_linear(pixels: &mut [f32], width: usize) {
    let m = matrix::to_f32(&matrix::srgb_to_rec2020());
    pixels.par_chunks_mut(width * 3).for_each(|row| {
        for p in row.chunks_exact_mut(3) {
            let (r, g, b) = (transfer::srgb_to_linear(p[0]), transfer::srgb_to_linear(p[1]), transfer::srgb_to_linear(p[2]));
            p.copy_from_slice(&matrix::apply_f32(&m, r, g, b));
        }
    });
}

/// Size of `w × h` scaled so its long edge is at most `edge` (never upscaled).
pub(crate) fn fit(w: u32, h: u32, edge: u32) -> (u32, u32) {
    let long = w.max(h);
    if long <= edge {
        return (w, h);
    }
    let scale = |v: u32| ((v as f64 * edge as f64 / long as f64).round() as u32).max(1);
    if w >= h {
        (edge, scale(h))
    } else {
        (scale(w), edge)
    }
}

/// Lanczos3 resize of a linear image (no-op when the size already matches).
pub fn resize_linear(image: LinearImage, width: u32, height: u32) -> Result<LinearImage> {
    if (image.width, image.height) == (width, height) {
        return Ok(image);
    }
    let src: Vec<fr::pixels::F32x3> =
        image.data.chunks_exact(3).map(|p| fr::pixels::F32x3::new([p[0], p[1], p[2]])).collect();
    let src = fr::images::TypedImageRef::new(image.width, image.height, &src)?;
    let mut dst = fr::images::TypedImage::<fr::pixels::F32x3>::new(width, height);
    let options = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3));
    fr::Resizer::new().resize_typed(&src, &mut dst, &options)?;
    let data = dst.pixels().iter().flat_map(|p| p.0).collect();
    Ok(LinearImage::new(width, height, data).with_meta(image.meta))
}

/// Downscale to fit `max_long_edge` when given and needed. The target size is computed from the
/// file's full size `(full_w, full_h)` so a DCT-scaled decode lands on the same size a full decode would.
pub(crate) fn fit_linear(image: LinearImage, (full_w, full_h): (u32, u32), max_long_edge: Option<u32>) -> Result<LinearImage> {
    match max_long_edge {
        Some(edge) if edge > 0 => {
            let (w, h) = fit(full_w, full_h, edge);
            if w > image.width || h > image.height {
                return Ok(image);
            }
            resize_linear(image, w, h)
        }
        _ => Ok(image),
    }
}

/// Apply an EXIF orientation (1..=8) so the image is upright.
pub fn orient(image: LinearImage, orientation: u32) -> LinearImage {
    if !(2..=8).contains(&orientation) {
        return image;
    }
    let (w, h) = (image.width as usize, image.height as usize);
    let (ow, oh) = if orientation >= 5 { (h, w) } else { (w, h) };
    // Source pixel for each output pixel; see the EXIF 2.3 orientation table.
    let src_of = |x: usize, y: usize| -> (usize, usize) {
        match orientation {
            2 => (w - 1 - x, y),
            3 => (w - 1 - x, h - 1 - y),
            4 => (x, h - 1 - y),
            5 => (y, x),
            6 => (y, h - 1 - x),
            7 => (w - 1 - y, h - 1 - x),
            _ => (w - 1 - y, x),
        }
    };
    let mut data = vec![0.0f32; image.data.len()];
    data.par_chunks_mut(ow * 3).enumerate().for_each(|(y, row)| {
        for x in 0..ow {
            let (sx, sy) = src_of(x, y);
            let s = (sy * w + sx) * 3;
            row[x * 3..x * 3 + 3].copy_from_slice(&image.data[s..s + 3]);
        }
    });
    LinearImage::new(ow as u32, oh as u32, data).with_meta(image.meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tagged(w: u32, h: u32) -> LinearImage {
        let data = (0..w * h).flat_map(|i| [i as f32, 0.0, 0.0]).collect();
        LinearImage::new(w, h, data)
    }

    #[test]
    fn orientations_match_the_exif_table() {
        // 3×2 source, pixel value = index: [0 1 2 / 3 4 5].
        let at = |img: &LinearImage| -> Vec<u32> { img.data.chunks(3).map(|p| p[0] as u32).collect() };
        assert_eq!(at(&orient(tagged(3, 2), 2)), vec![2, 1, 0, 5, 4, 3]);
        assert_eq!(at(&orient(tagged(3, 2), 3)), vec![5, 4, 3, 2, 1, 0]);
        assert_eq!(at(&orient(tagged(3, 2), 4)), vec![3, 4, 5, 0, 1, 2]);
        assert_eq!(at(&orient(tagged(3, 2), 5)), vec![0, 3, 1, 4, 2, 5]);
        // 6 = rotate 90° clockwise to view.
        assert_eq!(at(&orient(tagged(3, 2), 6)), vec![3, 0, 4, 1, 5, 2]);
        assert_eq!(at(&orient(tagged(3, 2), 7)), vec![5, 2, 4, 1, 3, 0]);
        assert_eq!(at(&orient(tagged(3, 2), 8)), vec![2, 5, 1, 4, 0, 3]);
        assert_eq!(orient(tagged(3, 2), 6).width, 2);
    }

    #[test]
    fn fit_never_upscales() {
        assert_eq!(fit(6000, 4000, 1600), (1600, 1067));
        assert_eq!(fit(4000, 6000, 1600), (1067, 1600));
        assert_eq!(fit(800, 600, 1600), (800, 600));
    }

    #[test]
    fn resize_keeps_flat_colour() {
        let img = LinearImage::new(40, 20, [0.18f32, 0.5, 0.02].repeat(800));
        let small = resize_linear(img, 10, 5).unwrap();
        for p in small.data.chunks(3) {
            assert!((p[0] - 0.18).abs() < 1e-5 && (p[1] - 0.5).abs() < 1e-5 && (p[2] - 0.02).abs() < 1e-5);
        }
    }
}
