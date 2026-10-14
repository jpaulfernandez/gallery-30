//! HEIC/HEIF through ImageIO and CoreGraphics (macOS, feature `heic-imageio`, plan step D6.2).
//!
//! ImageIO decodes the primary image at its own bit depth (8 or 10 bit); CoreGraphics draws it into a 16-bit
//! half-float RGBA bitmap in `kCGColorSpaceExtendedLinearSRGB`, which applies the file's colour (its ICC profile
//! or nclx colour information, Display P3 on iPhones) with ColorSync and keeps colours outside sRGB as values
//! below 0 or above 1. The linear extended sRGB is then taken to linear Rec.2020 with the BT.709 → BT.2020 matrix,
//! so nothing is clipped on the way. Transparent pixels are composited over white (as the PNG path does).
//!
//! `CGImageSourceCreateImageAtIndex` does not orient: the EXIF-style orientation (`kCGImagePropertyOrientation`,
//! which ImageIO derives from the HEIF `irot`/`imir` properties) is applied by [`super::orient`] after the
//! linear-light downscale, like the JPEG path.

use std::ffi::c_void;
use std::path::Path;

use objc2_core_foundation::{CFData, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    kCGColorSpaceExtendedLinearSRGB, CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo,
    CGImageByteOrderInfo, CGImageComponentInfo,
};
use objc2_image_io::{kCGImagePropertyOrientation, CGImageSource};
use rayon::prelude::*;

use super::{fit_linear, orient};
use crate::color::matrix;
use crate::error::{Error, Result};
use crate::image::LinearImage;

/// HEIF-family extensions (lower case) [`super::decode_file`] sends here.
pub const HEIC_EXTENSIONS: &[&str] = &["heic", "heif", "hif"];

/// Decode a HEIC/HEIF file to linear Rec.2020, upright, long edge at most `max_long_edge`.
pub fn decode_heic(path: &Path, max_long_edge: Option<u32>) -> Result<LinearImage> {
    let bytes = std::fs::read(path)?;
    let data = CFData::from_bytes(&bytes);
    // SAFETY: no options dictionary.
    let source = unsafe { CGImageSource::with_data(&data, None) }
        .ok_or_else(|| Error::Invalid("ImageIO could not open the file".into()))?;
    // SAFETY: index 0 with no options; the source stays alive for the image's lifetime (CFRetained).
    let image = unsafe { source.image_at_index(0, None) }
        .ok_or_else(|| Error::Invalid("ImageIO could not decode the primary image".into()))?;
    let orientation = orientation(&source);
    let (w, h) = (CGImage::width(Some(&image)), CGImage::height(Some(&image)));
    if w == 0 || h == 0 {
        return Err(Error::Invalid("empty image".into()));
    }
    let halves = draw_linear(&image, w, h)?;
    drop(image);
    drop(source);

    let m = matrix::to_f32(&matrix::srgb_to_rec2020());
    let mut out = vec![0.0f32; w * h * 3];
    out.par_chunks_mut(w * 3).zip(halves.par_chunks(w * 4)).for_each(|(dst, src)| {
        for (d, s) in dst.chunks_exact_mut(3).zip(src.chunks_exact(4)) {
            let (r, g, b) = (f16_to_f32(s[0]), f16_to_f32(s[1]), f16_to_f32(s[2]));
            d.copy_from_slice(&matrix::apply_f32(&m, r, g, b));
        }
    });
    drop(halves);
    let full = (w as u32, h as u32);
    let linear = fit_linear(LinearImage::new(w as u32, h as u32, out), full, max_long_edge)?;
    Ok(orient(linear, orientation))
}

/// `kCGImagePropertyOrientation` of the primary image (1..=8; 1 when absent).
fn orientation(source: &CGImageSource) -> u32 {
    // SAFETY: index 0 with no options.
    let Some(props) = (unsafe { source.properties_at_index(0, None) }) else { return 1 };
    let key: &CFString = unsafe { kCGImagePropertyOrientation };
    // SAFETY: a CFString key in a CFDictionary of CF objects; the value (if any) is borrowed from `props`.
    let value = unsafe { props.value((key as *const CFString).cast::<c_void>()) };
    if value.is_null() {
        return 1;
    }
    // SAFETY: values of an ImageIO properties dictionary are CF objects.
    let value: &CFType = unsafe { &*value.cast::<CFType>() };
    value.downcast_ref::<CFNumber>().and_then(CFNumber::as_i32).map_or(1, |o| o as u32).clamp(1, 8)
}

/// Draw `image` over white into a `w × h` RGBA half-float bitmap in extended linear sRGB; returns the raw halves.
fn draw_linear(image: &CGImage, w: usize, h: usize) -> Result<Vec<u16>> {
    let space: CFRetained<CGColorSpace> = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceExtendedLinearSRGB }))
        .ok_or_else(|| Error::Invalid("no extended linear sRGB colour space".into()))?;
    let mut pixels = vec![0u16; w * h * 4];
    let info = CGImageAlphaInfo::PremultipliedLast.0 | CGImageComponentInfo::Float.0 | CGImageByteOrderInfo::Order16Little.0;
    // SAFETY: `pixels` holds `h` rows of `w * 8` bytes and outlives the context (dropped at the end of this block).
    let context: CFRetained<CGContext> = unsafe {
        CGBitmapContextCreate(pixels.as_mut_ptr().cast(), w, h, 16, w * 8, Some(&space), info)
    }
    .ok_or_else(|| Error::Invalid("CoreGraphics refused a 16-bit float bitmap".into()))?;
    let rect = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(w as f64, h as f64));
    CGContext::set_rgb_fill_color(Some(&context), 1.0, 1.0, 1.0, 1.0);
    CGContext::fill_rect(Some(&context), rect);
    CGContext::draw_image(Some(&context), rect, Some(image));
    drop(context);
    Ok(pixels)
}

/// IEEE 754 binary16 → f32.
#[inline]
fn f16_to_f32(h: u16) -> f32 {
    let sign = ((h & 0x8000) as u32) << 16;
    let exp = ((h >> 10) & 0x1f) as u32;
    let man = (h & 0x3ff) as u32;
    let bits = match exp {
        0 if man == 0 => sign,
        0 => {
            // Subnormal: normalise.
            let shift = man.leading_zeros() - 21;
            let man = (man << shift) & 0x3ff;
            sign | ((113 - shift) << 23) | (man << 13)
        }
        31 => sign | 0x7f80_0000 | (man << 13),
        _ => sign | ((exp + 112) << 23) | (man << 13),
    };
    f32::from_bits(bits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halves_convert() {
        assert_eq!(f16_to_f32(0x3c00), 1.0);
        assert_eq!(f16_to_f32(0xc000), -2.0);
        assert_eq!(f16_to_f32(0x3555), 0.333_251_95);
        assert_eq!(f16_to_f32(0x0001), 2f32.powi(-24));
        assert_eq!(f16_to_f32(0x03ff), 2f32.powi(-14) * (1023.0 / 1024.0));
        assert_eq!(f16_to_f32(0x0000), 0.0);
        assert!(f16_to_f32(0x7c00).is_infinite());
    }
}
