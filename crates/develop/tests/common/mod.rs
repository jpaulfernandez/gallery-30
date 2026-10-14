//! Fixture generators shared by the integration tests (no binary fixtures): the D1.2 pipeline fixtures
//! (a grey ramp PNG, a colour chart PNG, a synthetic "photo" JPEG, written to a temp dir) and the D3.1
//! detail fixtures (linear images built from sRGB functions, a backlit edge, a resolution-independent
//! scene). `pipeline.rs`, `detail.rs` and `gpu.rs` use them.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use photobook_develop::color::{matrix, transfer};
use photobook_develop::LinearImage;

// ---------- pipeline fixtures ----------

pub const RAMP_W: u32 = 256;
pub const RAMP_H: u32 = 16;

/// Column `x` is the 8-bit grey `x`.
pub fn ramp_pixels() -> Vec<u8> {
    (0..RAMP_H).flat_map(|_| (0..RAMP_W).flat_map(|x| [x as u8; 3])).collect()
}

pub const PATCH: u32 = 40;
/// 6 × 3 patches.
pub const CHART: [[u8; 3]; 18] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [0, 255, 255],
    [255, 0, 255],
    [255, 255, 0],
    [255, 128, 0],
    [224, 172, 140], // skin
    [90, 150, 220],  // sky
    [118, 118, 118], // ~0.18 linear
    [30, 30, 30],
    [245, 245, 245],
    [200, 30, 40],
    [40, 160, 70],
    [60, 60, 180],
    [128, 64, 32],
    [0, 0, 0],
    [255, 255, 255],
];

pub fn chart_pixels() -> (u32, u32, Vec<u8>) {
    let (w, h) = (6 * PATCH, 3 * PATCH);
    let data = (0..h).flat_map(|y| (0..w).flat_map(move |x| CHART[((y / PATCH) * 6 + x / PATCH) as usize])).collect();
    (w, h, data)
}

pub fn patch_origin(i: usize) -> (u32, u32) {
    ((i as u32 % 6) * PATCH, (i as u32 / 6) * PATCH)
}

/// A procedural 640×427 "photo": sky gradient with a sun, ground, a skin-toned face, a deep shadow and
/// noise.
pub fn photo_pixels(w: u32, h: u32) -> Vec<u8> {
    let mut seed = 0x1234_5678u32;
    let mut noise = move || {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        ((seed >> 24) as i32 % 13) - 6
    };
    let mut out = Vec::with_capacity((w * h * 3) as usize);
    let (wf, hf) = (w as f32, h as f32);
    for y in 0..h {
        for x in 0..w {
            let (fx, fy) = (x as f32 / wf, y as f32 / hf);
            let mut c = if fy < 0.45 {
                let t = fy / 0.45;
                [90.0 + 80.0 * t, 140.0 + 60.0 * t, 210.0 + 25.0 * t]
            } else {
                let t = (fy - 0.45) / 0.55;
                [70.0 + 40.0 * t, 110.0 - 20.0 * t, 50.0 + 10.0 * t]
            };
            let sun = ((fx - 0.8).powi(2) + (fy - 0.15).powi(2) * (hf / wf).powi(-2)).sqrt();
            if sun < 0.05 {
                c = [250.0, 248.0, 240.0];
            }
            let face = ((fx - 0.3) / 0.09).powi(2) + ((fy - 0.55) / 0.16).powi(2);
            if face < 1.0 {
                let shade = 1.0 - 0.25 * (fx - 0.3 + 0.09) / 0.18;
                c = [225.0 * shade, 175.0 * shade, 145.0 * shade];
            }
            if fx < 0.15 && fy > 0.8 {
                c = [25.0, 25.0, 30.0];
            }
            for v in c {
                out.push((v as i32 + noise()).clamp(0, 255) as u8);
            }
        }
    }
    out
}

pub fn write_png8(path: &Path, w: u32, h: u32, data: Vec<u8>) {
    image::RgbImage::from_raw(w, h, data).unwrap().save(path).unwrap();
}

/// Plain turbojpeg encode (no ICC), optionally with an Exif APP1 carrying `orientation`.
pub fn write_jpeg(path: &Path, w: u32, h: u32, data: &[u8], orientation: Option<u16>) {
    let img = turbojpeg::Image { pixels: data, width: w as usize, pitch: w as usize * 3, height: h as usize, format: turbojpeg::PixelFormat::RGB };
    let mut bytes = turbojpeg::compress(img, 92, turbojpeg::Subsamp::Sub2x2).unwrap().to_vec();
    if let Some(o) = orientation {
        // Big-endian TIFF with one IFD0 entry: Orientation (SHORT) = o.
        let mut payload = b"Exif\0\0MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01".to_vec();
        payload.extend_from_slice(&o.to_be_bytes());
        payload.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        splice_segment(&mut bytes, 0xE1, &payload);
    }
    std::fs::write(path, bytes).unwrap();
}

pub fn splice_segment(jpeg: &mut Vec<u8>, marker: u8, payload: &[u8]) {
    let mut seg = vec![0xFF, marker];
    seg.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    seg.extend_from_slice(payload);
    jpeg.splice(2..2, seg);
}

pub struct Fixtures {
    pub _dir: tempfile::TempDir,
    pub ramp: PathBuf,
    pub chart: PathBuf,
    pub photo: PathBuf,
}

pub fn fixtures() -> Fixtures {
    let dir = tempfile::tempdir().unwrap();
    let ramp = dir.path().join("ramp.png");
    write_png8(&ramp, RAMP_W, RAMP_H, ramp_pixels());
    let chart = dir.path().join("chart.png");
    let (w, h, data) = chart_pixels();
    write_png8(&chart, w, h, data);
    let photo = dir.path().join("photo.jpg");
    write_jpeg(&photo, 640, 427, &photo_pixels(640, 427), None);
    Fixtures { _dir: dir, ramp, chart, photo }
}

// ---------- detail fixtures ----------

/// sRGB 0..255 → linear.
pub fn lin8(v: f32) -> f32 {
    transfer::srgb_to_linear((v / 255.0).clamp(0.0, 1.0))
}

/// A linear Rec.2020 image from a function giving sRGB 0..255 per channel at each pixel.
pub fn image(w: u32, h: u32, f: impl Fn(u32, u32) -> [f32; 3]) -> LinearImage {
    let m = matrix::to_f32(&matrix::srgb_to_rec2020());
    let mut data = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            let [r, g, b] = f(x, y);
            data.extend_from_slice(&matrix::apply_f32(&m, lin8(r), lin8(g), lin8(b)));
        }
    }
    LinearImage::new(w, h, data)
}

pub fn grey(v: f32) -> [f32; 3] {
    [v; 3]
}

/// Deterministic noise in -0.5..0.5.
pub fn hash(x: u32, y: u32, seed: u32) -> f32 {
    let mut s = x.wrapping_mul(0x9E37_79B1) ^ y.wrapping_mul(0x85EB_CA77) ^ seed.wrapping_mul(0xC2B2_AE3D);
    s ^= s >> 15;
    s = s.wrapping_mul(0x2C1B_3C6D);
    s ^= s >> 12;
    s = s.wrapping_mul(0x297A_2D39);
    s ^= s >> 15;
    (s >> 8) as f32 / (1u32 << 24) as f32 - 0.5
}

/// Smooth value noise with features about `cell` px across, -0.5..0.5.
pub fn value_noise(x: u32, y: u32, cell: f32, seed: u32) -> f32 {
    let (fx, fy) = (x as f32 / cell, y as f32 / cell);
    let (ix, iy) = (fx.floor() as u32, fy.floor() as u32);
    let (tx, ty) = (fx - ix as f32, fy - iy as f32);
    let s = |t: f32| t * t * (3.0 - 2.0 * t);
    let (sx, sy) = (s(tx), s(ty));
    let top = hash(ix, iy, seed) + (hash(ix + 1, iy, seed) - hash(ix, iy, seed)) * sx;
    let bottom = hash(ix, iy + 1, seed) + (hash(ix + 1, iy + 1, seed) - hash(ix, iy + 1, seed)) * sx;
    top + (bottom - top) * sy
}

pub fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

pub const W: u32 = 1440;
pub const H: u32 = 1080;

/// Backlit edge: dark (40) left, bright (225) right, a 16 px soft gradient at the centre.
pub fn backlit_edge() -> LinearImage {
    image(W, H, |x, _| grey(40.0 + 185.0 * smoothstep(W as f32 / 2.0 - 8.0, W as f32 / 2.0 + 8.0, x as f32)))
}

/// A continuous scene sampled at `w × h` (u across 0..1): soft-edged discs and bars, a backlit
/// horizon, sinusoidal and value-noise texture. Every feature is several reference px wide.
pub fn scene(w: u32, h: u32) -> LinearImage {
    let k = w as f32;
    image(w, h, |x, y| {
        let (u, v) = ((x as f32 + 0.5) / k, (y as f32 + 0.5) / k);
        let edge = 0.004; // soft edge width, ~6 px at 1600
        let sky = smoothstep(0.30 - edge, 0.30 + edge, v); // 1 below the horizon
        let mut c = [200.0 + 30.0 * (1.0 - v), 215.0 + 20.0 * (1.0 - v), 240.0];
        let ground = [70.0 + 40.0 * u, 90.0 + 20.0 * (u * 12.0).sin(), 50.0];
        let ripple = 18.0 * (u * 2.0 * std::f32::consts::PI * 60.0).sin() * (v * 2.0 * std::f32::consts::PI * 45.0).sin();
        for i in 0..3 {
            c[i] = c[i] * (1.0 - sky) + (ground[i] + ripple) * sky;
        }
        // Dark disc against the sky, bright disc on the ground.
        let d1 = ((u - 0.25).powi(2) + (v - 0.18).powi(2)).sqrt();
        let a1 = 1.0 - smoothstep(0.08 - edge, 0.08 + edge, d1);
        let d2 = ((u - 0.7).powi(2) + (v - 0.48).powi(2)).sqrt();
        let a2 = 1.0 - smoothstep(0.1 - edge, 0.1 + edge, d2);
        for i in 0..3 {
            c[i] = c[i] * (1.0 - a1) + 30.0 * a1;
            c[i] = c[i] * (1.0 - a2) + (190.0 + 25.0 * (u * 2.0 * std::f32::consts::PI * 30.0).cos()) * a2;
        }
        c.map(|v| v.clamp(0.0, 255.0))
    })
}
