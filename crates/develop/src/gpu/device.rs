//! The process-wide GPU context: instance, adapter (high performance; Metal on macOS), device and queue,
//! the compiled kernels, and the conditions under which the GPU is not used.
//!
//! [`GpuContext::get`] is `None` when
//! - `PHOTOBOOK_FORCE_CPU` is set to anything but `0`/`false`/empty (checked on every call),
//! - the crash flag file exists: [`init`] names a directory; `<dir>/gpu-crash-flag` is written before the
//!   first device creation and removed once the device and every kernel exist, so a crash (or hang that
//!   gets the app killed) while bringing the GPU up leaves the flag behind and the next launch stays on
//!   the CPU, as RapidRAW does ([`clear_crash_flag`] re-enables it),
//! - adapter or device creation or kernel compilation failed,
//! - the device reported an uncaptured error or was lost since: the context is then marked broken for
//!   the rest of the process and every later render takes the CPU path.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use super::kernels::Kernels;

/// Name of the crash flag file inside the directory given to [`init`].
pub const CRASH_FLAG_FILE: &str = "gpu-crash-flag";
/// Set to `1` to disable the GPU path (read on every [`GpuContext::get`]).
pub const FORCE_CPU_ENV: &str = "PHOTOBOOK_FORCE_CPU";

static FLAG_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static CONTEXT: OnceLock<Option<GpuContext>> = OnceLock::new();

/// Tell the crate where to keep the GPU crash flag (`<flag_dir>/gpu-crash-flag`, normally the app's cache
/// directory) and start bringing the GPU up on a background thread, so the first render does not wait
/// for it (device creation takes ~15 ms, but compiling the kernels after an update, before Metal has
/// cached them, about 2 s). Call once at startup, before the first render. Without `init` there is no
/// flag (`None` does the same) and the device is created by the first render. Calls after the device
/// was created only change where [`clear_crash_flag`] looks.
pub fn init(flag_dir: Option<PathBuf>) {
    *FLAG_DIR.lock().unwrap_or_else(|e| e.into_inner()) = flag_dir;
    if !force_cpu() && CONTEXT.get().is_none() {
        let _ = std::thread::Builder::new().name("photobook-gpu-init".into()).spawn(|| {
            let _ = GpuContext::get();
        });
    }
}

fn flag_path() -> Option<PathBuf> {
    FLAG_DIR.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|d| d.join(CRASH_FLAG_FILE))
}

/// Whether a crash flag from an earlier run is present (the GPU stays off while it is).
pub fn crash_flag_present() -> bool {
    flag_path().is_some_and(|p| p.exists())
}

/// Remove the crash flag so the next process tries the GPU again (a settings toggle, after an update).
pub fn clear_crash_flag() -> std::io::Result<()> {
    match flag_path() {
        Some(p) if p.exists() => std::fs::remove_file(p),
        _ => Ok(()),
    }
}

/// `PHOTOBOOK_FORCE_CPU` is set (to anything but empty, `0` or `false`).
pub fn force_cpu() -> bool {
    std::env::var(FORCE_CPU_ENV).is_ok_and(|v| !matches!(v.trim(), "" | "0" | "false" | "FALSE" | "no"))
}

/// The device, queue and compiled kernels, shared by every render in the process.
pub struct GpuContext {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: wgpu::AdapterInfo,
    pub(crate) kernels: Kernels,
    broken: Arc<AtomicBool>,
    /// Time to create the device and compile the kernels.
    pub startup_ms: f64,
}

impl std::fmt::Debug for GpuContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GpuContext")
            .field("adapter", &self.info.name)
            .field("backend", &self.info.backend)
            .field("broken", &self.is_broken())
            .finish()
    }
}

impl GpuContext {
    /// The shared context, created on first call; `None` when the GPU must not or cannot be used (see the
    /// module notes).
    pub fn get() -> Option<&'static GpuContext> {
        if force_cpu() {
            return None;
        }
        let ctx = CONTEXT.get_or_init(create).as_ref()?;
        (!ctx.is_broken()).then_some(ctx)
    }

    /// The device reported an error or was lost; the GPU is not used again in this process.
    pub fn is_broken(&self) -> bool {
        self.broken.load(Ordering::Relaxed)
    }

    /// Stop using the GPU for the rest of the process (after an error on a render).
    pub fn mark_broken(&self, why: &str) {
        if !self.broken.swap(true, Ordering::Relaxed) {
            log::error!("[photobook:gpu] disabled for this session: {why}");
        }
    }

    pub(crate) fn limits(&self) -> wgpu::Limits {
        self.device.limits()
    }
}

/// Whether renders can use the GPU, for a startup log line: `Ok("<adapter> (<backend>)")`, or `Err(reason)`
/// (`PHOTOBOOK_FORCE_CPU`, a crash flag from an earlier run, no adapter/device, a broken context). Waits for
/// the context when [`init`] is still bringing it up.
pub fn availability() -> Result<String, String> {
    if force_cpu() {
        return Err(format!("{FORCE_CPU_ENV} is set"));
    }
    match CONTEXT.get_or_init(create).as_ref() {
        Some(ctx) if ctx.is_broken() => Err("the GPU reported an error and was disabled for this session".into()),
        Some(ctx) => Ok(format!("{} ({:?}, ready in {:.0} ms)", ctx.info.name, ctx.info.backend, ctx.startup_ms)),
        // `create` removes its own flag once it returns, so a flag still there is an earlier run's.
        None if crash_flag_present() => {
            Err("a crash flag from an earlier start is present (clear it to retry the GPU)".into())
        }
        None => Err("no usable GPU adapter, device or kernels (see the [photobook:gpu] log)".into()),
    }
}

fn create() -> Option<GpuContext> {
    let flag = flag_path();
    if let Some(flag) = &flag {
        if flag.exists() {
            log::warn!(
                "[photobook:gpu] crash flag {} present (the GPU failed to start last time); using the CPU",
                flag.display()
            );
            return None;
        }
        write_flag(flag);
    }
    let start = Instant::now();
    let ctx = pollster::block_on(create_async(start));
    if let Some(flag) = &flag {
        // Removed when creation returned, whether or not it succeeded: only a crash leaves it behind.
        let _ = std::fs::remove_file(flag);
    }
    ctx
}

fn write_flag(flag: &Path) {
    if let Some(dir) = flag.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(err) = std::fs::write(flag, b"photobook: GPU initialisation in progress\n") {
        log::warn!("[photobook:gpu] cannot write crash flag {}: {err}", flag.display());
    }
}

async fn create_async(start: Instant) -> Option<GpuContext> {
    let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
    desc.backends = wgpu::Backends::PRIMARY;
    let instance = wgpu::Instance::new(desc);
    let adapter = match instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter: false,
            compatible_surface: None,
            apply_limit_buckets: false,
        })
        .await
    {
        Ok(a) => a,
        Err(err) => {
            log::warn!("[photobook:gpu] no adapter ({err}); using the CPU");
            return None;
        }
    };
    let info = adapter.get_info();
    if info.device_type == wgpu::DeviceType::Cpu {
        log::warn!("[photobook:gpu] only a software adapter ({}); using the CPU", info.name);
        return None;
    }
    // Everything the adapter offers: large storage buffers for uploads, 16384 px textures.
    let limits = adapter.limits();
    let (device, queue) = match adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("photobook-develop"),
            required_features: wgpu::Features::empty(),
            required_limits: limits,
            experimental_features: wgpu::ExperimentalFeatures::disabled(),
            memory_hints: wgpu::MemoryHints::Performance,
            trace: wgpu::Trace::Off,
        })
        .await
    {
        Ok(d) => d,
        Err(err) => {
            log::warn!("[photobook:gpu] device creation failed ({err}); using the CPU");
            return None;
        }
    };
    let broken = Arc::new(AtomicBool::new(false));
    {
        let broken = Arc::clone(&broken);
        device.on_uncaptured_error(Arc::new(move |err: wgpu::Error| {
            log::error!("[photobook:gpu] uncaptured device error: {err}");
            broken.store(true, Ordering::Relaxed);
        }));
    }
    {
        let broken = Arc::clone(&broken);
        device.set_device_lost_callback(move |reason, msg| {
            log::error!("[photobook:gpu] device lost ({reason:?}): {msg}");
            broken.store(true, Ordering::Relaxed);
        });
    }
    let device_ms = start.elapsed().as_secs_f64() * 1e3;
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let kernels = Kernels::new(&device);
    log::debug!("[photobook:gpu] device {device_ms:.0} ms, kernels {:.0} ms", start.elapsed().as_secs_f64() * 1e3 - device_ms);
    if let Some(err) = scope.pop().await {
        log::error!("[photobook:gpu] kernel compilation failed: {err}");
        return None;
    }
    let startup_ms = start.elapsed().as_secs_f64() * 1e3;
    log::info!(
        "[photobook:gpu] {} ({:?}, {:?}) ready in {startup_ms:.0} ms",
        info.name,
        info.backend,
        info.device_type
    );
    Some(GpuContext { instance, adapter, device, queue, info, kernels, broken, startup_ms })
}
