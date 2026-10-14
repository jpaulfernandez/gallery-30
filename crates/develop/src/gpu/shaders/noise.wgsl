// (n) The chroma filter and mask noise (workflow plan 24, `ops::noise`): the coarse Oklab cells, and the joint
// upsampling pass that writes the filtered image the chain starts from. The coefficients between the two are solved
// on the CPU (`ops::noise::planes_from_cells`, small planes), so both paths share that maths exactly.

@group(0) @binding(0) var<uniform> U: Uni;
@group(0) @binding(1) var src: texture_2d<f32>;
// Oklab matrices, rows padded to vec4: to_lms (0..3), from_lms (3..6), m2 (6..9), m2_inv (9..12).
@group(0) @binding(5) var<storage, read> M: array<vec4<f32>, 12>;

// Same association as `matrix::apply_f32`: (m0·x + m1·y) + m2·z.
fn mat_cpu(i: u32, v: vec3<f32>) -> vec3<f32> {
    let r0 = M[i];
    let r1 = M[i + 1u];
    let r2 = M[i + 2u];
    return vec3<f32>(
        r0.x * v.x + r0.y * v.y + r0.z * v.z,
        r1.x * v.x + r1.y * v.y + r1.z * v.z,
        r2.x * v.x + r2.y * v.y + r2.z * v.z,
    );
}

fn cbrt_signed(v: f32) -> f32 {
    let a = abs(v);
    var r = 0.0;
    if (a > 0.0) {
        r = pow(a, 1.0 / 3.0);
    }
    return select(r, -r, v < 0.0);
}

fn to_lab(rgb: vec3<f32>) -> vec3<f32> {
    let lms = mat_cpu(0u, rgb);
    return mat_cpu(6u, vec3<f32>(cbrt_signed(lms.x), cbrt_signed(lms.y), cbrt_signed(lms.z)));
}

fn to_rgb(lab: vec3<f32>) -> vec3<f32> {
    let l = mat_cpu(9u, lab);
    return mat_cpu(3u, l * l * l);
}

// ---------- coarse cells ----------
// i0 = (factor, low w, low h, _), i1 = (image w, image h, _, _), f0.x = L_FLOOR.
// Per cell: the mean of Oklab L, a / max(L, L_FLOOR) and b / max(L, L_FLOOR), summed row by row as the CPU does.

@group(0) @binding(2) var cells: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8)
fn noise_cells(@builtin(global_invocation_id) id: vec3<u32>) {
    if (i32(id.x) >= U.i0.y || i32(id.y) >= U.i0.z) {
        return;
    }
    let f = U.i0.x;
    let x0 = i32(id.x) * f;
    let y0 = i32(id.y) * f;
    let x1 = min(x0 + f, U.i1.x);
    let y1 = min(y0 + f, U.i1.y);
    var sum = vec3<f32>(0.0);
    for (var y = y0; y < y1; y++) {
        for (var x = x0; x < x1; x++) {
            let lab = to_lab(textureLoad(src, vec2<i32>(x, y), 0).rgb);
            let inv = 1.0 / max(lab.x, U.f0.x);
            sum += vec3<f32>(lab.x, lab.y * inv, lab.z * inv);
        }
    }
    let n = f32((x1 - x0) * (y1 - y0));
    textureStore(cells, vec2<u32>(id.xy), vec4<f32>(sum / n, 0.0));
}

// ---------- joint upsampling ----------
// i0 = (low w, low h, has amounts, has luma), i1 = (tile w, tile h, tile x0, tile y0): `src` and the coefficients are
// read at the tile's absolute position, `amounts` and `filtered` are the tile's own (origin at the tile),
// f0 = (1 / factor, global chroma strength, MASK_LUMA_SHARE, L_FLOOR).

@group(0) @binding(3) var coef: texture_2d<f32>;
@group(0) @binding(4) var aux: texture_2d<f32>;
@group(0) @binding(6) var amounts: texture_2d<f32>;
@group(0) @binding(7) var filtered: texture_storage_2d<IMAGE_FORMAT, write>;

fn axis(v: i32, n: i32, scale: f32) -> vec3<f32> {
    let pos = max((f32(v) + 0.5) * scale - 0.5, 0.0);
    let i = min(i32(pos), n - 1);
    let j = min(i + 1, n - 1);
    return vec3<f32>(f32(i), f32(j), pos - f32(i));
}

fn bilinear(t: texture_2d<f32>, ax: vec3<f32>, ay: vec3<f32>) -> vec4<f32> {
    let c00 = textureLoad(t, vec2<i32>(i32(ax.x), i32(ay.x)), 0);
    let c10 = textureLoad(t, vec2<i32>(i32(ax.y), i32(ay.x)), 0);
    let c01 = textureLoad(t, vec2<i32>(i32(ax.x), i32(ay.y)), 0);
    let c11 = textureLoad(t, vec2<i32>(i32(ax.y), i32(ay.y)), 0);
    let top = c00 + (c10 - c00) * ax.z;
    let bottom = c01 + (c11 - c01) * ax.z;
    return top + (bottom - top) * ay.z;
}

fn mix_cpu(a: f32, b: f32, t: f32) -> f32 {
    return a * (1.0 - t) + b * t;
}

@compute @workgroup_size(8, 8)
fn noise_apply(@builtin(global_invocation_id) id: vec3<u32>) {
    let q = vec2<i32>(id.xy);
    if (q.x >= U.i1.x || q.y >= U.i1.y) {
        return;
    }
    let p = q + U.i1.zw;
    let px = textureLoad(src, p, 0);
    var n = 0.0;
    if (U.i0.z == 1) {
        n = textureLoad(amounts, q, 0).r;
    }
    var t_ab = U.f0.y;
    var t_l = 0.0;
    if (n > 0.0) {
        t_ab = clamp(U.f0.y + n, 0.0, 1.0);
        t_l = clamp(n * U.f0.z, 0.0, 1.0);
    }
    if (t_ab <= 0.0 && t_l <= 0.0) {
        textureStore(filtered, q, px);
        return;
    }
    let ax = axis(p.x, U.i0.x, U.f0.x);
    let ay = axis(p.y, U.i0.y, U.f0.x);
    let c = bilinear(coef, ax, ay);
    let x = bilinear(aux, ax, ay);
    let lab = to_lab(px.rgb);
    let t = t_ab * x.x;
    let lf = max(lab.x, U.f0.w);
    let fa = (c.x * lab.x + c.y) * lf;
    let fb = (c.z * lab.x + c.w) * lf;
    var out = vec3<f32>(lab.x, mix_cpu(lab.y, fa, t), mix_cpu(lab.z, fb, t));
    if (t_l > 0.0 && U.i0.w == 1) {
        out.x = mix_cpu(lab.x, x.y * lab.x + x.z, t_l);
    }
    textureStore(filtered, q, vec4<f32>(to_rgb(out), px.a));
}
