//! The preview modes on the GPU (plan 53; the CPU reference is [`crate::preview_modes`]): one compute pass over the
//! 8-bit develop output, after the develop chain and outside it, so it never touches the develop hash or a full
//! render. The image goes up as one `u32` per pixel and comes back the same way; the constants are the Rust ones,
//! printed into the shader, and the maths is integer, so the result equals the CPU's.

use std::sync::OnceLock;

use super::engine::GpuError;
use super::GpuContext;
use crate::image::Rgb8Image;
use crate::preview_modes::{
    mode_bits, PreviewMode, LUMA_WEIGHTS, PEAK_ALPHA, PEAK_COLOR, PEAK_THRESHOLD, ZEBRA_HIGH_ALPHA, ZEBRA_HIGH_COLOR,
    ZEBRA_LOW_ALPHA, ZEBRA_LOW_COLOR, ZEBRA_STRIPE,
};
use crate::stats::{CLIP_HIGH, CLIP_LOW};

const SHADER: &str = include_str!("shaders/preview_mode.wgsl");
const WG: u32 = 8;

fn constants() -> String {
    let rgb = |c: [u8; 3]| format!("vec3<u32>({}u, {}u, {}u)", c[0], c[1], c[2]);
    format!(
        "const LUMA_R: u32 = {}u;\nconst LUMA_G: u32 = {}u;\nconst LUMA_B: u32 = {}u;\n\
         const PEAK_THRESHOLD: u32 = {PEAK_THRESHOLD}u;\nconst PEAK_COLOR: vec3<u32> = {};\nconst PEAK_ALPHA: u32 = {PEAK_ALPHA}u;\n\
         const CLIP_HIGH: u32 = {CLIP_HIGH}u;\nconst CLIP_LOW: u32 = {CLIP_LOW}u;\nconst ZEBRA_STRIPE: u32 = {ZEBRA_STRIPE}u;\n\
         const ZEBRA_HIGH_COLOR: vec3<u32> = {};\nconst ZEBRA_HIGH_ALPHA: u32 = {ZEBRA_HIGH_ALPHA}u;\n\
         const ZEBRA_LOW_COLOR: vec3<u32> = {};\nconst ZEBRA_LOW_ALPHA: u32 = {ZEBRA_LOW_ALPHA}u;\n",
        LUMA_WEIGHTS[0],
        LUMA_WEIGHTS[1],
        LUMA_WEIGHTS[2],
        rgb(PEAK_COLOR),
        rgb(ZEBRA_HIGH_COLOR),
        rgb(ZEBRA_LOW_COLOR),
    )
}

fn pipeline(ctx: &GpuContext) -> &'static wgpu::ComputePipeline {
    static PIPELINE: OnceLock<wgpu::ComputePipeline> = OnceLock::new();
    PIPELINE.get_or_init(|| {
        let module = ctx.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("preview-mode"),
            source: wgpu::ShaderSource::Wgsl(format!("{}{SHADER}", constants()).into()),
        });
        ctx.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("preview-mode"),
            layout: None,
            module: &module,
            entry_point: Some("preview_mode"),
            compilation_options: Default::default(),
            cache: None,
        })
    })
}

/// `image` with `modes` drawn over it. `Err` when the image is too big for one storage buffer or the GPU failed.
pub(crate) fn run(ctx: &GpuContext, image: &Rgb8Image, modes: &[PreviewMode]) -> Result<Rgb8Image, GpuError> {
    use wgpu::util::DeviceExt;
    let (w, h) = (image.width, image.height);
    let pixels = w as u64 * h as u64;
    let bits = mode_bits(modes);
    if pixels == 0 || bits == 0 {
        return Ok(image.clone());
    }
    let bytes = pixels * 4;
    let limits = ctx.limits();
    if bytes > limits.max_storage_buffer_binding_size as u64 || bytes > limits.max_buffer_size {
        return Err(GpuError(format!("preview mode: {w}x{h} is too big for one buffer")));
    }
    let packed: Vec<u32> =
        image.data.chunks_exact(3).map(|p| p[0] as u32 | (p[1] as u32) << 8 | (p[2] as u32) << 16).collect();
    let device = &ctx.device;
    let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("preview-mode-params"),
        contents: bytemuck::cast_slice(&[w, h, bits, 0u32]),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let src = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("preview-mode-src"),
        contents: bytemuck::cast_slice(&packed),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let dst = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("preview-mode-dst"),
        size: bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let read = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("preview-mode-read"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let pipeline = pipeline(ctx);
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("preview-mode"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: src.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: dst.as_entire_binding() },
        ],
    });
    let mut enc = device.create_command_encoder(&Default::default());
    {
        let mut pass = enc.begin_compute_pass(&Default::default());
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.dispatch_workgroups(w.div_ceil(WG), h.div_ceil(WG), 1);
    }
    enc.copy_buffer_to_buffer(&dst, 0, &read, 0, bytes);
    ctx.queue.submit([enc.finish()]);
    let (tx, rx) = std::sync::mpsc::channel();
    read.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| GpuError(format!("poll: {e}")))?;
    rx.recv().map_err(|e| GpuError(format!("map: {e}")))?.map_err(|e| GpuError(format!("map: {e}")))?;
    let mapped = read.slice(..).get_mapped_range().map_err(|e| GpuError(format!("mapped range: {e}")))?;
    let mut data = Vec::with_capacity(pixels as usize * 3);
    for px in mapped.chunks_exact(4) {
        data.extend_from_slice(&px[..3]);
    }
    drop(mapped);
    read.unmap();
    Ok(Rgb8Image::new(w, h, data))
}
