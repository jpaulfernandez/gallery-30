//! Serde mirror of the Zod `DevelopSchema` in `packages/shared/src/develop/schema.ts`, which is the source
//! of truth. Field names, nesting and defaults match it exactly, so a settings object written by the
//! editor deserialises here and serialises back to the same canonical JSON (checked by
//! `tests/parity.rs` against fixtures the TypeScript side generates).
//!
//! Fields with a Zod default carry `#[serde(default)]` with the same value; fields Zod requires (ids,
//! names, mask geometry, a crop's `rect`, a denoise `model`, ...) are required here too. Slider ranges
//! are validated by Zod in the editor and not re-checked here.

use serde::{Deserialize, Serialize};

/// Develop settings format version, independent of the book version (`DEVELOP_VERSION` in TS).
pub const DEVELOP_VERSION: u32 = 1;

/// `[x, y]`, fractions of the transformed, uncropped image unless noted.
pub type Point = [f64; 2];

fn yes() -> bool {
    true
}
fn fifty() -> f64 {
    50.0
}
fn hundred() -> f64 {
    100.0
}
fn develop_version() -> u32 {
    DEVELOP_VERSION
}

/// The settings on `Asset.develop`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DevelopSettings {
    pub version: u32,
    pub light: Light,
    pub white_balance: WhiteBalance,
    pub curve: Curve,
    pub color: Color,
    pub detail: Detail,
    pub geometry: Geometry,
    pub masks: Vec<Mask>,
    /// Workflow plan 17. Left out of the JSON (and so of [`crate::develop_hash`]) while at its defaults, like
    /// `HASH_OPTIONAL_SECTIONS` in TS, so adding it changed no existing photo's hash.
    #[serde(skip_serializing_if = "Effects::is_default")]
    pub effects: Effects,
    /// Workflow plan 18: the 3D LUT. Left out of the JSON (and the hash) while it has none, like `effects`.
    #[serde(skip_serializing_if = "Look::is_default")]
    pub look: Look,
}

impl Default for DevelopSettings {
    fn default() -> Self {
        Self {
            version: develop_version(),
            light: Light::default(),
            white_balance: WhiteBalance::default(),
            curve: Curve::default(),
            color: Color::default(),
            detail: Detail::default(),
            geometry: Geometry::default(),
            masks: Vec::new(),
            effects: Effects::default(),
            look: Look::default(),
        }
    }
}

impl DevelopSettings {
    /// True when every setting equals its default, i.e. the photo is unedited (`isDefaultDevelop` in TS).
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Light {
    /// EV, -5..5.
    pub exposure: f64,
    pub contrast: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub whites: f64,
    pub blacks: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum WhiteBalance {
    /// The camera's white balance (for rendered files: leave the colours as they are).
    #[default]
    AsShot,
    /// Kelvin (2000..50000) and tint (-150..150), for RAW files.
    Absolute {
        temperature: f64,
        #[serde(default)]
        tint: f64,
    },
    /// Relative shifts (-100..100), for rendered files.
    Incremental {
        #[serde(default)]
        temperature: f64,
        #[serde(default)]
        tint: f64,
    },
}

/// `[input, output]`, both 0..1.
pub type CurvePoint = [f64; 2];

fn identity_curve() -> Vec<CurvePoint> {
    vec![[0.0, 0.0], [1.0, 1.0]]
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ParametricCurve {
    pub highlights: f64,
    pub lights: f64,
    pub darks: f64,
    pub shadows: f64,
    /// Region boundaries on the input axis, 0..1 and increasing.
    pub splits: [f64; 3],
}

impl Default for ParametricCurve {
    fn default() -> Self {
        Self { highlights: 0.0, lights: 0.0, darks: 0.0, shadows: 0.0, splits: [0.25, 0.5, 0.75] }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Curve {
    pub parametric: ParametricCurve,
    pub luma: Vec<CurvePoint>,
    pub red: Vec<CurvePoint>,
    pub green: Vec<CurvePoint>,
    pub blue: Vec<CurvePoint>,
}

impl Default for Curve {
    fn default() -> Self {
        Self {
            parametric: ParametricCurve::default(),
            luma: identity_curve(),
            red: identity_curve(),
            green: identity_curve(),
            blue: identity_curve(),
        }
    }
}

/// The eight hue bands of the colour mixer, in hue order (`HUE_BANDS` in TS).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HueBand {
    Red,
    Orange,
    Yellow,
    Green,
    Aqua,
    Blue,
    Purple,
    Magenta,
}

impl HueBand {
    pub const ALL: [HueBand; 8] = [
        HueBand::Red,
        HueBand::Orange,
        HueBand::Yellow,
        HueBand::Green,
        HueBand::Aqua,
        HueBand::Blue,
        HueBand::Purple,
        HueBand::Magenta,
    ];
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct HueMix {
    pub hue: f64,
    pub saturation: f64,
    pub luminance: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ColorMix {
    pub red: HueMix,
    pub orange: HueMix,
    pub yellow: HueMix,
    pub green: HueMix,
    pub aqua: HueMix,
    pub blue: HueMix,
    pub purple: HueMix,
    pub magenta: HueMix,
}

impl ColorMix {
    pub fn band(&self, band: HueBand) -> &HueMix {
        match band {
            HueBand::Red => &self.red,
            HueBand::Orange => &self.orange,
            HueBand::Yellow => &self.yellow,
            HueBand::Green => &self.green,
            HueBand::Aqua => &self.aqua,
            HueBand::Blue => &self.blue,
            HueBand::Purple => &self.purple,
            HueBand::Magenta => &self.magenta,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Color {
    pub vibrance: f64,
    pub saturation: f64,
    pub mix: ColorMix,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Sharpen {
    /// 0..150.
    pub amount: f64,
    /// Pixels at the 1080 px short-side reference, 0.5..3.
    pub radius: f64,
    pub detail: f64,
    pub masking: f64,
}

impl Default for Sharpen {
    fn default() -> Self {
        Self { amount: 40.0, radius: 1.0, detail: 25.0, masking: 0.0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DenoiseModel {
    #[serde(rename = "nafnet-w32")]
    NafnetW32,
    #[serde(rename = "nafnet-w64")]
    NafnetW64,
    #[serde(rename = "scunet")]
    Scunet,
}

/// Where denoise's colour (Oklab a/b) comes from (workflow plan 24): `Filter` (the default) is the classical guided
/// filter on a/b applied at render time ([`crate::ops::noise`]), `Model` the network's own a/b blended into the
/// intermediate as before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChromaMode {
    #[default]
    Filter,
    Model,
}

impl ChromaMode {
    pub fn is_default(&self) -> bool {
        *self == ChromaMode::Filter
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Denoise {
    pub model: DenoiseModel,
    #[serde(default = "fifty")]
    pub luminance: f64,
    #[serde(default = "default_chroma")]
    pub chroma: f64,
    #[serde(default = "default_denoise_sharpen")]
    pub sharpen: f64,
    /// Workflow plan 24; `filter` when absent, and left out of the JSON (so of the develop hash) at that default, as
    /// `hashableDevelop` does in TS: the field changed no existing hash.
    #[serde(default, rename = "chromaMode", skip_serializing_if = "ChromaMode::is_default")]
    pub chroma_mode: ChromaMode,
}

fn default_chroma() -> f64 {
    75.0
}
fn default_denoise_sharpen() -> f64 {
    25.0
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Detail {
    pub clarity: f64,
    pub texture: f64,
    pub dehaze: f64,
    pub sharpen: Sharpen,
    /// AI denoise; `None` (JSON `null`) when off.
    pub denoise: Option<Denoise>,
}

/// User rotation on top of the EXIF orientation, degrees clockwise. Serialised as the number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(try_from = "u16", into = "u16")]
pub enum Rotation {
    #[default]
    R0,
    R90,
    R180,
    R270,
}

impl Rotation {
    pub fn degrees(self) -> u16 {
        match self {
            Rotation::R0 => 0,
            Rotation::R90 => 90,
            Rotation::R180 => 180,
            Rotation::R270 => 270,
        }
    }
}

impl From<Rotation> for u16 {
    fn from(r: Rotation) -> u16 {
        r.degrees()
    }
}

impl TryFrom<u16> for Rotation {
    type Error = String;
    fn try_from(deg: u16) -> Result<Self, Self::Error> {
        match deg {
            0 => Ok(Rotation::R0),
            90 => Ok(Rotation::R90),
            180 => Ok(Rotation::R180),
            270 => Ok(Rotation::R270),
            other => Err(format!("rotate must be 0, 90, 180 or 270, got {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UprightMode {
    #[default]
    Off,
    Auto,
    Level,
    Vertical,
    Full,
    Guided,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GuideKind {
    Vertical,
    Horizontal,
}

/// A line the user drew for guided Upright.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UprightGuide {
    pub id: String,
    pub kind: GuideKind,
    pub from: Point,
    pub to: Point,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Upright {
    pub mode: UprightMode,
    /// At most 4.
    pub guides: Vec<UprightGuide>,
    /// Row-major forward homography in 0..1 coordinates of the oriented image, stored by the analysis;
    /// `None` until analysed.
    pub transform: Option<[f64; 9]>,
    /// Focal length in long-edge units the analysis assumed.
    pub focal: Option<f64>,
}

/// Manual Transform sliders, applied after Upright.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ManualTransform {
    pub vertical: f64,
    pub horizontal: f64,
    /// Degrees, -10..10.
    pub rotate: f64,
    pub aspect: f64,
    /// Percent, 50..150.
    pub scale: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}

impl Default for ManualTransform {
    fn default() -> Self {
        Self {
            vertical: 0.0,
            horizontal: 0.0,
            rotate: 0.0,
            aspect: 0.0,
            scale: hundred(),
            offset_x: 0.0,
            offset_y: 0.0,
        }
    }
}

/// Fractions of the transformed, uncropped image.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AspectPreset {
    #[default]
    Free,
    Original,
}

/// `"free"`, `"original"` or a `[width, height]` ratio.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CropAspect {
    Preset(AspectPreset),
    Ratio(f64, f64),
}

impl Default for CropAspect {
    fn default() -> Self {
        CropAspect::Preset(AspectPreset::Free)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Crop {
    pub rect: CropRect,
    /// Straighten angle in degrees about the crop centre, positive clockwise, -45..45.
    #[serde(default)]
    pub angle: f64,
    #[serde(default)]
    pub aspect: CropAspect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Geometry {
    pub rotate: Rotation,
    pub flip_h: bool,
    pub flip_v: bool,
    pub upright: Upright,
    pub transform: ManualTransform,
    /// Keep the crop inside the warped image.
    pub constrain_crop: bool,
    /// `None` (JSON `null`): no crop.
    pub crop: Option<Crop>,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            rotate: Rotation::R0,
            flip_h: false,
            flip_v: false,
            upright: Upright::default(),
            transform: ManualTransform::default(),
            constrain_crop: yes(),
            crop: None,
        }
    }
}

/// One brush stroke; `points` are image fractions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrushStroke {
    pub points: Vec<Point>,
    /// Diameter as a percentage of the image's short side.
    #[serde(default = "default_brush_size")]
    pub size: f64,
    #[serde(default = "fifty")]
    pub feather: f64,
    #[serde(default = "hundred")]
    pub flow: f64,
    #[serde(default)]
    pub erase: bool,
}

fn default_brush_size() -> f64 {
    25.0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptKind {
    Point,
    Box,
}

/// A click or box prompt for a promptable AI mask.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MaskPrompt {
    pub kind: PromptKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point: Option<Point>,
    #[serde(rename = "box", default, skip_serializing_if = "Option::is_none")]
    pub bbox: Option<[Point; 2]>,
    /// `false` excludes the region.
    #[serde(default = "yes")]
    pub positive: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaskMode {
    #[default]
    Add,
    Subtract,
    Intersect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiMaskTarget {
    Subject,
    Background,
    Sky,
    People,
    Depth,
}

/// One part of a mask; `mode` says how it combines with the components before it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MaskComponent {
    pub id: String,
    #[serde(default)]
    pub mode: MaskMode,
    #[serde(default)]
    pub invert: bool,
    #[serde(flatten)]
    pub shape: MaskShape,
}

/// The kind-specific part of a mask component, tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MaskShape {
    Brush {
        strokes: Vec<BrushStroke>,
    },
    Linear {
        from: Point,
        to: Point,
    },
    Radial {
        center: Point,
        radii: Point,
        /// Degrees.
        angle: f64,
        #[serde(default = "fifty")]
        feather: f64,
    },
    Luminance {
        /// 0..1.
        range: [f64; 2],
        #[serde(default)]
        feather: f64,
    },
    Color {
        /// Hex colours.
        samples: Vec<String>,
        #[serde(default = "fifty")]
        tolerance: f64,
    },
    Ai {
        target: AiMaskTarget,
        model: String,
        model_version: String,
        #[serde(default)]
        prompts: Vec<MaskPrompt>,
        /// For `depth`: near and far bounds, 0..1. Left out of the JSON when absent, like Zod's optional.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        depth_range: Option<[f64; 2]>,
    },
}

/// The Lightroom local-adjustment subset a mask applies. All -100..100 except `exposure` (EV, -4..4)
/// and `noise` (0..100).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LocalAdjustments {
    pub exposure: f64,
    pub contrast: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub whites: f64,
    pub blacks: f64,
    pub temperature: f64,
    pub tint: f64,
    pub texture: f64,
    pub clarity: f64,
    pub dehaze: f64,
    pub saturation: f64,
    pub sharpness: f64,
    pub noise: f64,
    pub hue: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mask {
    pub id: String,
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub invert: bool,
    /// 0..100.
    #[serde(default = "hundred")]
    pub opacity: f64,
    #[serde(default)]
    pub feather: f64,
    /// At least one.
    pub components: Vec<MaskComponent>,
    #[serde(default)]
    pub adjustments: LocalAdjustments,
}

// --- Effects (workflow plan 17): colour grading, grain, vignette, halation. Every default is a no-op.

/// One colour-grading wheel: `hue` on the colour wheel in degrees (0 red, 120 green, 240 blue, 0..360) and
/// `saturation` (0..100).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct GradingWheel {
    pub hue: f64,
    pub saturation: f64,
    /// Plan 55: a lightness offset over the wheel's tonal range, -100..100. Left out of the JSON (and so of the
    /// develop hash) at 0, as `hashableDevelop` does in TS, so settings written before it hash as they did.
    #[serde(skip_serializing_if = "is_zero")]
    pub luminance: f64,
}

impl GradingWheel {
    /// True at the defaults (no tint, no lightness offset).
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

fn is_zero(v: &f64) -> bool {
    *v == 0.0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Grading {
    pub shadows: GradingWheel,
    pub midtones: GradingWheel,
    pub highlights: GradingWheel,
    /// Plan 55: the Global wheel, over every tone. Left out of the JSON (and the hash) at its defaults. The harmony
    /// lock (`grading.harmony` in TS) is UI state the hash never sees, so it has no field here (serde ignores it).
    #[serde(skip_serializing_if = "GradingWheel::is_default")]
    pub global: GradingWheel,
    /// Overlap of the tonal ranges, 0..100.
    pub blending: f64,
    /// Shadows / highlights split, -100..100 (positive: more of the range to the highlights wheel).
    pub balance: f64,
}

impl Default for Grading {
    fn default() -> Self {
        Self {
            shadows: GradingWheel::default(),
            midtones: GradingWheel::default(),
            highlights: GradingWheel::default(),
            global: GradingWheel::default(),
            blending: fifty(),
            balance: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Grain {
    /// 0..100.
    pub amount: f64,
    /// 0..100; grain size in reference pixels (long edge 2048).
    pub size: f64,
    /// 0..100; weight of the fine octave.
    pub roughness: f64,
}

impl Default for Grain {
    fn default() -> Self {
        Self { amount: 0.0, size: 25.0, roughness: fifty() }
    }
}

/// Post-crop vignette on lightness.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Vignette {
    /// -100..100; negative darkens the corners.
    pub amount: f64,
    /// 0..100.
    pub midpoint: f64,
    /// 0..100.
    pub feather: f64,
    /// -100 (rounded rectangle)..100 (circle); 0 is an ellipse following the frame.
    pub roundness: f64,
}

impl Default for Vignette {
    fn default() -> Self {
        Self { amount: 0.0, midpoint: fifty(), feather: fifty(), roundness: 0.0 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Halation {
    /// 0..100.
    pub amount: f64,
    /// 0..100; lightness above which highlights glow.
    pub threshold: f64,
    /// 0..100.
    pub radius: f64,
}

impl Default for Halation {
    fn default() -> Self {
        Self { amount: 0.0, threshold: 75.0, radius: 30.0 }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Effects {
    pub grading: Grading,
    pub grain: Grain,
    pub vignette: Vignette,
    pub halation: Halation,
}

impl Effects {
    /// True when every effect is at its default (the section is then left out of the hash).
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

// --- Look (workflow plan 18): a user 3D LUT by content hash.

/// A LUT the look applies: `id` is the SHA-256 of `<appdata>/luts/<id>.cube`, `name` what the editor shows (also when
/// the file is missing), `strength` 0..100 a blend with the input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LutRef {
    pub id: String,
    pub name: String,
    #[serde(default = "hundred")]
    pub strength: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Look {
    /// `None` (JSON `null`): no LUT.
    pub lut: Option<LutRef>,
}

impl Look {
    /// True without a LUT (the section is then left out of the hash).
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}
