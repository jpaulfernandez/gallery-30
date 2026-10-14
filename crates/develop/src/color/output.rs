//! Output colour spaces (plan section 4.5, step D6.2): the book's output profile, sRGB or Display P3, and the
//! compact ICC profile each render is tagged with.
//!
//! Both are linear Rec.2020 → a 3×3 matrix → the sRGB transfer function (Display P3 uses the sRGB curve), so the
//! output stage only swaps the matrix and the gamut mapper's Oklab converter ([`crate::ops::output`]); the GPU gets
//! the same matrices through its uniform block.
//!
//! The ICC profiles are assembled here rather than taken from `moxcms`'s encoder: that one writes a `cicp` tag
//! (ICC v4.4) with narrow range and BT.709 matrix coefficients, and SMPTE 431 (DCI-P3, ~6300 K white) for Display
//! P3, which a CICP-aware reader would honour over the matrix. What is written is the classic v4.3 display
//! matrix/TRC profile, like Apple's own `Display P3.icc`: `desc`, `cprt`, `wtpt` (D50), `chad` (Bradford D65 → D50),
//! Bradford-adapted `rXYZ`/`gXYZ`/`bXYZ` and one shared `para` sRGB curve for the three TRCs (about 450 bytes).

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use super::matrix::{self, Mat3, Primaries, D65_XY, P3_PRIMARIES, SRGB_PRIMARIES};

/// The book's output colour space (`Book.outputProfile` in the Zod schema: `"srgb"` or `"display-p3"`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OutputProfile {
    /// sRGB (IEC 61966-2-1): what the web assumes for untagged images.
    #[default]
    Srgb,
    /// Display P3: P3 primaries, D65 white, the sRGB transfer function.
    DisplayP3,
}

impl OutputProfile {
    /// Parse the schema's string (`"srgb"`, `"display-p3"`).
    pub fn parse(value: &str) -> Option<OutputProfile> {
        match value {
            "srgb" => Some(OutputProfile::Srgb),
            "display-p3" => Some(OutputProfile::DisplayP3),
            _ => None,
        }
    }

    /// The schema's string.
    pub fn as_str(self) -> &'static str {
        match self {
            OutputProfile::Srgb => "srgb",
            OutputProfile::DisplayP3 => "display-p3",
        }
    }

    /// What render file names carry after the develop hash: nothing for sRGB, `-p3` for Display P3. Equal to
    /// `outputProfileSuffix` in `packages/shared`.
    pub fn file_suffix(self) -> &'static str {
        match self {
            OutputProfile::Srgb => "",
            OutputProfile::DisplayP3 => "-p3",
        }
    }

    pub fn primaries(self) -> &'static Primaries {
        match self {
            OutputProfile::Srgb => &SRGB_PRIMARIES,
            OutputProfile::DisplayP3 => &P3_PRIMARIES,
        }
    }

    /// Linear output RGB → XYZ (D65).
    pub fn to_xyz(self) -> Mat3 {
        matrix::rgb_to_xyz_matrix(self.primaries(), D65_XY)
    }

    /// Linear Rec.2020 → linear output RGB.
    pub fn from_rec2020(self) -> Mat3 {
        matrix::mul(&matrix::inv(&self.to_xyz()), &matrix::rec2020_to_xyz())
    }

    /// The profile embedded in renders of this space (built once).
    pub fn icc(self) -> &'static [u8] {
        static SRGB: OnceLock<Vec<u8>> = OnceLock::new();
        static P3: OnceLock<Vec<u8>> = OnceLock::new();
        match self {
            OutputProfile::Srgb => SRGB.get_or_init(|| build_icc(&SRGB_PRIMARIES, "sRGB IEC61966-2.1")),
            OutputProfile::DisplayP3 => P3.get_or_init(|| build_icc(&P3_PRIMARIES, "Display P3")),
        }
    }
}

/// The ICC profile connection space illuminant (D50) as the header and `wtpt` store it.
pub const PCS_D50: [f64; 3] = [0.9642, 1.0, 0.8249];

/// The Bradford cone response matrix.
const BRADFORD: Mat3 = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];

/// The sRGB curve as an ICC parametric curve of type 3: `Y = (aX + b)^g` for `X ≥ d`, else `cX`.
pub const SRGB_PARA: [f64; 5] = [2.4, 1.0 / 1.055, 0.055 / 1.055, 1.0 / 12.92, 0.04045];

/// Bradford chromatic adaptation from `src` to `dst` (XYZ whites).
pub fn bradford(src: [f64; 3], dst: [f64; 3]) -> Mat3 {
    let s = matrix::apply(&BRADFORD, src);
    let d = matrix::apply(&BRADFORD, dst);
    let scale = matrix::diag([d[0] / s[0], d[1] / s[1], d[2] / s[2]]);
    matrix::mul(&matrix::inv(&BRADFORD), &matrix::mul(&scale, &BRADFORD))
}

/// The D50-adapted colorant matrix of an RGB space with a D65 white (columns: red, green, blue as PCS XYZ).
pub fn d50_colorants(primaries: &Primaries) -> Mat3 {
    let chad = bradford(matrix::xy_to_xyz(D65_XY), PCS_D50);
    matrix::mul(&chad, &matrix::rgb_to_xyz_matrix(primaries, D65_XY))
}

fn s15f16(v: f64) -> [u8; 4] {
    ((v * 65536.0).round() as i32).to_be_bytes()
}

fn xyz_tag(xyz: [f64; 3]) -> Vec<u8> {
    let mut t = b"XYZ \0\0\0\0".to_vec();
    for v in xyz {
        t.extend_from_slice(&s15f16(v));
    }
    t
}

fn mluc_tag(text: &str) -> Vec<u8> {
    let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
    let mut t = b"mluc\0\0\0\0".to_vec();
    t.extend_from_slice(&1u32.to_be_bytes()); // one record
    t.extend_from_slice(&12u32.to_be_bytes()); // record size
    t.extend_from_slice(b"enUS");
    t.extend_from_slice(&(utf16.len() as u32).to_be_bytes());
    t.extend_from_slice(&28u32.to_be_bytes()); // offset of the string from the tag start
    t.extend_from_slice(&utf16);
    t
}

fn para_tag(p: &[f64; 5]) -> Vec<u8> {
    let mut t = b"para\0\0\0\0".to_vec();
    t.extend_from_slice(&3u16.to_be_bytes());
    t.extend_from_slice(&[0, 0]);
    for v in p {
        t.extend_from_slice(&s15f16(*v));
    }
    t
}

fn sf32_tag(m: &Mat3) -> Vec<u8> {
    let mut t = b"sf32\0\0\0\0".to_vec();
    for row in m {
        for v in row {
            t.extend_from_slice(&s15f16(*v));
        }
    }
    t
}

/// A v4.3 display-class RGB matrix/TRC profile for `primaries` (D65 white, sRGB curve). Deterministic: a
/// fixed creation date and a zero profile ID (allowed by ICC.1:2022 when not computed).
pub fn build_icc(primaries: &Primaries, description: &str) -> Vec<u8> {
    let colorants = d50_colorants(primaries);
    let column = |c: usize| [colorants[0][c], colorants[1][c], colorants[2][c]];
    let chad = bradford(matrix::xy_to_xyz(D65_XY), PCS_D50);
    let trc = para_tag(&SRGB_PARA);
    // (signature, data); identical data is stored once and shared (the three TRCs).
    let tags: Vec<(&[u8; 4], Vec<u8>)> = vec![
        (b"desc", mluc_tag(description)),
        (b"cprt", mluc_tag("No copyright, use freely")),
        (b"wtpt", xyz_tag(PCS_D50)),
        (b"chad", sf32_tag(&chad)),
        (b"rXYZ", xyz_tag(column(0))),
        (b"gXYZ", xyz_tag(column(1))),
        (b"bXYZ", xyz_tag(column(2))),
        (b"rTRC", trc.clone()),
        (b"gTRC", trc.clone()),
        (b"bTRC", trc),
    ];
    let table_len = 4 + 12 * tags.len();
    let mut data: Vec<u8> = Vec::new();
    let mut entries: Vec<(&[u8; 4], u32, u32)> = Vec::new();
    let mut stored: Vec<(Vec<u8>, u32)> = Vec::new();
    for (sig, bytes) in &tags {
        let offset = match stored.iter().find(|(b, _)| b == bytes) {
            Some((_, at)) => *at,
            None => {
                while data.len() % 4 != 0 {
                    data.push(0);
                }
                let at = (128 + table_len + data.len()) as u32;
                data.extend_from_slice(bytes);
                stored.push((bytes.clone(), at));
                at
            }
        };
        entries.push((sig, offset, bytes.len() as u32));
    }
    while data.len() % 4 != 0 {
        data.push(0);
    }
    let size = (128 + table_len + data.len()) as u32;

    let mut out = Vec::with_capacity(size as usize);
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(&[0; 4]); // preferred CMM: none
    out.extend_from_slice(&0x0430_0000u32.to_be_bytes()); // version 4.3
    out.extend_from_slice(b"mntr");
    out.extend_from_slice(b"RGB ");
    out.extend_from_slice(b"XYZ ");
    for v in [2026u16, 1, 1, 0, 0, 0] {
        out.extend_from_slice(&v.to_be_bytes());
    }
    out.extend_from_slice(b"acsp");
    out.extend_from_slice(&[0; 4]); // primary platform
    out.extend_from_slice(&[0; 4]); // flags
    out.extend_from_slice(&[0; 4]); // device manufacturer
    out.extend_from_slice(&[0; 4]); // device model
    out.extend_from_slice(&[0; 8]); // device attributes
    out.extend_from_slice(&0u32.to_be_bytes()); // perceptual intent
    for v in PCS_D50 {
        out.extend_from_slice(&s15f16(v));
    }
    out.extend_from_slice(&[0; 4]); // creator
    out.extend_from_slice(&[0; 16]); // profile ID
    out.extend_from_slice(&[0; 28]); // reserved
    debug_assert_eq!(out.len(), 128);
    out.extend_from_slice(&(tags.len() as u32).to_be_bytes());
    for (sig, offset, len) in entries {
        out.extend_from_slice(sig);
        out.extend_from_slice(&offset.to_be_bytes());
        out.extend_from_slice(&len.to_be_bytes());
    }
    out.extend_from_slice(&data);
    debug_assert_eq!(out.len(), size as usize);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_round_trips_the_names() {
        for p in [OutputProfile::Srgb, OutputProfile::DisplayP3] {
            assert_eq!(OutputProfile::parse(p.as_str()), Some(p));
            assert_eq!(serde_json::to_value(p).unwrap(), serde_json::json!(p.as_str()));
        }
        assert_eq!(OutputProfile::parse("p3"), None);
        assert_eq!(OutputProfile::default(), OutputProfile::Srgb);
        assert_eq!(OutputProfile::DisplayP3.file_suffix(), "-p3");
    }

    #[test]
    fn colorants_sum_to_d50_and_srgb_matches_the_published_ones() {
        for prim in [&SRGB_PRIMARIES, &P3_PRIMARIES] {
            let white = matrix::apply(&d50_colorants(prim), [1.0, 1.0, 1.0]);
            for c in 0..3 {
                assert!((white[c] - PCS_D50[c]).abs() < 2e-4, "{white:?}");
            }
        }
        // The Bradford-adapted sRGB colorants of the ICC sRGB profiles (Lindbloom / ICC sRGB v4).
        let srgb = d50_colorants(&SRGB_PRIMARIES);
        let published = [[0.4361, 0.3851, 0.1431], [0.2225, 0.7169, 0.0606], [0.0139, 0.0971, 0.7141]];
        for i in 0..3 {
            for j in 0..3 {
                assert!((srgb[i][j] - published[i][j]).abs() < 3e-4, "[{i}][{j}] {srgb:?}");
            }
        }
    }

    #[test]
    fn profile_is_well_formed_and_small() {
        let icc = OutputProfile::DisplayP3.icc();
        assert_eq!(u32::from_be_bytes(icc[0..4].try_into().unwrap()) as usize, icc.len());
        assert_eq!(&icc[36..40], b"acsp");
        assert!(icc.len() < 600, "{} bytes", icc.len());
        assert_ne!(OutputProfile::Srgb.icc(), icc);
    }
}
