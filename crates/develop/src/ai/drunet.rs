//! The σ-map denoise experiment (workflow plan 26, feature `denoise-drunet`, off by default).
//!
//! DRUNet (DPIR, Zhang et al. 2021; KAIR, MIT) is a residual U-Net trained on additive Gaussian noise that takes the
//! noise level as a fourth input channel instead of guessing it. Here that channel comes from the photo's noise
//! profile (workflow plan 23): the Poisson-Gaussian curve `variance = a·mean + b` per channel, evaluated per pixel at
//! the local (blurred) level and carried into the model's sRGB-encoded units through the slope of the sRGB curve, so
//! shadows (where the encoding stretches noise) get a higher σ than highlights. Everything after the model (the
//! luminance merge, the chroma handling, the sharpening) is [`denoise::finish`], exactly as for NAFNet.
//!
//! The model is not in `models.toml`: our static export (`scripts/models/export_drunet.py`) has to be hosted on a
//! GitHub Release before it can be pinned. Until then [`DrunetEngine::load`] takes a file path, and the inference
//! ([`infer_sigma`]) takes any [`SigmaModel`], which is how the unit tests run it on a mocked session.
//!
//! IO of the export: `input` f32 `[1, 4, n, n]` (sRGB-encoded RGB 0..1, then σ in the same units), `output` f32
//! `[1, 3, n, n]`, the denoised sRGB image (not a residual).

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use half::f16;
use ndarray::{ArrayViewD, IxDyn};
use rayon::prelude::*;

use super::denoise::{self, DenoiseOptions, TILE_OVERLAP};
use super::noise_profile::{ChannelFit, NoiseFit};
use super::runtime::{SessionOptions, Tensor};
use super::tiling::{reflect, tile_plan, Blender};
use super::{Error, Result, Session};
use crate::color::matrix::{self, apply_f32};
use crate::color::transfer::{linear_to_srgb, srgb_to_linear};
use crate::image::LinearImage;
use crate::local::gaussian_blur;
use crate::settings::Denoise;

/// DRUNet downsamples three times; padded images are a multiple of this.
pub const TILE_MULTIPLE: usize = 8;
/// Blur (px) of the level the σ map is read at, so the map follows the scene, not the noise.
pub const LEVEL_BLUR: f32 = 2.0;
/// DRUNet was trained on σ up to 50/255; the map is clamped there.
pub const MAX_SIGMA: f32 = 50.0 / 255.0;

/// The noise curve the σ map is read from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SigmaCurve {
    /// Per channel (linear Rec.2020), `variance = a·mean + b` at the analysed size.
    pub channels: [ChannelFit; 3],
    /// σ multiplier: the analysed-to-full size factor when the curve was measured on a downscaled image (noise
    /// averages down with the pixels), times any strength the caller wants. 1 when measured at full size.
    pub scale: f32,
}

impl SigmaCurve {
    /// A fit measured at the size it is applied at.
    pub fn from_fit(fit: &NoiseFit) -> Self {
        Self { channels: fit.channels, scale: 1.0 }
    }

    /// A fit measured on a downscaled copy of an image `full_width × full_height`: σ scaled by the long-edge ratio,
    /// the white-noise bound (demosaiced and compressed noise is correlated, so it averages down less: an upper
    /// bound, to be tuned by the caller's strength).
    pub fn for_full_size(fit: &NoiseFit, full_width: u32, full_height: u32) -> Self {
        let analysed = fit.width.max(fit.height).max(1) as f32;
        let full = full_width.max(full_height) as f32;
        Self { channels: fit.channels, scale: (full / analysed).max(1.0) }
    }

    /// σ in linear units of the model's sRGB primaries at a linear level. The curve is per Rec.2020 channel; the
    /// model sees `M·x` with `M` = Rec.2020 → sRGB, whose negative off-diagonal terms amplify independent channel
    /// noise (`var_i = Σ_j M_ij²·var_j`, about 1.5–1.8× in σ): the mean over the three sRGB channels.
    pub fn sigma_linear(&self, level: f32) -> f32 {
        let m = f64::from(level.clamp(0.0, 1.0));
        let var: [f64; 3] = std::array::from_fn(|c| self.channels[c].variance_at(m));
        let to = matrix::rec2020_to_srgb();
        let mean = to.iter().map(|row| row.iter().zip(&var).map(|(k, v)| k * k * v).sum::<f64>()).sum::<f64>() / 3.0;
        (mean.sqrt() as f32) * self.scale
    }

    /// σ in the model's sRGB-encoded units at a linear level: σ_linear times the slope of the sRGB curve there,
    /// not clamped. Approximations: the level is one value for the three channels (their mean, so a saturated
    /// colour's channels get the σ of its mean), and the slope is first order (fine while σ is small against the
    /// level; in deep shadows the curve bends within ±σ and the clamp at 0 before the model matters more).
    pub fn sigma_encoded_raw(&self, level: f32) -> f32 {
        let m = level.clamp(0.0, 1.0);
        let slope = if m <= 0.003_130_8 { 12.92 } else { 1.055 / 2.4 * m.powf(1.0 / 2.4 - 1.0) };
        self.sigma_linear(m) * slope
    }

    /// [`sigma_encoded_raw`](Self::sigma_encoded_raw) clamped to [`MAX_SIGMA`] (DRUNet's training range).
    pub fn sigma_encoded(&self, level: f32) -> f32 {
        self.sigma_encoded_raw(level).clamp(0.0, MAX_SIGMA)
    }
}

/// The σ map of `image` (one value per pixel, the model's units): the curve read at the pixel's blurred level
/// (mean of the three linear channels, [`LEVEL_BLUR`] px), times `strength`, then clamped to [`MAX_SIGMA`] (after the
/// multiply, so a strength above 1 never feeds the model a σ outside its training range).
pub fn sigma_plane(image: &LinearImage, curve: &SigmaCurve, strength: f32) -> Vec<f32> {
    let (w, h) = (image.width as usize, image.height as usize);
    let mut level: Vec<f32> = image.data.par_chunks_exact(3).map(|p| (p[0] + p[1] + p[2]) / 3.0).collect();
    gaussian_blur(&mut level, w, h, LEVEL_BLUR);
    level.par_iter_mut().for_each(|v| *v = (curve.sigma_encoded_raw(*v) * strength).clamp(0.0, MAX_SIGMA));
    level
}

/// A model that takes `[1, 4, n, n]` (RGB + σ) and returns `[1, 3, n, n]`.
pub trait SigmaModel: Sync {
    /// The static tile size `n`.
    fn tile(&self) -> usize;
    /// Run one `4 × n × n` plane (R, G, B, σ planes in that order); returns `3 × n × n`.
    fn run(&self, input: &[f32]) -> Result<Vec<f32>>;
}

/// A loaded DRUNet export.
pub struct DrunetEngine {
    session: Session,
    tile: usize,
    input: String,
    input_f16: bool,
}

impl DrunetEngine {
    /// Load an export from `path` (CoreML on macOS with `opts` as given; `SessionOptions::default()` is right).
    pub fn load(path: &Path, opts: &SessionOptions) -> Result<DrunetEngine> {
        let session = Session::load(path, opts)?;
        session.log_compute_plan();
        let first = session.info().inputs.first().ok_or_else(|| Error::Runtime("DRUNet export has no input".into()))?;
        let tile = match first.shape.as_slice() {
            [b, 4, h, w] if *b <= 1 && h == w && *h > 0 => *h as usize,
            other => return Err(Error::Runtime(format!("DRUNet input must be [1, 4, n, n], not {other:?}"))),
        };
        Ok(DrunetEngine { tile, input: first.name.clone(), input_f16: first.dtype == "f16", session })
    }

    pub fn session(&self) -> &Session {
        &self.session
    }
}

impl SigmaModel for DrunetEngine {
    fn tile(&self) -> usize {
        self.tile
    }

    fn run(&self, input: &[f32]) -> Result<Vec<f32>> {
        let n = self.tile;
        let shape = IxDyn(&[1, 4, n, n]);
        let outputs = if self.input_f16 {
            let half: Vec<f16> = input.iter().map(|&v| f16::from_f32(v)).collect();
            let view = ArrayViewD::from_shape(shape, &half).map_err(|e| Error::Runtime(e.to_string()))?;
            self.session.run(&[(self.input.as_str(), Tensor::F16(view))])?
        } else {
            let view = ArrayViewD::from_shape(shape, input).map_err(|e| Error::Runtime(e.to_string()))?;
            self.session.run(&[(self.input.as_str(), Tensor::F32(view))])?
        };
        let out = outputs.first().ok_or_else(|| Error::Runtime("DRUNet returned nothing".into()))?;
        Ok(out.iter().copied().collect())
    }
}

/// Linear Rec.2020 → the model's input (as `denoise`): sRGB primaries, clamped, sRGB-encoded.
#[inline]
fn to_model(m: &matrix::Mat3f, [r, g, b]: [f32; 3]) -> [f32; 3] {
    apply_f32(m, r, g, b).map(|v| linear_to_srgb(v.clamp(0.0, 1.0)))
}

#[inline]
fn from_model(m: &matrix::Mat3f, [r, g, b]: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = [r, g, b].map(|v| srgb_to_linear(v.clamp(0.0, 1.0)));
    apply_f32(m, r, g, b)
}

/// The full-strength model result in linear Rec.2020, tiled as [`denoise::infer`] does (same overlap and blend,
/// the model's change applied as a residual in linear light), with `sigma` (one value per pixel of `image`, see
/// [`sigma_plane`]) as the fourth channel of every tile.
pub fn infer_sigma(
    model: &dyn SigmaModel,
    image: &LinearImage,
    sigma: &[f32],
    progress: &dyn Fn(usize, usize),
    cancel: &AtomicBool,
) -> Result<LinearImage> {
    let (w, h) = (image.width as usize, image.height as usize);
    if sigma.len() != w * h {
        return Err(Error::Runtime(format!("σ map has {} values for a {w}×{h} image", sigma.len())));
    }
    let n = model.tile();
    let plan = tile_plan(w, h, n, TILE_OVERLAP, TILE_MULTIPLE);
    let to = matrix::to_f32(&matrix::rec2020_to_srgb());
    let from = matrix::to_f32(&matrix::srgb_to_rec2020());
    let total = plan.tiles.len();
    let mut blender = Blender::new(&plan);
    for (i, tile) in plan.tiles.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        let mut input = plan.extract(&image.data, tile, |p| to_model(&to, p));
        input.reserve_exact(n * n);
        for ty in 0..n {
            let row = reflect(tile.y + ty, h) * w;
            input.extend((0..n).map(|tx| sigma[row + reflect(tile.x + tx, w)]));
        }
        let output = model.run(&input)?;
        if output.len() != 3 * n * n {
            return Err(Error::Runtime(format!("DRUNet returned {} values, expected {}", output.len(), 3 * n * n)));
        }
        blender.add(i, &output);
        progress(i + 1, total);
    }
    let mut data = blender.finish();
    data.par_chunks_mut(3).zip(image.data.par_chunks(3)).for_each(|(o, x)| {
        let x = [x[0], x[1], x[2]];
        let seen = from_model(&from, to_model(&to, x));
        let out = from_model(&from, [o[0], o[1], o[2]]);
        for c in 0..3 {
            o[c] = x[c] + out[c] - seen[c];
        }
    });
    Ok(LinearImage::new(image.width, image.height, data).with_meta(image.meta.clone()))
}

/// The whole σ-map denoise: [`sigma_plane`] at `strength`, [`infer_sigma`], then [`denoise::finish`] with
/// `settings` (Luminance, Colour, Sharpen and the chroma mode act as they do for NAFNet; `settings.model` is
/// ignored).
pub fn denoise_sigma(
    model: &dyn SigmaModel,
    image: &LinearImage,
    curve: &SigmaCurve,
    strength: f32,
    settings: &Denoise,
    opts: &DenoiseOptions,
    progress: &dyn Fn(usize, usize),
    cancel: &AtomicBool,
) -> Result<LinearImage> {
    let sigma = sigma_plane(image, curve, strength);
    let raw = infer_sigma(model, image, &sigma, progress, cancel)?;
    Ok(denoise::finish(image, raw, settings, opts))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// A stand-in session: records the σ plane of every tile and returns `f(rgb, σ)` per pixel.
    struct Mock {
        tile: usize,
        sigmas: Mutex<Vec<Vec<f32>>>,
        f: fn([f32; 3], f32) -> [f32; 3],
    }

    impl Mock {
        fn new(tile: usize, f: fn([f32; 3], f32) -> [f32; 3]) -> Self {
            Self { tile, sigmas: Mutex::default(), f }
        }
    }

    impl SigmaModel for Mock {
        fn tile(&self) -> usize {
            self.tile
        }

        fn run(&self, input: &[f32]) -> Result<Vec<f32>> {
            let nn = self.tile * self.tile;
            assert_eq!(input.len(), 4 * nn, "RGB + σ planes");
            self.sigmas.lock().unwrap().push(input[3 * nn..].to_vec());
            let mut out = vec![0.0; 3 * nn];
            for i in 0..nn {
                let p = (self.f)([input[i], input[nn + i], input[2 * nn + i]], input[3 * nn + i]);
                for c in 0..3 {
                    out[c * nn + i] = p[c];
                }
            }
            Ok(out)
        }
    }

    fn curve(a: f64, b: f64) -> SigmaCurve {
        SigmaCurve { channels: [ChannelFit { a, b }; 3], scale: 1.0 }
    }

    fn grey(w: u32, h: u32, v: f32) -> LinearImage {
        LinearImage::new(w, h, vec![v; (w * h * 3) as usize])
    }

    #[test]
    fn sigma_follows_the_curve_and_the_srgb_slope() {
        // Gaussian only (b): the same linear σ everywhere, so the encoded σ is larger in the shadows. Independent
        // Rec.2020 channel noise grows by `gain` in the model's sRGB primaries.
        let to = matrix::rec2020_to_srgb();
        let gain = (to.iter().flatten().map(|k| k * k).sum::<f64>() / 3.0).sqrt() as f32;
        assert!(gain > 1.3 && gain < 2.0, "{gain}");
        let c = curve(0.0, 1e-6);
        assert!((c.sigma_linear(0.5) - 1e-3 * gain).abs() < 1e-7);
        assert!(c.sigma_encoded(0.02) > c.sigma_encoded(0.18));
        assert!(c.sigma_encoded(0.18) > c.sigma_encoded(0.8));
        // At mid-grey the slope of the sRGB curve is 1.055/2.4 · 0.18^(1/2.4 − 1) ≈ 1.195.
        assert!((c.sigma_encoded(0.18) / (1e-3 * gain) - 1.1953).abs() < 1e-3, "{}", c.sigma_encoded(0.18));
        // Shot noise (a) rises with the level in linear units; the scale multiplies; the map is clamped.
        let shot = curve(1e-4, 0.0);
        assert!(shot.sigma_linear(0.8) > shot.sigma_linear(0.1));
        assert!((SigmaCurve { scale: 2.0, ..shot }.sigma_linear(0.3) / shot.sigma_linear(0.3) - 2.0).abs() < 1e-5);
        assert_eq!(curve(1.0, 1.0).sigma_encoded(0.5), MAX_SIGMA);
        // A fit measured on a 1600 px copy of a 6400 px image: σ × 4.
        let fit = NoiseFit {
            channels: [ChannelFit { a: 0.0, b: 1e-6 }; 3],
            sigma: 1e-3,
            confidence: 1.0,
            patches: 500,
            range: [0.01, 0.5],
            extrapolated: false,
            width: 1600,
            height: 1067,
        };
        assert_eq!(SigmaCurve::for_full_size(&fit, 6400, 4267).scale, 4.0);
        assert_eq!(SigmaCurve::from_fit(&fit).scale, 1.0);
    }

    #[test]
    fn a_flat_image_gets_a_flat_map() {
        let c = curve(2e-5, 4e-6);
        let map = sigma_plane(&grey(40, 30, 0.18), &c, 0.5);
        assert_eq!(map.len(), 40 * 30);
        let want = c.sigma_encoded(0.18) * 0.5;
        assert!(map.iter().all(|v| (v - want).abs() < 1e-6), "{} vs {want}", map[0]);
        // The clamp comes after the strength: a large strength never goes past DRUNet's range.
        let loud = curve(1e-2, 1e-4);
        assert!(loud.sigma_encoded_raw(0.1) * 3.0 > MAX_SIGMA);
        let map = sigma_plane(&grey(40, 30, 0.1), &loud, 3.0);
        assert!(map.iter().all(|&v| v == MAX_SIGMA));
    }

    #[test]
    fn every_tile_gets_its_part_of_the_map_and_an_identity_model_changes_nothing() {
        // 300 × 200 with 128 px tiles: several tiles, reflect padding at the right and bottom edges.
        let (w, h) = (300u32, 200u32);
        let data: Vec<f32> = (0..w * h * 3).map(|i| 0.05 + 0.6 * ((i / 3) % w) as f32 / w as f32).collect();
        let image = LinearImage::new(w, h, data);
        // A map that encodes the column, so a tile reading the wrong pixels shows.
        let sigma: Vec<f32> = (0..w * h).map(|i| (i % w) as f32 / 1000.0).collect();
        let mock = Mock::new(128, |rgb, _| rgb);
        let done = Mutex::new(Vec::new());
        let out = infer_sigma(&mock, &image, &sigma, &|d, t| done.lock().unwrap().push((d, t)), &AtomicBool::new(false))
            .unwrap();
        let plan = tile_plan(w as usize, h as usize, 128, TILE_OVERLAP, TILE_MULTIPLE);
        assert!(plan.tiles.len() > 4);
        let seen = mock.sigmas.lock().unwrap();
        assert_eq!(seen.len(), plan.tiles.len());
        assert_eq!(done.lock().unwrap().last(), Some(&(plan.tiles.len(), plan.tiles.len())));
        for (tile, plane) in plan.tiles.iter().zip(seen.iter()) {
            for ty in 0..128 {
                for tx in 0..128 {
                    let sx = reflect(tile.x + tx, w as usize);
                    assert_eq!(plane[ty * 128 + tx], sx as f32 / 1000.0);
                }
            }
        }
        let err = out.data.iter().zip(&image.data).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(err < 1e-4, "identity model moved the image by {err}");
    }

    #[test]
    fn the_model_change_comes_back_as_a_residual() {
        // The mock darkens by σ in the encoded domain: the output must be the input minus that change in linear light.
        let image = grey(150, 120, 0.18);
        let sigma = vec![0.02f32; 150 * 120];
        let mock = Mock::new(128, |rgb, s| rgb.map(|v| v - s));
        let out = infer_sigma(&mock, &image, &sigma, &|_, _| {}, &AtomicBool::new(false)).unwrap();
        let want = srgb_to_linear(linear_to_srgb(0.18) - 0.02);
        for v in &out.data {
            assert!((v - want).abs() < 2e-4, "{v} vs {want}");
        }
    }

    #[test]
    fn errors_and_cancel() {
        let image = grey(40, 40, 0.3);
        let mock = Mock::new(128, |rgb, _| rgb);
        let never = AtomicBool::new(false);
        assert!(infer_sigma(&mock, &image, &[0.0; 10], &|_, _| {}, &never).is_err(), "wrong map size");
        assert!(matches!(
            infer_sigma(&mock, &image, &vec![0.0; 1600], &|_, _| {}, &AtomicBool::new(true)),
            Err(Error::Cancelled)
        ));
        struct Short;
        impl SigmaModel for Short {
            fn tile(&self) -> usize {
                128
            }
            fn run(&self, _: &[f32]) -> Result<Vec<f32>> {
                Ok(vec![0.0; 7])
            }
        }
        assert!(infer_sigma(&Short, &image, &vec![0.0; 1600], &|_, _| {}, &never).is_err());
        // The whole path with the default settings runs through `denoise::finish`.
        let settings = Denoise {
            model: crate::settings::DenoiseModel::NafnetW32,
            luminance: 50.0,
            chroma: 75.0,
            sharpen: 25.0,
            chroma_mode: Default::default(),
        };
        let out =
            denoise_sigma(&mock, &image, &curve(0.0, 1e-6), 1.0, &settings, &DenoiseOptions::default(), &|_, _| {}, &never)
                .unwrap();
        assert_eq!((out.width, out.height), (40, 40));
        assert!(out.data.iter().all(|v| (v - 0.3).abs() < 1e-3));
    }
}
