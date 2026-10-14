// (c) Full-resolution single-channel planes of one (padded) tile, r32float, edges clamped at the tile
// border (which is the image border wherever the tile touches it; elsewhere the tile overlap is at least
// the filters' total support, so the core never sees the clamp): log luminance, separable Gaussian
// (sampled kernel) and box passes, differences of planes and the Sobel magnitude.
//
// The filters run in difference form, `x_p + Σ k_i·(x_i − x_p)`: the same value as `Σ k_i·x_i` for a
// normalised kernel, but a flat region stays exactly flat (no last-bit noise for the sharpening to pick
// up), whatever the GPU's fused multiply-adds do.

@group(0) @binding(0) var<uniform> U: Uni;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<r32float, write>;

fn plane_size() -> vec2<i32> {
    return vec2<i32>(U.i0.z, U.i0.w);
}

// i0 = (tile origin x, tile origin y in the image, tile w, tile h); `src` is the rgba16float image.
@compute @workgroup_size(8, 8)
fn log_luminance(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (p.x >= U.i0.z || p.y >= U.i0.w) {
        return;
    }
    let px = textureLoad(src, p + U.i0.xy, 0).rgb;
    textureStore(dst, p, vec4<f32>(log_y(px), 0.0, 0.0, 0.0));
}

// i0 = (_, _, w, h), i1 = (radius, 1 = horizontal / 0 = vertical, _, _); `kernel` holds 2r + 1 weights.
@group(0) @binding(3) var<storage, read> kernel: array<f32>;

@compute @workgroup_size(8, 8)
fn convolve(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = plane_size();
    let p = vec2<i32>(id.xy);
    if (p.x >= size.x || p.y >= size.y) {
        return;
    }
    let r = U.i1.x;
    let axis = select(vec2<i32>(0, 1), vec2<i32>(1, 0), U.i1.y == 1);
    let n = select(size.y, size.x, U.i1.y == 1);
    let pos = select(p.y, p.x, U.i1.y == 1);
    let centre = textureLoad(src, p, 0).r;
    var acc = 0.0;
    for (var i = -r; i <= r; i++) {
        let q = clamp(pos + i, 0, n - 1);
        let at = select(vec2<i32>(p.x, q), vec2<i32>(q, p.y), U.i1.y == 1);
        acc += kernel[i + r] * (textureLoad(src, at, 0).r - centre);
    }
    textureStore(dst, p, vec4<f32>(centre + acc, 0.0, 0.0, 0.0));
}

// i0 = (_, _, w, h), i1 = (radius, 1 = horizontal / 0 = vertical, _, _), f0.x = 1 / (2r + 1).
@compute @workgroup_size(8, 8)
fn box_blur(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = plane_size();
    let p = vec2<i32>(id.xy);
    if (p.x >= size.x || p.y >= size.y) {
        return;
    }
    let r = U.i1.x;
    let n = select(size.y, size.x, U.i1.y == 1);
    let pos = select(p.y, p.x, U.i1.y == 1);
    let centre = textureLoad(src, p, 0).r;
    var acc = 0.0;
    for (var i = -r; i <= r; i++) {
        let q = clamp(pos + i, 0, n - 1);
        let at = select(vec2<i32>(p.x, q), vec2<i32>(q, p.y), U.i1.y == 1);
        acc += textureLoad(src, at, 0).r - centre;
    }
    textureStore(dst, p, vec4<f32>(centre + acc * U.f0.x, 0.0, 0.0, 0.0));
}

// dst = src − other. i0 = (_, _, w, h).
@group(0) @binding(4) var other: texture_2d<f32>;

@compute @workgroup_size(8, 8)
fn difference(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (p.x >= U.i0.z || p.y >= U.i0.w) {
        return;
    }
    textureStore(dst, p, vec4<f32>(textureLoad(src, p, 0).r - textureLoad(other, p, 0).r, 0.0, 0.0, 0.0));
}

// Sobel magnitude (kernels normalised to a unit step) times f0.x. i0 = (_, _, w, h).
@compute @workgroup_size(8, 8)
fn sobel(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = plane_size();
    let p = vec2<i32>(id.xy);
    if (p.x >= size.x || p.y >= size.y) {
        return;
    }
    let l = max(p.x - 1, 0);
    let r = min(p.x + 1, size.x - 1);
    let t = max(p.y - 1, 0);
    let b = min(p.y + 1, size.y - 1);
    let gx = (textureLoad(src, vec2<i32>(r, t), 0).r - textureLoad(src, vec2<i32>(l, t), 0).r)
        + 2.0 * (textureLoad(src, vec2<i32>(r, p.y), 0).r - textureLoad(src, vec2<i32>(l, p.y), 0).r)
        + (textureLoad(src, vec2<i32>(r, b), 0).r - textureLoad(src, vec2<i32>(l, b), 0).r);
    let gy = (textureLoad(src, vec2<i32>(l, b), 0).r - textureLoad(src, vec2<i32>(l, t), 0).r)
        + 2.0 * (textureLoad(src, vec2<i32>(p.x, b), 0).r - textureLoad(src, vec2<i32>(p.x, t), 0).r)
        + (textureLoad(src, vec2<i32>(r, b), 0).r - textureLoad(src, vec2<i32>(r, t), 0).r);
    textureStore(dst, p, vec4<f32>(sqrt(gx * gx + gy * gy) / 8.0 * U.f0.x, 0.0, 0.0, 0.0));
}
