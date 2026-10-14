//! D6.3: Lightroom XMP import and export (`photobook_develop::xmp`). The fixtures in `fixtures/xmp/` are
//! hand-written sidecars, not copied from real photos.

use std::path::PathBuf;

use photobook_develop::geometry::transform::perspective_matrix;
use photobook_develop::settings::{
    Crop, CropAspect, CropRect, DevelopSettings, GuideKind, ManualTransform, UprightGuide, UprightMode, WhiteBalance,
};
use photobook_develop::xmp::{
    self, merge_into_sidecar, orientation_map, read_embedded, read_packet, read_photobook_packet, read_sidecar,
    remap_crop_for_orientation, remap_transform_sliders, remap_upright_transform, write_crs_packet,
    write_photobook_packet, CrsExportOptions, DropKind, XmpImport,
};
use photobook_develop::{canonical_json, develop_hash};
use serde_json::{json, Value};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/xmp").join(name)
}

/// Settings from a partial JSON object (missing fields take their defaults).
fn settings(partial: Value) -> DevelopSettings {
    serde_json::from_value(partial).expect("expected settings deserialise")
}

/// Compare two JSON values, numbers within `eps`; panics with the path of the first difference.
fn assert_close(actual: &Value, expected: &Value, eps: f64, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            assert!((a - b).abs() <= eps, "{path}: {a} != {b}");
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: array lengths differ");
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                assert_close(x, y, eps, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            let mut keys: Vec<&String> = a.keys().chain(b.keys()).collect();
            keys.sort();
            keys.dedup();
            for k in keys {
                let (x, y) = (a.get(k).unwrap_or(&Value::Null), b.get(k).unwrap_or(&Value::Null));
                assert_close(x, y, eps, &format!("{path}.{k}"));
            }
        }
        (a, b) => assert_eq!(a, b, "{path}"),
    }
}

fn assert_settings_close(actual: &DevelopSettings, expected: &DevelopSettings) {
    let (a, b) = (serde_json::to_value(actual).unwrap(), serde_json::to_value(expected).unwrap());
    if a == b {
        return;
    }
    assert_close(&a, &b, 1e-9, "settings");
}

fn dropped_fields(import: &XmpImport, kind: DropKind) -> Vec<String> {
    import.dropped.iter().filter(|d| d.kind == kind).map(|d| d.field.clone()).collect()
}

#[test]
fn basic_sidecar() {
    let import = read_sidecar(fixture("basic.xmp")).unwrap();
    let expected = settings(json!({
        "version": 1,
        "light": { "exposure": 0.65, "contrast": 15, "highlights": -40, "shadows": 30, "whites": 5, "blacks": -8 },
        "whiteBalance": { "mode": "incremental", "temperature": 12, "tint": -4 },
        "color": { "vibrance": 20, "saturation": -5 },
        "detail": { "clarity": 18, "texture": 10, "dehaze": 7, "sharpen": { "amount": 0 } },
    }));
    // Exact here: every value is written with the same digits.
    assert_eq!(
        canonical_json(&serde_json::to_value(&import.settings).unwrap()),
        canonical_json(&serde_json::to_value(&expected).unwrap())
    );
    assert_eq!(import.process_version.as_deref(), Some("15.4"));
    assert_eq!(import.orientation, Some(1));
    assert!(!import.already_applied);
    assert!(import.dropped.is_empty(), "{:?}", import.dropped);
    // CameraProfile is not mapped: ignored but counted. HasSettings/Version are metadata.
    assert_eq!(import.ignored, vec!["CameraProfile".to_string()]);
}

#[test]
fn curves_and_mix_sidecar() {
    let import = read_sidecar(fixture("curves-mix.xmp")).unwrap();
    let bands = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"];
    let mut mix = serde_json::Map::new();
    for (i, b) in bands.iter().enumerate() {
        let i = i as i64;
        mix.insert(b.to_string(), json!({ "hue": i * 2 - 7, "saturation": i * 3 - 10, "luminance": 10 - i * 2 }));
    }
    let c = |v: f64| v / 255.0;
    let expected = settings(json!({
        "version": 1,
        "whiteBalance": { "mode": "asShot" },
        "curve": {
            "parametric": { "highlights": -12, "lights": 8, "darks": 5, "shadows": -10, "splits": [0.2, 0.45, 0.8] },
            "luma": [[0, 0], [c(64.0), c(56.0)], [c(192.0), c(200.0)], [1, 1]],
            "red": [[0, 0], [c(128.0), c(140.0)], [1, 1]],
            "green": [[0, 0], [1, 1]],
            "blue": [[0, c(10.0)], [1, c(245.0)]],
        },
        "color": { "mix": mix },
        "detail": { "sharpen": { "amount": 60, "radius": 1.2, "detail": 30, "masking": 15 } },
    }));
    assert_settings_close(&import.settings, &expected);
    assert_eq!(import.process_version.as_deref(), Some("11.0"));
    assert_eq!(
        dropped_fields(&import, DropKind::Dropped),
        vec!["LuminanceSmoothing", "ColorNoiseReduction", "GrainAmount"]
    );
    let denoise = import.dropped.iter().find(|d| d.field == "LuminanceSmoothing").unwrap();
    assert!(denoise.reason.contains("model-based"));
    assert!(import.ignored.is_empty(), "{:?}", import.ignored);
}

#[test]
fn geometry_sidecar_with_orientation_6() {
    let import = read_sidecar(fixture("geometry.xmp")).unwrap();
    assert_eq!(import.orientation, Some(6));
    let g = &import.settings.geometry;

    // Crop: recorded L 0.1 T 0.2 R 0.7 B 0.9 → oriented (u, v) → (1 − v, u).
    let crop = g.crop.as_ref().unwrap();
    assert_close(
        &serde_json::to_value(crop).unwrap(),
        &json!({ "rect": { "x": 0.1, "y": 0.1, "w": 0.7, "h": 0.6 }, "angle": 2.5, "aspect": "free" }),
        1e-12,
        "crop",
    );
    assert!(!g.constrain_crop);
    // Sliders: (H, V) = (10, −20) → (20, 10); (X, Y) = (4, −6) → (6, 4); aspect negates.
    assert_eq!(
        g.transform,
        ManualTransform { vertical: 10.0, horizontal: 20.0, rotate: 1.5, aspect: -15.0, scale: 95.0, offset_x: 6.0, offset_y: 4.0 }
    );
    assert_eq!(g.upright.mode, UprightMode::Guided);
    assert_eq!(g.upright.focal, Some(0.75));
    let want = [0.98, 0.02, 0.01, -0.01, 1.02, -0.005, 0.0, 0.02, 1.0];
    for (a, b) in g.upright.transform.unwrap().iter().zip(want) {
        assert!((a - b).abs() < 1e-12, "{:?}", g.upright.transform);
    }

    // Guides: recorded → oriented (orientation 6) → through Upright and the sliders (6000 × 4000 recorded,
    // so 4000 × 6000 oriented).
    let warp = perspective_matrix(g, 4000.0, 6000.0);
    let segs = [[0.1, 0.2, 0.9, 0.25], [0.1, 0.8, 0.9, 0.75], [0.2, 0.1, 0.25, 0.9], [0.8, 0.1, 0.75, 0.9]];
    assert_eq!(g.upright.guides.len(), 4);
    for (guide, s) in g.upright.guides.iter().zip(segs) {
        let from = warp.apply(orientation_map(6).apply([s[0], s[1]]));
        let to = warp.apply(orientation_map(6).apply([s[2], s[3]]));
        for (a, b) in guide.from.iter().chain(&guide.to).zip(from.iter().chain(&to)) {
            assert!((a - b).abs() < 1e-12);
        }
    }
    // Horizontal in the recorded frame are vertical once rotated.
    let kinds: Vec<GuideKind> = g.upright.guides.iter().map(|g| g.kind).collect();
    assert_eq!(kinds, [GuideKind::Vertical, GuideKind::Vertical, GuideKind::Horizontal, GuideKind::Horizontal]);
    assert_eq!(import.settings.white_balance, WhiteBalance::Absolute { temperature: 4850.0, tint: 12.0 });

    let masks = import.dropped.iter().find(|d| d.field == "MaskGroupBasedCorrections").unwrap();
    assert_eq!(masks.kind, DropKind::Dropped);
    assert!(masks.reason.contains("masks are not imported (2 corrections)"), "{}", masks.reason);
    let unverified = dropped_fields(&import, DropKind::Unverified);
    assert_eq!(unverified, vec!["Perspective*", "UprightTransform_5", "UprightFourSegments_N", "CropAngle"]);
    assert_eq!(import.ignored, vec!["UprightTransformCount".to_string()]);
}

#[test]
fn legacy_process_version_is_dropped() {
    let import = read_sidecar(fixture("legacy-pv2010.xmp")).unwrap();
    assert!(import.settings.is_default());
    assert_eq!(import.process_version.as_deref(), Some("5.7"));
    assert_eq!(
        dropped_fields(&import, DropKind::Dropped),
        vec!["ProcessVersion", "Exposure", "Brightness", "Contrast", "FillLight", "ToneCurve"]
    );
    assert!(import.dropped[0].reason.contains("predates PV2012"));
    // Everything else in a legacy packet is ignored, not mapped.
    assert!(import.ignored.contains(&"Vibrance".to_string()));
}

#[test]
fn legacy_without_process_version_is_detected() {
    let xml = r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure="+1.0"/>
    </rdf:RDF>"#;
    let import = read_packet(xml).unwrap();
    assert!(import.settings.is_default());
    assert_eq!(import.dropped[0].field, "ProcessVersion");
}

#[test]
fn already_applied_is_flagged() {
    let xml = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
        crs:ProcessVersion="15.4" crs:AlreadyApplied="True" crs:Exposure2012="+0.30"/>
    </rdf:RDF></x:xmpmeta>"#;
    let import = read_packet(xml).unwrap();
    assert!(import.already_applied);
    assert_eq!(import.settings.light.exposure, 0.3);
}

#[test]
fn element_form_white_balance_and_bad_values() {
    // Element-form simple properties, an unparseable number, a bad curve.
    let xml = r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
        <crs:ProcessVersion>15.4</crs:ProcessVersion>
        <crs:WhiteBalance>As Shot</crs:WhiteBalance>
        <crs:IncrementalTemperature>0</crs:IncrementalTemperature>
        <crs:IncrementalTint>0</crs:IncrementalTint>
        <crs:Contrast2012>lots</crs:Contrast2012>
        <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li></rdf:Seq></crs:ToneCurvePV2012>
        <crs:Whites2012>+3</crs:Whites2012>
      </rdf:Description>
    </rdf:RDF>"#;
    let import = read_packet(xml).unwrap();
    assert_eq!(import.settings.white_balance, WhiteBalance::AsShot);
    assert_eq!(import.settings.light.whites, 3.0);
    assert_eq!(import.settings.light.contrast, 0.0);
    assert_eq!(dropped_fields(&import, DropKind::Dropped), vec!["Contrast2012", "ToneCurvePV2012"]);
}

#[test]
fn six_scalar_upright_transform_is_affine() {
    let xml = r#"<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:ProcessVersion="15.4"
        crs:PerspectiveUpright="2" crs:UprightTransform_0="1.1" crs:UprightTransform_1="0"
        crs:UprightTransform_2="-0.05" crs:UprightTransform_3="0" crs:UprightTransform_4="0.9"
        crs:UprightTransform_5="0.05"/>
    </rdf:RDF>"#;
    let import = read_packet(xml).unwrap();
    assert_eq!(import.settings.geometry.upright.mode, UprightMode::Full);
    assert_eq!(import.settings.geometry.upright.transform, Some([1.1, 0.0, -0.05, 0.0, 0.9, 0.05, 0.0, 0.0, 1.0]));
    assert_eq!(dropped_fields(&import, DropKind::Unverified), vec!["UprightTransform_0..5"]);
}

#[test]
fn crop_remap_for_orientations() {
    let rect = CropRect { x: 0.1, y: 0.2, w: 0.6, h: 0.7 }; // L 0.1 T 0.2 R 0.7 B 0.9
    let close = |(r, a): (CropRect, f64), want: [f64; 4], angle: f64| {
        let got = [r.x, r.y, r.w, r.h];
        for (g, w) in got.iter().zip(want) {
            assert!((g - w).abs() < 1e-12, "{got:?} vs {want:?}");
        }
        assert_eq!(a, angle);
    };
    close(remap_crop_for_orientation(&rect, 3.0, 1), [0.1, 0.2, 0.6, 0.7], 3.0);
    // 180°: (1 − u, 1 − v).
    close(remap_crop_for_orientation(&rect, 3.0, 3), [0.3, 0.1, 0.6, 0.7], 3.0);
    // 90° clockwise: (1 − v, u); width and height swap.
    close(remap_crop_for_orientation(&rect, 3.0, 6), [0.1, 0.1, 0.7, 0.6], 3.0);
    // 270° clockwise: (v, 1 − u).
    close(remap_crop_for_orientation(&rect, 3.0, 8), [0.2, 0.3, 0.7, 0.6], 3.0);
    // Mirrors flip the angle.
    close(remap_crop_for_orientation(&rect, 3.0, 2), [0.3, 0.2, 0.6, 0.7], -3.0);
    // Each is undone by the inverse orientation.
    for o in 1..=8u8 {
        let (r, a) = remap_crop_for_orientation(&rect, 3.0, o);
        let (back, a2) = remap_crop_for_orientation(&r, a, xmp::inverse_orientation(o));
        close((back, a2), [0.1, 0.2, 0.6, 0.7], 3.0);
    }
}

#[test]
fn slider_and_homography_remaps() {
    let t = ManualTransform { vertical: -20.0, horizontal: 10.0, rotate: 2.0, aspect: 30.0, scale: 110.0, offset_x: 5.0, offset_y: -7.0 };
    let r8 = remap_transform_sliders(&t, 8);
    assert_eq!((r8.horizontal, r8.vertical, r8.offset_x, r8.offset_y), (-20.0, -10.0, -7.0, -5.0));
    assert_eq!((r8.rotate, r8.aspect, r8.scale), (2.0, -30.0, 110.0));
    let r3 = remap_transform_sliders(&t, 3);
    assert_eq!((r3.horizontal, r3.vertical, r3.offset_x, r3.offset_y, r3.aspect), (-10.0, 20.0, -5.0, 7.0, 30.0));
    let r2 = remap_transform_sliders(&t, 2);
    assert_eq!((r2.horizontal, r2.vertical, r2.rotate), (-10.0, -20.0, -2.0));
    // A recorded shift right by 0.1 is a shift down by 0.1 once rotated 90° clockwise.
    let shift = [1.0, 0.0, 0.1, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    assert_eq!(remap_upright_transform(shift, 6), [1.0, 0.0, 0.0, 0.0, 1.0, 0.1, 0.0, 0.0, 1.0]);
}

#[test]
fn embedded_packet_in_jpeg() {
    let (w, h) = (16usize, 16usize);
    let pixels: Vec<u8> = (0..w * h * 3).map(|i| (i * 7 % 251) as u8).collect();
    let img = turbojpeg::Image { pixels: pixels.as_slice(), width: w, pitch: w * 3, height: h, format: turbojpeg::PixelFormat::RGB };
    let jpeg = turbojpeg::compress(img, 90, turbojpeg::Subsamp::None).unwrap().to_vec();
    let dir = tempfile::tempdir().unwrap();

    // No packet yet.
    let plain = dir.path().join("plain.jpg");
    std::fs::write(&plain, &jpeg).unwrap();
    assert!(read_embedded(&plain).unwrap().is_none());

    let xml = std::fs::read_to_string(fixture("basic.xmp")).unwrap();
    let mut payload = b"http://ns.adobe.com/xap/1.0/\0".to_vec();
    payload.extend_from_slice(xml.as_bytes());
    let mut spliced = jpeg[..2].to_vec();
    spliced.extend_from_slice(&[0xFF, 0xE1]);
    spliced.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    spliced.extend_from_slice(&payload);
    spliced.extend_from_slice(&jpeg[2..]);
    let path = dir.path().join("embedded.jpg");
    std::fs::write(&path, &spliced).unwrap();

    let embedded = read_embedded(&path).unwrap().expect("packet found");
    assert_eq!(embedded, read_sidecar(fixture("basic.xmp")).unwrap());
    // The spliced file still decodes.
    assert!(photobook_develop::decode_file(&path, None).is_ok());
}

/// Every importable field set away from its default.
fn everything() -> DevelopSettings {
    let c = |v: f64| v / 255.0;
    settings(json!({
        "version": 1,
        "light": { "exposure": 0.65, "contrast": 15, "highlights": -40, "shadows": 30, "whites": 5, "blacks": -8 },
        "whiteBalance": { "mode": "incremental", "temperature": 12, "tint": -4 },
        "curve": {
            "parametric": { "highlights": -12, "lights": 8, "darks": 5, "shadows": -10, "splits": [0.2, 0.45, 0.8] },
            "luma": [[0, 0], [c(64.0), c(56.0)], [1, 1]],
            "red": [[0, c(3.0)], [1, 1]],
            "green": [[0, 0], [c(100.0), c(120.0)], [1, 1]],
            "blue": [[0, 0], [1, c(250.0)]],
        },
        "color": {
            "vibrance": 20, "saturation": -5,
            "mix": {
                "red": { "hue": 5, "saturation": -10, "luminance": 3 },
                "aqua": { "hue": -20, "saturation": 15, "luminance": -7 },
                "magenta": { "hue": 1, "saturation": 2, "luminance": 4 },
            },
        },
        "detail": { "clarity": 18, "texture": 10, "dehaze": 7, "sharpen": { "amount": 70, "radius": 1.4, "detail": 35, "masking": 20 } },
        "geometry": {
            "upright": {
                "mode": "guided",
                "guides": [
                    { "id": "xmp-guide-1", "kind": "vertical", "from": [0.2, 0.1], "to": [0.22, 0.9] },
                    { "id": "xmp-guide-2", "kind": "horizontal", "from": [0.1, 0.3], "to": [0.85, 0.32] },
                ],
                "transform": [1.01, 0.02, -0.01, 0.005, 0.99, 0.003, 0.01, -0.02, 1],
                "focal": 0.8,
            },
            "transform": { "vertical": -12, "horizontal": 6, "rotate": 1.25, "aspect": 10, "scale": 105, "offsetX": 3, "offsetY": -2 },
            "constrainCrop": false,
            "crop": { "rect": { "x": 0.05, "y": 0.1, "w": 0.8, "h": 0.75 }, "angle": -3.5, "aspect": "free" },
        },
    }))
}

#[test]
fn crs_round_trip() {
    let original = everything();
    for (orientation, size) in [(None, None), (Some(1), None), (Some(6), Some((6000, 4000))), (Some(5), Some((4000, 3000))), (Some(3), None)] {
        let xml = write_crs_packet(&original, &CrsExportOptions { warn: true, orientation, source_size: size });
        let import = read_packet(&xml).unwrap_or_else(|e| panic!("{e}\n{xml}"));
        assert_settings_close(&import.settings, &original);
        assert_eq!(import.orientation, orientation);
        assert_eq!(import.process_version.as_deref(), Some("15.4"));
        assert!(import.ignored.is_empty(), "{:?}", import.ignored);
        assert!(import.dropped.iter().all(|d| d.kind == DropKind::Unverified), "{:?}", import.dropped);
        assert!(xml.contains("photobook:ExportWarning="));
    }
    // Absolute white balance, no crop, Upright off: the defaults stay defaults.
    let mut s = DevelopSettings::default();
    s.white_balance = WhiteBalance::Absolute { temperature: 5200.0, tint: 7.0 };
    let import = read_packet(&write_crs_packet(&s, &CrsExportOptions::default())).unwrap();
    assert_eq!(import.settings, s);
    assert!(import.dropped.is_empty());
    let import = read_packet(&write_crs_packet(&DevelopSettings::default(), &CrsExportOptions::default())).unwrap();
    assert!(import.settings.is_default(), "{:?}", import.settings);
}

#[test]
fn crs_export_writes_lightroom_shapes() {
    let xml = write_crs_packet(&everything(), &CrsExportOptions { warn: false, orientation: Some(6), source_size: None });
    assert!(xml.contains(r#"crs:ProcessVersion="15.4""#));
    assert!(xml.contains(r#"tiff:Orientation="6""#));
    assert!(xml.contains("<rdf:li>64, 56</rdf:li>"));
    assert!(xml.contains(r#"crs:ParametricMidtoneSplit="45""#));
    assert!(xml.contains(r#"crs:PerspectiveUpright="5""#));
    assert!(xml.contains("crs:UprightTransform_5="));
    assert!(!xml.contains("ExportWarning"));
    assert!(xml.starts_with("<?xpacket begin="));
}

#[test]
fn photobook_packet_round_trip() {
    let mut s = everything();
    s.detail.denoise = Some(serde_json::from_value(json!({ "model": "nafnet-w32" })).unwrap());
    s.geometry.crop = Some(Crop { rect: CropRect { x: 0.0, y: 0.0, w: 1.0, h: 0.5 }, angle: 0.0, aspect: CropAspect::Ratio(3.0, 2.0) });
    let xml = write_photobook_packet(&s);
    assert!(xml.contains("photobook:Engine="));
    let back = read_photobook_packet(&xml).unwrap().unwrap();
    assert_eq!(back, s);
    assert_eq!(develop_hash(&back), develop_hash(&s));
    assert!(read_photobook_packet(&std::fs::read_to_string(fixture("basic.xmp")).unwrap()).unwrap().is_none());
}

#[test]
fn merge_keeps_other_properties() {
    let existing = std::fs::read_to_string(fixture("geometry.xmp")).unwrap().replace(
        "crs:Version=\"15.4\"",
        "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" crs:Version=\"15.4\"",
    );
    let existing = existing.replace(
        "   <crs:MaskGroupBasedCorrections>",
        "   <dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">Harbour &amp; boats</rdf:li></rdf:Alt></dc:title>\n   <crs:MaskGroupBasedCorrections>",
    );
    assert!(existing.contains("dc:title"));

    // A photobook packet keeps the Lightroom settings.
    let mut s = DevelopSettings::default();
    s.light.exposure = 1.25;
    let merged = merge_into_sidecar(Some(&existing), &write_photobook_packet(&s)).unwrap();
    assert_eq!(read_photobook_packet(&merged).unwrap(), Some(s.clone()));
    assert_eq!(read_packet(&merged).unwrap(), read_packet(&existing).unwrap());
    assert!(merged.contains("Harbour &amp; boats"));

    // A crs packet replaces every crs field (the masks go) and keeps dc:title, exif and photobook.
    let mut t = DevelopSettings::default();
    t.light.contrast = 22.0;
    let crs = write_crs_packet(&t, &CrsExportOptions { warn: true, orientation: Some(6), source_size: None });
    let merged2 = merge_into_sidecar(Some(&merged), &crs).unwrap();
    let import = read_packet(&merged2).unwrap();
    assert_eq!(import.settings, t);
    assert!(!merged2.contains("MaskGroupBasedCorrections"));
    assert!(merged2.contains("Harbour &amp; boats"));
    assert!(merged2.contains("exif:PixelXDimension=\"6000\""));
    assert_eq!(read_photobook_packet(&merged2).unwrap(), Some(s));
    assert_eq!(merged2.matches("tiff:Orientation=").count(), 1);

    // No sidecar yet: the packet itself. A broken one is an error, not overwritten.
    assert_eq!(merge_into_sidecar(None, &crs).unwrap(), crs);
    assert!(merge_into_sidecar(Some("<x:xmpmeta"), &crs).is_err());
}

#[test]
fn guides_without_image_size_use_upright_only() {
    let mut s = DevelopSettings::default();
    s.geometry.upright.mode = UprightMode::Guided;
    s.geometry.upright.guides = vec![UprightGuide {
        id: "xmp-guide-1".into(),
        kind: GuideKind::Vertical,
        from: [0.3, 0.1],
        to: [0.25, 0.9],
    }];
    // Rotated 90° clockwise: the recorded segment is horizontal; no Upright transform, no sliders.
    let xml = write_crs_packet(&s, &CrsExportOptions { warn: false, orientation: Some(6), source_size: None });
    assert!(xml.contains(r#"crs:UprightFourSegments_0="0.1,0.7,0.9,0.75""#), "{xml}");
    let import = read_packet(&xml).unwrap();
    assert_settings_close(&import.settings, &s);
}
