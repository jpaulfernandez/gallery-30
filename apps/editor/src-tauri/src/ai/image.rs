//! The images a request sends: a cached proxy (or a page render) decoded, downscaled to a long edge (768 px by
//! default) and encoded as JPEG. Only these bytes leave the machine, never the originals.

use std::path::Path;

use turbojpeg::{Compressor, PixelFormat, Subsamp};

use crate::commands::assets::{fit, resize, Pixels};
use crate::error::{Error, Result};

const QUALITY: i32 = 85;

/// Read `path` (JPEG or PNG) and return it as a JPEG at most `edge` px on its long side, with its size.
pub fn load_downscaled(path: &Path, edge: u32) -> Result<(Vec<u8>, u32, u32)> {
    let bytes = std::fs::read(path).map_err(|err| Error::Io(format!("reading {}", path.display()), err))?;
    downscale(&bytes, edge).map_err(|message| Error::Invalid(format!("{}: {message}", path.display())))
}

/// Decode `bytes` (JPEG or PNG), fit them into `edge` and encode a JPEG.
pub fn downscale(bytes: &[u8], edge: u32) -> std::result::Result<(Vec<u8>, u32, u32), String> {
    let pixels = if bytes.starts_with(&[0xFF, 0xD8]) {
        let image = turbojpeg::decompress(bytes, PixelFormat::RGB).map_err(|e| format!("decoding JPEG: {e}"))?;
        Pixels { data: image.pixels, width: image.width as u32, height: image.height as u32, channels: 3 }
    } else if bytes.starts_with(b"\x89PNG") {
        let image = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
            .map_err(|e| format!("decoding PNG: {e}"))?
            .to_rgb8();
        let (width, height) = image.dimensions();
        Pixels { data: image.into_raw(), width, height, channels: 3 }
    } else {
        return Err("not a JPEG or PNG image".into());
    };
    let (width, height) = fit(pixels.width, pixels.height, edge);
    let small = resize(&pixels, (width, height)).map_err(|e| e.to_string())?;
    let mut compressor = Compressor::new().map_err(|e| e.to_string())?;
    compressor.set_quality(QUALITY).map_err(|e| e.to_string())?;
    compressor.set_subsamp(Subsamp::Sub2x2).map_err(|e| e.to_string())?;
    let image = turbojpeg::Image {
        pixels: small.data.as_slice(),
        width: width as usize,
        pitch: width as usize * 3,
        height: height as usize,
        format: PixelFormat::RGB,
    };
    let jpeg = compressor.compress_to_vec(image).map_err(|e| e.to_string())?;
    Ok((jpeg, width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downscales_a_jpeg_to_the_long_edge() {
        let jpeg = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/sample-trip/DSCF1004.jpg");
        let (out, w, h) = load_downscaled(&jpeg, 768).unwrap();
        assert_eq!(w.max(h), 768);
        assert!(out.starts_with(&[0xFF, 0xD8]));
        assert!(out.len() < 400_000, "{} bytes", out.len());
    }

    #[test]
    fn png_page_renders_are_accepted() {
        let img = image::RgbImage::from_pixel(1080, 1350, image::Rgb([200, 200, 200]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(img).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        let (_, w, h) = downscale(&png, 768).unwrap();
        assert_eq!((w, h), (614, 768));
        assert!(downscale(b"GIF89a", 768).is_err());
    }
}
