// (a) Upload: a band of interleaved f32 RGB rows into the rgba16float image texture.
// i0 = (width, rows in this band, first row, _).

@group(0) @binding(0) var<uniform> U: Uni;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<IMAGE_FORMAT, write>;

@compute @workgroup_size(8, 8)
fn upload(@builtin(global_invocation_id) id: vec3<u32>) {
    let w = u32(U.i0.x);
    if (id.x >= w || id.y >= u32(U.i0.y)) {
        return;
    }
    let i = (id.y * w + id.x) * 3u;
    textureStore(dst, vec2<u32>(id.x, id.y + u32(U.i0.z)), vec4<f32>(src[i], src[i + 1u], src[i + 2u], 1.0));
}
