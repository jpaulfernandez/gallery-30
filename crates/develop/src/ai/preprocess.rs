//! Model inputs from a [`LinearImage`] and model outputs back onto the image (D4.3).
//!
//! The masking models are trained on ordinary sRGB photos, so the working image (linear Rec.2020, scene-referred)
//! is converted first: Rec.2020 → sRGB primaries, clamped to 0..1, sRGB transfer ([`to_srgb`]). That is the 8-bit
//! JPEG a model expects, kept in `f32`.
//!
//! Two ways to reach the model's square input ([`Fit`]):
//!
//! - **Letterbox** (BiRefNet, SAM): the long edge is scaled to the input size, the aspect kept, and the rest padded
//!   at the right/bottom with the normalisation mean (0 after normalising). SAM's own preprocessing pads the same
//!   way, so its prompt coordinates are just the image's scaled by [`InputFrame::scale_x`].
//! - **Stretch** (SkyWater-Seg, RT-DETR, Depth Anything): a plain resize to the input size, aspect not kept. These
//!   models are trained and evaluated that way (SegFormer and Depth Anything resize the whole picture; RT-DETR's
//!   boxes are fractions of the stretched input).
//!
//! Downscaling uses `fast_image_resize` convolution filters (the kernel widens with the scale, so it averages
//! instead of aliasing): bilinear by default, Catmull-Rom for Depth Anything (its reference preprocessing is bicubic).
//! [`unletterbox`] maps an output plane back: the content box of the model frame resized to the image size
//! (bilinear).

use fast_image_resize as fr;
use ndarray::Array4;
use rayon::prelude::*;

use super::{Error, Result};
use crate::color::matrix::{self, apply_f32};
use crate::color::transfer::linear_to_srgb;
use crate::geometry::Homography;
use crate::image::LinearImage;
use crate::masks::MaskPlane;

/// ImageNet mean and standard deviation (RGB, 0..1).
pub const IMAGENET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
pub const IMAGENET_STD: [f32; 3] = [0.229, 0.224, 0.225];

/// How pixel values are normalised.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Norm {
    /// `(v − mean) / std` with the ImageNet constants.
    ImageNet,
    /// `v` as is (0..1, i.e. RGB / 255).
    Unit,
}

impl Norm {
    /// The padding colour (0..1) that normalises to zero, or black for [`Norm::Unit`].
    fn pad(self) -> [f32; 3] {
        match self {
            Norm::ImageNet => IMAGENET_MEAN,
            Norm::Unit => [0.0; 3],
        }
    }

    #[inline]
    fn apply(self, c: usize, v: f32) -> f32 {
        match self {
            Norm::ImageNet => (v - IMAGENET_MEAN[c]) / IMAGENET_STD[c],
            Norm::Unit => v,
        }
    }
}

/// How the picture reaches the model's input size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fit {
    /// Keep the aspect, pad right and bottom.
    Letterbox,
    /// Resize to the input size, aspect not kept.
    Stretch,
}

/// The resampling filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    Bilinear,
    Bicubic,
}

impl Filter {
    fn alg(self) -> fr::ResizeAlg {
        match self {
            Filter::Bilinear => fr::ResizeAlg::Convolution(fr::FilterType::Bilinear),
            Filter::Bicubic => fr::ResizeAlg::Convolution(fr::FilterType::CatmullRom),
        }
    }
}

/// Where the image sits in the model's input: the input size and the content box (model pixels).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InputFrame {
    /// The model input's width and height.
    pub width: u32,
    pub height: u32,
    /// The size of the image that was fed.
    pub source_width: u32,
    pub source_height: u32,
    /// The image's box inside the input, in input pixels (`x0 = y0 = 0` for both fits).
    pub content_width: u32,
    pub content_height: u32,
}

impl InputFrame {
    /// Input pixels per image pixel along x and y.
    pub fn scale_x(&self) -> f64 {
        self.content_width as f64 / self.source_width.max(1) as f64
    }

    pub fn scale_y(&self) -> f64 {
        self.content_height as f64 / self.source_height.max(1) as f64
    }

    /// Image fractions (0..1) → input pixels.
    pub fn to_input(&self, p: [f64; 2]) -> [f64; 2] {
        [p[0] * self.content_width as f64, p[1] * self.content_height as f64]
    }
}

/// An NCHW `[1, 3, h, w]` tensor and where the image sits in it.
#[derive(Debug, Clone)]
pub struct ModelInput {
    pub tensor: Array4<f32>,
    pub frame: InputFrame,
}

/// sRGB-encoded RGB (0..1, interleaved) of a linear Rec.2020 image: sRGB primaries, clamped, sRGB transfer.
pub fn to_srgb(image: &LinearImage) -> Vec<f32> {
    let m = matrix::to_f32(&matrix::rec2020_to_srgb());
    let mut out = vec![0.0f32; image.data.len()];
    out.par_chunks_exact_mut(3).zip(image.data.par_chunks_exact(3)).for_each(|(o, p)| {
        let rgb = apply_f32(&m, p[0], p[1], p[2]);
        for c in 0..3 {
            o[c] = linear_to_srgb(rgb[c].clamp(0.0, 1.0));
        }
    });
    out
}

/// Resize an interleaved `f32` buffer with `channels` 1 or 3 from `w × h` to `nw × nh`, optionally reading only
/// the `crop` box `(left, top, width, height)` of the source (source pixels, fractional allowed).
pub fn resize_f32(
    data: &[f32],
    channels: usize,
    (w, h): (u32, u32),
    (nw, nh): (u32, u32),
    filter: Filter,
    crop: Option<(f64, f64, f64, f64)>,
) -> Result<Vec<f32>> {
    assert!(channels == 1 || channels == 3, "1 or 3 channels");
    assert_eq!(data.len(), w as usize * h as usize * channels, "buffer size");
    let identity = crop.is_none_or(|c| c == (0.0, 0.0, w as f64, h as f64));
    if (w, h) == (nw, nh) && identity {
        return Ok(data.to_vec());
    }
    let err = |e: fr::ResizeError| Error::Runtime(format!("resize: {e}"));
    let buf = |e: fr::InvalidPixelsSize| Error::Runtime(format!("resize: {e}"));
    let mut options = fr::ResizeOptions::new().resize_alg(filter.alg());
    if let Some((l, t, cw, ch)) = crop {
        options = options.crop(l, t, cw, ch);
    }
    let mut resizer = fr::Resizer::new();
    if channels == 3 {
        let src: Vec<fr::pixels::F32x3> = data.chunks_exact(3).map(|p| fr::pixels::F32x3::new([p[0], p[1], p[2]])).collect();
        let src = fr::images::TypedImageRef::new(w, h, &src).map_err(buf)?;
        let mut dst = fr::images::TypedImage::<fr::pixels::F32x3>::new(nw, nh);
        resizer.resize_typed(&src, &mut dst, &options).map_err(err)?;
        Ok(dst.pixels().iter().flat_map(|p| p.0).collect())
    } else {
        let src: Vec<fr::pixels::F32> = data.iter().map(|&v| fr::pixels::F32::new(v)).collect();
        let src = fr::images::TypedImageRef::new(w, h, &src).map_err(buf)?;
        let mut dst = fr::images::TypedImage::<fr::pixels::F32>::new(nw, nh);
        resizer.resize_typed(&src, &mut dst, &options).map_err(err)?;
        Ok(dst.pixels().iter().map(|p| p.0).collect())
    }
}

/// The model input for `image` at `width × height`.
pub fn prepare(image: &LinearImage, width: u32, height: u32, fit: Fit, norm: Norm, filter: Filter) -> Result<ModelInput> {
    prepare_srgb(&to_srgb(image), image.width, image.height, width, height, fit, norm, filter)
}

/// [`prepare`] from an sRGB buffer already made by [`to_srgb`] (several models can share one conversion).
#[allow(clippy::too_many_arguments)]
pub fn prepare_srgb(
    srgb: &[f32],
    sw: u32,
    sh: u32,
    width: u32,
    height: u32,
    fit: Fit,
    norm: Norm,
    filter: Filter,
) -> Result<ModelInput> {
    let (sw1, sh1) = (sw.max(1), sh.max(1));
    let (cw, ch) = match fit {
        Fit::Stretch => (width, height),
        Fit::Letterbox => {
            let s = (width as f64 / sw1 as f64).min(height as f64 / sh1 as f64);
            (((sw1 as f64 * s).round() as u32).clamp(1, width), ((sh1 as f64 * s).round() as u32).clamp(1, height))
        }
    };
    let resized = resize_f32(srgb, 3, (sw, sh), (cw, ch), filter, None)?;
    let (w, h) = (width as usize, height as usize);
    let pad = norm.pad();
    let mut tensor = Array4::<f32>::zeros((1, 3, h, w));
    {
        let slice = tensor.as_slice_mut().expect("standard layout");
        let (r, rest) = slice.split_at_mut(w * h);
        let (g, b) = rest.split_at_mut(w * h);
        for (c, plane) in [r, g, b].into_iter().enumerate() {
            plane.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
                for (x, o) in row.iter_mut().enumerate() {
                    let v = if x < cw as usize && y < ch as usize { resized[(y * cw as usize + x) * 3 + c] } else { pad[c] };
                    *o = norm.apply(c, v);
                }
            });
        }
    }
    let frame = InputFrame { width, height, source_width: sw, source_height: sh, content_width: cw, content_height: ch };
    Ok(ModelInput { tensor, frame })
}

/// An output plane on the model's input grid (`plane_w × plane_h`, which may be a fraction of the input size, as
/// SAM's 256 px masks are of its 1024 px input) back on the image: the content box resized bilinearly to
/// `out_w × out_h`.
pub fn unletterbox(plane: &[f32], plane_w: u32, plane_h: u32, frame: &InputFrame, out_w: u32, out_h: u32) -> Result<MaskPlane> {
    let (sx, sy) = (plane_w as f64 / frame.width as f64, plane_h as f64 / frame.height as f64);
    let (cw, ch) = (frame.content_width as f64 * sx, frame.content_height as f64 * sy);
    // Copy the content box out first so the filter clamps at its edge instead of reading the padding.
    let (bw, bh) = ((cw.ceil() as u32).clamp(1, plane_w), (ch.ceil() as u32).clamp(1, plane_h));
    let boxed: Vec<f32> = if (bw, bh) == (plane_w, plane_h) {
        plane.to_vec()
    } else {
        (0..bh as usize).flat_map(|y| plane[y * plane_w as usize..y * plane_w as usize + bw as usize].iter().copied()).collect()
    };
    let crop = Some((0.0, 0.0, cw.min(bw as f64), ch.min(bh as f64)));
    let data = resize_f32(&boxed, 1, (bw, bh), (out_w, out_h), Filter::Bilinear, crop)?;
    Ok(MaskPlane::new(out_w, out_h, data))
}

/// The logistic function.
#[inline]
pub fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// Copy an interleaved buffer into another frame through an exact pixel permutation: `dst_to_src` maps normalised
/// destination coordinates to normalised source coordinates (an orientation matrix: 90° turns and flips), and each
/// destination pixel centre takes the nearest source pixel. Used to run models on the picture as the user turned
/// it and to bring their output back.
pub fn remap_exact(src: &[f32], channels: usize, (sw, sh): (u32, u32), (dw, dh): (u32, u32), dst_to_src: &Homography) -> Vec<f32> {
    assert_eq!(src.len(), sw as usize * sh as usize * channels, "buffer size");
    let mut out = vec![0.0f32; dw as usize * dh as usize * channels];
    if dw == 0 || dh == 0 || sw == 0 || sh == 0 {
        return out;
    }
    out.par_chunks_mut(dw as usize * channels).enumerate().for_each(|(y, row)| {
        let v = (y as f64 + 0.5) / dh as f64;
        for x in 0..dw as usize {
            let [su, sv] = dst_to_src.apply([(x as f64 + 0.5) / dw as f64, v]);
            let sx = ((su * sw as f64).floor() as i64).clamp(0, sw as i64 - 1) as usize;
            let sy = ((sv * sh as f64).floor() as i64).clamp(0, sh as i64 - 1) as usize;
            let s = (sy * sw as usize + sx) * channels;
            row[x * channels..(x + 1) * channels].copy_from_slice(&src[s..s + channels]);
        }
    });
    out
}
