//! The two image buffers the pipeline passes around.

use std::sync::Arc;

use crate::color::camera::CameraColor;

/// What the decoder knows about where a [`LinearImage`] came from. Default (all empty) for JPEG/PNG; filled by
/// the RAW decoder (D6.1). The geometry warp and the linear resize carry it over.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImageMeta {
    /// Decoded from a camera RAW file. The editor turns the display look on by default for these.
    pub is_raw: bool,
    /// The as-shot white balance as `(Kelvin, tint)`: what the Absolute white balance sliders start from, and
    /// where `WhiteBalance::Absolute` is a no-op.
    pub as_shot: Option<(f64, f64)>,
    /// The camera's colour matrices and as-shot neutral, so Absolute white balance is solved through the camera
    /// matrix ([`CameraColor::rebalance_rec2020`]).
    pub camera: Option<Arc<CameraColor>>,
    /// The source's noise σ (linear, at mid-grey, measured on the 1600 px working decode: workflow plan 23's
    /// `measured.sigma`, quantised by [`crate::ops::noise::chroma_sigma`]), when the caller knows it. The chroma filter
    /// (plan 24) derives its radius and ε from it; `None` uses [`crate::ops::noise::DEFAULT_SIGMA`].
    pub noise_sigma: Option<f32>,
}

/// Interleaved RGB, `f32` per channel, **linear Rec.2020 with a D65 white**, upright (EXIF orientation
/// already applied). Values are scene-referred: 1.0 is the input's diffuse white, nothing is clamped.
#[derive(Debug, Clone, PartialEq)]
pub struct LinearImage {
    pub width: u32,
    pub height: u32,
    /// `width * height * 3` values, row-major.
    pub data: Vec<f32>,
    /// Source metadata (RAW white balance data); default for rendered files.
    pub meta: ImageMeta,
}

impl LinearImage {
    pub fn new(width: u32, height: u32, data: Vec<f32>) -> Self {
        assert_eq!(data.len(), width as usize * height as usize * 3, "LinearImage data has the wrong length");
        Self { width, height, data, meta: ImageMeta::default() }
    }

    /// The same image with `meta`.
    pub fn with_meta(mut self, meta: ImageMeta) -> Self {
        self.meta = meta;
        self
    }

    /// The RGB triple at `(x, y)`.
    pub fn pixel(&self, x: u32, y: u32) -> [f32; 3] {
        let i = (y as usize * self.width as usize + x as usize) * 3;
        [self.data[i], self.data[i + 1], self.data[i + 2]]
    }

    /// One row of `width * 3` values.
    pub fn row(&self, y: u32) -> &[f32] {
        let stride = self.width as usize * 3;
        &self.data[y as usize * stride..(y as usize + 1) * stride]
    }
}

/// Interleaved RGB, 8 bits per channel, sRGB-encoded (the output of a render).
#[derive(Debug, Clone, PartialEq)]
pub struct Rgb8Image {
    pub width: u32,
    pub height: u32,
    /// `width * height * 3` bytes, row-major.
    pub data: Vec<u8>,
}

impl Rgb8Image {
    pub fn new(width: u32, height: u32, data: Vec<u8>) -> Self {
        assert_eq!(data.len(), width as usize * height as usize * 3, "Rgb8Image data has the wrong length");
        Self { width, height, data }
    }

    pub fn pixel(&self, x: u32, y: u32) -> [u8; 3] {
        let i = (y as usize * self.width as usize + x as usize) * 3;
        [self.data[i], self.data[i + 1], self.data[i + 2]]
    }
}

/// Interleaved RGB, 16 bits per channel, encoded like [`Rgb8Image`] (sRGB transfer, the output profile's
/// primaries): a 16-bit render for the export's TIFF and HEIC (workflow plan 12).
#[derive(Debug, Clone, PartialEq)]
pub struct Rgb16Image {
    pub width: u32,
    pub height: u32,
    /// `width * height * 3` samples, row-major.
    pub data: Vec<u16>,
}

impl Rgb16Image {
    pub fn new(width: u32, height: u32, data: Vec<u16>) -> Self {
        assert_eq!(data.len(), width as usize * height as usize * 3, "Rgb16Image data has the wrong length");
        Self { width, height, data }
    }

    pub fn pixel(&self, x: u32, y: u32) -> [u16; 3] {
        let i = (y as usize * self.width as usize + x as usize) * 3;
        [self.data[i], self.data[i + 1], self.data[i + 2]]
    }
}
