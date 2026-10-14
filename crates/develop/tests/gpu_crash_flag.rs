//! The GPU crash flag: when `<dir>/gpu-crash-flag` is left over from a launch that died while bringing the
//! GPU up, this process stays on the CPU. Its own test binary because the GPU context is per process.

use photobook_develop::gpu::{self, GpuContext, CRASH_FLAG_FILE};
use photobook_develop::{DevelopSettings, Developer, LinearImage, RenderBackend};

#[test]
fn a_leftover_crash_flag_keeps_the_process_on_the_cpu() {
    let dir = tempfile::tempdir().unwrap();
    let flag = dir.path().join(CRASH_FLAG_FILE);
    std::fs::write(&flag, b"left by a crash").unwrap();
    gpu::init(Some(dir.path().to_path_buf()));
    assert!(gpu::crash_flag_present());
    assert!(GpuContext::get().is_none(), "a crash flag must disable the GPU");
    let mut s = DevelopSettings::default();
    s.light.exposure = 0.5;
    let dev = Developer::new(LinearImage::new(64, 48, vec![0.2; 64 * 48 * 3]));
    let _ = dev.render(&s);
    assert_eq!(dev.last_backend(), Some(RenderBackend::Cpu));
    // The flag stays until cleared; clearing it lets the next process try the GPU again.
    assert!(flag.exists());
    gpu::clear_crash_flag().unwrap();
    assert!(!flag.exists() && !gpu::crash_flag_present());
}
