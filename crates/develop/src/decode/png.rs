//! PNG through the `image` crate (8 and 16 bit), alpha composited over white.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use image::codecs::png::PngDecoder;
use image::{DynamicImage, ImageDecoder};

use super::{exif_orientation, fit_linear, icc, orient, srgb_f32_to_linear};
use crate::error::Result;
use crate::image::LinearImage;

pub(super) fn decode_png(path: &Path, max_long_edge: Option<u32>) -> Result<LinearImage> {
    let orientation = File::open(path).map(|f| exif_orientation(&mut BufReader::new(f))).unwrap_or(1);
    let mut decoder = PngDecoder::new(BufReader::new(File::open(path)?))?;
    let profile = icc::input_profile(decoder.icc_profile().ok().flatten().as_deref());
    let img = DynamicImage::from_decoder(decoder)?;
    let (w, h) = (img.width(), img.height());
    // `to_rgba32f` normalises 8- and 16-bit samples to 0..1 without changing the encoding.
    let rgba = img.to_rgba32f().into_raw();
    let mut encoded: Vec<f32> = rgba
        .chunks_exact(4)
        .flat_map(|p| {
            let a = p[3].clamp(0.0, 1.0);
            [p[0] * a + (1.0 - a), p[1] * a + (1.0 - a), p[2] * a + (1.0 - a)]
        })
        .collect();
    let data = match profile {
        Some(profile) => icc::to_linear_rec2020(&encoded, w as usize, &profile)?,
        None => {
            srgb_f32_to_linear(&mut encoded, w as usize);
            encoded
        }
    };
    let linear = fit_linear(LinearImage::new(w, h, data), (w, h), max_long_edge)?;
    Ok(orient(linear, orientation))
}
