// (b) The geometry warp (`geometry::warp`): the exact integer copy, the separable resize used for the
// copy + resize path and for the Mitchell prefilter (fast_image_resize's convolution with its
// coefficients precomputed on the CPU), and the inverse-mapping gathers (16-tap Catmull-Rom, 36-tap
// Lanczos3 with normalised weights), clipped to the 2×2 nearest source pixels.

@group(0) @binding(0) var<uniform> U: Uni;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<IMAGE_FORMAT, write>;

// ---------- exact copy ----------
// i0 = (origin x, origin y, dx.x, dx.y), i1 = (dy.x, dy.y, out w, out h).
@compute @workgroup_size(8, 8)
fn copy_map(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = i32(id.x);
    let j = i32(id.y);
    if (i >= U.i1.z || j >= U.i1.w) {
        return;
    }
    let sx = U.i0.x + i * U.i0.z + j * U.i1.x;
    let sy = U.i0.y + i * U.i0.w + j * U.i1.y;
    textureStore(dst, vec2<i32>(i, j), textureLoad(src, vec2<i32>(sx, sy), 0));
}

// ---------- separable resize (fast_image_resize convolution) ----------
// i0 = (out w, out h, window size, 1 = horizontal / 0 = vertical). `bounds[o]` = (first tap, tap count).
@group(0) @binding(3) var<storage, read> bounds: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read> weights: array<f32>;

@compute @workgroup_size(8, 8)
fn resize(@builtin(global_invocation_id) id: vec3<u32>) {
    if (i32(id.x) >= U.i0.x || i32(id.y) >= U.i0.y) {
        return;
    }
    let horizontal = U.i0.w == 1;
    let o = select(id.y, id.x, horizontal);
    let b = bounds[o];
    let base = o * u32(U.i0.z);
    var acc = vec3<f32>(0.0);
    for (var k = 0u; k < b.y; k++) {
        let s = b.x + k;
        let at = select(vec2<u32>(id.x, s), vec2<u32>(s, id.y), horizontal);
        acc += weights[base + k] * textureLoad(src, at, 0).rgb;
    }
    textureStore(dst, vec2<u32>(id.x, id.y), vec4<f32>(acc, 1.0));
}

// ---------- inverse-mapping gathers ----------
// i0 = (source w, source h, out w, out h); f0, f1, f2.x = the inverse homography h0..h8 (output pixel
// → source pixel, continuous coordinates).
@group(0) @binding(5) var<storage, read> lanczos: array<f32>;

fn catmull_rom(t: f32) -> array<f32, 6> {
    let t2 = t * t;
    let t3 = t2 * t;
    return array<f32, 6>(
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2,
        0.0,
        0.0,
    );
}

fn lanczos_k(x: f32) -> f32 {
    let f = abs(x) * f32(LANCZOS_LUT_PER_UNIT);
    let i = u32(f);
    if (i >= 3u * LANCZOS_LUT_PER_UNIT) {
        return 0.0;
    }
    let r = f - f32(i);
    return lanczos[i] + (lanczos[i + 1u] - lanczos[i]) * r;
}

fn lanczos3(t: f32) -> array<f32, 6> {
    var w = array<f32, 6>(lanczos_k(t + 2.0), lanczos_k(t + 1.0), lanczos_k(t), lanczos_k(1.0 - t), lanczos_k(2.0 - t), lanczos_k(3.0 - t));
    let sum = ((((w[0] + w[1]) + w[2]) + w[3]) + w[4]) + w[5];
    if (sum != 0.0) {
        for (var k = 0; k < 6; k++) {
            w[k] = w[k] / sum;
        }
    }
    return w;
}

fn gather(id: vec3<u32>, n: i32) {
    let i = i32(id.x);
    let j = i32(id.y);
    if (i >= U.i0.z || j >= U.i0.w) {
        return;
    }
    let sw = U.i0.x;
    let sh = U.i0.y;
    let xc = f32(i) + 0.5;
    let yc = f32(j) + 0.5;
    let wh = U.f1.z * xc + U.f1.w * yc + U.f2.x;
    let x = (U.f0.x * xc + U.f0.y * yc + U.f0.z) / wh;
    let y = (U.f0.w * xc + U.f1.x * yc + U.f1.y) / wh;
    let fx = x - 0.5;
    let fy = y - 0.5;
    let ixf = floor(fx);
    let iyf = floor(fy);
    let tx = fx - ixf;
    let ty = fy - iyf;
    let ix = i32(ixf);
    let iy = i32(iyf);
    var wx: array<f32, 6>;
    var wy: array<f32, 6>;
    if (n == 4) {
        wx = catmull_rom(tx);
        wy = catmull_rom(ty);
    } else {
        wx = lanczos3(tx);
        wy = lanczos3(ty);
    }
    let back = n / 2 - 1;
    var acc = vec3<f32>(0.0);
    for (var k = 0; k < n; k++) {
        let yk = clamp(iy - back + k, 0, sh - 1);
        var racc = vec3<f32>(0.0);
        for (var m = 0; m < n; m++) {
            let xk = clamp(ix - back + m, 0, sw - 1);
            racc += wx[m] * textureLoad(src, vec2<i32>(xk, yk), 0).rgb;
        }
        acc += wy[k] * racc;
    }
    // Clip to the 2×2 nearest neighbours (taps `back` and `back + 1`).
    let x0 = clamp(ix, 0, sw - 1);
    let x1 = clamp(ix + 1, 0, sw - 1);
    let y0 = clamp(iy, 0, sh - 1);
    let y1 = clamp(iy + 1, 0, sh - 1);
    let a = textureLoad(src, vec2<i32>(x0, y0), 0).rgb;
    let b = textureLoad(src, vec2<i32>(x1, y0), 0).rgb;
    let d = textureLoad(src, vec2<i32>(x0, y1), 0).rgb;
    let e = textureLoad(src, vec2<i32>(x1, y1), 0).rgb;
    let lo = min(min(a, b), min(d, e));
    let hi = max(max(a, b), max(d, e));
    textureStore(dst, vec2<i32>(i, j), vec4<f32>(clamp(acc, lo, hi), 1.0));
}

@compute @workgroup_size(8, 8)
fn gather_catmull_rom(@builtin(global_invocation_id) id: vec3<u32>) {
    gather(id, 4);
}

@compute @workgroup_size(8, 8)
fn gather_lanczos3(@builtin(global_invocation_id) id: vec3<u32>) {
    gather(id, 6);
}
