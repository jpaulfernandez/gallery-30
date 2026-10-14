//! Look thumbnails (workflow plan 20): the Looks strip shows the photo rendered with each look.
//!
//! `render_look_thumbs(folder, relPath, hash, base, looks, job)` takes the photo's settings without its look (`base`,
//! the editor's `lookBase`) and, per look, the full settings to render (`base` with that look at 100 %, built by the
//! editor's `applyLook`, so the scaling maths lives in one place). The cached 1600 px working image of the photo
//! (`DevelopJobs`) is resized once to [`LOOK_EDGE`] and each look is one render of it (the GPU when available), written
//! to `<appdata>/cache/<hash>/looks/<baseDh>-<presetKey>-<dh16>.jpg`:
//!
//! - `baseDh` is the develop hash of `base` with `effects` and `look` at their defaults (the cache key the plan names,
//!   and the unit of pruning: the thumbnails of the last [`KEEP_BASES`] bases are kept);
//! - `presetKey` the preset id with `:` turned into `_` (built-in looks are `builtin:<slug>`);
//! - `dh16` the first 16 hex digits of the develop hash of the rendered settings, so an edited look (same id, other
//!   values) never shows a stale thumbnail; the older file of the same look and base is deleted.
//!
//! Every thumbnail is reported on `develop:look-thumb` as it is ready (cached ones first, without a render permit);
//! a newer `job` stops an older one between looks. Thumbnails are sRGB (they are small UI swatches).

use super::*;

/// Long edge of a look thumbnail.
pub const LOOK_EDGE: u32 = 240;
const LOOK_QUALITY: u8 = 82;
/// Bases (photo settings without a look) whose thumbnails are kept per photo.
pub const KEEP_BASES: usize = 3;
const LOOKS_DIR: &str = "looks";
const MAX_LOOKS: usize = 256;
pub const EVENT_LOOK_THUMB: &str = "develop:look-thumb";

/// Highest look-thumbnail job seen; an older job stops before its next render.
static LOOK_JOB: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LookThumbItem {
    /// The look's preset id (`none` for the photo without a look).
    pub preset_id: String,
    /// What to render: `base` with the look applied.
    pub settings: DevelopSettings,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LookThumb {
    pub preset_id: String,
    /// Absolute path of the thumbnail JPEG.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Read from the cache rather than rendered now.
    pub cached: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LookThumbEvent<'a> {
    job: u64,
    #[serde(flatten)]
    thumb: &'a LookThumb,
}

/// A preset id as a file name part: ULIDs and `builtin:` slugs only (`:` becomes `_`).
pub fn preset_key(id: &str) -> Option<String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'-' || b == b'_');
    ok.then(|| id.replace(':', "_"))
}

/// The develop hash of `base` without its look: what every look thumbnail of this photo state shares.
pub fn base_hash(base: &DevelopSettings) -> String {
    let mut plain = base.clone();
    plain.effects = Default::default();
    plain.look = Default::default();
    develop_hash(&plain)
}

fn thumb_file(dir: &Path, base_dh: &str, key: &str, settings: &DevelopSettings) -> PathBuf {
    let dh = develop_hash(settings);
    dir.join(format!("{base_dh}-{key}-{}.jpg", &dh[..16]))
}

/// The base hash a thumbnail file name starts with.
fn base_of(name: &str) -> Option<&str> {
    let base = name.get(..64)?;
    (base.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && name.as_bytes().get(64) == Some(&b'-')
        && name.ends_with(".jpg"))
    .then_some(base)
}

/// The thumbnails of `items` already in `dir` (a hit counts as a use for pruning); `None` where one must be rendered.
pub fn cached_thumbs(dir: &Path, base_dh: &str, items: &[LookThumbItem]) -> Vec<Option<LookThumb>> {
    items
        .iter()
        .map(|item| {
            let key = preset_key(&item.preset_id)?;
            let file = thumb_file(dir, base_dh, &key, &item.settings);
            if !file.is_file() {
                return None;
            }
            let _ = fs::File::options().append(true).open(&file).and_then(|f| f.set_modified(SystemTime::now()));
            Some(LookThumb {
                preset_id: item.preset_id.clone(),
                path: Some(file.to_string_lossy().into_owned()),
                error: None,
                cached: true,
            })
        })
        .collect()
}

/// The working image resized so that the photo's crop (`geometry`) comes out at [`LOOK_EDGE`] on its long edge (never
/// above the working size), the AI mask rasters carried over: ready to render each look.
fn small_developer(proxy: &Developer, geometry: &photobook_develop::settings::Geometry) -> Result<Developer> {
    let (w, h) = proxy.size();
    let (dw, dh) = proxy.developed_size(geometry);
    let scale = (LOOK_EDGE as f64 / dw.max(dh).max(1) as f64).min(1.0);
    let (tw, th) = ((w as f64 * scale).round() as u32, (h as f64 * scale).round() as u32);
    let small = photobook_develop::decode::resize_linear(proxy.image().clone(), tw.max(1), th.max(1))?;
    let developer = Developer::new(small);
    developer.set_ai_rasters(proxy.ai_rasters());
    Ok(developer)
}

/// What a render holds while it runs (the editor's render permit), so previews interleave with a long strip.
pub type RenderGuard = Option<tokio::sync::OwnedSemaphorePermit>;

/// Render the `items` that are not cached into `dir` from `proxy`, reporting each thumbnail (cached or rendered) to
/// `emit` in item order. `stale` is asked before each render: once it says yes the rest are left out. `gate` is called
/// before each render and its guard held for that render only. Prunes old bases and older versions of the same look
/// afterwards. No Tauri state: unit-tested below.
pub fn render_thumbs_into(
    dir: &Path,
    proxy: &Developer,
    base_dh: &str,
    items: &[LookThumbItem],
    stale: &dyn Fn() -> bool,
    gate: &mut dyn FnMut() -> Result<RenderGuard>,
    emit: &mut dyn FnMut(&LookThumb),
) -> Result<Vec<LookThumb>> {
    fs::create_dir_all(dir).ctx(format!("creating {}", dir.display()))?;
    let cached = cached_thumbs(dir, base_dh, items);
    let mut small: Option<Developer> = None;
    let mut out = Vec::with_capacity(items.len());
    for (item, hit) in items.iter().zip(cached) {
        let thumb = match hit {
            Some(hit) => hit,
            None => {
                let _guard = gate()?;
                if stale() {
                    break;
                }
                render_one(dir, proxy, &mut small, base_dh, item)
            }
        };
        emit(&thumb);
        out.push(thumb);
    }
    prune_looks(dir, KEEP_BASES, base_dh, items);
    Ok(out)
}

fn render_one(
    dir: &Path,
    proxy: &Developer,
    small: &mut Option<Developer>,
    base_dh: &str,
    item: &LookThumbItem,
) -> LookThumb {
    let result = (|| -> Result<PathBuf> {
        let key = preset_key(&item.preset_id)
            .ok_or_else(|| Error::Invalid(format!("Invalid look id {:?}", item.preset_id)))?;
        if small.is_none() {
            *small = Some(small_developer(proxy, &item.settings.geometry)?);
        }
        let developer = small.as_ref().expect("set above");
        let options = render_options(developer.image(), OutputProfile::Srgb);
        let rendered = developer.render_with(&item.settings, &options);
        let file = thumb_file(dir, base_dh, &key, &item.settings);
        write_atomic(&file, &encode_jpeg_as(&rendered, LOOK_QUALITY, OutputProfile::Srgb)?)?;
        Ok(file)
    })();
    match result {
        Ok(file) => LookThumb {
            preset_id: item.preset_id.clone(),
            path: Some(file.to_string_lossy().into_owned()),
            error: None,
            cached: false,
        },
        Err(err) => LookThumb { preset_id: item.preset_id.clone(), path: None, error: Some(err.to_string()), cached: false },
    }
}

/// Keep the thumbnails of the `keep` most recently used bases (newest mtime among a base's files) and, within
/// `current`, only the file each of `items` names (an edited look's older thumbnail goes). Best effort.
pub fn prune_looks(dir: &Path, keep: usize, current: &str, items: &[LookThumbItem]) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let wanted: HashSet<PathBuf> = items
        .iter()
        .filter_map(|item| Some(thumb_file(dir, current, &preset_key(&item.preset_id)?, &item.settings)))
        .collect();
    let keys: Vec<String> = items.iter().filter_map(|item| preset_key(&item.preset_id)).collect();
    let mut groups: Vec<(String, SystemTime, Vec<PathBuf>)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(base) = base_of(&name) else { continue };
        let path = entry.path();
        if base == current && !wanted.contains(&path) {
            // `<base>-<key>-<dh16>.jpg`: another version of a look asked for now.
            let rest = &name[65..name.len() - 4];
            if rest.len() > 17 && keys.iter().any(|k| rest.len() == k.len() + 17 && rest.starts_with(k.as_str())) {
                let _ = fs::remove_file(&path);
                continue;
            }
        }
        let mtime = entry.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
        match groups.iter_mut().find(|g| g.0 == base) {
            Some(group) => {
                group.1 = group.1.max(mtime);
                group.2.push(path);
            }
            None => groups.push((base.to_string(), mtime, vec![path])),
        }
    }
    groups.sort_by(|a, b| b.1.cmp(&a.1));
    for (base, _, paths) in groups.into_iter().skip(keep) {
        if base == current {
            continue;
        }
        for path in paths {
            let _ = fs::remove_file(path);
        }
    }
}

/// Thumbnails of the photo with each look (see the module docs). Returns them in `looks` order; each also arrives on
/// `develop:look-thumb` `{ job, presetId, path?, error?, cached }` as soon as it is ready. A newer `job` (ids must
/// increase) stops this one before its next render, so its result may be shorter than `looks`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn render_look_thumbs<R: Runtime>(
    app: AppHandle<R>,
    folder: String,
    rel_path: String,
    hash: String,
    base: DevelopSettings,
    looks: Vec<LookThumbItem>,
    job: u64,
) -> Result<Vec<LookThumb>> {
    if looks.len() > MAX_LOOKS {
        return Err(Error::Invalid(format!(
            "Too many looks for one strip ({}): thumbnails are made for at most {MAX_LOOKS} at a time",
            looks.len()
        )));
    }
    LOOK_JOB.fetch_max(job, Ordering::SeqCst);
    let root = source_root(&app, &folder)?;
    let src = resolve_rel(&app, &root, &rel_path)?;
    let entry_dir = ensure_allowed(&app, cache_entry_dir(&cache_root(&app)?, &hash)?)?;
    let dir = entry_dir.join(LOOKS_DIR);
    let base_dh = base_hash(&base);
    let start = Instant::now();
    let emit_one = |thumb: &LookThumb| {
        let _ = app.emit(EVENT_LOOK_THUMB, LookThumbEvent { job, thumb });
    };
    // All cached: no permit, no decode.
    let hits = cached_thumbs(&dir, &base_dh, &looks);
    if hits.iter().all(Option::is_some) {
        let thumbs: Vec<LookThumb> = hits.into_iter().flatten().collect();
        thumbs.iter().for_each(emit_one);
        log::info!("[photobook:develop] look thumbs n={} cached={} in {}ms", thumbs.len(), thumbs.len(), ms(start));
        return Ok(thumbs);
    }
    // The decode holds a render permit; then each look takes one for its own render only, so a slider's preview
    // waits for at most one thumbnail, not for the whole strip.
    let permit = render_permit(&app).await?;
    let stale = move || LOOK_JOB.load(Ordering::SeqCst) != job;
    if stale() {
        return Ok(Vec::new());
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let decode_start = Instant::now();
        let choice = choose_input(&entry_dir, &base);
        let decoded_proxy = app2.state::<DevelopJobs>().developer_with(&hash, &entry_dir, &src, false, Some(&choice.input));
        drop(permit);
        let (developer, decoded) = decoded_proxy?;
        let decode = ms(decode_start);
        let mut gate = || -> Result<RenderGuard> { Ok(Some(tauri::async_runtime::block_on(render_permit(&app2))?)) };
        let render_start = Instant::now();
        let mut emit = |thumb: &LookThumb| {
            let _ = app2.emit(EVENT_LOOK_THUMB, LookThumbEvent { job, thumb });
        };
        let thumbs = render_thumbs_into(&dir, &developer, &base_dh, &looks, &stale, &mut gate, &mut emit)?;
        let rendered = thumbs.iter().filter(|t| !t.cached && t.path.is_some()).count();
        log::info!(
            "[photobook:develop] look thumbs n={} rendered={rendered} cached={} decode={decode}ms{} render={}ms total={}ms ({rel_path})",
            thumbs.len(),
            thumbs.iter().filter(|t| t.cached).count(),
            if decoded { "" } else { " (reused)" },
            ms(render_start),
            ms(start)
        );
        Ok(thumbs)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn proxy() -> Developer {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/sample-trip/DSCF1000.jpg");
        Developer::new(decode_file(&src, Some(PROXY_EDGE)).unwrap())
    }

    fn settings(json: &str) -> DevelopSettings {
        serde_json::from_str(json).unwrap()
    }

    /// Twelve looks over `base` (exposure 0.3), each a different grain / vignette / grading / saturation mix.
    fn looks() -> Vec<LookThumbItem> {
        let mut items = vec![LookThumbItem {
            preset_id: "none".into(),
            settings: settings(r#"{"version":1,"light":{"exposure":0.3}}"#),
        }];
        for i in 0..11 {
            let json = format!(
                r#"{{"version":1,"light":{{"exposure":0.3}},"color":{{"saturation":{}}},"effects":{{"grain":{{"amount":{}}},"vignette":{{"amount":{}}},"grading":{{"shadows":{{"hue":{},"saturation":30}}}}}}}}"#,
                -40 + i * 7,
                i * 5,
                -i * 6,
                i * 30
            );
            items.push(LookThumbItem { preset_id: format!("01J9ZK3Y8M0Q4R5T6V7W8X9Y{:02}", i), settings: settings(&json) });
        }
        items[3].preset_id = "builtin:warm-negative".into();
        items
    }

    #[test]
    fn keys_and_names() {
        assert_eq!(preset_key("builtin:warm-negative").as_deref(), Some("builtin_warm-negative"));
        assert_eq!(preset_key("01J9ZK3Y8M0Q4R5T6V7W8X9YAB").as_deref(), Some("01J9ZK3Y8M0Q4R5T6V7W8X9YAB"));
        assert!(preset_key("../x").is_none());
        assert!(preset_key("").is_none());
        assert!(preset_key(&"a".repeat(65)).is_none());
        let base = settings(r#"{"version":1,"light":{"exposure":0.3}}"#);
        let with_look = settings(
            r#"{"version":1,"light":{"exposure":0.3},"effects":{"grain":{"amount":20}},"look":{"lut":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"x"}}}"#,
        );
        assert_eq!(base_hash(&base), base_hash(&with_look), "the look is not part of the base");
        assert_eq!(base_hash(&base), develop_hash(&base));
        assert_eq!(base_of(&format!("{}-none-0123456789abcdef.jpg", "ab".repeat(32))), Some("ab".repeat(32).as_str()));
        assert_eq!(base_of("notes.jpg"), None);
    }

    #[test]
    fn renders_once_then_hits_the_cache_and_prunes_old_bases() {
        let dir = tempfile::tempdir().unwrap();
        let looks_dir = dir.path().join(LOOKS_DIR);
        let proxy = proxy();
        let items = looks();
        let base_dh = base_hash(&items[0].settings);
        let mut events = Vec::new();
        let first = render_thumbs_into(&looks_dir, &proxy, &base_dh, &items, &|| false, &mut || Ok(None), &mut |t| events.push(t.clone())).unwrap();
        assert_eq!(first.len(), items.len());
        assert_eq!(events, first, "one event per thumbnail, in order");
        assert!(first.iter().all(|t| !t.cached && t.error.is_none()), "{first:?}");
        let path = PathBuf::from(first[3].path.clone().unwrap());
        assert!(path.file_name().unwrap().to_string_lossy().contains("-builtin_warm-negative-"));
        let (w, h) = jpeg_size(&path);
        assert_eq!(w.max(h), LOOK_EDGE);
        // Different looks give different pictures.
        assert_ne!(fs::read(&first[0].path.clone().unwrap()).unwrap(), fs::read(&first[11].path.clone().unwrap()).unwrap());

        // Reopen: every thumbnail is a cache hit, nothing is rendered (a stale job would stop any render).
        let again = render_thumbs_into(&looks_dir, &proxy, &base_dh, &items, &|| true, &mut || Ok(None), &mut |_| {}).unwrap();
        assert_eq!(again.len(), items.len());
        assert!(again.iter().all(|t| t.cached));
        assert_eq!(again.iter().map(|t| t.path.clone()).collect::<Vec<_>>(), first.iter().map(|t| t.path.clone()).collect::<Vec<_>>());

        // An edited look (same id, other values) renders anew and its old file goes.
        let mut edited = items.clone();
        edited[5].settings.effects.grain.amount = 77.0;
        let third = render_thumbs_into(&looks_dir, &proxy, &base_dh, &edited, &|| false, &mut || Ok(None), &mut |_| {}).unwrap();
        assert!(!third[5].cached && third[4].cached);
        assert!(!Path::new(first[5].path.as_ref().unwrap()).exists());
        assert_eq!(fs::read_dir(&looks_dir).unwrap().count(), items.len());

        // Only the last three bases are kept.
        let mut bases = Vec::new();
        for exposure in [0.1, 0.2, 0.4, 0.5] {
            std::thread::sleep(Duration::from_millis(20));
            let mut moved = items[..2].to_vec();
            for item in &mut moved {
                item.settings.light.exposure = exposure;
            }
            let dh = base_hash(&moved[0].settings);
            render_thumbs_into(&looks_dir, &proxy, &dh, &moved, &|| false, &mut || Ok(None), &mut |_| {}).unwrap();
            bases.push(dh);
        }
        let left: HashSet<String> = fs::read_dir(&looks_dir)
            .unwrap()
            .map(|e| base_of(&e.unwrap().file_name().to_string_lossy()).unwrap().to_string())
            .collect();
        assert_eq!(left, bases[1..].iter().cloned().collect::<HashSet<_>>());
    }

    #[test]
    fn a_cropped_photo_gets_a_full_size_thumbnail_of_its_crop() {
        let dir = tempfile::tempdir().unwrap();
        let proxy = proxy();
        let crop = settings(
            r#"{"version":1,"geometry":{"crop":{"rect":{"x":0.25,"y":0.25,"w":0.5,"h":0.5},"angle":0}}}"#,
        );
        let items = vec![LookThumbItem { preset_id: "none".into(), settings: crop.clone() }];
        let base_dh = base_hash(&crop);
        let mut gated = 0;
        let out = render_thumbs_into(dir.path(), &proxy, &base_dh, &items, &|| false, &mut || { gated += 1; Ok(None) }, &mut |_| {})
            .unwrap();
        assert_eq!(gated, 1, "one gate per render");
        let (w, h) = jpeg_size(Path::new(out[0].path.as_ref().unwrap()));
        assert!((w.max(h) as i64 - LOOK_EDGE as i64).abs() <= 2, "{w}x{h}");
    }

    #[test]
    fn a_stale_job_stops_before_the_next_render() {
        let dir = tempfile::tempdir().unwrap();
        let proxy = proxy();
        let items = looks();
        let base_dh = base_hash(&items[0].settings);
        let calls = std::cell::Cell::new(0);
        let stale = || {
            calls.set(calls.get() + 1);
            calls.get() > 2
        };
        let out = render_thumbs_into(dir.path(), &proxy, &base_dh, &items, &stale, &mut || Ok(None), &mut |_| {}).unwrap();
        assert_eq!(out.len(), 2);
    }

    /// Plan 20's check: 12 looks on a proxy in under 300 ms. Run with
    /// `cargo test --lib looks::tests::timing_twelve_looks -- --ignored --nocapture` (add `--release` for a real number).
    #[test]
    #[ignore]
    fn timing_twelve_looks() {
        let proxy = proxy();
        let items = looks();
        let base_dh = base_hash(&items[0].settings);
        let mut times = Vec::new();
        for _ in 0..5 {
            let dir = tempfile::tempdir().unwrap();
            let start = Instant::now();
            let out = render_thumbs_into(dir.path(), &proxy, &base_dh, &items, &|| false, &mut || Ok(None), &mut |_| {}).unwrap();
            assert_eq!(out.len(), 12);
            times.push(start.elapsed().as_millis());
        }
        let dir = tempfile::tempdir().unwrap();
        render_thumbs_into(dir.path(), &proxy, &base_dh, &items, &|| false, &mut || Ok(None), &mut |_| {}).unwrap();
        let start = Instant::now();
        render_thumbs_into(dir.path(), &proxy, &base_dh, &items, &|| false, &mut || Ok(None), &mut |_| {}).unwrap();
        let hit = start.elapsed().as_millis();
        times.sort();
        eprintln!(
            "[photobook:develop] look thumbs timing: 12 looks on a {}x{} proxy, runs {times:?} ms (median {} ms), cache hit {hit} ms",
            proxy.size().0,
            proxy.size().1,
            times[times.len() / 2]
        );
    }

    fn jpeg_size(path: &Path) -> (u32, u32) {
        let header = turbojpeg::read_header(&fs::read(path).unwrap()).unwrap();
        (header.width as u32, header.height as u32)
    }
}
