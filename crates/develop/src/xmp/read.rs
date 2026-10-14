//! `crs:` packets → [`XmpImport`].

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use super::dom::{self, Element};
use super::fields::*;
use super::{DroppedItem, XmpImport, NS_CRS, NS_EXIF, NS_PHOTOBOOK, NS_RDF, NS_TIFF};
use crate::error::{Error, Result};
use crate::geometry::transform::{perspective_matrix, upright_matrix};
use crate::settings::{
    Crop, CropAspect, CropRect, DevelopSettings, GuideKind, ManualTransform, UprightGuide, UprightMode, WhiteBalance,
};

/// APP1 signature of a standard XMP packet in a JPEG.
const XMP_SIG: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

/// Lowest process version with the 2012 sliders (PV2012 = "6.7").
const PV2012: f64 = 6.7;

/// One property value: a simple value, or the items of an `rdf:Seq`/`Bag`/`Alt`, or a struct.
#[derive(Debug, Clone, Default)]
struct Prop {
    text: Option<String>,
    items: Vec<String>,
    /// Number of `rdf:li` items (or 1 for a struct).
    count: usize,
}

fn prop_of(el: &Element) -> Prop {
    if let Some(list) = el.elements().find(|e| e.is(NS_RDF, "Seq") || e.is(NS_RDF, "Bag") || e.is(NS_RDF, "Alt")) {
        let lis: Vec<&Element> = list.elements().filter(|e| e.is(NS_RDF, "li")).collect();
        let items = lis.iter().map(|li| li.text().trim().to_string()).collect();
        return Prop { text: None, items, count: lis.len() };
    }
    if el.elements().next().is_some() || el.attr(NS_RDF, "parseType").is_some() {
        return Prop { text: None, items: Vec::new(), count: 1 };
    }
    if let Some(r) = el.attr(NS_RDF, "resource") {
        return Prop { text: Some(r.to_string()), items: Vec::new(), count: 0 };
    }
    Prop { text: Some(el.text().trim().to_string()), items: Vec::new(), count: 0 }
}

/// The top-level properties of every `rdf:Description` directly under `rdf:RDF`, keyed by
/// `(namespace, local name)`; the first occurrence wins. Nested descriptions (`crs:Look`, mask
/// corrections) stay inside their property.
fn collect(root: &Element) -> Result<HashMap<(String, String), Prop>> {
    let rdf = root.find(NS_RDF, "RDF").ok_or_else(|| Error::Invalid("XMP: no rdf:RDF element".into()))?;
    let mut out: HashMap<(String, String), Prop> = HashMap::new();
    for desc in rdf.elements().filter(|e| e.is(NS_RDF, "Description")) {
        for a in &desc.attrs {
            if a.is_xmlns() || a.ns.as_deref() == Some(NS_RDF) {
                continue;
            }
            if let Some(ns) = &a.ns {
                out.entry((ns.clone(), a.local.clone())).or_insert(Prop {
                    text: Some(a.value.trim().to_string()),
                    items: Vec::new(),
                    count: 0,
                });
            }
        }
        for el in desc.elements() {
            if let Some(ns) = &el.ns {
                out.entry((ns.clone(), el.local.clone())).or_insert_with(|| prop_of(el));
            }
        }
    }
    Ok(out)
}

fn parse_num(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

fn is_true(s: &str) -> bool {
    matches!(s.trim().to_ascii_lowercase().as_str(), "true" | "1")
}

/// The remaining `crs:` properties; mapping code takes what it uses and the rest is `ignored`.
struct Crs {
    map: BTreeMap<String, Prop>,
    dropped: Vec<DroppedItem>,
}

impl Crs {
    fn take(&mut self, name: &str) -> Option<Prop> {
        self.map.remove(name)
    }

    fn text(&mut self, name: &str) -> Option<String> {
        self.take(name).and_then(|p| p.text)
    }

    /// A numeric field; an unparseable value is reported and skipped.
    fn num(&mut self, name: &str) -> Option<f64> {
        let text = self.text(name)?;
        match parse_num(&text) {
            Some(v) => Some(v),
            None => {
                self.dropped.push(DroppedItem::dropped(name, format!("not a number: {text:?}")));
                None
            }
        }
    }

    fn has(&self, name: &str) -> bool {
        self.map.contains_key(name)
    }
}

/// `"x, y"` pairs on 0..255 → `[x, y]` on 0..1.
fn parse_curve(items: &[String]) -> Option<Vec<[f64; 2]>> {
    let mut pts = Vec::with_capacity(items.len());
    for item in items {
        let mut it = item.split(',').map(parse_num);
        let (Some(Some(x)), Some(Some(y)), None) = (it.next(), it.next(), it.next()) else {
            return None;
        };
        if !(0.0..=255.0).contains(&x) || !(0.0..=255.0).contains(&y) {
            return None;
        }
        pts.push([x / 255.0, y / 255.0]);
    }
    (pts.len() >= 2).then_some(pts)
}

fn numbers(s: &str) -> Option<Vec<f64>> {
    s.split(|c: char| c == ',' || c.is_whitespace()).filter(|t| !t.is_empty()).map(parse_num).collect()
}

/// Read a sidecar `.xmp` file.
pub fn read_sidecar(path: impl AsRef<Path>) -> Result<XmpImport> {
    let path = path.as_ref();
    let bytes = std::fs::read(path)?;
    let text = String::from_utf8(bytes).map_err(|_| Error::Invalid(format!("{}: XMP is not UTF-8", path.display())))?;
    read_packet(&text)
}

/// The standard XMP packet of a JPEG (APP1 `http://ns.adobe.com/xap/1.0/\0`), if any. Extended XMP
/// (`http://ns.adobe.com/xmp/extension/`) is ignored; Camera Raw settings live in the standard packet.
pub fn find_embedded_packet(jpeg: &[u8]) -> Option<String> {
    if !jpeg.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut pos = 2;
    while pos + 4 <= jpeg.len() {
        if jpeg[pos] != 0xFF {
            return None;
        }
        let marker = jpeg[pos + 1];
        if marker == 0xFF {
            pos += 1;
            continue;
        }
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        if (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            pos += 2;
            continue;
        }
        let len = u16::from_be_bytes([jpeg[pos + 2], jpeg[pos + 3]]) as usize;
        if len < 2 || pos + 2 + len > jpeg.len() {
            return None;
        }
        let payload = &jpeg[pos + 4..pos + 2 + len];
        if marker == 0xE1 && payload.starts_with(XMP_SIG) {
            let xml = String::from_utf8_lossy(&payload[XMP_SIG.len()..]);
            return Some(xml.trim_end_matches(['\0', ' ', '\n', '\r', '\t']).to_string());
        }
        pos += 2 + len;
    }
    None
}

/// Read the packet embedded in a JPEG; `Ok(None)` when it has none (or none with `crs:` settings is
/// not checked here: a packet without `crs:` fields imports as defaults).
pub fn read_embedded(jpeg_path: impl AsRef<Path>) -> Result<Option<XmpImport>> {
    let bytes = std::fs::read(jpeg_path.as_ref())?;
    match find_embedded_packet(&bytes) {
        Some(xml) => read_packet(&xml).map(Some),
        None => Ok(None),
    }
}

/// Our own `photobook:Develop` settings from a packet, if present.
pub fn read_photobook_packet(xml: &str) -> Result<Option<DevelopSettings>> {
    let root = dom::parse(xml)?;
    let props = collect(&root)?;
    let Some(json) = props.get(&(NS_PHOTOBOOK.to_string(), "Develop".to_string())).and_then(|p| p.text.as_deref()) else {
        return Ok(None);
    };
    serde_json::from_str(json).map(Some).map_err(|e| Error::Invalid(format!("photobook:Develop: {e}")))
}

/// Map one XMP packet's `crs:` settings to [`DevelopSettings`].
pub fn read_packet(xml: &str) -> Result<XmpImport> {
    let root = dom::parse(xml)?;
    let mut props = collect(&root)?;
    let mut get = |ns: &str, local: &str| props.remove(&(ns.to_string(), local.to_string()));

    let orientation = get(NS_TIFF, "Orientation")
        .and_then(|p| p.text)
        .and_then(|t| t.trim().parse::<u8>().ok())
        .filter(|o| is_valid_orientation(*o));
    let dim = |p: Option<Prop>| p.and_then(|p| p.text).and_then(|t| t.trim().parse::<u32>().ok()).filter(|v| *v > 0);
    let tiff_size = dim(get(NS_TIFF, "ImageWidth")).zip(dim(get(NS_TIFF, "ImageLength")));
    let exif_size = dim(get(NS_EXIF, "PixelXDimension")).zip(dim(get(NS_EXIF, "PixelYDimension")));
    // Recorded (pre-orientation) size, when the packet says.
    let recorded_size = tiff_size.or(exif_size);

    let map: BTreeMap<String, Prop> =
        props.into_iter().filter(|((ns, _), _)| ns == NS_CRS).map(|((_, local), p)| (local, p)).collect();
    let mut crs = Crs { map, dropped: Vec::new() };

    let already_applied = crs.text("AlreadyApplied").is_some_and(|t| is_true(&t));
    let process_version = crs.text("ProcessVersion");
    crs.take("Version");
    crs.take("HasSettings");

    let has_2012 = crs.map.keys().any(|k| k.ends_with("2012"));
    let legacy = match process_version.as_deref().and_then(parse_num) {
        Some(pv) => pv < PV2012,
        None => !has_2012 && LEGACY_FIELDS.iter().any(|f| crs.has(f)),
    };

    let mut settings = DevelopSettings::default();
    if legacy {
        let pv = process_version.as_deref().unwrap_or("unknown");
        crs.dropped.push(DroppedItem::dropped(
            "ProcessVersion",
            format!(
                "process version {pv} predates PV2012 (6.7); its sliders do not map. Update the photo to the current process in Lightroom and save the metadata again"
            ),
        ));
        for f in LEGACY_FIELDS {
            if crs.take(f).is_some() {
                crs.dropped.push(DroppedItem::dropped(*f, "legacy (pre-PV2012) slider"));
            }
        }
    } else {
        map_settings(&mut crs, &mut settings, orientation.unwrap_or(1), recorded_size);
    }

    let ignored = crs.map.keys().cloned().collect();
    Ok(XmpImport { settings, process_version, dropped: crs.dropped, already_applied, orientation, ignored })
}

fn map_settings(crs: &mut Crs, s: &mut DevelopSettings, orientation: u8, recorded_size: Option<(u32, u32)>) {
    for (name, slot) in SCALARS {
        if let Some(v) = crs.num(name) {
            *slot(s) = v;
        }
    }
    for (i, name) in SPLITS.iter().enumerate() {
        if let Some(v) = crs.num(name) {
            s.curve.parametric.splits[i] = v / 100.0;
        }
    }
    for (name, band, k) in mix_fields() {
        if let Some(v) = crs.num(&name) {
            *mix_value(band_mut(&mut s.color.mix, band), k) = v;
        }
    }
    map_white_balance(crs, s);

    crs.take("ToneCurveName2012");
    for (i, name) in CURVES.iter().enumerate() {
        if let Some(p) = crs.take(name) {
            match parse_curve(&p.items) {
                Some(pts) => *curve_mut(s, i) = pts,
                None => crs.dropped.push(DroppedItem::dropped(*name, "unreadable tone curve (expected \"x, y\" pairs on 0..255)")),
            }
        }
    }

    map_geometry(crs, s, orientation, recorded_size);

    for name in MASK_FIELDS {
        if let Some(p) = crs.take(name) {
            let n = p.count.max(p.items.len());
            if n > 0 {
                crs.dropped.push(DroppedItem::dropped(*name, format!("masks are not imported ({n} correction{})", if n == 1 { "" } else { "s" })));
            }
        }
    }
    for (name, unused, reason) in UNSUPPORTED {
        let Some(p) = crs.take(name) else { continue };
        let in_use = match (unused, p.text.as_deref()) {
            (None, _) => true,
            (Some(_), None) => p.count > 0,
            (Some(u), Some(t)) => match (parse_num(t), parse_num(u)) {
                (Some(a), Some(b)) => a != b,
                _ => !t.eq_ignore_ascii_case(u),
            },
        };
        if in_use {
            crs.dropped.push(DroppedItem::dropped(*name, *reason));
        }
    }
}

/// `WhiteBalance="As Shot"` → as shot; `Incremental*` (rendered files) → incremental; a Kelvin
/// `Temperature` (RAW) → absolute.
fn map_white_balance(crs: &mut Crs, s: &mut DevelopSettings) {
    let wb = crs.text("WhiteBalance");
    let as_shot = wb.as_deref().is_some_and(|w| w.eq_ignore_ascii_case("As Shot"));
    let (it, itint) = (crs.num("IncrementalTemperature"), crs.num("IncrementalTint"));
    let (t, tint) = (crs.num("Temperature"), crs.num("Tint"));
    let incremental_used = it.is_some_and(|v| v != 0.0) || itint.is_some_and(|v| v != 0.0);
    s.white_balance = if it.is_some() || itint.is_some() {
        if as_shot && !incremental_used {
            WhiteBalance::AsShot
        } else {
            WhiteBalance::Incremental { temperature: it.unwrap_or(0.0), tint: itint.unwrap_or(0.0) }
        }
    } else if as_shot {
        WhiteBalance::AsShot
    } else {
        match t {
            Some(k) if (2000.0..=50000.0).contains(&k) => WhiteBalance::Absolute { temperature: k, tint: tint.unwrap_or(0.0) },
            Some(k) => {
                crs.dropped.push(DroppedItem::dropped("Temperature", format!("{k} is not a Kelvin value in 2000..50000")));
                WhiteBalance::AsShot
            }
            None => WhiteBalance::AsShot,
        }
    };
}

fn map_geometry(crs: &mut Crs, s: &mut DevelopSettings, orientation: u8, recorded_size: Option<(u32, u32)>) {
    let g = &mut s.geometry;

    // Manual Transform sliders, recorded frame → oriented frame.
    let mut t = ManualTransform::default();
    let mut any_transform = false;
    for (name, field) in [
        ("PerspectiveVertical", &mut t.vertical),
        ("PerspectiveHorizontal", &mut t.horizontal),
        ("PerspectiveRotate", &mut t.rotate),
        ("PerspectiveAspect", &mut t.aspect),
        ("PerspectiveScale", &mut t.scale),
        ("PerspectiveX", &mut t.offset_x),
        ("PerspectiveY", &mut t.offset_y),
    ] {
        if let Some(v) = crs.num(name) {
            *field = v;
            any_transform = true;
        }
    }
    g.transform = remap_transform_sliders(&t, orientation);
    if any_transform && g.transform != ManualTransform::default() {
        crs.dropped.push(DroppedItem::unverified(
            "Perspective*",
            "Transform sliders imported 1:1 (remapped from the recorded frame); Lightroom's ranges, the Vertical sign and its keystone maths are unverified",
        ));
    }
    if let Some(c) = crs.text("CropConstrainToWarp") {
        g.constrain_crop = is_true(&c);
    }

    // Upright.
    if let Some(m) = crs.num("PerspectiveUpright") {
        match UPRIGHT_MODES.get(m as usize).filter(|_| m.fract() == 0.0 && m >= 0.0) {
            Some(mode) => g.upright.mode = *mode,
            None => crs.dropped.push(DroppedItem::dropped("PerspectiveUpright", format!("unknown Upright mode {m}"))),
        }
    }
    if let Some(f) = crs.num("UprightFocalLength35mm") {
        if f > 0.0 {
            g.upright.focal = Some(f / 36.0);
        }
    }
    let transforms: Vec<Option<String>> = (0..6).map(|i| crs.text(&format!("UprightTransform_{i}"))).collect();
    let parsed: Vec<Option<Vec<f64>>> = transforms.iter().map(|t| t.as_deref().and_then(numbers)).collect();
    let mode_index = UPRIGHT_MODES.iter().position(|m| *m == g.upright.mode).unwrap_or(0);
    let matrix: Option<([f64; 9], String)> = if parsed.iter().any(|p| p.as_ref().is_some_and(|v| v.len() == 9)) {
        // One 3×3 per Upright mode, indexed like PerspectiveUpright.
        parsed[mode_index].as_ref().filter(|v| v.len() == 9).map(|v| {
            let mut m = [0.0; 9];
            m.copy_from_slice(v);
            (m, format!("UprightTransform_{mode_index}"))
        })
    } else if parsed.iter().all(|p| p.as_ref().is_some_and(|v| v.len() == 1)) {
        // Six scalars: a 2×3 affine map, padded with the row 0, 0, 1.
        let v: Vec<f64> = parsed.iter().map(|p| p.as_ref().unwrap()[0]).collect();
        Some(([v[0], v[1], v[2], v[3], v[4], v[5], 0.0, 0.0, 1.0], "UprightTransform_0..5".to_string()))
    } else {
        if transforms.iter().any(|t| t.is_some()) {
            crs.dropped.push(DroppedItem::dropped("UprightTransform_N", "unreadable Upright transform"));
        }
        None
    };
    if let Some((m, field)) = matrix {
        if g.upright.mode != UprightMode::Off && m.iter().all(|v| v.is_finite()) && m[8] != 0.0 {
            g.upright.transform = Some(remap_upright_transform(m, orientation));
            crs.dropped.push(DroppedItem::unverified(
                field,
                "imported as the stored Upright homography (row-major forward map in 0..1 of the recorded frame); the layout is known from third-party readers only",
            ));
        }
    }

    // Guides: "x1,y1,x2,y2" in 0..1 of the recorded, unwarped frame (assumed) → our transformed frame.
    crs.take("UprightFourSegmentsCount");
    let mut segments = Vec::new();
    for i in 0..4 {
        let Some(text) = crs.text(&format!("UprightFourSegments_{i}")) else { continue };
        match numbers(&text) {
            Some(v) if v.len() == 4 && v.iter().any(|x| *x != 0.0) && (v[0], v[1]) != (v[2], v[3]) => segments.push(v),
            Some(v) if v.iter().all(|x| *x == 0.0) => {}
            _ => crs.dropped.push(DroppedItem::dropped(format!("UprightFourSegments_{i}"), "unreadable guide")),
        }
    }
    if !segments.is_empty() {
        let p = orientation_map(orientation);
        let frame = match recorded_size {
            Some((w, h)) if orientation_swaps_axes(orientation) => Some((h as f64, w as f64)),
            Some((w, h)) => Some((w as f64, h as f64)),
            None => None,
        };
        let warp = match frame {
            Some((fw, fh)) => perspective_matrix(g, fw, fh),
            None => upright_matrix(&g.upright),
        };
        if frame.is_none() && g.transform != ManualTransform::default() {
            crs.dropped.push(DroppedItem::unverified(
                "UprightFourSegments_N",
                "image size unknown: guides were mapped through Upright only, not the Transform sliders",
            ));
        }
        g.upright.guides = segments
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let from = warp.apply(p.apply([v[0], v[1]]));
                let to = warp.apply(p.apply([v[2], v[3]]));
                let kind = if (to[1] - from[1]).abs() >= (to[0] - from[0]).abs() { GuideKind::Vertical } else { GuideKind::Horizontal };
                UprightGuide { id: format!("xmp-guide-{}", i + 1), kind, from, to }
            })
            .collect();
        crs.dropped.push(DroppedItem::unverified(
            "UprightFourSegments_N",
            "guides assumed to be 0..1 of the recorded, unwarped frame",
        ));
    }

    // Crop: fractions of the straightened recorded frame → oriented frame.
    let has_crop = crs.text("HasCrop").map(|t| is_true(&t));
    let (top, left, bottom, right) = (crs.num("CropTop"), crs.num("CropLeft"), crs.num("CropBottom"), crs.num("CropRight"));
    let angle = crs.num("CropAngle").unwrap_or(0.0);
    let (x0, y0, x1, y1) = (left.unwrap_or(0.0), top.unwrap_or(0.0), right.unwrap_or(1.0), bottom.unwrap_or(1.0));
    let trivial = (x0, y0, x1, y1) == (0.0, 0.0, 1.0, 1.0) && angle == 0.0;
    if has_crop.unwrap_or(!trivial) {
        if x1 > x0 && y1 > y0 && (-45.0..=45.0).contains(&angle) {
            let rect = CropRect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
            let (rect, angle) = remap_crop_for_orientation(&rect, angle, orientation);
            g.crop = Some(Crop { rect, angle, aspect: CropAspect::default() });
            if angle != 0.0 {
                crs.dropped.push(DroppedItem::unverified(
                    "CropAngle",
                    "straighten is applied about the crop centre here; Lightroom's rotation centre for the crop rectangle is unverified",
                ));
            }
        } else {
            crs.dropped.push(DroppedItem::dropped("Crop*", "crop rectangle or angle out of range"));
        }
    }
    for meta in [
        "UprightVersion",
        "UprightCenterMode",
        "UprightCenterNormX",
        "UprightCenterNormY",
        "UprightFocalMode",
        "UprightPreview",
        "UprightDependentDigest",
        "UprightGuidedDependentDigest",
    ] {
        crs.take(meta);
    }
}
