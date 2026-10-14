//! D4.2: the model downloader against a local Range-capable HTTP server (offline), and an ignored hello-world that
//! downloads SkyWater-Seg (48 MB) and runs it through ONNX Runtime with the CoreML EP.
//!
//! `cargo test -p photobook-develop --test ai` runs the offline tests.
//! `cargo test -p photobook-develop --test ai -- --ignored --nocapture` downloads the model (into
//! `PHOTOBOOK_MODELS_DIR`, default the editor's `<appdata>/models`) and prints timings and the partition count.
#![cfg(feature = "ai")]

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use photobook_develop::ai::runtime::{SessionOptions, Tensor};
use photobook_develop::ai::{
    self, delete_model, download_model, registry, status, Error, ModelDir, ModelEntry, ModelFile, ModelStatus,
    Progress, Session, Task,
};
use sha2::{Digest, Sha256};

// ---------- a tiny HTTP/1.1 file server with Range support ----------

#[derive(Default)]
struct ServerState {
    files: BTreeMap<String, Vec<u8>>,
    /// The `Range` header of each request (None when absent), in order.
    ranges: Vec<Option<String>>,
    /// Answer 200 with the whole body even when a Range was asked for.
    ignore_range: bool,
}

struct Server {
    base: String,
    state: Arc<Mutex<ServerState>>,
}

impl Server {
    fn start(files: &[(&str, Vec<u8>)]) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(ServerState {
            files: files.iter().map(|(k, v)| (format!("/{k}"), v.clone())).collect(),
            ..ServerState::default()
        }));
        let shared = state.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let state = shared.clone();
                std::thread::spawn(move || {
                    let _ = serve(stream, &state);
                });
            }
        });
        Server { base, state }
    }

    fn url(&self, name: &str) -> String {
        format!("{}/{name}", self.base)
    }

    fn ranges(&self) -> Vec<Option<String>> {
        self.state.lock().unwrap().ranges.clone()
    }
}

fn serve(stream: TcpStream, state: &Mutex<ServerState>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let path = request_line.split_whitespace().nth(1).unwrap_or("/").to_owned();
    let mut range = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_owned());
            }
        }
    }
    let (body, ignore) = {
        let mut s = state.lock().unwrap();
        s.ranges.push(range.clone());
        (s.files.get(&path).cloned(), s.ignore_range)
    };
    let mut out = stream;
    let Some(body) = body else {
        return out.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    let start = range
        .filter(|_| !ignore)
        .and_then(|r| r.strip_prefix("bytes=").and_then(|r| r.strip_suffix('-')).and_then(|n| n.parse::<usize>().ok()));
    let head = match start {
        Some(s) if s >= body.len() => {
            let h = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", body.len());
            return out.write_all(h.as_bytes());
        }
        Some(s) => format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {s}-{}/{}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
            body.len() - 1,
            body.len(),
            body.len() - s
        ),
        None => format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
            body.len()
        ),
    };
    out.write_all(head.as_bytes())?;
    for chunk in body[start.unwrap_or(0)..].chunks(64 * 1024) {
        out.write_all(chunk)?;
    }
    out.flush()
}

// ---------- fixtures ----------

/// Deterministic pseudo-random bytes (SplitMix64).
fn bytes(len: usize, seed: u64) -> Vec<u8> {
    let mut state = seed;
    (0..len)
        .map(|_| {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            (z ^ (z >> 31)) as u8
        })
        .collect()
}

fn sha(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

const GRAPH_LEN: usize = 3_000_000;
const DATA_LEN: usize = 120_000;

fn fixture() -> (Server, ModelEntry, Vec<u8>, Vec<u8>) {
    let graph = bytes(GRAPH_LEN, 1);
    let data = bytes(DATA_LEN, 2);
    let server = Server::start(&[("m.onnx", graph.clone()), ("m.onnx_data", data.clone())]);
    let entry = entry_for(&server, &graph, &data);
    (server, entry, graph, data)
}

fn entry_for(server: &Server, graph: &[u8], data: &[u8]) -> ModelEntry {
    ModelEntry {
        name: "test-model".into(),
        title: "Test".into(),
        version: "v1".into(),
        task: Task::Sky,
        licence: "MIT".into(),
        licence_url: "https://example.com".into(),
        homepage: "https://example.com".into(),
        input: vec![1, 3, 8, 8],
        dims: BTreeMap::new(),
        static_input: true,
        verified: true,
        files: vec![
            ModelFile { path: "m.onnx".into(), url: server.url("m.onnx"), bytes: graph.len() as u64, sha256: sha(graph) },
            ModelFile {
                path: "m.onnx_data".into(),
                url: server.url("m.onnx_data"),
                bytes: data.len() as u64,
                sha256: sha(data),
            },
        ],
    }
}

/// Progress events, checked to be monotonic and bounded by the total.
#[derive(Default)]
struct Recorder(Mutex<Vec<Progress>>);

impl Recorder {
    fn callback(&self) -> impl Fn(Progress) + '_ {
        move |p| self.0.lock().unwrap().push(p)
    }

    fn check(&self, total: u64) -> Vec<Progress> {
        let events = self.0.lock().unwrap().clone();
        assert!(!events.is_empty());
        for p in &events {
            assert_eq!(p.total, total);
            assert!(p.received <= total);
        }
        events
    }
}

// ---------- offline downloader tests ----------

#[test]
fn downloads_verifies_and_installs() {
    let (server, entry, graph, data) = fixture();
    let tmp = tempfile::tempdir().unwrap();
    let dir = ModelDir::new(tmp.path());
    // An older version is pruned once the new one is complete.
    fs::create_dir_all(tmp.path().join("test-model/v0")).unwrap();
    fs::write(tmp.path().join("test-model/v0/m.onnx"), b"old").unwrap();

    let rec = Recorder::default();
    let path = download_model(&entry, &dir, &rec.callback(), &AtomicBool::new(false)).unwrap();
    assert_eq!(path, tmp.path().join("test-model/v1/m.onnx"));
    assert_eq!(fs::read(&path).unwrap(), graph);
    assert_eq!(fs::read(tmp.path().join("test-model/v1/m.onnx_data")).unwrap(), data);
    assert!(!tmp.path().join("test-model/v1/m.onnx.part").exists());
    assert!(!tmp.path().join("test-model/v0").exists());
    assert_eq!(status(&entry, &dir), ModelStatus::Installed);

    let events = rec.check(entry.total_bytes());
    assert!(events.windows(2).all(|w| w[0].received <= w[1].received), "progress is monotonic");
    assert_eq!(events.last().unwrap().received, entry.total_bytes());
    assert!(events.len() > 5, "progress is reported while streaming");
    assert_eq!(server.ranges(), vec![None, None]);

    // Installed files are not fetched again.
    download_model(&entry, &dir, &|_| {}, &AtomicBool::new(false)).unwrap();
    assert_eq!(server.ranges().len(), 2);

    let freed = delete_model(&entry, &dir).unwrap();
    assert_eq!(freed, entry.total_bytes());
    assert_eq!(status(&entry, &dir), ModelStatus::Missing);
    assert_eq!(delete_model(&entry, &dir).unwrap(), 0);
}

#[test]
fn resumes_after_a_cancel_and_after_a_killed_write() {
    let (server, entry, graph, _) = fixture();
    let tmp = tempfile::tempdir().unwrap();
    let dir = ModelDir::new(tmp.path());
    let part = tmp.path().join("test-model/v1/m.onnx.part");

    // Cancel once a megabyte has arrived: the part stays for the next attempt.
    let cancel = AtomicBool::new(false);
    let err = download_model(
        &entry,
        &dir,
        &|p| {
            if p.received > 1_000_000 {
                cancel.store(true, Ordering::Relaxed);
            }
        },
        &cancel,
    )
    .unwrap_err();
    assert!(matches!(err, Error::Cancelled), "{err}");
    let kept = fs::metadata(&part).unwrap().len();
    assert!(kept > 1_000_000 && kept < GRAPH_LEN as u64, "{kept}");
    assert_eq!(status(&entry, &dir), ModelStatus::Partial(kept));

    // A process killed mid-write leaves a shorter part; resume from whatever is there.
    fs::OpenOptions::new().write(true).open(&part).unwrap().set_len(700_000).unwrap();
    let rec = Recorder::default();
    download_model(&entry, &dir, &rec.callback(), &AtomicBool::new(false)).unwrap();
    assert_eq!(fs::read(tmp.path().join("test-model/v1/m.onnx")).unwrap(), graph);
    let ranges = server.ranges();
    assert_eq!(ranges[1].as_deref(), Some("bytes=700000-"), "{ranges:?}");
    // Progress after a resume starts at the bytes already on disk.
    let events = rec.check(entry.total_bytes());
    assert_eq!(events[0].received, 700_000);
}

#[test]
fn a_corrupted_part_fails_the_checksum_and_is_removed() {
    let (_server, entry, graph, _) = fixture();
    let tmp = tempfile::tempdir().unwrap();
    let dir = ModelDir::new(tmp.path());
    let part = tmp.path().join("test-model/v1/m.onnx.part");
    fs::create_dir_all(part.parent().unwrap()).unwrap();
    let mut bad = graph[..500_000].to_vec();
    bad[1234] ^= 0xff;
    fs::write(&part, bad).unwrap();

    let err = download_model(&entry, &dir, &|_| {}, &AtomicBool::new(false)).unwrap_err();
    assert!(matches!(err, Error::HashMismatch { ref file, .. } if file == "m.onnx"), "{err}");
    assert!(!part.exists());
    assert!(!tmp.path().join("test-model/v1/m.onnx").exists());

    // The next attempt starts over and succeeds.
    download_model(&entry, &dir, &|_| {}, &AtomicBool::new(false)).unwrap();
    assert_eq!(status(&entry, &dir), ModelStatus::Installed);
}

#[test]
fn a_server_that_ignores_range_restarts_the_file() {
    let (server, entry, graph, _) = fixture();
    server.state.lock().unwrap().ignore_range = true;
    let tmp = tempfile::tempdir().unwrap();
    let dir = ModelDir::new(tmp.path());
    let part = tmp.path().join("test-model/v1/m.onnx.part");
    fs::create_dir_all(part.parent().unwrap()).unwrap();
    fs::write(&part, &graph[..400_000]).unwrap();
    download_model(&entry, &dir, &|_| {}, &AtomicBool::new(false)).unwrap();
    assert_eq!(fs::read(tmp.path().join("test-model/v1/m.onnx")).unwrap(), graph);
    assert_eq!(server.ranges()[0].as_deref(), Some("bytes=400000-"));
}

#[test]
fn wrong_content_and_http_errors() {
    let (server, mut entry, _, _) = fixture();
    let tmp = tempfile::tempdir().unwrap();
    let dir = ModelDir::new(tmp.path());
    // The server's bytes do not match the pinned hash.
    entry.files[1].sha256 = sha(b"something else");
    let err = download_model(&entry, &dir, &|_| {}, &AtomicBool::new(false)).unwrap_err();
    assert!(matches!(err, Error::HashMismatch { ref file, .. } if file == "m.onnx_data"), "{err}");
    // The first file was fine and stays installed; only the bad one is missing.
    assert!(tmp.path().join("test-model/v1/m.onnx").exists());
    assert_eq!(status(&entry, &dir), ModelStatus::Partial(GRAPH_LEN as u64));

    entry.files[1].url = server.url("missing");
    let err = download_model(&entry, &dir, &|_| {}, &AtomicBool::new(false)).unwrap_err();
    assert!(matches!(err, Error::Http { status: 404, .. }), "{err}");

    // More bytes than the manifest says: rejected without writing past the size.
    let mut short = entry_for(&server, &bytes(GRAPH_LEN, 1), &bytes(DATA_LEN, 2));
    short.version = "v2".into();
    short.files[0].bytes = 1000;
    let err = download_model(&short, &dir, &|_| {}, &AtomicBool::new(false)).unwrap_err();
    assert!(matches!(err, Error::SizeMismatch { expected: 1000, .. }), "{err}");
}

#[test]
fn offline_and_unverified() {
    // A port nobody listens on: connection refused, reported as offline.
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let (_server, mut entry, _, _) = fixture();
    entry.files[0].url = format!("http://127.0.0.1:{port}/m.onnx");
    let tmp = tempfile::tempdir().unwrap();
    let err = download_model(&entry, &ModelDir::new(tmp.path()), &|_| {}, &AtomicBool::new(false)).unwrap_err();
    assert!(matches!(err, Error::Offline { ref host, .. } if host == "127.0.0.1"), "{err}");
    assert!(err.to_string().starts_with("offline: could not reach 127.0.0.1"), "{err}");

    // An entry without a pinned hash (NAFNet was one until D5.1 pinned it) is refused before any request.
    let mut unpinned = registry().get("nafnet-sidd-width32").unwrap().clone();
    unpinned.verified = false;
    unpinned.files[0].sha256.clear();
    let err = download_model(&unpinned, &ModelDir::new(tmp.path()), &|_| {}, &AtomicBool::new(false)).unwrap_err();
    assert!(matches!(err, Error::Unverified(_)), "{err}");
}

// ---------- hello world: SkyWater-Seg through ONNX Runtime (network, 48 MB) ----------

fn models_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("PHOTOBOOK_MODELS_DIR") {
        return dir.into();
    }
    let home = std::env::var_os("HOME").expect("HOME");
    PathBuf::from(home).join("Library/Application Support/com.photobook.editor/models")
}

/// 384 × 384: a blue sky gradient over the top half, textured green grass below, ImageNet-normalised NCHW.
fn sky_over_grass(size: usize) -> ndarray::Array4<f32> {
    let mean = [0.485f32, 0.456, 0.406];
    let std = [0.229f32, 0.224, 0.225];
    let noise = bytes(size * size, 7);
    let mut x = ndarray::Array4::<f32>::zeros((1, 3, size, size));
    for row in 0..size {
        let t = row as f32 / size as f32;
        for col in 0..size {
            let n = noise[row * size + col] as f32 / 255.0 - 0.5;
            let rgb = if t < 0.5 {
                // Deep blue at the top, paler toward the horizon.
                let h = t / 0.5;
                [0.25 + 0.45 * h, 0.45 + 0.35 * h, 0.85 + 0.1 * h]
            } else {
                [0.18 + 0.12 * n, 0.42 + 0.2 * n, 0.12 + 0.08 * n]
            };
            for c in 0..3 {
                x[[0, c, row, col]] = (rgb[c].clamp(0.0, 1.0) - mean[c]) / std[c];
            }
        }
    }
    x
}

#[test]
#[ignore = "downloads SkyWater-Seg (48 MB) and runs ONNX Runtime"]
fn hello_world_skywater() {
    let _ = env_logger_like();
    let entry = registry().get("skywater-seg").unwrap();
    let dir = ModelDir::new(models_dir());
    println!("models dir: {}", dir.root().display());

    let t = Instant::now();
    let last = Mutex::new(0u64);
    download_model(
        entry,
        &dir,
        &|p| {
            let pct = p.received * 10 / p.total.max(1);
            let mut l = last.lock().unwrap();
            if pct != *l {
                *l = pct;
                println!("  download {}%", pct * 10);
            }
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    println!("download/verify: {:.1} s", t.elapsed().as_secs_f64());
    assert_eq!(status(entry, &dir), ModelStatus::Installed);

    let input = sky_over_grass(384);
    for (label, opts) in [
        ("CoreML", SessionOptions::for_model(entry, &dir)),
        ("CPU", SessionOptions::for_model(entry, &dir).cpu()),
    ] {
        let session = Session::load(&dir.primary_path(entry), &opts).unwrap();
        session.log_compute_plan();
        let info = session.info();
        println!(
            "{label}: load {} ms, {}, inputs {:?}, outputs {:?}",
            info.load_time.as_millis(),
            info.provider_summary(),
            info.inputs,
            info.outputs
        );
        if !info.unsupported_ops.is_empty() {
            println!("{label}: ops CoreML rejected: {:?}", info.unsupported_ops);
        } else if info.coreml_partitions.unwrap_or(0) > 1 {
            let sample: Vec<&String> = session.load_log().iter().filter(|l| l.contains("upported")).take(5).collect();
            println!("{label}: support lines: {sample:?}");
        }
        if let Some(dump) = std::env::var_os("PHOTOBOOK_AI_DUMP_LOG") {
            fs::write(PathBuf::from(dump).join(format!("ort-{label}.log")), session.load_log().join("\n")).unwrap();
        }
        let warm = session.warm_up(2).unwrap();
        let mut times = Vec::new();
        let mut out = None;
        for _ in 0..10 {
            let t = Instant::now();
            out = Some(session.run(&[("input", Tensor::F32(input.view().into_dyn()))]).unwrap());
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(f64::total_cmp);
        println!("{label}: warm-up run {:.1} ms, median run {:.2} ms, min {:.2} ms", warm.as_secs_f64() * 1000.0, times[5], times[0]);

        let out = out.unwrap();
        let logits = out.get("output_fp32").expect("output_fp32");
        assert_eq!(logits.shape(), &[1, 4, 384, 384]);
        // Sky = argmax class 1. Top 40 % should be sky, bottom 40 % not.
        let sky_fraction = |rows: std::ops::Range<usize>| {
            let mut sky = 0usize;
            let mut n = 0usize;
            for r in rows {
                for c in 0..384 {
                    let v: Vec<f32> = (0..4).map(|k| logits[[0, k, r, c]]).collect();
                    let best = (0..4).max_by(|&a, &b| v[a].total_cmp(&v[b])).unwrap();
                    sky += usize::from(best == 1);
                    n += 1;
                }
            }
            sky as f64 / n as f64
        };
        let top = sky_fraction(0..154);
        let bottom = sky_fraction(230..384);
        println!("{label}: sky fraction top 40% {top:.3}, bottom 40% {bottom:.3}");
        assert!(top > 0.9, "top should be sky: {top}");
        assert!(bottom < 0.05, "bottom should not be sky: {bottom}");
    }
    let installed = ai::installed(&dir);
    println!("installed: {installed:?}");
}

/// Print `log` records (the `[photobook:ai]` lines) to stderr in the ignored test.
fn env_logger_like() -> Result<(), log::SetLoggerError> {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, m: &log::Metadata) -> bool {
            m.level() <= log::Level::Info
        }
        fn log(&self, r: &log::Record) {
            if self.enabled(r.metadata()) {
                eprintln!("{} {}", r.level(), r.args());
            }
        }
        fn flush(&self) {}
    }
    log::set_logger(&Stderr).map(|()| log::set_max_level(log::LevelFilter::Info))
}
