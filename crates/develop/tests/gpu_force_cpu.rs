//! `PHOTOBOOK_FORCE_CPU=1` turns the GPU path off: every entry point renders on the CPU and gives exactly
//! the CPU reference's bytes. Its own test binary (one process, one test) because it sets the variable.
//! The whole suite also passes with the variable set: `PHOTOBOOK_FORCE_CPU=1 cargo test -p photobook-develop`.

use photobook_develop::gpu::{GpuContext, FORCE_CPU_ENV};
use photobook_develop::{
    decode_file, render_full, DevelopSettings, Developer, RenderBackend, RenderOptions,
};

mod common;
use common::*;

fn everything() -> DevelopSettings {
    let mut s = DevelopSettings::default();
    s.light.exposure = 0.3;
    s.light.shadows = 40.0;
    s.light.highlights = -50.0;
    s.light.contrast = 20.0;
    s.color.vibrance = 30.0;
    s.detail.clarity = 30.0;
    s.detail.texture = 20.0;
    s.detail.dehaze = 15.0;
    s.detail.sharpen.amount = 60.0;
    s.curve.luma = vec![[0.0, 0.02], [0.5, 0.52], [1.0, 1.0]];
    s
}

#[test]
fn force_cpu_env_var_selects_the_cpu_path() {
    std::env::remove_var(FORCE_CPU_ENV);
    // With a flag directory, the flag is written while the GPU comes up and removed once it is ready.
    let flags = tempfile::tempdir().unwrap();
    photobook_develop::gpu::init(Some(flags.path().to_path_buf()));
    let gpu_available = GpuContext::get().is_some();
    eprintln!("GPU available without the variable: {gpu_available}");
    assert!(!flags.path().join(photobook_develop::gpu::CRASH_FLAG_FILE).exists(), "the crash flag must be gone after start-up");

    std::env::set_var(FORCE_CPU_ENV, "1");
    assert!(GpuContext::get().is_none(), "{FORCE_CPU_ENV}=1 must hide the GPU");

    let f = fixtures();
    let s = everything();
    for img in [decode_file(&f.photo, None).unwrap(), decode_file(&f.chart, None).unwrap(), scene(1200, 800)] {
        let reference = Developer::new(img.clone()).render_with(&s, &RenderOptions { backend: RenderBackend::Cpu, ..RenderOptions::default() });
        let dev = Developer::new(img.clone());
        assert_eq!(dev.render(&s), reference, "Auto under {FORCE_CPU_ENV} is the CPU");
        assert_eq!(dev.last_backend(), Some(RenderBackend::Cpu));
        let forced = dev.render_with(&s, &RenderOptions { backend: RenderBackend::Gpu, ..RenderOptions::default() });
        assert_eq!(forced, reference, "an explicit GPU request falls back to the CPU");
        assert_eq!(dev.last_backend(), Some(RenderBackend::Cpu));
        assert_eq!(render_full(&img, &s).unwrap(), reference);
    }

    // The variable is read on every call: clearing it brings the GPU back (where there is one).
    std::env::remove_var(FORCE_CPU_ENV);
    assert_eq!(GpuContext::get().is_some(), gpu_available);
    if gpu_available {
        let dev = Developer::new(scene(640, 400));
        let _ = dev.render(&s);
        assert_eq!(dev.last_backend(), Some(RenderBackend::Gpu));
    }
}
