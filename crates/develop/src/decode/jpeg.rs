//! JPEG through libjpeg-turbo, with DCT scaling.

use std::io::Cursor;

use turbojpeg::{Decompressor, PixelFormat, ScalingFactor};

use super::{exif_orientation, fit_linear, icc, orient, srgb8_to_linear};
use crate::error::{Error, Result};
use crate::image::LinearImage;
use crate::jpeg_markers;

/// The smallest supported DCT scale (≤ 1) whose scaled long edge still covers `target`.
fn pick_scale(long_edge: usize, target: usize) -> ScalingFactor {
    Decompressor::supported_scaling_factors()
        .into_iter()
        .filter(|f| f.num() <= f.denom() && f.scale(long_edge) >= target)
        .min_by(|a, b| (a.num() * b.denom()).cmp(&(b.num() * a.denom())))
        .unwrap_or(ScalingFactor::ONE)
}

/// Decode JPEG bytes to linear Rec.2020, upright, long edge at most `max_long_edge`.
pub fn decode_jpeg(bytes: &[u8], max_long_edge: Option<u32>) -> Result<LinearImage> {
    let mut decompressor = Decompressor::new()?;
    let header = decompressor.read_header(bytes)?;
    if matches!(header.colorspace, turbojpeg::Colorspace::CMYK | turbojpeg::Colorspace::YCCK) {
        return Err(Error::Unsupported("CMYK JPEG (convert it with sips first)".into()));
    }
    if let Some(target) = max_long_edge {
        let factor = pick_scale(header.width.max(header.height), target as usize);
        decompressor.set_scaling_factor(factor)?;
    }
    let scaled = header.scaled(decompressor.scaling_factor());
    let mut image = turbojpeg::Image {
        pixels: vec![0u8; scaled.width * scaled.height * 3],
        width: scaled.width,
        pitch: scaled.width * 3,
        height: scaled.height,
        format: PixelFormat::RGB,
    };
    decompressor.decompress(bytes, image.as_deref_mut())?;
    let (w, h) = (scaled.width, scaled.height);

    let profile = icc::input_profile(jpeg_markers::read_icc(bytes).as_deref());
    let data = match profile {
        Some(profile) => {
            let encoded: Vec<f32> = image.pixels.iter().map(|&v| v as f32 / 255.0).collect();
            icc::to_linear_rec2020(&encoded, w, &profile)?
        }
        None => srgb8_to_linear(&image.pixels, w),
    };
    let full = (header.width as u32, header.height as u32);
    let linear = fit_linear(LinearImage::new(w as u32, h as u32, data), full, max_long_edge)?;
    Ok(orient(linear, exif_orientation(&mut Cursor::new(bytes))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_covers_target() {
        let f = pick_scale(6000, 1600);
        assert!(f.scale(6000) >= 1600);
        assert!(f.scale(6000) < 3200);
        assert_eq!(pick_scale(1000, 1600), ScalingFactor::ONE);
    }
}
