// (e) The per-pixel chain, in the CPU order (`cpu::develop`), all f32 within this one pass, and (f) the
// 8-bit encode into an rgba8uint texture that is copied to a buffer for readback.
//
// white balance → exposure → highlights/shadows → whites/blacks → contrast → clarity → texture → dehaze →
// sharpening → colour (OKLCH mix, vibrance, saturation) → halation → vignette → display look → Rec.2020 →
// output RGB (sRGB or Display P3, from the uniform), gamut map → sRGB transfer → curves → 3D LUT (plan 18) →
// grading → grain → dither → 8 bit. The Effects (workflow plans 17 and 19) run on every pixel, masked or not, as
// the CPU's `LinearEffects` / `DisplayEffects`; halation reads its glow plane (`halation_plane`, a whole-image
// pre-pass at reduced size), so a tile needs no overlap for it.
//
// The guided-filter planes (highlights/shadows base, clarity detail, dehaze density) are applied here from
// the whole image's coarse coefficients (`ā·I + b̄`, bilinear), so a tile needs no overlap for them.
//
// Masks (D4.1, `cpu::masked`): a pixel some mask layer covers sums `w · adjustments` over the layers and runs
// `develop_masked`, where each operator adds its local value to the global one (falling back to the global
// pass when its own local value is 0); every other pixel runs the global chain unchanged.

struct Matrix {
    r0: vec4<f32>,
    r1: vec4<f32>,
    r2: vec4<f32>,
}

// Coarse coefficient texture: x = low w, y = low h, z = 1 / factor (as the CPU computes it).
struct Coarse {
    size: vec4<f32>,
}

struct Chain {
    // x: pass mask (PASS_*), y, z: dither origin of the core (output pixel coordinates).
    flags: vec4<u32>,
    // x, y: core origin in the image; z, w: core origin in the tile planes.
    origin: vec4<i32>,
    // x, y: core size.
    size: vec4<u32>,
    wb: Matrix,
    // x: exposure gain, y: highlights/shadows base scale, z: contrast c.
    tone: vec4<f32>,
    // whites/blacks: black, slope, radius, qscale.
    wb_curve: vec4<f32>,
    // x: whites k, y: clarity k, z: texture k, w: dehaze strength.
    detail: vec4<f32>,
    // Atmospheric light as measured (xyz, for the density guide).
    air_measured: vec4<f32>,
    // Atmospheric light in this render's space (after white balance and exposure).
    air: vec4<f32>,
    // Sharpening: amount, detail mix, masking.
    sharpen: vec4<f32>,
    // x: vibrance, y: saturation.
    color: vec4<f32>,
    hs: Coarse,
    clarity: Coarse,
    haze: Coarse,
    // Linear Rec.2020 ↔ Oklab.
    work_to_lms: Matrix,
    work_from_lms: Matrix,
    // Linear output RGB (sRGB or Display P3) ↔ Oklab (the gamut mapper).
    out_to_lms: Matrix,
    out_from_lms: Matrix,
    m2: Matrix,
    m2_inv: Matrix,
    // Linear Rec.2020 → linear output RGB (sRGB or Display P3; both use the sRGB transfer below).
    to_srgb: Matrix,
    // Masks: x = layer count, y = LOCAL_* bits, z, w = white balance table size (temperature, tint).
    masks: vec4<u32>,
    // Global values the local ones add to: exposure EV, exposure gain, grey gain, base scale.
    local_a: vec4<f32>,
    // Highlights, shadows, whites, blacks (unit).
    local_b: vec4<f32>,
    // Contrast, clarity, texture, dehaze (unit).
    local_c: vec4<f32>,
    // Saturation (unit), sharpening amount (unit), detail, masking.
    local_d: vec4<f32>,
    // White balance table: temperature start, step; tint start, step.
    wb_lut: vec4<f32>,
    // x: offset of the white balance table in `luts`.
    lut_offsets: vec4<u32>,
    // The look's 3D LUT (plan 18): x = size - 1, y = strength (0..1).
    lut3d: vec4<f32>,
    // Its DOMAIN_MIN and 1 / (DOMAIN_MAX - DOMAIN_MIN).
    lut3d_min: vec4<f32>,
    lut3d_scale: vec4<f32>,
    // Effects (plan 19). Halation: the glow plane's low w, low h, 1 / factor, and gain × grey gain.
    halation: vec4<f32>,
    // Vignette: signed stops, falloff middle, falloff width, superellipse exponent; frame w, h, axis scales.
    vignette: vec4<f32>,
    vignette_frame: vec4<f32>,
    // Grading: Oklab (a, b) offsets of shadows, midtones | highlights, pivot, band edge width.
    grading_a: vec4<f32>,
    grading_b: vec4<f32>,
    // Grading (plan 55): the Global wheel's (a, b) offset, z = 1 when the luminance offsets or the Global wheel are on;
    // the L offsets of the shadows, midtones, highlights and Global wheels.
    grading_c: vec4<f32>,
    grading_l: vec4<f32>,
    // Grain: amplitude, 1 / cell size, roughness, normalisation; x = reference px per pixel.
    grain: vec4<f32>,
    grain_scale: vec4<f32>,
}

const PASS_WB: u32 = 1u;
const PASS_EXPOSURE: u32 = 2u;
const PASS_HS: u32 = 4u;
const PASS_WHITES_BLACKS: u32 = 8u;
const PASS_CONTRAST: u32 = 16u;
const PASS_CLARITY: u32 = 32u;
const PASS_TEXTURE: u32 = 64u;
const PASS_DEHAZE: u32 = 128u;
const PASS_SHARPEN: u32 = 256u;
const PASS_COLOR: u32 = 512u;
const PASS_LOOK: u32 = 1024u;
const PASS_CURVES: u32 = 2048u;
const PASS_LUT: u32 = 4096u;
const PASS_HALATION: u32 = 8192u;
const PASS_VIGNETTE: u32 = 16384u;
const PASS_GRADING: u32 = 32768u;
const PASS_GRAIN: u32 = 65536u;

@group(0) @binding(0) var<uniform> C: Chain;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var hs_coef: texture_2d<f32>;
@group(0) @binding(3) var clarity_coef: texture_2d<f32>;
@group(0) @binding(4) var haze_coef: texture_2d<f32>;
@group(0) @binding(5) var band: texture_2d<f32>;
@group(0) @binding(6) var fine: texture_2d<f32>;
@group(0) @binding(7) var coarse: texture_2d<f32>;
@group(0) @binding(8) var edges: texture_2d<f32>;
// [0, GAIN_LUT_SIZE): highlights/shadows gain; then BINS × (cos, sin, sat, lum, skin).
@group(0) @binding(9) var<storage, read> luts: array<f32>;
@group(0) @binding(10) var curves: texture_1d<f32>;
@group(0) @binding(11) var out: texture_storage_2d<rgba8uint, write>;
// One layer per mask, the tile's core window (or the whole image for a one-tile render).
@group(0) @binding(12) var mask_layers: texture_2d_array<f32>;
// Four vec4 per layer: exposure, contrast, highlights, shadows | whites, blacks, temperature, tint |
// texture, clarity, dehaze, saturation | sharpness, noise, hue, 0.
@group(0) @binding(13) var<storage, read> mask_adj: array<vec4<f32>>;
// The look's 3D LUT, `.cube` order (x = red); a 1³ dummy when PASS_LUT is off.
@group(0) @binding(14) var lut3d: texture_3d<f32>;
// The halation glow at reduced size (`local::prepass::HalationPlane`); a 1×1 dummy when PASS_HALATION is off.
@group(0) @binding(15) var halation_plane: texture_2d<f32>;
// Workflow plan 24: the image the chain starts from (the noise pass's tile, or the input itself). Guides read
// `image`, the unfiltered input, as the CPU's pre-passes do.
@group(0) @binding(20) var start_image: texture_2d<f32>;
var<private> start_px: vec3<f32>;

fn apply(m: Matrix, v: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        m.r0.x * v.x + m.r0.y * v.y + m.r0.z * v.z,
        m.r1.x * v.x + m.r1.y * v.y + m.r1.z * v.z,
        m.r2.x * v.x + m.r2.y * v.y + m.r2.z * v.z,
    );
}

fn on(pass_bit: u32) -> bool {
    return (C.flags.x & pass_bit) != 0u;
}

// `apply_coefficients`: the coarse (ā, b̄) bilinearly at image pixel `p`, as `ā·g + b̄`.
fn coarse_axis(v: i32, n: i32, scale: f32) -> vec3<f32> {
    let pos = max((f32(v) + 0.5) * scale - 0.5, 0.0);
    let i = min(i32(pos), n - 1);
    let j = min(i + 1, n - 1);
    return vec3<f32>(f32(i), f32(j), pos - f32(i));
}

fn guided(coef: texture_2d<f32>, c: Coarse, p: vec2<i32>, g: f32) -> f32 {
    let ax = coarse_axis(p.x, i32(c.size.x), c.size.z);
    let ay = coarse_axis(p.y, i32(c.size.y), c.size.z);
    let x0 = i32(ax.x);
    let x1 = i32(ax.y);
    let y0 = i32(ay.x);
    let y1 = i32(ay.y);
    let c00 = textureLoad(coef, vec2<i32>(x0, y0), 0).xy;
    let c10 = textureLoad(coef, vec2<i32>(x1, y0), 0).xy;
    let c01 = textureLoad(coef, vec2<i32>(x0, y1), 0).xy;
    let c11 = textureLoad(coef, vec2<i32>(x1, y1), 0).xy;
    let top = c00 + (c10 - c00) * ax.z;
    let bottom = c01 + (c11 - c01) * ax.z;
    let ab = top + (bottom - top) * ay.z;
    return ab.x * g + ab.y;
}

// ---------- tone ----------

fn hs_gain(t: f32) -> f32 {
    return hs_gain_scaled(t, C.tone.y);
}

fn hs_gain_scaled(t: f32, scale: f32) -> f32 {
    let p = clamp(t * scale, 0.0, 1.0) * f32(GAIN_LUT_SIZE - 1u);
    let i = min(u32(p), GAIN_LUT_SIZE - 2u);
    let f = p - f32(i);
    return luts[i] + (luts[i + 1u] - luts[i]) * f;
}

fn whites_blacks_curve(u_in: f32) -> f32 {
    return wb_curve_with(u_in, C.wb_curve, C.detail.x);
}

// The whites/blacks curve with (black, slope, radius, qscale) and whites k.
fn wb_curve_with(u_in: f32, curve: vec4<f32>, k: f32) -> f32 {
    let black = curve.x;
    let slope = curve.y;
    let radius = curve.z;
    var u: f32;
    if (radius > 0.0) {
        if (u_in <= black - radius) {
            u = 0.0;
        } else if (u_in >= black + radius) {
            u = (u_in - black) * slope;
        } else {
            let y = u_in - (black - radius);
            u = curve.w * y * y;
        }
    } else {
        u = (u_in - black) * slope;
    }
    if (u <= 0.0) {
        return u;
    } else if (u <= 1.0) {
        return u + k * u * u;
    }
    return (1.0 + k) + (1.0 + 2.0 * k) * (u - 1.0);
}

fn signed_pow(v: f32, e: f32) -> f32 {
    let a = abs(v);
    var r = 0.0;
    if (a > 0.0) {
        r = pow(a, e);
    }
    return select(r, -r, v < 0.0);
}

// ---------- detail ----------

fn detail_gate(t: f32) -> f32 {
    return sstep(0.02, 0.10, t) * (1.0 - sstep(0.85, 1.0, t));
}

fn midtone_weight(t: f32) -> f32 {
    let m = 2.0 * t - 1.0;
    return sqrt(max(1.0 - m * m, 0.0));
}

fn halo_shape(d: f32, s: f32) -> f32 {
    let q = d / s;
    return d / (1.0 + q * q);
}

fn mask_value(edge: f32, masking: f32) -> f32 {
    if (masking <= 0.0) {
        return 1.0;
    }
    let t = masking * MASK_EDGE_MAX;
    return sstep(0.5 * t, 1.5 * t, edge);
}

// ---------- colour ----------

fn cbrt(v: f32) -> f32 {
    return signed_pow(v, 1.0 / 3.0);
}

fn to_lab(to_lms: Matrix, rgb: vec3<f32>) -> vec3<f32> {
    let lms = apply(to_lms, rgb);
    return apply(C.m2, vec3<f32>(cbrt(lms.x), cbrt(lms.y), cbrt(lms.z)));
}

fn to_rgb(from_lms: Matrix, lab: vec3<f32>) -> vec3<f32> {
    let l = apply(C.m2_inv, lab);
    return apply(from_lms, l * l * l);
}

struct HueEntry {
    cos: f32,
    sin: f32,
    sat: f32,
    lum: f32,
    skin: f32,
}

fn bin(i: u32) -> HueEntry {
    let o = GAIN_LUT_SIZE + i * 5u;
    return HueEntry(luts[o], luts[o + 1u], luts[o + 2u], luts[o + 3u], luts[o + 4u]);
}

fn hue_entry(hue: f32) -> HueEntry {
    let p = hue / BIN_DEG;
    let i = u32(p) % BINS;
    let j = (i + 1u) % BINS;
    let f = p - floor(p);
    let a = bin(i);
    let b = bin(j);
    return HueEntry(
        a.cos + (b.cos - a.cos) * f,
        a.sin + (b.sin - a.sin) * f,
        a.sat + (b.sat - a.sat) * f,
        a.lum + (b.lum - a.lum) * f,
        a.skin + (b.skin - a.skin) * f,
    );
}

fn vibrance(c: f32, v: f32, skin: f32) -> f32 {
    if (v == 0.0) {
        return 1.0;
    }
    let base = 1.0 - min(c / VIBRANCE_CHROMA_REF, 1.0);
    var weight = 0.0;
    if (base > 0.0) {
        weight = pow(base, 1.25);
    }
    return 1.0 + v * weight * select(1.0, skin, v > 0.0);
}

fn color(px: vec3<f32>) -> vec3<f32> {
    let lab = to_lab(C.work_to_lms, px);
    let c = sqrt(lab.y * lab.y + lab.z * lab.z);
    if (c < 1e-5) {
        return px;
    }
    var hue = degrees(atan2(lab.z, lab.y));
    if (hue < 0.0) {
        hue += 360.0;
    }
    let e = hue_entry(hue);
    let a2 = lab.y * e.cos - lab.z * e.sin;
    let b2 = lab.y * e.sin + lab.z * e.cos;
    let l2 = lab.x * (1.0 + LUM_STRENGTH * e.lum * sstep(0.0, 0.08, c));
    let scale = max(e.sat * vibrance(c, C.color.x, e.skin) * (1.0 + C.color.y), 0.0);
    return to_rgb(C.work_from_lms, vec3<f32>(l2, a2 * scale, b2 * scale));
}

fn look_curve(x: f32) -> f32 {
    if (x <= 0.0) {
        return 0.0;
    }
    let p = pow(x, LOOK_POWER);
    return p / (p + LOOK_K);
}

// ---------- output ----------

fn lut_at(r: i32, g: i32, b: i32) -> vec3<f32> {
    return textureLoad(lut3d, vec3<i32>(r, g, b), 0).rgb;
}

// `Lut3d::apply` (tetrahedral interpolation, inputs clamped to the domain) blended by strength, as `LutParams::apply`.
fn lut_apply(enc: vec3<f32>) -> vec3<f32> {
    let last = C.lut3d.x;
    let t = clamp((enc - C.lut3d_min.xyz) * C.lut3d_scale.xyz, vec3<f32>(0.0), vec3<f32>(1.0)) * last;
    let k = min(floor(t), vec3<f32>(last - 1.0));
    let f = t - k;
    let r = i32(k.x);
    let g = i32(k.y);
    let b = i32(k.z);
    let fr = f.x;
    let fg = f.y;
    let fb = f.z;
    let c000 = lut_at(r, g, b);
    let c111 = lut_at(r + 1, g + 1, b + 1);
    var c1: vec3<f32>;
    var c2: vec3<f32>;
    var w: vec4<f32>;
    if (fr >= fg) {
        if (fg >= fb) {
            c1 = lut_at(r + 1, g, b);
            c2 = lut_at(r + 1, g + 1, b);
            w = vec4<f32>(1.0 - fr, fr - fg, fg - fb, fb);
        } else if (fr >= fb) {
            c1 = lut_at(r + 1, g, b);
            c2 = lut_at(r + 1, g, b + 1);
            w = vec4<f32>(1.0 - fr, fr - fb, fb - fg, fg);
        } else {
            c1 = lut_at(r, g, b + 1);
            c2 = lut_at(r + 1, g, b + 1);
            w = vec4<f32>(1.0 - fb, fb - fr, fr - fg, fg);
        }
    } else if (fb >= fg) {
        c1 = lut_at(r, g, b + 1);
        c2 = lut_at(r, g + 1, b + 1);
        w = vec4<f32>(1.0 - fb, fb - fg, fg - fr, fr);
    } else if (fb >= fr) {
        c1 = lut_at(r, g + 1, b);
        c2 = lut_at(r, g + 1, b + 1);
        w = vec4<f32>(1.0 - fg, fg - fb, fb - fr, fr);
    } else {
        c1 = lut_at(r, g + 1, b);
        c2 = lut_at(r + 1, g + 1, b);
        w = vec4<f32>(1.0 - fg, fg - fr, fr - fb, fb);
    }
    let out = w.x * c000 + w.y * c1 + w.z * c2 + w.w * c111;
    return clamp(enc + C.lut3d.y * (out - enc), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn in_gamut(v: vec3<f32>) -> bool {
    return all(v >= vec3<f32>(-GAMUT_EPS)) && all(v <= vec3<f32>(1.0 + GAMUT_EPS));
}

fn gamut_map(rgb: vec3<f32>) -> vec3<f32> {
    if (in_gamut(rgb)) {
        return clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    let lab = to_lab(C.out_to_lms, rgb);
    if (!(lab.x < 1.0)) {
        return vec3<f32>(1.0);
    }
    if (!(lab.x > 0.0)) {
        return vec3<f32>(0.0);
    }
    var lo = 0.0;
    var hi = 1.0;
    for (var i = 0u; i < GAMUT_STEPS; i++) {
        let mid = 0.5 * (lo + hi);
        if (in_gamut(to_rgb(C.out_from_lms, vec3<f32>(lab.x, lab.y * mid, lab.z * mid)))) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return clamp(to_rgb(C.out_from_lms, vec3<f32>(lab.x, lab.y * lo, lab.z * lo)), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn linear_to_srgb(v: f32) -> f32 {
    let a = abs(v);
    var e: f32;
    if (a <= 0.0031308) {
        e = a * 12.92;
    } else {
        e = 1.055 * pow(a, 1.0 / 2.4) - 0.055;
    }
    return select(e, -e, v < 0.0);
}

fn curve(x: f32, c: u32) -> f32 {
    let p = clamp(x, 0.0, 1.0) * f32(CURVE_LUT_SIZE - 1u);
    let i = min(u32(p), CURVE_LUT_SIZE - 2u);
    let f = p - f32(i);
    let a = textureLoad(curves, i, 0)[c];
    let b = textureLoad(curves, i + 1u, 0)[c];
    return a + (b - a) * f;
}

fn dither(x: u32, y: u32, c: u32) -> f32 {
    var h = (x * 0x8da6b343u) ^ (y * 0xd8163841u) ^ (c * 0xcb1ab31fu);
    h ^= h >> 16u;
    h *= 0x7feb352du;
    h ^= h >> 15u;
    h *= 0x846ca68bu;
    h ^= h >> 16u;
    return f32(h >> 8u) / 16777216.0 - 0.5;
}

// ---------- effects (workflow plans 17 and 19) ----------

// `HalationPlane::sample_row`: the glow bilinearly at image pixel `p` (pixel centres, as `coarse_axis`).
fn halation_glow(p: vec2<i32>) -> f32 {
    let ax = coarse_axis(p.x, i32(C.halation.x), C.halation.z);
    let ay = coarse_axis(p.y, i32(C.halation.y), C.halation.z);
    let x0 = i32(ax.x);
    let x1 = i32(ax.y);
    let y0 = i32(ay.x);
    let y1 = i32(ay.y);
    let g00 = textureLoad(halation_plane, vec2<i32>(x0, y0), 0).r;
    let g10 = textureLoad(halation_plane, vec2<i32>(x1, y0), 0).r;
    let g01 = textureLoad(halation_plane, vec2<i32>(x0, y1), 0).r;
    let g11 = textureLoad(halation_plane, vec2<i32>(x1, y1), 0).r;
    let top = g00 + (g10 - g00) * ax.z;
    let bottom = g01 + (g11 - g01) * ax.z;
    return top + (bottom - top) * ay.z;
}

// `ops::halation::halation`: the tinted glow added to linear light.
fn halation_apply(px: vec3<f32>, p: vec2<i32>) -> vec3<f32> {
    let add = C.halation.w * halation_glow(p);
    if (add > 0.0) {
        return px + add * vec3<f32>(HALATION_TINT_R, HALATION_TINT_G, HALATION_TINT_B);
    }
    return px;
}

// `VignetteParams::gain` at image pixel `p`.
fn vignette_gain(p: vec2<i32>) -> f32 {
    let f = C.vignette_frame;
    let u = (f32(2 * p.x + 1) - f.x) / f.x * f.z;
    let v = (f32(2 * p.y + 1) - f.y) / f.y * f.w;
    let e = C.vignette.w;
    var d: f32;
    if (e == 2.0) {
        d = sqrt(u * u + v * v);
    } else {
        d = signed_pow(signed_pow(abs(u), e) + signed_pow(abs(v), e), 1.0 / e);
    }
    let hw = 0.5 * C.vignette.z;
    let weight = sstep(C.vignette.y - hw, C.vignette.y + hw, d);
    return exp2(C.vignette.x * weight);
}

fn srgb_to_linear(v: f32) -> f32 {
    let a = abs(v);
    var l: f32;
    if (a <= 0.04045) {
        l = a / 12.92;
    } else {
        l = pow((a + 0.055) / 1.055, 2.4);
    }
    return select(l, -l, v < 0.0);
}

// `GradingParams::weights`: [shadows, midtones, highlights] at Oklab lightness `l_in`.
fn grading_weights(l_in: f32) -> vec3<f32> {
    let l = clamp(l_in, 0.0, 1.0);
    let p = C.grading_b.z;
    var t: f32;
    if (l < p) {
        t = 0.5 * l / p;
    } else {
        t = 0.5 + 0.5 * (l - p) / (1.0 - p);
    }
    let hw = 0.5 * C.grading_b.w;
    let shadows = 1.0 - sstep(1.0 / 3.0 - hw, 1.0 / 3.0 + hw, t);
    let highlights = sstep(2.0 / 3.0 - hw, 2.0 / 3.0 + hw, t);
    let sum = shadows + highlights;
    if (sum > 1.0) {
        return vec3<f32>(shadows / sum, 0.0, highlights / sum);
    }
    return vec3<f32>(shadows, 1.0 - sum, highlights);
}

// `ops::grading::grade` on linear output RGB, then gamut mapped and re-encoded, as `encode_row_with`.
fn grading_apply(enc: vec3<f32>) -> vec3<f32> {
    let lin = vec3<f32>(srgb_to_linear(enc.x), srgb_to_linear(enc.y), srgb_to_linear(enc.z));
    let lab = to_lab(C.out_to_lms, lin);
    let l = lab.x;
    let w = grading_weights(l);
    let fade = sstep(0.0, 0.05, l) * (1.0 - sstep(0.98, 1.0, l));
    let a = C.grading_a;
    let b = C.grading_b;
    let da = (w.x * a.x + w.y * a.z + w.z * b.x) * fade;
    let db = (w.x * a.y + w.y * a.w + w.z * b.y) * fade;
    let graded = gamut_map(to_rgb(C.out_from_lms, vec3<f32>(l, lab.y + da, lab.z + db)));
    return vec3<f32>(linear_to_srgb(graded.x), linear_to_srgb(graded.y), linear_to_srgb(graded.z));
}

// Plan 55: `grading_apply` with the Global wheel and the luminance offsets (`GradingParams::shift` with `extra`). Only
// the `develop_wheels` pipeline (`GRADING_WHEELS` on) calls it: Metal compiles with fast math, so any change to the
// code of the plain pipeline could move engine 3's pixels; this way settings without the wheels keep them exactly.
override GRADING_WHEELS: bool = false;

fn grading_apply_wheels(enc: vec3<f32>) -> vec3<f32> {
    let lin = vec3<f32>(srgb_to_linear(enc.x), srgb_to_linear(enc.y), srgb_to_linear(enc.z));
    let lab = to_lab(C.out_to_lms, lin);
    let l = lab.x;
    let w = grading_weights(l);
    let fade = sstep(0.0, 0.05, l) * (1.0 - sstep(0.98, 1.0, l));
    let a = C.grading_a;
    let b = C.grading_b;
    let g = C.grading_c;
    let k = C.grading_l;
    let da = (w.x * a.x + w.y * a.z + w.z * b.x) * fade + g.x * fade;
    let db = (w.x * a.y + w.y * a.w + w.z * b.y) * fade + g.y * fade;
    let dl = (w.x * k.x + w.y * k.y + w.z * k.z + k.w) * fade;
    let shifted = vec3<f32>(clamp(l + dl, 0.0, 1.0), lab.y + da, lab.z + db);
    let graded = gamut_map(to_rgb(C.out_from_lms, shifted));
    return vec3<f32>(linear_to_srgb(graded.x), linear_to_srgb(graded.y), linear_to_srgb(graded.z));
}

// `ops::grain::lattice`: uniform −1..1 from a lattice point (the same integer hash as the CPU, so exact).
fn grain_lattice(ix: i32, iy: i32, seed: u32) -> f32 {
    var h = (bitcast<u32>(ix) * 0x8da6b343u) ^ (bitcast<u32>(iy) * 0xd8163841u) ^ seed;
    h ^= h >> 16u;
    h *= 0x7feb352du;
    h ^= h >> 15u;
    h *= 0x846ca68bu;
    h ^= h >> 16u;
    return f32(h >> 8u) / 8388608.0 - 1.0;
}

fn smootherstep(t: f32) -> f32 {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

// `ops::grain::value_noise`.
fn value_noise(u: f32, v: f32, seed: u32) -> f32 {
    let x0 = floor(u);
    let y0 = floor(v);
    let ix = i32(x0);
    let iy = i32(y0);
    let tx = smootherstep(u - x0);
    let ty = smootherstep(v - y0);
    let a = grain_lattice(ix, iy, seed);
    let c = grain_lattice(ix, iy + 1, seed);
    let top = a + (grain_lattice(ix + 1, iy, seed) - a) * tx;
    let bottom = c + (grain_lattice(ix + 1, iy + 1, seed) - c) * tx;
    return top + (bottom - top) * ty;
}

// `GrainParams::apply` at output pixel (x, y).
fn grain_apply(enc: vec3<f32>, x: u32, y: u32) -> vec3<f32> {
    let y_enc = clamp(GRAIN_LUMA_R * enc.x + GRAIN_LUMA_G * enc.y + GRAIN_LUMA_B * enc.z, 0.0, 1.0);
    let weight = 4.0 * y_enc * (1.0 - y_enc);
    let fu = f32(x) * C.grain_scale.x * C.grain.y;
    let fv = f32(y) * C.grain_scale.x * C.grain.y;
    let coarse_n = value_noise(fu, fv, GRAIN_SEED);
    var fine_n = 0.0;
    if (C.grain.z > 0.0) {
        fine_n = value_noise(2.0 * fu, 2.0 * fv, GRAIN_FINE_SEED);
    }
    let n = (coarse_n + C.grain.z * fine_n) * C.grain.w * C.grain.x * weight;
    return enc + vec3<f32>(n);
}

// ---------- operators shared by the global and the masked chain ----------

fn clarity_apply(px: vec3<f32>, p: vec2<i32>, original: vec3<f32>, k: f32) -> vec3<f32> {
    let y = luma(px);
    if (y > 0.0) {
        let t = lightness(y);
        let w = midtone_weight(t) * detail_gate(t);
        if (w != 0.0) {
            let ly = log_y(original);
            let d = ly - guided(clarity_coef, C.clarity, p, ly);
            let shaped = select(d, halo_shape(d, HALO_SCALE), k > 0.0);
            return px * exp2(k * shaped * w);
        }
    }
    return px;
}

fn texture_apply(px: vec3<f32>, q: vec2<i32>, k: f32) -> vec3<f32> {
    let y = luma(px);
    if (y > 0.0) {
        let w = detail_gate(lightness(y));
        if (w != 0.0) {
            let b = textureLoad(band, q, 0).r;
            let shaped = select(b, halo_shape(b, TEXTURE_HALO_SCALE), k > 0.0);
            return px * exp2(k * shaped * w);
        }
    }
    return px;
}

fn haze_density(p: vec2<i32>, original: vec3<f32>) -> f32 {
    return clamp(guided(haze_coef, C.haze, p, dark_of(original, C.air_measured.xyz)), 0.0, 1.0);
}

// `ops::dehaze::dehaze_px` (strength 0 leaves the pixel alone).
fn dehaze_apply(px: vec3<f32>, density: f32, strength: f32) -> vec3<f32> {
    let a = C.air.xyz;
    if (strength > 0.0) {
        let omega = OMEGA * strength;
        let k = SKY_TOLERANCE * luma(a);
        var t = max(1.0 - omega * density, T0);
        let diff = max(max(abs(px.x - a.x), abs(px.y - a.y)), abs(px.z - a.z));
        if (diff < k) {
            t = min(t * k / max(diff, 1e-6), 1.0);
        }
        let inv = 1.0 / t;
        return max((px - a) * inv + a, vec3<f32>(0.0));
    } else if (strength < 0.0) {
        let m = -strength * HAZE_ADD * (0.3 + 0.7 * density);
        return px + (a - px) * m;
    }
    return px;
}

fn sharpen_apply(px: vec3<f32>, q: vec2<i32>, amount: f32, m: f32, masking: f32) -> vec3<f32> {
    let mask = mask_value(textureLoad(edges, q, 0).r, masking);
    if (mask != 0.0) {
        let d = m * textureLoad(fine, q, 0).r + (1.0 - m) * textureLoad(coarse, q, 0).r;
        return px * exp2(HALO_LIMIT * tanh(amount * d * mask / HALO_LIMIT));
    }
    return px;
}

fn whites_blacks_apply(px: vec3<f32>, curve: vec4<f32>, k: f32) -> vec3<f32> {
    return vec3<f32>(
        signed_pow(wb_curve_with(signed_pow(px.x, INV_BASE_GAMMA), curve, k), 2.4),
        signed_pow(wb_curve_with(signed_pow(px.y, INV_BASE_GAMMA), curve, k), 2.4),
        signed_pow(wb_curve_with(signed_pow(px.z, INV_BASE_GAMMA), curve, k), 2.4),
    );
}

fn contrast_apply(px: vec3<f32>, c: f32) -> vec3<f32> {
    let y = luma(px);
    if (y > 1e-7) {
        return px * pow(y / FULCRUM, c);
    }
    return px;
}

// ---------- the global chain ----------

// White balance → sharpening and colour with the global sliders (`cpu::develop`'s row path).
fn develop_global(original: vec3<f32>, p: vec2<i32>, q: vec2<i32>) -> vec3<f32> {
    var px = start_px;
    if (on(PASS_WB)) {
        px = apply(C.wb, px);
    }
    if (on(PASS_EXPOSURE)) {
        px = px * C.tone.x;
    }
    // The planes are computed from the image as decoded/warped (before white balance and exposure).
    if (on(PASS_HS)) {
        let base = lightness(exp2(guided(hs_coef, C.hs, p, log_y(original))) - LOG_FLOOR);
        px = px * hs_gain(base);
    }
    if (on(PASS_WHITES_BLACKS)) {
        px = whites_blacks_apply(px, C.wb_curve, C.detail.x);
    }
    if (on(PASS_CONTRAST)) {
        px = contrast_apply(px, C.tone.z);
    }
    if (on(PASS_CLARITY)) {
        px = clarity_apply(px, p, original, C.detail.y);
    }
    if (on(PASS_TEXTURE)) {
        px = texture_apply(px, q, C.detail.z);
    }
    if (on(PASS_DEHAZE)) {
        px = dehaze_apply(px, haze_density(p, original), C.detail.w);
    }
    if (on(PASS_SHARPEN)) {
        px = sharpen_apply(px, q, C.sharpen.x, C.sharpen.y, C.sharpen.z);
    }
    if (on(PASS_COLOR)) {
        px = color(px);
    }
    return px;
}

// ---------- masks ----------

fn local_on(bit: u32) -> bool {
    return (C.masks.y & bit) != 0u;
}

// `Σ w · adjustments` over the layers at the core pixel `id` (layers in order, zero weights skipped), as
// `cpu::masked::LocalBlend::local_at`.
struct Local {
    a: vec4<f32>,
    b: vec4<f32>,
    c: vec4<f32>,
    d: vec4<f32>,
    any: bool,
}

fn local_sum(id: vec2<i32>) -> Local {
    var l = Local(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), false);
    for (var k = 0u; k < C.masks.x; k++) {
        let w = textureLoad(mask_layers, id, i32(k), 0).r;
        if (w > 0.0) {
            l.a = l.a + w * mask_adj[k * 4u];
            l.b = l.b + w * mask_adj[k * 4u + 1u];
            l.c = l.c + w * mask_adj[k * 4u + 2u];
            l.d = l.d + w * mask_adj[k * 4u + 3u];
            l.any = true;
        }
    }
    return l;
}

fn unit_sum(g: f32, l: f32) -> f32 {
    return clamp(g + l / 100.0, -1.0, 1.0);
}

// `ops::tonal::tone_gain_ev`.
fn tone_gain_ev(t_in: f32, h: f32, s: f32) -> f32 {
    let t = clamp(t_in, 0.0, 1.0);
    let wh = sstep(0.25, 1.0, t);
    let u = 1.0 - t;
    let ws = t * (u * u * u) / SHADOW_PEAK;
    let s_ev = select(SHADOWS_DEEPEN_EV, SHADOWS_LIFT_EV, s > 0.0);
    return h * HIGHLIGHTS_EV * wh + s * s_ev * ws;
}

// `cpu::masked::lut_axis`: (i, j, f).
fn lut_axis(v: f32, v0: f32, step: f32, n: u32) -> vec3<f32> {
    let p = clamp((v - v0) / step, 0.0, f32(n - 1u));
    let i = min(u32(p), max(n, 2u) - 2u);
    let j = min(i + 1u, n - 1u);
    return vec3<f32>(f32(i), f32(j), p - f32(i));
}

fn wb_value(e: u32, k: u32) -> f32 {
    return luts[C.lut_offsets.x + e * WB_ENTRY + k];
}

struct WbEntry {
    m: Matrix,
    grey: f32,
}

// `cpu::masked::WbLut::at`: the matrix and grey gain for local (temperature, tint).
fn wb_local(lt: f32, lti: f32) -> WbEntry {
    let nt = C.masks.z;
    let ta = lut_axis(lt, C.wb_lut.x, C.wb_lut.y, nt);
    let ia = lut_axis(lti, C.wb_lut.z, C.wb_lut.w, C.masks.w);
    let ti = u32(ta.x);
    let tj = u32(ta.y);
    let ii = u32(ia.x);
    let ij = u32(ia.y);
    var v: array<f32, 10>;
    for (var k = 0u; k < WB_ENTRY; k++) {
        let a = wb_value(ii * nt + ti, k);
        let b = wb_value(ii * nt + tj, k);
        let c = wb_value(ij * nt + ti, k);
        let d = wb_value(ij * nt + tj, k);
        let top = a + (b - a) * ta.z;
        let bottom = c + (d - c) * ta.z;
        v[k] = top + (bottom - top) * ia.z;
    }
    let m = Matrix(vec4<f32>(v[0], v[1], v[2], 0.0), vec4<f32>(v[3], v[4], v[5], 0.0), vec4<f32>(v[6], v[7], v[8], 0.0));
    return WbEntry(m, v[9]);
}

// `ops::color::color_px` with saturation multiplier `sat` and an optional extra hue rotation (cos, sin).
fn color_local(px: vec3<f32>, sat: f32, rotate: bool, rot: vec2<f32>) -> vec3<f32> {
    let lab = to_lab(C.work_to_lms, px);
    let c = sqrt(lab.y * lab.y + lab.z * lab.z);
    if (c < 1e-5) {
        return px;
    }
    var hue = degrees(atan2(lab.z, lab.y));
    if (hue < 0.0) {
        hue += 360.0;
    }
    let e = hue_entry(hue);
    var a2 = lab.y * e.cos - lab.z * e.sin;
    var b2 = lab.y * e.sin + lab.z * e.cos;
    if (rotate) {
        let ra = a2 * rot.x - b2 * rot.y;
        let rb = a2 * rot.y + b2 * rot.x;
        a2 = ra;
        b2 = rb;
    }
    let l2 = lab.x * (1.0 + LUM_STRENGTH * e.lum * sstep(0.0, 0.08, c));
    let scale = max(e.sat * vibrance(c, C.color.x, e.skin) * sat, 0.0);
    return to_rgb(C.work_from_lms, vec3<f32>(l2, a2 * scale, b2 * scale));
}

// `cpu::masked::develop_pixel`: the chain with this pixel's local values added to the global ones.
fn develop_masked(original: vec3<f32>, p: vec2<i32>, q: vec2<i32>, l: Local) -> vec3<f32> {
    var px = start_px;
    let l_exposure = l.a.x;
    let l_contrast = l.a.y;
    let l_highlights = l.a.z;
    let l_shadows = l.a.w;
    let l_whites = l.b.x;
    let l_blacks = l.b.y;
    let l_temperature = l.b.z;
    let l_tint = l.b.w;
    let l_texture = l.c.x;
    let l_clarity = l.c.y;
    let l_dehaze = l.c.z;
    let l_saturation = l.c.w;
    let l_sharpness = l.d.x;
    let l_hue = l.d.z;

    // White balance.
    var grey = C.local_a.z;
    var rescaled = false;
    if (local_on(LOCAL_WB) && (l_temperature != 0.0 || l_tint != 0.0)) {
        let e = wb_local(l_temperature, l_tint);
        px = apply(e.m, px);
        grey = e.grey;
        rescaled = true;
    } else if (on(PASS_WB)) {
        px = apply(C.wb, px);
    }
    // Exposure.
    var gain = C.local_a.y;
    if (l_exposure != 0.0) {
        gain = exp2(clamp(C.local_a.x + l_exposure, -10.0, 10.0));
        px = px * gain;
        rescaled = true;
    } else if (on(PASS_EXPOSURE)) {
        px = px * C.tone.x;
    }
    // Highlights / shadows on the base rescaled by this pixel's exposure and white balance.
    if (on(PASS_HS) || local_on(LOCAL_HS)) {
        let t = lightness(exp2(guided(hs_coef, C.hs, p, log_y(original))) - LOG_FLOOR);
        var scale = C.local_a.w;
        if (rescaled) {
            scale = lightness(max(gain * grey, 0.0));
        }
        if (l_highlights != 0.0 || l_shadows != 0.0) {
            let h = unit_sum(C.local_b.x, l_highlights);
            let s = unit_sum(C.local_b.y, l_shadows);
            if (h != 0.0 || s != 0.0) {
                px = px * exp2(tone_gain_ev(clamp(t * scale, 0.0, 1.0), h, s));
            }
        } else if (on(PASS_HS)) {
            px = px * hs_gain_scaled(t, scale);
        }
    }
    // Whites / blacks.
    if (l_whites != 0.0 || l_blacks != 0.0) {
        let whites = unit_sum(C.local_b.z, l_whites);
        let blacks = unit_sum(C.local_b.w, l_blacks);
        if (whites != 0.0 || blacks != 0.0) {
            // `WhitesBlacksParams::from_unit`.
            let black = -blacks * BLACKS_RANGE;
            let slope = 1.0 / (1.0 - black);
            var radius = 0.0;
            if (black > 0.0) {
                radius = min(0.5 * black, 1.0 / 16.0 / slope);
            }
            var qscale = 0.0;
            if (radius > 0.0) {
                qscale = slope / (4.0 * radius);
            }
            let white = 1.0 - whites * WHITES_RANGE;
            px = whites_blacks_apply(px, vec4<f32>(black, slope, radius, qscale), 1.0 / white - 1.0);
        }
    } else if (on(PASS_WHITES_BLACKS)) {
        px = whites_blacks_apply(px, C.wb_curve, C.detail.x);
    }
    // Contrast.
    if (l_contrast != 0.0) {
        let c = unit_sum(C.local_c.x, l_contrast);
        if (c != 0.0) {
            px = contrast_apply(px, c * CONTRAST_STRENGTH);
        }
    } else if (on(PASS_CONTRAST)) {
        px = contrast_apply(px, C.tone.z);
    }
    // Clarity.
    if (l_clarity != 0.0) {
        let c = unit_sum(C.local_c.y, l_clarity);
        if (c != 0.0) {
            px = clarity_apply(px, p, original, select(c * SOFTEN_STRENGTH, c * CLARITY_STRENGTH, c > 0.0));
        }
    } else if (on(PASS_CLARITY)) {
        px = clarity_apply(px, p, original, C.detail.y);
    }
    // Texture.
    if (l_texture != 0.0) {
        let c = unit_sum(C.local_c.z, l_texture);
        if (c != 0.0) {
            px = texture_apply(px, q, select(c * SMOOTH_STRENGTH, c * TEXTURE_STRENGTH, c > 0.0));
        }
    } else if (on(PASS_TEXTURE)) {
        px = texture_apply(px, q, C.detail.z);
    }
    // Dehaze (the atmospheric light stays global).
    if (on(PASS_DEHAZE) || local_on(LOCAL_DEHAZE)) {
        var strength = 0.0;
        if (l_dehaze != 0.0) {
            strength = unit_sum(C.local_c.w, l_dehaze);
        } else if (on(PASS_DEHAZE)) {
            strength = C.detail.w;
        }
        px = dehaze_apply(px, haze_density(p, original), strength);
    }
    // Sharpening.
    if (l_sharpness != 0.0) {
        let amount = clamp(C.local_d.y + l_sharpness / 100.0, 0.0, 1.5) * SHARPEN_STRENGTH;
        if (amount > 0.0) {
            px = sharpen_apply(px, q, amount, C.local_d.z, C.local_d.w);
        }
    } else if (on(PASS_SHARPEN)) {
        px = sharpen_apply(px, q, C.sharpen.x, C.sharpen.y, C.sharpen.z);
    }
    // Colour: saturation and hue.
    if (l_saturation != 0.0 || l_hue != 0.0) {
        if (on(PASS_COLOR) || local_on(LOCAL_COLOR)) {
            let sat = 1.0 + unit_sum(C.local_d.x, l_saturation);
            let rad = radians(clamp(l_hue / 100.0, -1.0, 1.0) * MAX_HUE_SHIFT);
            px = color_local(px, sat, l_hue != 0.0, vec2<f32>(cos(rad), sin(rad)));
        }
    } else if (on(PASS_COLOR)) {
        px = color(px);
    }
    return px;
}

@compute @workgroup_size(8, 8)
fn develop(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= C.size.x || id.y >= C.size.y) {
        return;
    }
    let p = C.origin.xy + vec2<i32>(id.xy);
    let q = C.origin.zw + vec2<i32>(id.xy);
    let original = textureLoad(image, p, 0).rgb;
    // The input itself (read at `p`), or the noise pass's tile-sized output (read at the tile's own `id`).
    let whole_start = all(textureDimensions(start_image) == textureDimensions(image));
    start_px = textureLoad(start_image, select(vec2<i32>(id.xy), p, whole_start), 0).rgb;
    var px: vec3<f32>;
    var l = Local(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), false);
    if (C.masks.x > 0u) {
        l = local_sum(vec2<i32>(id.xy));
    }
    if (l.any) {
        px = develop_masked(original, p, q, l);
    } else {
        px = develop_global(original, p, q);
    }
    if (on(PASS_HALATION)) {
        px = halation_apply(px, p);
    }
    if (on(PASS_VIGNETTE)) {
        px = px * vignette_gain(p);
    }
    if (on(PASS_LOOK)) {
        let y = luma(px);
        if (y > 1e-7) {
            px = px * (look_curve(y) / y);
        }
    }

    let lin = gamut_map(apply(C.to_srgb, px));
    var enc = vec3<f32>(linear_to_srgb(lin.x), linear_to_srgb(lin.y), linear_to_srgb(lin.z));
    if (on(PASS_CURVES)) {
        enc = vec3<f32>(curve(enc.x, 0u), curve(enc.y, 1u), curve(enc.z, 2u));
    }
    if (on(PASS_LUT)) {
        enc = lut_apply(enc);
    }
    let x = C.flags.y + id.x;
    let y = C.flags.z + id.y;
    if (on(PASS_GRADING)) {
        if (GRADING_WHEELS) {
            enc = grading_apply_wheels(enc);
        } else {
            enc = grading_apply(enc);
        }
    }
    if (on(PASS_GRAIN)) {
        enc = grain_apply(enc, x, y);
    }
    var o = vec4<u32>(0u, 0u, 0u, 255u);
    for (var c = 0u; c < 3u; c++) {
        let v = clamp(enc[c] * 255.0 + 0.5 + 0.98 * dither(x, y, c), 0.0, 255.0);
        o[c] = u32(v);
    }
    textureStore(out, vec2<u32>(id.xy), o);
}
