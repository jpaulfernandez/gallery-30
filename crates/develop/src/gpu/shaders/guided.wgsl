// (d) The guided filter's coarse stage (`local::guided`), once per image for the whole image: cell
// reductions of the full-resolution image, the min/max filters of the dark channel, the four window
// means (rgba32float accumulators), the coefficient pass and the means of the coefficients. The chain
// applies `ā·I + b̄` per pixel with the coefficients upsampled bilinearly.

@group(0) @binding(0) var<uniform> U: Uni;
@group(0) @binding(1) var src: texture_2d<f32>;

// ---------- cell reductions of the full-resolution image ----------
// i0 = (factor, low w, low h, _), i1 = (image w, image h, _, _).

fn cell(id: vec3<u32>) -> vec4<i32> {
    let f = U.i0.x;
    let x0 = i32(id.x) * f;
    let y0 = i32(id.y) * f;
    return vec4<i32>(x0, y0, min(x0 + f, U.i1.x), min(y0 + f, U.i1.y));
}

@group(0) @binding(2) var low: texture_storage_2d<r32float, write>;

// Mean of log luminance over each cell (`downsample_mean(log_luminance(image))`), summed row by row.
@compute @workgroup_size(8, 8)
fn cell_mean_log(@builtin(global_invocation_id) id: vec3<u32>) {
    if (i32(id.x) >= U.i0.y || i32(id.y) >= U.i0.z) {
        return;
    }
    let c = cell(id);
    var sum = 0.0;
    for (var y = c.y; y < c.w; y++) {
        for (var x = c.x; x < c.z; x++) {
            sum += log_y(textureLoad(src, vec2<i32>(x, y), 0).rgb);
        }
    }
    textureStore(low, vec2<u32>(id.xy), vec4<f32>(sum / f32((c.z - c.x) * (c.w - c.y)), 0.0, 0.0, 0.0));
}

// Mean over each cell of the halation excess `clamp(Y − f0.x, 0, MAX_EXCESS)` (`local::prepass::halation_plane`:
// the per-pixel excess, then `downsample_mean`), summed row by row like `cell_mean_log`.
@compute @workgroup_size(8, 8)
fn cell_mean_excess(@builtin(global_invocation_id) id: vec3<u32>) {
    if (i32(id.x) >= U.i0.y || i32(id.y) >= U.i0.z) {
        return;
    }
    let c = cell(id);
    var sum = 0.0;
    for (var y = c.y; y < c.w; y++) {
        for (var x = c.x; x < c.z; x++) {
            sum += clamp(luma(textureLoad(src, vec2<i32>(x, y), 0).rgb) - U.f0.x, 0.0, MAX_EXCESS);
        }
    }
    textureStore(low, vec2<u32>(id.xy), vec4<f32>(sum / f32((c.z - c.x) * (c.w - c.y)), 0.0, 0.0, 0.0));
}

// The dark channel of `I / A` (A = f0.xyz) per cell: its minimum (`low`), its mean (`low_mean`) and the
// cell's RGB sum and pixel count (`sums`, for the atmospheric light).
@group(0) @binding(3) var low_mean: texture_storage_2d<r32float, write>;
@group(0) @binding(4) var sums: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn cell_dark(@builtin(global_invocation_id) id: vec3<u32>) {
    if (i32(id.x) >= U.i0.y || i32(id.y) >= U.i0.z) {
        return;
    }
    let c = cell(id);
    let a = U.f0.xyz;
    var lo = 3.4e38;
    var mean = 0.0;
    var rgb = vec3<f32>(0.0);
    for (var y = c.y; y < c.w; y++) {
        for (var x = c.x; x < c.z; x++) {
            let p = textureLoad(src, vec2<i32>(x, y), 0).rgb;
            let d = dark_of(p, a);
            lo = min(lo, d);
            mean += d;
            rgb += p;
        }
    }
    let n = f32((c.z - c.x) * (c.w - c.y));
    textureStore(low, vec2<u32>(id.xy), vec4<f32>(lo, 0.0, 0.0, 0.0));
    textureStore(low_mean, vec2<u32>(id.xy), vec4<f32>(mean / n, 0.0, 0.0, 0.0));
    textureStore(sums, vec2<u32>(id.xy), vec4<f32>(rgb, n));
}

// ---------- low-resolution filters ----------
// i0 = (_, w, h, _), i1 = (radius, 1 = horizontal / 0 = vertical, 1 = max / 0 = min, _).

@compute @workgroup_size(8, 8)
fn min_max(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (p.x >= U.i0.y || p.y >= U.i0.z) {
        return;
    }
    let horizontal = U.i1.y == 1;
    let n = select(U.i0.z, U.i0.y, horizontal);
    let pos = select(p.y, p.x, horizontal);
    let a = max(pos - U.i1.x, 0);
    let b = min(pos + U.i1.x, n - 1);
    var v = select(3.4e38, -3.4e38, U.i1.z == 1);
    for (var q = a; q <= b; q++) {
        let s = textureLoad(src, select(vec2<i32>(p.x, q), vec2<i32>(q, p.y), horizontal), 0).r;
        v = select(min(v, s), max(v, s), U.i1.z == 1);
    }
    textureStore(low, p, vec4<f32>(v, 0.0, 0.0, 0.0));
}

@group(0) @binding(5) var acc: texture_storage_2d<rgba32float, write>;
@group(0) @binding(6) var input: texture_2d<f32>;

// (I, I², p, I·p) from the guide (`src`) and the input (`input`, or the guide itself when i1.z = 0).
@compute @workgroup_size(8, 8)
fn stats(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (p.x >= U.i0.y || p.y >= U.i0.z) {
        return;
    }
    let g = textureLoad(src, p, 0).r;
    var v = g;
    if (U.i1.z == 1) {
        v = textureLoad(input, p, 0).r;
    }
    textureStore(acc, p, vec4<f32>(g, g * g, v, g * v));
}

// Box mean of all four channels along one axis (difference form). f0.x = 1 / (2r + 1).
@compute @workgroup_size(8, 8)
fn box4(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (p.x >= U.i0.y || p.y >= U.i0.z) {
        return;
    }
    let horizontal = U.i1.y == 1;
    let n = select(U.i0.z, U.i0.y, horizontal);
    let pos = select(p.y, p.x, horizontal);
    let r = U.i1.x;
    let centre = textureLoad(src, p, 0);
    var sum = vec4<f32>(0.0);
    for (var i = -r; i <= r; i++) {
        let q = clamp(pos + i, 0, n - 1);
        sum += textureLoad(src, select(vec2<i32>(p.x, q), vec2<i32>(q, p.y), horizontal), 0) - centre;
    }
    textureStore(acc, p, centre + sum * U.f0.x);
}

// The linear coefficients from the window means: a = cov / (var + eps), b = mean_p − a·mean_I.
// f0.x = eps.
@compute @workgroup_size(8, 8)
fn coefficients(@builtin(global_invocation_id) id: vec3<u32>) {
    let p = vec2<i32>(id.xy);
    if (p.x >= U.i0.y || p.y >= U.i0.z) {
        return;
    }
    let m = textureLoad(src, p, 0);
    let variance = max(m.y - m.x * m.x, 0.0);
    let cov = m.w - m.x * m.z;
    let a = cov / (variance + U.f0.x);
    textureStore(acc, p, vec4<f32>(a, m.z - a * m.x, 0.0, 0.0));
}
