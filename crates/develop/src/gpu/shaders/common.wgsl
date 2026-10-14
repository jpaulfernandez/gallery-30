// Shared by every module. The `const` block above this file is generated from the Rust constants
// (`gpu::kernels::prelude`), so the tuning values cannot drift from the CPU reference.

// The small kernels' parameters: integers in `i0`, `i1`, floats in `f0`..`f2` (meaning per kernel).
struct Uni {
    i0: vec4<i32>,
    i1: vec4<i32>,
    f0: vec4<f32>,
    f1: vec4<f32>,
    f2: vec4<f32>,
}

fn luma(p: vec3<f32>) -> f32 {
    // Same association as the CPU: (L0·r + L1·g) + L2·b.
    return REC2020_LUMA_R * p.x + REC2020_LUMA_G * p.y + REC2020_LUMA_B * p.z;
}

// `log2(max(Y, 0) + LOG_FLOOR)` (`local::prepass::log_luminance`).
fn log_y(p: vec3<f32>) -> f32 {
    return log2(max(luma(p), 0.0) + LOG_FLOOR);
}

// `max(y, 0)^(1/2.4)` (`local::lightness`).
fn lightness(y: f32) -> f32 {
    if (y <= 0.0) {
        return 0.0;
    }
    return pow(y, INV_BASE_GAMMA);
}

// Hermite smoothstep as `ops::smoothstep` (not the builtin, whose precision is unspecified).
fn sstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

// The dark channel of `p / a` clamped to 0..1 (`local::prepass::haze_planes`).
fn dark_of(p: vec3<f32>, a: vec3<f32>) -> f32 {
    return clamp(min(min(p.x / a.x, p.y / a.y), p.z / a.z), 0.0, 1.0);
}
