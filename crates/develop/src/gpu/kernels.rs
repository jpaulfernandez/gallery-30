//! WGSL assembly and the compute pipelines.
//!
//! Every module is `prelude() + common.wgsl + <module>.wgsl`. The prelude is a block of WGSL `const`s
//! printed from the Rust constants the CPU operators use (shortest round-trip `f32` literals with the `f`
//! suffix, so the shader sees the identical `f32`), which is how the two paths cannot drift on a tuning
//! value. Literal thresholds inside the operators (`1e-7`, the smoothstep edges, ...) are mirrored by hand
//! and covered by the CPU-vs-GPU tests.

use std::fmt::Write as _;

use wgpu::util::DeviceExt;

use crate::color::curve::LUT_SIZE;
use crate::color::matrix::REC2020_LUMA;
use crate::local::{BASE_GAMMA, LOG_FLOOR};
use crate::cpu::masked::{
    LOCAL_CLARITY, LOCAL_COLOR, LOCAL_CONTRAST, LOCAL_DEHAZE, LOCAL_EXPOSURE, LOCAL_HS, LOCAL_SHARPEN, LOCAL_TEXTURE,
    LOCAL_WB, LOCAL_WHITES_BLACKS, WB_ENTRY,
};
use crate::ops::clarity::{CLARITY_STRENGTH, HALO_SCALE, SOFTEN_STRENGTH};
use crate::ops::color::{BINS, BIN_DEG, LUM_STRENGTH, MAX_HUE_SHIFT, VIBRANCE_CHROMA_REF};
use crate::ops::contrast::{FULCRUM, STRENGTH as CONTRAST_STRENGTH};
use crate::ops::dehaze::{HAZE_ADD, OMEGA, SKY_TOLERANCE, T0};
use crate::ops::display::{LOOK_POWER, MID_GREY};
use crate::ops::grain::{GRAIN_FINE_SEED, GRAIN_SEED, LUMA as GRAIN_LUMA};
use crate::ops::halation::{HALATION_TINT, MAX_EXCESS};
use crate::ops::output::{GAMUT_EPS, GAMUT_STEPS};
use crate::ops::sharpen::{HALO_LIMIT, MASK_EDGE_MAX, SHARPEN_STRENGTH};
use crate::ops::texture::{SMOOTH_STRENGTH, TEXTURE_HALO_SCALE, TEXTURE_STRENGTH};
use crate::ops::tonal::{
    BLACKS_RANGE, GAIN_LUT_SIZE, HIGHLIGHTS_EV, SHADOWS_DEEPEN_EV, SHADOWS_LIFT_EV, SHADOW_PEAK, WHITES_RANGE,
};

pub(crate) const COMMON: &str = include_str!("shaders/common.wgsl");
pub(crate) const UPLOAD: &str = include_str!("shaders/upload.wgsl");
pub(crate) const WARP: &str = include_str!("shaders/warp.wgsl");
pub(crate) const PLANES: &str = include_str!("shaders/planes.wgsl");
pub(crate) const GUIDED: &str = include_str!("shaders/guided.wgsl");
pub(crate) const CHAIN: &str = include_str!("shaders/chain.wgsl");

/// Lanczos3 lookup-table resolution, as `geometry::warp` builds it.
pub(crate) const LANCZOS_LUT_PER_UNIT: u32 = 1024;

/// Workgroup edge of every kernel (8 × 8).
pub(crate) const WG: u32 = 8;

/// The image texture format (source, warped image, warp intermediates). `Rgba32Float`, not the plan's
/// `Rgba16Float`: f16 rounds the input by up to 2.4e-4 relative, which most controls turn into at most
/// one 8-bit level, but dehaze divides by a transmission down to 0.08 (×12.5) and with dehaze +100 the
/// CPU-vs-GPU difference reached 5 levels (8 on one pixel of the chart). Switching this constant to
/// `Rgba16Float` halves image memory (8 instead of 16 bytes per pixel) at that cost; nothing else changes.
pub(crate) const IMAGE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba32Float;
/// Single-channel planes.
pub(crate) const PLANE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R32Float;
/// Guided-filter accumulators and coefficients, cell sums.
pub(crate) const ACC_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba32Float;
/// The 8-bit output.
pub(crate) const OUT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Uint;

/// An `f32` as a WGSL literal that parses back to the same value.
fn lit(v: f32) -> String {
    assert!(v.is_finite());
    format!("{v:?}f")
}

/// The generated `const` block.
pub(crate) fn prelude() -> String {
    let mut s = String::from("// Generated from the Rust constants (gpu::kernels::prelude). Do not edit.\n");
    let f = |s: &mut String, name: &str, v: f32| writeln!(s, "const {name}: f32 = {};", lit(v)).unwrap();
    let u = |s: &mut String, name: &str, v: usize| writeln!(s, "const {name}: u32 = {v}u;").unwrap();
    f(&mut s, "REC2020_LUMA_R", REC2020_LUMA[0]);
    f(&mut s, "REC2020_LUMA_G", REC2020_LUMA[1]);
    f(&mut s, "REC2020_LUMA_B", REC2020_LUMA[2]);
    f(&mut s, "LOG_FLOOR", LOG_FLOOR);
    // `1.0 / BASE_GAMMA` in f32, also `1.0 / 2.4` of the sRGB transfer and whites/blacks.
    f(&mut s, "INV_BASE_GAMMA", 1.0 / BASE_GAMMA);
    u(&mut s, "GAIN_LUT_SIZE", GAIN_LUT_SIZE);
    u(&mut s, "BINS", BINS);
    f(&mut s, "BIN_DEG", BIN_DEG);
    u(&mut s, "CURVE_LUT_SIZE", LUT_SIZE);
    u(&mut s, "LANCZOS_LUT_PER_UNIT", LANCZOS_LUT_PER_UNIT as usize);
    f(&mut s, "HALO_SCALE", HALO_SCALE);
    f(&mut s, "TEXTURE_HALO_SCALE", TEXTURE_HALO_SCALE);
    f(&mut s, "OMEGA", OMEGA);
    f(&mut s, "T0", T0);
    f(&mut s, "SKY_TOLERANCE", SKY_TOLERANCE);
    f(&mut s, "HAZE_ADD", HAZE_ADD);
    f(&mut s, "HALO_LIMIT", HALO_LIMIT);
    f(&mut s, "MASK_EDGE_MAX", MASK_EDGE_MAX);
    f(&mut s, "LUM_STRENGTH", LUM_STRENGTH);
    f(&mut s, "VIBRANCE_CHROMA_REF", VIBRANCE_CHROMA_REF);
    f(&mut s, "FULCRUM", FULCRUM);
    f(&mut s, "LOOK_POWER", LOOK_POWER);
    // `look_curve`'s K, computed exactly as the CPU does per call.
    f(&mut s, "LOOK_K", MID_GREY.powf(LOOK_POWER) * (1.0 / MID_GREY - 1.0));
    f(&mut s, "GAMUT_EPS", GAMUT_EPS);
    u(&mut s, "GAMUT_STEPS", GAMUT_STEPS);
    // Local adjustments (masks).
    f(&mut s, "CONTRAST_STRENGTH", CONTRAST_STRENGTH);
    f(&mut s, "CLARITY_STRENGTH", CLARITY_STRENGTH);
    f(&mut s, "SOFTEN_STRENGTH", SOFTEN_STRENGTH);
    f(&mut s, "TEXTURE_STRENGTH", TEXTURE_STRENGTH);
    f(&mut s, "SMOOTH_STRENGTH", SMOOTH_STRENGTH);
    f(&mut s, "SHARPEN_STRENGTH", SHARPEN_STRENGTH);
    f(&mut s, "HIGHLIGHTS_EV", HIGHLIGHTS_EV);
    f(&mut s, "SHADOWS_LIFT_EV", SHADOWS_LIFT_EV);
    f(&mut s, "SHADOWS_DEEPEN_EV", SHADOWS_DEEPEN_EV);
    f(&mut s, "SHADOW_PEAK", SHADOW_PEAK);
    f(&mut s, "BLACKS_RANGE", BLACKS_RANGE);
    f(&mut s, "WHITES_RANGE", WHITES_RANGE);
    f(&mut s, "MAX_HUE_SHIFT", MAX_HUE_SHIFT);
    u(&mut s, "WB_ENTRY", WB_ENTRY);
    // Effects (workflow plan 19).
    f(&mut s, "MAX_EXCESS", MAX_EXCESS);
    f(&mut s, "HALATION_TINT_R", HALATION_TINT[0]);
    f(&mut s, "HALATION_TINT_G", HALATION_TINT[1]);
    f(&mut s, "HALATION_TINT_B", HALATION_TINT[2]);
    u(&mut s, "GRAIN_SEED", GRAIN_SEED as usize);
    u(&mut s, "GRAIN_FINE_SEED", GRAIN_FINE_SEED as usize);
    f(&mut s, "GRAIN_LUMA_R", GRAIN_LUMA[0]);
    f(&mut s, "GRAIN_LUMA_G", GRAIN_LUMA[1]);
    f(&mut s, "GRAIN_LUMA_B", GRAIN_LUMA[2]);
    for (name, bit) in [
        ("LOCAL_EXPOSURE", LOCAL_EXPOSURE),
        ("LOCAL_WB", LOCAL_WB),
        ("LOCAL_HS", LOCAL_HS),
        ("LOCAL_WHITES_BLACKS", LOCAL_WHITES_BLACKS),
        ("LOCAL_CONTRAST", LOCAL_CONTRAST),
        ("LOCAL_CLARITY", LOCAL_CLARITY),
        ("LOCAL_TEXTURE", LOCAL_TEXTURE),
        ("LOCAL_DEHAZE", LOCAL_DEHAZE),
        ("LOCAL_SHARPEN", LOCAL_SHARPEN),
        ("LOCAL_COLOR", LOCAL_COLOR),
    ] {
        u(&mut s, name, bit as usize);
    }
    s
}

/// WGSL name of [`IMAGE_FORMAT`] (substituted for the `IMAGE_FORMAT` placeholder in storage declarations).
fn image_format_name() -> &'static str {
    match IMAGE_FORMAT {
        wgpu::TextureFormat::Rgba16Float => "rgba16float",
        wgpu::TextureFormat::Rgba32Float => "rgba32float",
        other => unreachable!("image format {other:?}"),
    }
}

/// The full source of one module.
pub(crate) fn module_source(body: &str) -> String {
    format!("{}\n{COMMON}\n{}", prelude(), body.replace("<IMAGE_FORMAT,", &format!("<{},", image_format_name())))
}

/// One binding of a kernel's bind group layout.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Slot {
    Uniform(u32),
    /// Read-only storage buffer.
    Storage(u32),
    /// `texture_2d<f32>` read with `textureLoad`.
    Texture(u32),
    /// `texture_1d<f32>`.
    Texture1d(u32),
    /// `texture_2d_array<f32>`.
    TextureArray(u32),
    /// `texture_3d<f32>` (the look's LUT).
    Texture3d(u32),
    /// Write-only storage texture.
    Store(u32, wgpu::TextureFormat),
}

impl Slot {
    fn binding(self) -> u32 {
        match self {
            Slot::Uniform(b)
            | Slot::Storage(b)
            | Slot::Texture(b)
            | Slot::Texture1d(b)
            | Slot::TextureArray(b)
            | Slot::Texture3d(b)
            | Slot::Store(b, _) => b,
        }
    }

    fn entry(self) -> wgpu::BindGroupLayoutEntry {
        let ty = match self {
            Slot::Uniform(_) => wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            Slot::Storage(_) => wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            Slot::Texture(_) | Slot::Texture1d(_) | Slot::TextureArray(_) | Slot::Texture3d(_) => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: match self {
                    Slot::Texture1d(_) => wgpu::TextureViewDimension::D1,
                    Slot::TextureArray(_) => wgpu::TextureViewDimension::D2Array,
                    Slot::Texture3d(_) => wgpu::TextureViewDimension::D3,
                    _ => wgpu::TextureViewDimension::D2,
                },
                multisampled: false,
            },
            Slot::Store(_, format) => wgpu::BindingType::StorageTexture {
                access: wgpu::StorageTextureAccess::WriteOnly,
                format,
                view_dimension: wgpu::TextureViewDimension::D2,
            },
        };
        wgpu::BindGroupLayoutEntry { binding: self.binding(), visibility: wgpu::ShaderStages::COMPUTE, ty, count: None }
    }
}

/// A compute pipeline and its bind group layout.
pub(crate) struct Kernel {
    pub name: &'static str,
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
    slots: Vec<Slot>,
}

/// A resource bound to one slot, in the kernel's slot order.
#[derive(Clone, Copy)]
pub(crate) enum Res<'a> {
    Buffer(&'a wgpu::Buffer),
    View(&'a wgpu::TextureView),
}

use Slot::{Storage as S, Store as W, Texture as T, Texture1d as T1, Texture3d as T3, TextureArray as TA, Uniform as U};

const IMG: wgpu::TextureFormat = IMAGE_FORMAT;
const PL: wgpu::TextureFormat = PLANE_FORMAT;
const ACC: wgpu::TextureFormat = ACC_FORMAT;

/// Every kernel, compiled once per process.
pub(crate) struct Kernels {
    pub upload: Kernel,
    pub copy_map: Kernel,
    pub resize: Kernel,
    pub gather_catmull_rom: Kernel,
    pub gather_lanczos3: Kernel,
    pub log_luminance: Kernel,
    pub convolve: Kernel,
    pub box_blur: Kernel,
    pub difference: Kernel,
    pub sobel: Kernel,
    pub cell_mean_log: Kernel,
    /// The halation glow's cell means (workflow plan 19).
    pub cell_mean_excess: Kernel,
    pub cell_dark: Kernel,
    pub min_max: Kernel,
    pub stats: Kernel,
    pub box4: Kernel,
    pub coefficients: Kernel,
    pub develop: Kernel,
    /// Plan 55: `develop` with `GRADING_WHEELS` on (the luminance offsets and the Global wheel); `develop` itself
    /// keeps engine 3's compiled code, so settings without them render byte-identical.
    pub develop_wheels: Kernel,
}

impl Kernels {
    pub fn new(device: &wgpu::Device) -> Kernels {
        let module = |label: &str, body: &str| {
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label),
                source: wgpu::ShaderSource::Wgsl(module_source(body).into()),
            })
        };
        let upload = module("upload", UPLOAD);
        let warp = module("warp", WARP);
        let planes = module("planes", PLANES);
        let guided = module("guided", GUIDED);
        let chain = module("chain", CHAIN);
        let k = |m: &wgpu::ShaderModule, name: &'static str, slots: &[Slot]| Kernel::new(device, m, name, slots);
        let develop_slots = [
            U(0),
            T(1),
            T(2),
            T(3),
            T(4),
            T(5),
            T(6),
            T(7),
            T(8),
            S(9),
            T1(10),
            W(11, OUT_FORMAT),
            TA(12),
            S(13),
            T3(14),
            T(15),
            // Workflow plan 24: the image the chain starts from (the noise pass's output, or the input).
            T(20),
        ];
        Kernels {
            upload: k(&upload, "upload", &[U(0), S(1), W(2, IMG)]),
            copy_map: k(&warp, "copy_map", &[U(0), T(1), W(2, IMG)]),
            resize: k(&warp, "resize", &[U(0), T(1), W(2, IMG), S(3), S(4)]),
            gather_catmull_rom: k(&warp, "gather_catmull_rom", &[U(0), T(1), W(2, IMG), S(5)]),
            gather_lanczos3: k(&warp, "gather_lanczos3", &[U(0), T(1), W(2, IMG), S(5)]),
            log_luminance: k(&planes, "log_luminance", &[U(0), T(1), W(2, PL)]),
            convolve: k(&planes, "convolve", &[U(0), T(1), W(2, PL), S(3)]),
            box_blur: k(&planes, "box_blur", &[U(0), T(1), W(2, PL)]),
            difference: k(&planes, "difference", &[U(0), T(1), W(2, PL), T(4)]),
            sobel: k(&planes, "sobel", &[U(0), T(1), W(2, PL)]),
            cell_mean_log: k(&guided, "cell_mean_log", &[U(0), T(1), W(2, PL)]),
            cell_mean_excess: k(&guided, "cell_mean_excess", &[U(0), T(1), W(2, PL)]),
            cell_dark: k(&guided, "cell_dark", &[U(0), T(1), W(2, PL), W(3, PL), W(4, ACC)]),
            min_max: k(&guided, "min_max", &[U(0), T(1), W(2, PL)]),
            stats: k(&guided, "stats", &[U(0), T(1), W(5, ACC), T(6)]),
            box4: k(&guided, "box4", &[U(0), T(1), W(5, ACC)]),
            coefficients: k(&guided, "coefficients", &[U(0), T(1), W(5, ACC)]),
            develop: k(&chain, "develop", &develop_slots),
            develop_wheels: Kernel::with_constants(device, &chain, "develop", &develop_slots, &[("GRADING_WHEELS", 1.0)]),
        }
    }
}

impl Kernel {
    pub(crate) fn new(device: &wgpu::Device, module: &wgpu::ShaderModule, name: &'static str, slots: &[Slot]) -> Kernel {
        Self::with_constants(device, module, name, slots, &[])
    }

    /// [`Kernel::new`] with the module's pipeline-overridable constants set (plan 55: `GRADING_WHEELS`).
    pub(crate) fn with_constants(
        device: &wgpu::Device,
        module: &wgpu::ShaderModule,
        name: &'static str,
        slots: &[Slot],
        constants: &[(&str, f64)],
    ) -> Kernel {
        let entries: Vec<_> = slots.iter().map(|s| s.entry()).collect();
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(name), entries: &entries });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some(name),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(name),
            layout: Some(&pipeline_layout),
            module,
            entry_point: Some(name),
            compilation_options: wgpu::PipelineCompilationOptions { constants, ..Default::default() },
            cache: None,
        });
        Kernel { name, pipeline, layout, slots: slots.to_vec() }
    }

    /// Record one dispatch covering `size` invocations (8 × 8 workgroups).
    pub fn run(&self, device: &wgpu::Device, enc: &mut wgpu::CommandEncoder, res: &[Res<'_>], size: (u32, u32)) {
        assert_eq!(res.len(), self.slots.len(), "{}: wrong number of resources", self.name);
        if size.0 == 0 || size.1 == 0 {
            return;
        }
        let entries: Vec<wgpu::BindGroupEntry<'_>> = self
            .slots
            .iter()
            .zip(res)
            .map(|(slot, r)| wgpu::BindGroupEntry {
                binding: slot.binding(),
                resource: match r {
                    Res::Buffer(b) => b.as_entire_binding(),
                    Res::View(v) => wgpu::BindingResource::TextureView(v),
                },
            })
            .collect();
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(self.name), layout: &self.layout, entries: &entries });
        let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some(self.name), timestamp_writes: None });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(size.0.div_ceil(WG), size.1.div_ceil(WG), 1);
    }
}

/// The small kernels' uniform (`Uni` in common.wgsl): 2 × `vec4<i32>`, 3 × `vec4<f32>`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct Uni {
    pub i0: [i32; 4],
    pub i1: [i32; 4],
    pub f0: [f32; 4],
    pub f1: [f32; 4],
    pub f2: [f32; 4],
}

impl Uni {
    pub fn buffer(&self, device: &wgpu::Device) -> wgpu::Buffer {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("uni"),
            contents: bytemuck::bytes_of(self),
            usage: wgpu::BufferUsages::UNIFORM,
        })
    }
}

/// A read-only storage buffer holding `data`.
pub(crate) fn storage<T: bytemuck::Pod>(device: &wgpu::Device, label: &str, data: &[T]) -> wgpu::Buffer {
    // A zero-sized binding is invalid; bind at least one element.
    let bytes = bytemuck::cast_slice(data);
    let zero = [0u8; 16];
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: if bytes.is_empty() { &zero } else { bytes },
        usage: wgpu::BufferUsages::STORAGE,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every module parses and validates with naga (no device needed), so a WGSL error fails here
    /// rather than only on machines with a GPU.
    #[test]
    fn every_module_validates() {
        use wgpu::naga;
        for (name, body) in [("upload", UPLOAD), ("warp", WARP), ("planes", PLANES), ("guided", GUIDED), ("chain", CHAIN)] {
            let src = module_source(body);
            let module = naga::front::wgsl::parse_str(&src).unwrap_or_else(|e| panic!("{name}: {}", e.emit_to_string(&src)));
            naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all())
                .validate(&module)
                .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        }
    }

    /// The prelude's literals parse back to the very same `f32`s.
    #[test]
    fn prelude_literals_round_trip() {
        for v in [REC2020_LUMA[0], LOG_FLOOR, 1.0 / BASE_GAMMA, LOOK_POWER, 1e-4, BIN_DEG, T0] {
            let l = lit(v);
            assert_eq!(l.trim_end_matches('f').parse::<f32>().unwrap().to_bits(), v.to_bits(), "{l}");
        }
        assert!(prelude().contains("const GAIN_LUT_SIZE: u32 = 1024u;"));
    }
}
