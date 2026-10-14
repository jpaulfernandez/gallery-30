// Preview modes (plan 53): focus peak and zebra over the 8-bit develop output, one invocation per pixel. The CPU
// reference is `preview_modes::apply_preview_modes_cpu`; the maths is integer and identical, so the outputs are equal.
// `mode` is bit flags (1 focus peak, 2 zebra); both tests read the plain pixel, peak is painted first, zebra over it.
// The constants are prepended by `gpu::preview_mode` from the Rust ones.

struct Params {
  width: u32,
  height: u32,
  mode: u32,
  pad: u32,
}

@group(0) @binding(0) var<uniform> p: Params;
// One pixel per u32: r | g << 8 | b << 16.
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

fn unpack(v: u32) -> vec3<u32> {
  return vec3<u32>(v & 255u, (v >> 8u) & 255u, (v >> 16u) & 255u);
}

fn pack(c: vec3<u32>) -> u32 {
  return c.x | (c.y << 8u) | (c.z << 16u);
}

fn mix_pct(s: vec3<u32>, c: vec3<u32>, alpha: u32) -> vec3<u32> {
  return (s * (100u - alpha) + c * alpha + vec3<u32>(50u)) / 100u;
}

fn luma_at(x: u32, y: u32) -> u32 {
  let c = unpack(src[y * p.width + x]);
  return (LUMA_R * c.x + LUMA_G * c.y + LUMA_B * c.z + 128u) >> 8u;
}

@compute @workgroup_size(8, 8)
fn preview_mode(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.width || id.y >= p.height) {
    return;
  }
  let i = id.y * p.width + id.x;
  let s = unpack(src[i]);
  var out = s;
  if ((p.mode & 1u) != 0u) {
    let left = max(id.x, 1u) - 1u;
    let right = min(id.x + 1u, p.width - 1u);
    let up = max(id.y, 1u) - 1u;
    let down = min(id.y + 1u, p.height - 1u);
    let around = luma_at(left, id.y) + luma_at(right, id.y) + luma_at(id.x, up) + luma_at(id.x, down);
    let lap = abs(4 * i32(luma_at(id.x, id.y)) - i32(around));
    if (u32(lap) >= PEAK_THRESHOLD) {
      out = mix_pct(s, PEAK_COLOR, PEAK_ALPHA);
    }
  }
  if ((p.mode & 2u) != 0u) {
    let m = max(s.x, max(s.y, s.z));
    if (m >= CLIP_HIGH) {
      if (((id.x + id.y) / ZEBRA_STRIPE) % 2u == 0u) {
        out = mix_pct(out, ZEBRA_HIGH_COLOR, ZEBRA_HIGH_ALPHA);
      }
    } else if (m <= CLIP_LOW && ((id.x + p.height - 1u - id.y) / ZEBRA_STRIPE) % 2u == 0u) {
      out = mix_pct(out, ZEBRA_LOW_COLOR, ZEBRA_LOW_ALPHA);
    }
  }
  dst[i] = pack(out);
}
