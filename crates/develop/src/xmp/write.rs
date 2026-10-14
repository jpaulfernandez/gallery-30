//! Our `photobook:` packet, the lossy `crs:` export and sidecar merging.

use std::collections::HashSet;

use super::dom::{self, Attr, Element, Node};
use super::fields::*;
use super::{CRS_PROCESS_VERSION, NS_CRS, NS_PHOTOBOOK, NS_RDF, NS_TIFF, NS_X};
use crate::error::{Error, Result};
use crate::geometry::transform::{perspective_matrix, upright_matrix};
use crate::settings::{DevelopSettings, UprightMode, WhiteBalance};
use crate::{canonical_json, ENGINE_VERSION};

/// Options for [`write_crs_packet`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CrsExportOptions {
    /// Add `photobook:ExportWarning` (the "Lightroom will render this differently" note).
    pub warn: bool,
    /// The photo's EXIF orientation. Crop, Upright and the Transform sliders are written in the recorded
    /// frame, as Lightroom expects, and `tiff:Orientation` is written. `None` writes them as they are
    /// (orientation 1).
    pub orientation: Option<u8>,
    /// The recorded (pre-orientation) pixel size, written as `tiff:ImageWidth`/`ImageLength`. Needed to
    /// map guides back through the Transform sliders exactly.
    pub source_size: Option<(u32, u32)>,
}

/// The note [`CrsExportOptions::warn`] adds.
pub const EXPORT_WARNING: &str = "Exported from Photobook as a lossy mapping of its develop settings. Lightroom renders them with its own maths, so the photo will look different. Masks, AI denoise and settings without a Lightroom counterpart are not included.";

const XPACKET_BEGIN: &str = "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n";
const XPACKET_END: &str = "<?xpacket end=\"w\"?>\n";

fn attr(qname: &str, ns: Option<&str>, value: impl Into<String>) -> Attr {
    let local = qname.rsplit(':').next().unwrap_or(qname).to_string();
    Attr { qname: qname.to_string(), ns: ns.map(str::to_string), local, value: value.into() }
}

fn xmlns(prefix: &str, uri: &str) -> Attr {
    Attr { qname: format!("xmlns:{prefix}"), ns: None, local: format!("xmlns:{prefix}"), value: uri.to_string() }
}

fn element(qname: &str, ns: &str, attrs: Vec<Attr>, children: Vec<Node>) -> Element {
    let local = qname.rsplit(':').next().unwrap_or(qname).to_string();
    Element { qname: qname.to_string(), ns: Some(ns.to_string()), local, attrs, children }
}

/// `x:xmpmeta/rdf:RDF/description`, wrapped in `<?xpacket?>`.
fn packet(description: Element) -> String {
    let rdf = element("rdf:RDF", NS_RDF, vec![xmlns("rdf", NS_RDF)], vec![Node::Element(description)]);
    let meta = element(
        "x:xmpmeta",
        NS_X,
        vec![xmlns("x", NS_X), attr("x:xmptk", Some(NS_X), format!("Photobook {ENGINE_VERSION}"))],
        vec![Node::Element(rdf)],
    );
    serialise(&meta)
}

fn serialise(root: &Element) -> String {
    let mut out = String::from(XPACKET_BEGIN);
    dom::write(&mut out, root, 0);
    out.push_str(XPACKET_END);
    out
}

/// Shortest round-tripping decimal, never `-0` or an exponent.
fn num(v: f64) -> String {
    if v == 0.0 || !v.is_finite() {
        "0".to_string()
    } else {
        format!("{v}")
    }
}

/// An XMP packet with our own namespace: `photobook:Develop` holds the canonical settings JSON (the
/// same string [`crate::develop_hash`] hashes, without the engine line) and `photobook:Engine` the
/// engine version. [`super::read_photobook_packet`] reads it back exactly.
pub fn write_photobook_packet(settings: &DevelopSettings) -> String {
    let json = canonical_json(&serde_json::to_value(settings).expect("develop settings always serialise"));
    let desc = element(
        "rdf:Description",
        NS_RDF,
        vec![
            attr("rdf:about", Some(NS_RDF), ""),
            xmlns("photobook", NS_PHOTOBOOK),
            attr("photobook:Engine", Some(NS_PHOTOBOOK), ENGINE_VERSION),
        ],
        vec![Node::Element(element("photobook:Develop", NS_PHOTOBOOK, Vec::new(), vec![Node::Text(json)]))],
    );
    packet(desc)
}

/// The lossy reverse of [`super::read_packet`]: every importable field as `crs:` (PV `15.4`), curves
/// back to 0..255 integer pairs, splits to 0..100, crop/Upright/Transform into the recorded frame of
/// `opts.orientation`. Masks, denoise and the crop aspect preset are not written.
pub fn write_crs_packet(settings: &DevelopSettings, opts: &CrsExportOptions) -> String {
    let orientation = opts.orientation.filter(|o| is_valid_orientation(*o)).unwrap_or(1);
    let back = inverse_orientation(orientation);
    let mut s = settings.clone();
    let mut attrs = vec![attr("rdf:about", Some(NS_RDF), ""), xmlns("crs", NS_CRS)];
    if opts.orientation.is_some() || opts.source_size.is_some() {
        attrs.push(xmlns("tiff", NS_TIFF));
    }
    if opts.warn {
        attrs.push(xmlns("photobook", NS_PHOTOBOOK));
    }
    if let Some(o) = opts.orientation.filter(|o| is_valid_orientation(*o)) {
        attrs.push(attr("tiff:Orientation", Some(NS_TIFF), o.to_string()));
    }
    if let Some((w, h)) = opts.source_size {
        attrs.push(attr("tiff:ImageWidth", Some(NS_TIFF), w.to_string()));
        attrs.push(attr("tiff:ImageLength", Some(NS_TIFF), h.to_string()));
    }
    let mut crs = |name: &str, value: String| attrs.push(attr(&format!("crs:{name}"), Some(NS_CRS), value));
    crs("Version", CRS_PROCESS_VERSION.to_string());
    crs("ProcessVersion", CRS_PROCESS_VERSION.to_string());
    crs("HasSettings", "True".to_string());

    match &s.white_balance {
        WhiteBalance::AsShot => crs("WhiteBalance", "As Shot".to_string()),
        WhiteBalance::Absolute { temperature, tint } => {
            crs("WhiteBalance", "Custom".to_string());
            crs("Temperature", num(*temperature));
            crs("Tint", num(*tint));
        }
        WhiteBalance::Incremental { temperature, tint } => {
            crs("WhiteBalance", "Custom".to_string());
            crs("IncrementalTemperature", num(*temperature));
            crs("IncrementalTint", num(*tint));
        }
    }
    for (name, slot) in SCALARS {
        let v = *slot(&mut s);
        crs(name, num(v));
    }
    for (i, name) in SPLITS.iter().enumerate() {
        crs(name, num((s.curve.parametric.splits[i] * 100.0).round()));
    }
    for (name, band, k) in mix_fields() {
        let v = *mix_value(band_mut(&mut s.color.mix, band), k);
        crs(&name, num(v));
    }
    crs("ToneCurveName2012", "Custom".to_string());

    // Geometry, oriented frame → recorded frame.
    let g = &s.geometry;
    match &g.crop {
        Some(c) => {
            let (r, angle) = remap_crop_for_orientation(&c.rect, c.angle, back);
            crs("HasCrop", "True".to_string());
            crs("CropTop", num(r.y));
            crs("CropLeft", num(r.x));
            crs("CropBottom", num(r.y + r.h));
            crs("CropRight", num(r.x + r.w));
            crs("CropAngle", num(angle));
        }
        None => crs("HasCrop", "False".to_string()),
    }
    crs("CropConstrainToWarp", if g.constrain_crop { "1" } else { "0" }.to_string());
    let mode_index = UPRIGHT_MODES.iter().position(|m| *m == g.upright.mode).unwrap_or(0);
    crs("PerspectiveUpright", mode_index.to_string());
    let t = remap_transform_sliders(&g.transform, back);
    crs("PerspectiveVertical", num(t.vertical));
    crs("PerspectiveHorizontal", num(t.horizontal));
    crs("PerspectiveRotate", num(t.rotate));
    crs("PerspectiveScale", num(t.scale));
    crs("PerspectiveAspect", num(t.aspect));
    crs("PerspectiveX", num(t.offset_x));
    crs("PerspectiveY", num(t.offset_y));
    if let Some(f) = g.upright.focal {
        crs("UprightFocalLength35mm", num(f * 36.0));
    }
    if let (Some(m), true) = (g.upright.transform, g.upright.mode != UprightMode::Off) {
        let r = remap_upright_transform(m, back);
        crs(&format!("UprightTransform_{mode_index}"), r.iter().map(|v| num(*v)).collect::<Vec<_>>().join(","));
    }
    if !g.upright.guides.is_empty() {
        let frame = opts.source_size.map(|(w, h)| if orientation_swaps_axes(orientation) { (h as f64, w as f64) } else { (w as f64, h as f64) });
        let warp = match frame {
            Some((fw, fh)) => perspective_matrix(g, fw, fh),
            None => upright_matrix(&g.upright),
        };
        let unwarp = warp.invert().unwrap_or_else(crate::geometry::Homography::identity);
        let p_back = orientation_map(back);
        let guides: Vec<_> = g.upright.guides.iter().take(4).collect();
        crs("UprightFourSegmentsCount", guides.len().to_string());
        for (i, guide) in guides.iter().enumerate() {
            let a = p_back.apply(unwarp.apply(guide.from));
            let b = p_back.apply(unwarp.apply(guide.to));
            crs(&format!("UprightFourSegments_{i}"), [a[0], a[1], b[0], b[1]].map(num).join(","));
        }
    }
    if opts.warn {
        attrs.push(attr("photobook:ExportWarning", Some(NS_PHOTOBOOK), EXPORT_WARNING));
    }

    let mut children = Vec::new();
    for (i, name) in CURVES.iter().enumerate() {
        let items = curve_mut(&mut s, i)
            .iter()
            .map(|[x, y]| {
                let li = format!("{}, {}", num((x * 255.0).round()), num((y * 255.0).round()));
                Node::Element(element("rdf:li", NS_RDF, Vec::new(), vec![Node::Text(li)]))
            })
            .collect();
        let seq = element("rdf:Seq", NS_RDF, Vec::new(), items);
        children.push(Node::Element(element(&format!("crs:{name}"), NS_CRS, Vec::new(), vec![Node::Element(seq)])));
    }
    packet(element("rdf:Description", NS_RDF, attrs, children))
}

fn prefix_of(qname: &str) -> Option<&str> {
    qname.split_once(':').map(|(p, _)| p)
}

/// Merge `packet` (from [`write_crs_packet`] or [`write_photobook_packet`]) into an existing sidecar.
///
/// Every property of the existing packet is kept except: all `crs:` properties when `packet` carries
/// `crs:` settings (so stale Lightroom fields such as masks cannot mix with the new ones), and any
/// property `packet` sets itself. The new properties go into the first top-level `rdf:Description`.
/// With no existing sidecar, `packet` is returned as is. An existing sidecar that does not parse is an
/// error (rather than being overwritten).
pub fn merge_into_sidecar(existing: Option<&str>, packet: &str) -> Result<String> {
    let new_root = dom::parse(packet)?;
    let Some(existing) = existing.filter(|e| !e.trim().is_empty()) else {
        return Ok(packet.to_string());
    };
    let new_rdf = new_root.find(NS_RDF, "RDF").ok_or_else(|| Error::Invalid("XMP: packet has no rdf:RDF".into()))?;
    let mut decls: Vec<(String, String)> = Vec::new();
    let mut new_attrs: Vec<Attr> = Vec::new();
    let mut new_children: Vec<Node> = Vec::new();
    for desc in new_rdf.elements().filter(|e| e.is(NS_RDF, "Description")) {
        for a in &desc.attrs {
            if a.is_xmlns() {
                if let Some(p) = a.qname.strip_prefix("xmlns:") {
                    decls.push((p.to_string(), a.value.clone()));
                }
            } else if a.ns.as_deref() != Some(NS_RDF) {
                new_attrs.push(a.clone());
            }
        }
        new_children.extend(desc.elements().map(|e| Node::Element(e.clone())));
    }
    let keys: HashSet<(Option<String>, String)> = new_attrs
        .iter()
        .map(|a| (a.ns.clone(), a.local.clone()))
        .chain(new_children.iter().filter_map(|n| match n {
            Node::Element(e) => Some((e.ns.clone(), e.local.clone())),
            Node::Text(_) => None,
        }))
        .collect();
    let replaces_crs = keys.iter().any(|(ns, _)| ns.as_deref() == Some(NS_CRS));
    let stale = |ns: &Option<String>, local: &str| {
        (replaces_crs && ns.as_deref() == Some(NS_CRS)) || keys.contains(&(ns.clone(), local.to_string()))
    };

    let mut root = dom::parse(existing)?;
    // Namespace declarations in scope at rdf:RDF (on the root and on rdf:RDF itself).
    let mut in_scope: Vec<(String, String)> = root
        .attrs
        .iter()
        .filter_map(|a| a.qname.strip_prefix("xmlns:").map(|p| (p.to_string(), a.value.clone())))
        .collect();
    let rdf = root.find_mut(NS_RDF, "RDF").ok_or_else(|| Error::Invalid("XMP: existing sidecar has no rdf:RDF".into()))?;
    in_scope.extend(rdf.attrs.iter().filter_map(|a| a.qname.strip_prefix("xmlns:").map(|p| (p.to_string(), a.value.clone()))));
    let rdf_prefix = prefix_of(&rdf.qname).unwrap_or("rdf").to_string();

    for node in rdf.children.iter_mut() {
        if let Node::Element(desc) = node {
            if desc.is(NS_RDF, "Description") {
                desc.attrs.retain(|a| a.is_xmlns() || !stale(&a.ns, &a.local));
                desc.children.retain(|n| match n {
                    Node::Element(e) => !stale(&e.ns, &e.local),
                    Node::Text(_) => true,
                });
            }
        }
    }
    if !rdf.elements().any(|e| e.is(NS_RDF, "Description")) {
        let qname = format!("{rdf_prefix}:Description");
        rdf.children.push(Node::Element(element(&qname, NS_RDF, vec![attr(&format!("{rdf_prefix}:about"), Some(NS_RDF), "")], Vec::new())));
    }
    let desc = rdf
        .children
        .iter_mut()
        .find_map(|n| match n {
            Node::Element(e) if e.is(NS_RDF, "Description") => Some(e),
            _ => None,
        })
        .expect("a description exists");

    let used_prefixes: HashSet<&str> = new_attrs
        .iter()
        .map(|a| a.qname.as_str())
        .chain(new_children.iter().filter_map(|n| match n {
            Node::Element(e) => Some(e.qname.as_str()),
            Node::Text(_) => None,
        }))
        .filter_map(prefix_of)
        .collect();
    for (prefix, uri) in decls.iter().filter(|(p, _)| used_prefixes.contains(p.as_str())) {
        let local: Option<&str> = desc.attrs.iter().find(|a| a.qname == format!("xmlns:{prefix}")).map(|a| a.value.as_str());
        match local {
            Some(u) if u == uri => {}
            Some(u) => {
                return Err(Error::Invalid(format!("XMP: prefix {prefix:?} is bound to {u}, not {uri}")));
            }
            None => {
                if !in_scope.iter().rev().find(|(p, _)| p == prefix).is_some_and(|(_, u)| u == uri) {
                    desc.attrs.push(xmlns(prefix, uri));
                }
            }
        }
    }
    desc.attrs.extend(new_attrs);
    desc.children.extend(new_children);
    Ok(serialise(&root))
}
