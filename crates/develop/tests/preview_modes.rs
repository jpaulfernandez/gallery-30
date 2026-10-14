//! Plan 53: the preview modes (focus peak, zebra). The GPU pass against the CPU reference on developed previews
//! (exactly equal: the maths is integer), the CPU backend
//! giving exactly the reference, and the mode staying out of the develop hash. Without a GPU adapter the GPU part
//! prints `SKIP`; `PHOTOBOOK_FORCE_CPU=1 cargo test -p photobook-develop --test preview_modes` runs the CPU path.

use photobook_develop::gpu::{self, GpuContext};
use photobook_develop::{
    apply_preview_mode, apply_preview_mode_cpu, apply_preview_modes, apply_preview_modes_cpu, decode_file, develop_hash, develop_hash_input, render_preview_image_with,
    DevelopSettings, PreviewMode, RenderBackend, RenderOptions, Rgb8Image,
};

mod common;
use common::*;

const MODES: [PreviewMode; 2] = [PreviewMode::FocusPeak, PreviewMode::Zebra];
/// Every set of modes the editor sends (both in either order).
const SETS: [&[PreviewMode]; 4] = [
    &[PreviewMode::FocusPeak],
    &[PreviewMode::Zebra],
    &[PreviewMode::FocusPeak, PreviewMode::Zebra],
    &[PreviewMode::Zebra, PreviewMode::FocusPeak],
];

fn settings() -> Vec<(&'static str, DevelopSettings)> {
    let mut bright = DevelopSettings::default();
    bright.light.exposure = 1.5;
    let mut dark = DevelopSettings::default();
    dark.light.exposure = -2.0;
    dark.detail.sharpen.amount = 80.0;
    vec![("default", DevelopSettings::default()), ("bright", bright), ("dark", dark)]
}

/// Plain previews of the fixtures, at the editor's preview edge and at an odd size (partial workgroups).
fn previews() -> Vec<(String, Rgb8Image)> {
    let f = fixtures();
    let mut out = Vec::new();
    for (file, path) in [("chart", &f.chart), ("photo", &f.photo)] {
        let img = decode_file(path, None).unwrap();
        for (name, s) in settings() {
            for edge in [1600, 333] {
                let options = RenderOptions::for_image(&img.meta);
                let plain = render_preview_image_with(&img, &s, edge, &options).unwrap();
                out.push((format!("{file} {name} {edge}"), plain));
            }
        }
    }
    out
}

#[test]
fn a_mode_on_the_gpu_equals_the_plain_preview_with_the_cpu_overlay() {
    let Some(ctx) = GpuContext::get() else {
        eprintln!("SKIP a_mode_on_the_gpu_equals_the_plain_preview_with_the_cpu_overlay: no GPU adapter (or PHOTOBOOK_FORCE_CPU)");
        return;
    };
    for (name, plain) in previews() {
        for modes in SETS {
            let reference = apply_preview_modes_cpu(&plain, modes);
            let on_gpu = gpu::preview_modes(ctx, &plain, modes).expect("the GPU pass ran");
            assert!(on_gpu == reference, "{name} {modes:?}: the GPU differs from the CPU");
            // Through the entry point a render uses (Auto takes the GPU here).
            assert!(apply_preview_modes(&plain, modes, &RenderOptions::default()) == reference, "{name} {modes:?}");
        }
    }
}

#[test]
fn the_cpu_backend_gives_the_reference_and_the_modes_draw_something() {
    let cpu = RenderOptions { backend: RenderBackend::Cpu, ..RenderOptions::default() };
    for (name, plain) in previews() {
        for mode in MODES {
            let out = apply_preview_mode(&plain, mode, &cpu);
            assert!(out == apply_preview_mode_cpu(&plain, mode), "{name} {mode:?}");
            assert_eq!((out.width, out.height), (plain.width, plain.height));
        }
        for modes in SETS {
            assert!(apply_preview_modes(&plain, modes, &cpu) == apply_preview_modes_cpu(&plain, modes), "{name} {modes:?}");
        }
    }
    // The chart has hard patch edges (focus peak) and black and white patches (zebra) at the default settings.
    let f = fixtures();
    let chart = decode_file(&f.chart, None).unwrap();
    let plain = render_preview_image_with(&chart, &DevelopSettings::default(), 1600, &RenderOptions::for_image(&chart.meta)).unwrap();
    for mode in MODES {
        assert_ne!(apply_preview_mode_cpu(&plain, mode), plain, "{mode:?} drew nothing on the chart");
    }
}

#[test]
fn the_mode_is_not_part_of_the_develop_hash() {
    // A mode sent inside the settings (it never is: it is the preview command's own argument) is not a field of
    // them, so the canonical settings and the hash do not see it.
    let plain = DevelopSettings::default();
    for extra in [r#"{"version":1,"mode":"zebra"}"#, r#"{"version":1,"previewMode":"focus-peak"}"#] {
        let s: DevelopSettings = serde_json::from_str(extra).unwrap();
        assert_eq!(develop_hash(&s), develop_hash(&plain));
        let input = develop_hash_input(&s);
        assert!(!input.contains("zebra") && !input.contains("focus"), "{input}");
    }
}
