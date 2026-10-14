//! Golden-image checks of the D1.2 pipeline on three generated fixtures (no binary files): a neutral
//! grey ramp (PNG), a saturated colour chart (PNG) and a synthetic "photo" (JPEG with sky, skin, shadows
//! and noise). Each is written to a temp dir, decoded with `decode_file` and rendered.

use std::path::Path;
use std::time::Instant;

use photobook_develop::color::{matrix, transfer};
use photobook_develop::settings::{HueMix, WhiteBalance};
use photobook_develop::{
    copy_exif, decode_file, encode_jpeg, render_full, render_preview, DevelopSettings, Developer, LinearImage,
    RenderOptions, Rgb8Image,
};

mod common;
use common::*;

// ---------- helpers ----------

/// The reference: decoded pixels straight back to 8-bit sRGB (matrix, transfer function, rounding).
fn baseline(img: &LinearImage) -> Rgb8Image {
    let m = matrix::to_f32(&matrix::rec2020_to_srgb());
    let data = img
        .data
        .chunks_exact(3)
        .flat_map(|p| matrix::apply_f32(&m, p[0], p[1], p[2]).map(|v| (transfer::linear_to_srgb(v.clamp(0.0, 1.0)) * 255.0).round() as u8))
        .collect();
    Rgb8Image::new(img.width, img.height, data)
}

fn max_diff(a: &Rgb8Image, b: &Rgb8Image) -> u8 {
    assert_eq!((a.width, a.height), (b.width, b.height));
    a.data.iter().zip(&b.data).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0)
}

/// Mean of a rectangle, per channel, inset by 4 px to stay clear of JPEG/resample edges.
fn mean(img: &Rgb8Image, x0: u32, y0: u32, w: u32, h: u32) -> [f64; 3] {
    let mut sum = [0.0; 3];
    let mut n = 0.0;
    for y in y0 + 4..y0 + h - 4 {
        for x in x0 + 4..x0 + w - 4 {
            let p = img.pixel(x, y);
            for c in 0..3 {
                sum[c] += p[c] as f64;
            }
            n += 1.0;
        }
    }
    sum.map(|s| s / n)
}

fn patch(img: &Rgb8Image, i: usize) -> [f64; 3] {
    let (x, y) = patch_origin(i);
    mean(img, x, y, PATCH, PATCH)
}

fn lin(v: f64) -> f64 {
    transfer::srgb_to_linear((v / 255.0) as f32) as f64
}

fn render(path: &Path, settings: &DevelopSettings) -> Rgb8Image {
    Developer::new(decode_file(path, None).unwrap()).render(settings)
}

// ---------- tests ----------

#[test]
fn every_default_is_a_noop() {
    let f = fixtures();
    for path in [&f.ramp, &f.chart, &f.photo] {
        let img = decode_file(path, None).unwrap();
        let want = baseline(&img);
        let dev = Developer::new(img.clone());
        let got = dev.render(&DevelopSettings::default());
        assert!(max_diff(&got, &want) <= 1, "{}: default render differs", path.display());
        // Explicit zero sliders in every mode that has them are no-ops too.
        let mut s = DevelopSettings::default();
        s.white_balance = WhiteBalance::Incremental { temperature: 0.0, tint: 0.0 };
        assert!(max_diff(&dev.render(&s), &want) <= 1);
        assert_eq!(render_full(&img, &DevelopSettings::default()).unwrap(), got);
    }
    // And the PNG ramp decodes to exactly its 8-bit values.
    let img = decode_file(&f.ramp, None).unwrap();
    assert_eq!(baseline(&img).data, ramp_pixels());
}

#[test]
fn exposure_plus_one_doubles_linear() {
    let f = fixtures();
    let mut s = DevelopSettings::default();
    s.light.exposure = 1.0;
    let out = render(&f.ramp, &s);
    for v in [40u32, 80, 100, 118, 140, 170] {
        let got = out.pixel(v, RAMP_H / 2)[1] as f64;
        let ratio = lin(got) / lin(v as f64);
        // One output level at this value, as a ratio.
        let tol = (lin(got + 1.0) - lin(got)) / lin(v as f64) + 1e-3;
        assert!((ratio - 2.0).abs() <= tol, "grey {v}: {got} ratio {ratio}");
    }
}

#[test]
fn temperature_plus_50_warms() {
    let f = fixtures();
    let before = render(&f.photo, &DevelopSettings::default());
    let mut s = DevelopSettings::default();
    s.white_balance = WhiteBalance::Incremental { temperature: 50.0, tint: 0.0 };
    let after = render(&f.photo, &s);
    let rb = |img: &Rgb8Image| {
        let m = mean(img, 0, 0, img.width, img.height);
        m[0] / m[2]
    };
    assert!(rb(&after) > rb(&before) * 1.05, "{} vs {}", rb(&after), rb(&before));
}

#[test]
fn saturation_minus_100_is_neutral() {
    let f = fixtures();
    let mut s = DevelopSettings::default();
    s.color.saturation = -100.0;
    for path in [&f.chart, &f.photo] {
        let out = render(path, &s);
        for p in out.data.chunks(3) {
            assert!(p[0].abs_diff(p[1]) <= 1 && p[1].abs_diff(p[2]) <= 1, "{}: {p:?}", path.display());
        }
    }
}

#[test]
fn red_hue_shift_does_not_move_green() {
    let f = fixtures();
    let mut s = DevelopSettings::default();
    s.color.mix.red = HueMix { hue: 100.0, saturation: 0.0, luminance: 0.0 };
    let before = render(&f.chart, &DevelopSettings::default());
    let after = render(&f.chart, &s);
    for (i, colour) in CHART.iter().enumerate() {
        let (b, a) = (patch(&before, i), patch(&after, i));
        if *colour == [0, 255, 0] || *colour == [0, 0, 255] || colour[0] == colour[1] && colour[1] == colour[2] {
            for c in 0..3 {
                assert!((a[c] - b[c]).abs() <= 1.0, "patch {colour:?} moved: {b:?} → {a:?}");
            }
        }
    }
    let (b, a) = (patch(&before, 12), patch(&after, 12));
    assert!(a[1] > b[1] + 5.0, "red patch should move towards orange: {b:?} → {a:?}");
}

#[test]
fn contrast_keeps_mid_grey() {
    let f = fixtures();
    let mut s = DevelopSettings::default();
    s.light.contrast = 100.0;
    let out = render(&f.ramp, &s);
    let y = RAMP_H / 2;
    assert!(out.pixel(118, y)[0].abs_diff(118) <= 3, "{:?}", out.pixel(118, y));
    assert!(out.pixel(60, y)[0] < 55 && out.pixel(200, y)[0] > 205);
    s.light.contrast = -100.0;
    let out = render(&f.ramp, &s);
    assert!(out.pixel(118, y)[0].abs_diff(118) <= 3);
    assert!(out.pixel(60, y)[0] > 65 && out.pixel(200, y)[0] < 195);
}

#[test]
fn halving_point_curve_halves_output() {
    let f = fixtures();
    let mut s = DevelopSettings::default();
    s.curve.luma = vec![[0.0, 0.0], [1.0, 0.5]];
    let out = render(&f.ramp, &s);
    for x in 0..RAMP_W {
        let got = out.pixel(x, 3)[0] as f64;
        assert!((got - x as f64 / 2.0).abs() <= 1.0, "{x}: {got}");
    }
}

#[test]
fn parametric_highlights_darken_brights_only() {
    let f = fixtures();
    let mut s = DevelopSettings::default();
    s.curve.parametric.highlights = -100.0;
    let out = render(&f.ramp, &s);
    assert!(out.pixel(220, 3)[0] < 205, "{:?}", out.pixel(220, 3));
    assert!(out.pixel(50, 3)[0].abs_diff(50) <= 1);
    assert!(out.pixel(255, 3)[0] >= 254);
}

#[test]
fn highlights_shadows_whites_blacks() {
    let f = fixtures();
    let base = render(&f.chart, &DevelopSettings::default());
    let mut s = DevelopSettings::default();
    s.light.shadows = 100.0;
    let lifted = render(&f.chart, &s);
    assert!(patch(&lifted, 10)[0] > patch(&base, 10)[0] + 8.0, "dark grey should lift");
    assert!((patch(&lifted, 11)[0] - patch(&base, 11)[0]).abs() < 2.0, "near white should hold");
    let mut s = DevelopSettings::default();
    s.light.highlights = -100.0;
    let pulled = render(&f.chart, &s);
    assert!(patch(&pulled, 11)[0] < patch(&base, 11)[0] - 15.0, "near white should come down");
    assert!((patch(&pulled, 10)[0] - patch(&base, 10)[0]).abs() < 1.0, "dark grey should hold");
    let mut s = DevelopSettings::default();
    s.light.blacks = -100.0;
    let crushed = render(&f.chart, &s);
    assert!(patch(&crushed, 10)[0] < patch(&base, 10)[0] - 5.0);
    let mut s = DevelopSettings::default();
    s.light.whites = 100.0;
    let brighter = render(&f.chart, &s);
    assert!(patch(&brighter, 9)[0] > patch(&base, 9)[0] + 3.0);
    // The developer reuses its cached base across renders and agrees with render_full.
    let img = decode_file(&f.chart, None).unwrap();
    let dev = Developer::new(img.clone());
    let mut s = DevelopSettings::default();
    s.light.shadows = 60.0;
    s.light.highlights = -40.0;
    let a = dev.render(&s);
    s.light.exposure = 0.3;
    let _ = dev.render(&s);
    s.light.exposure = 0.0;
    assert_eq!(dev.render(&s), a);
    assert_eq!(render_full(&img, &s).unwrap(), a);
}

#[test]
fn vibrance_and_look_options() {
    let f = fixtures();
    let mut s = DevelopSettings::default();
    s.color.vibrance = 100.0;
    let base = render(&f.chart, &DevelopSettings::default());
    let vib = render(&f.chart, &s);
    let spread = |p: [f64; 3]| p.iter().cloned().fold(0.0, f64::max) - p.iter().cloned().fold(255.0, f64::min);
    // The muted sky patch gains more than the skin patch.
    let sky_gain = spread(patch(&vib, 8)) - spread(patch(&base, 8));
    let skin_gain = spread(patch(&vib, 7)) - spread(patch(&base, 7));
    assert!(sky_gain > 10.0 && sky_gain > skin_gain * 1.5, "sky {sky_gain} skin {skin_gain}");
    // The optional display look keeps mid-grey and rolls white off to about 217.
    let dev = Developer::new(decode_file(&f.chart, None).unwrap());
    let look = dev.render_with(&DevelopSettings::default(), &RenderOptions { look: true, ..RenderOptions::default() });
    assert!((patch(&look, 9)[0] - 118.0).abs() <= 2.0, "{:?}", patch(&look, 9));
    assert!((patch(&look, 17)[0] - 217.0).abs() <= 3.0, "{:?}", patch(&look, 17));
}

#[test]
fn decode_orientation_and_scaling() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rotated.jpg");
    let (w, h) = (640, 427);
    let mut pixels = photo_pixels(w, h);
    // Mark the stored top-left corner red so the rotation is visible.
    for y in 0..40 {
        for x in 0..40 {
            let i = ((y * w + x) * 3) as usize;
            pixels[i..i + 3].copy_from_slice(&[255, 0, 0]);
        }
    }
    write_jpeg(&path, w, h, &pixels, Some(6));
    let img = decode_file(&path, None).unwrap();
    assert_eq!((img.width, img.height), (427, 640));
    // Orientation 6: the stored top-left ends up top-right.
    let p = img.pixel(426 - 10, 10);
    assert!(p[0] > 0.5 && p[1] < 0.1, "{p:?}");
    let small = decode_file(&path, Some(200)).unwrap();
    assert_eq!((small.width, small.height), (133, 200));
    assert!(decode_file(&dir.path().join("x.heic"), None).is_err());
}

#[test]
fn sixteen_bit_png_and_alpha() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deep.png");
    let data: Vec<u16> = (0..64u32).flat_map(|x| [(x * 1040) as u16; 3]).collect();
    image::ImageBuffer::<image::Rgb<u16>, _>::from_raw(64, 1, data).unwrap().save(&path).unwrap();
    let img = decode_file(&path, None).unwrap();
    for x in 0..64u32 {
        let want = transfer::srgb_to_linear((x * 1040) as f32 / 65535.0);
        assert!((img.pixel(x, 0)[1] - want).abs() < 1e-4, "{x}");
    }
    let path = dir.path().join("alpha.png");
    image::RgbaImage::from_raw(2, 1, vec![0, 0, 0, 0, 0, 0, 0, 255]).unwrap().save(&path).unwrap();
    let img = decode_file(&path, None).unwrap();
    assert!((img.pixel(0, 0)[0] - 1.0).abs() < 1e-4, "transparent is white");
    assert!(img.pixel(1, 0)[0].abs() < 1e-6);
}

#[test]
fn display_p3_jpeg_is_colour_managed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p3.jpg");
    let (w, h, data) = chart_pixels();
    let img = || turbojpeg::Image { pixels: data.as_slice(), width: w as usize, pitch: w as usize * 3, height: h as usize, format: turbojpeg::PixelFormat::RGB };
    let mut bytes = turbojpeg::compress(img(), 95, turbojpeg::Subsamp::None).unwrap().to_vec();
    let mut payload = b"ICC_PROFILE\0\x01\x01".to_vec();
    payload.extend_from_slice(&moxcms::ColorProfile::new_display_p3().encode().unwrap());
    splice_segment(&mut bytes, 0xE2, &payload);
    std::fs::write(&path, &bytes).unwrap();
    let tagged = decode_file(&path, None).unwrap();
    std::fs::write(&path, turbojpeg::compress(img(), 95, turbojpeg::Subsamp::None).unwrap().to_vec()).unwrap();
    let untagged = decode_file(&path, None).unwrap();
    // P3 green is more saturated than sRGB green, so its Rec.2020 red component is lower.
    let (x, y) = patch_origin(1);
    let (pt, pu) = (tagged.pixel(x + 20, y + 20), untagged.pixel(x + 20, y + 20));
    assert!(pt[0] < pu[0] - 0.02, "P3 green {pt:?} vs sRGB green {pu:?}");
    let m = matrix::p3_to_rec2020();
    let want = matrix::apply(&m, [0.0, 1.0, 0.0]);
    for c in 0..3 {
        assert!((pt[c] as f64 - want[c]).abs() < 0.02, "{pt:?} vs {want:?}");
    }
}

#[test]
fn preview_jpeg_profile_and_exif() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src.jpg");
    write_jpeg(&src, 640, 427, &photo_pixels(640, 427), Some(8));
    let img = decode_file(&src, None).unwrap();
    let mut s = DevelopSettings::default();
    s.light.exposure = 0.5;
    let mut jpeg = render_preview(&img, &s, 320, 85).unwrap();
    let header = turbojpeg::read_header(&jpeg).unwrap();
    assert_eq!((header.width, header.height), (214, 320));
    assert_eq!(header.subsamp, turbojpeg::Subsamp::Sub2x2);
    assert!(jpeg.windows(12).any(|w| w == b"ICC_PROFILE\0"), "sRGB profile embedded");
    assert!(copy_exif(&src, &mut jpeg).unwrap());
    let exif = exif::Reader::new().read_from_container(&mut std::io::Cursor::new(&jpeg)).unwrap();
    let orientation = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY).unwrap().value.get_uint(0);
    assert_eq!(orientation, Some(1));
    // Our own output decodes back as sRGB (its profile is recognised) and upright.
    let back_path = dir.path().join("back.jpg");
    std::fs::write(&back_path, &jpeg).unwrap();
    assert_eq!(decode_file(&back_path, None).unwrap().width, 214);

    let full = render_full(&img, &s).unwrap();
    let q95 = encode_jpeg(&full, 95).unwrap();
    assert_eq!(turbojpeg::read_header(&q95).unwrap().subsamp, turbojpeg::Subsamp::None);
    let png = dir.path().join("x.png");
    write_png8(&png, 2, 2, vec![0; 12]);
    assert!(!copy_exif(&png, &mut jpeg.clone()).unwrap());
}

/// A 24 MP render on the CPU. Run with
/// `cargo test -p photobook-develop --release -- --ignored --nocapture`.
#[test]
#[ignore]
fn timing_24mp() {
    let (w, h) = (6000u32, 4000u32);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.jpg");
    let t = Instant::now();
    write_jpeg(&path, w, h, &photo_pixels(w, h), None);
    eprintln!("synthesise + encode source: {:?}", t.elapsed());

    let t = Instant::now();
    let img = decode_file(&path, None).unwrap();
    eprintln!("decode 24 MP JPEG to linear: {:?}", t.elapsed());
    let t = Instant::now();
    let proxy = decode_file(&path, Some(1600)).unwrap();
    eprintln!("decode to a 1600 px proxy: {:?} ({}x{})", t.elapsed(), proxy.width, proxy.height);

    let dev = Developer::new(img);
    let t = Instant::now();
    let _ = dev.render(&DevelopSettings::default());
    eprintln!("render 24 MP, defaults: {:?}", t.elapsed());

    let mut s = DevelopSettings::default();
    s.white_balance = WhiteBalance::Incremental { temperature: 20.0, tint: 5.0 };
    s.light.exposure = 0.3;
    s.light.highlights = -60.0;
    s.light.shadows = 40.0;
    s.light.whites = 10.0;
    s.light.blacks = -10.0;
    s.light.contrast = 25.0;
    s.color.vibrance = 30.0;
    s.color.saturation = 10.0;
    s.color.mix.blue = HueMix { hue: -10.0, saturation: 20.0, luminance: -20.0 };
    s.curve.parametric.lights = 20.0;
    s.curve.luma = vec![[0.0, 0.02], [0.5, 0.52], [1.0, 1.0]];
    let t = Instant::now();
    let _ = dev.render(&s);
    eprintln!("render 24 MP, every slider, first (computes the base): {:?}", t.elapsed());
    let t = Instant::now();
    let out = dev.render(&s);
    eprintln!("render 24 MP, every slider, cached base: {:?}", t.elapsed());
    let t = Instant::now();
    let jpeg = encode_jpeg(&out, 95).unwrap();
    eprintln!("encode 24 MP JPEG q95 4:4:4: {:?} ({} bytes)", t.elapsed(), jpeg.len());

    let pdev = Developer::new(proxy);
    let _ = pdev.render(&s);
    for _ in 0..3 {
        let t = Instant::now();
        let pout = pdev.render(&s);
        let rendered = t.elapsed();
        let pj = encode_jpeg(&pout, 85).unwrap();
        eprintln!("proxy, every slider: render {rendered:?}, + encode q85 {:?} ({} bytes)", t.elapsed(), pj.len());
    }
}
