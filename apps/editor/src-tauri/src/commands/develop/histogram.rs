//! The Photo pane's histogram (plan 52, ODDHALLS_LAYOUT_PLAN 3): `histogram(hash, developHash?)` counts the pixels of
//! a photo's cached 1600 px proxy into 256 bins per channel (red, green, blue) and for Rec. 709 luma, so the pane draws
//! RGB over luminance. It reads only the cache, never the source file: `<appdata>/cache/<hash>/proxy.jpg` without a
//! develop hash, `proxy-<developHash>.jpg` with one (the render key: 64 hex digits, `-p3` for a Display P3 render).
//!
//! The counts are cached next to the proxy as `histogram.json` / `histogram-<developHash>.json` (written to a temp name
//! and renamed), so a second call is one small file read; the develop pruning removes a develop hash's histogram with
//! its proxy. Both paths go through `ensure_allowed`. A proxy that does not exist yet is an error the pane shows as
//! "no histogram yet".

use super::*;

/// Bins per channel.
pub const BINS: usize = 256;
/// The cached histogram of the plain `proxy.jpg`.
const PLAIN_FILE: &str = "histogram.json";

/// Drop the cached histogram of `entry_dir`'s plain `proxy.jpg`: `prepare_asset` calls it whenever it writes that proxy
/// anew (a developed proxy's name carries its develop hash, so its histogram never goes stale).
pub(crate) fn forget_plain(entry_dir: &Path) {
    if let Err(err) = fs::remove_file(entry_dir.join(PLAIN_FILE)) {
        if err.kind() != std::io::ErrorKind::NotFound {
            log::info!("[photobook:develop] stale histogram kept in {}: {err}", entry_dir.display());
        }
    }
}

/// The counts of one proxy: 256 bins each for red, green, blue and luma.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Histogram {
    pub r: Vec<u32>,
    pub g: Vec<u32>,
    pub b: Vec<u32>,
    /// Rec. 709 luma of each pixel, rounded to 8 bits.
    pub l: Vec<u32>,
}

/// The histogram of `hash`'s cached proxy (`develop_hash`: its developed proxy), from the cache when counted before.
#[tauri::command]
pub async fn histogram<R: Runtime>(app: AppHandle<R>, hash: String, develop_hash: Option<String>) -> Result<Histogram> {
    let entry = cache_entry_dir(&cache_root(&app)?, &hash)?;
    let allow = move |p: &Path| ensure_allowed(&app, p);
    tauri::async_runtime::spawn_blocking(move || histogram_in(&entry, develop_hash.as_deref(), allow)).await?
}

/// [`histogram`] without an app handle: `allow` scopes each path (`ensure_allowed` in the command).
pub(crate) fn histogram_in(
    entry_dir: &Path,
    develop_hash: Option<&str>,
    allow: impl Fn(&Path) -> Result<PathBuf>,
) -> Result<Histogram> {
    if let Some(key) = develop_hash {
        let hex = key.strip_suffix(OutputProfile::DisplayP3.file_suffix()).unwrap_or(key);
        if !(hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
            return Err(Error::Invalid(format!("Invalid develop hash {key:?}")));
        }
    }
    let (proxy, cached) = match develop_hash {
        Some(key) => (proxy_name(key), format!("histogram-{key}.json")),
        None => (PROXY_FILE.to_string(), PLAIN_FILE.to_string()),
    };
    let cached = allow(&entry_dir.join(cached))?;
    if let Some(found) = fs::read(&cached).ok().and_then(|b| serde_json::from_slice::<Histogram>(&b).ok()) {
        if [&found.r, &found.g, &found.b, &found.l].iter().all(|bins| bins.len() == BINS) {
            return Ok(found);
        }
    }
    let proxy = allow(&entry_dir.join(proxy))?;
    let bytes = fs::read(&proxy).ctx(format!("reading {}", proxy.display()))?;
    let image = turbojpeg::decompress(&bytes, turbojpeg::PixelFormat::RGB)
        .map_err(|err| Error::Invalid(format!("{}: {err}", proxy.display())))?;
    let counted = count(&image.pixels, image.width, image.height, image.pitch);
    let json = serde_json::to_vec(&counted).map_err(|err| Error::Invalid(err.to_string()))?;
    write_atomic(&cached, &json)?;
    Ok(counted)
}

/// Count 8-bit RGB rows (`pitch` bytes apart) into the four channels' bins.
fn count(rgb: &[u8], width: usize, height: usize, pitch: usize) -> Histogram {
    let mut h = Histogram { r: vec![0; BINS], g: vec![0; BINS], b: vec![0; BINS], l: vec![0; BINS] };
    for row in rgb.chunks(pitch.max(1)).take(height) {
        for px in row[..(width * 3).min(row.len())].chunks_exact(3) {
            let (r, g, b) = (px[0] as u32, px[1] as u32, px[2] as u32);
            h.r[r as usize] += 1;
            h.g[g as usize] += 1;
            h.b[b as usize] += 1;
            // 0.2126, 0.7152, 0.0722 in 1/256ths (54 + 183 + 19 = 256), rounded.
            h.l[((54 * r + 183 * g + 19 * b + 128) >> 8) as usize] += 1;
        }
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scope::check_allowed;

    fn write_proxy(path: &Path, width: u32, height: u32) {
        let mut data = Vec::with_capacity((width * height * 3) as usize);
        for y in 0..height {
            for x in 0..width {
                data.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, 128]);
            }
        }
        let image = turbojpeg::Image {
            pixels: data.as_slice(),
            width: width as usize,
            pitch: width as usize * 3,
            height: height as usize,
            format: turbojpeg::PixelFormat::RGB,
        };
        let jpeg = turbojpeg::compress(image, 90, turbojpeg::Subsamp::Sub2x2).unwrap();
        fs::write(path, &*jpeg).unwrap();
    }

    #[test]
    fn counts_every_pixel_per_channel() {
        let h = count(&[255, 0, 0, 0, 0, 0, 255, 255, 255, 9, 9, 9], 2, 2, 6);
        assert_eq!((h.r[255], h.r[0], h.g[255], h.g[0], h.b[0]), (2, 1, 1, 2, 2));
        assert_eq!((h.l[54], h.l[0], h.l[255], h.l[9]), (1, 1, 1, 1));
        // A pitch wider than the row: the padding is not counted.
        let padded = count(&[1, 2, 3, 0, 4, 5, 6, 0], 1, 2, 4);
        assert_eq!(padded.r.iter().sum::<u32>(), 2);
        assert_eq!((padded.r[1], padded.r[4]), (1, 1));
    }

    #[test]
    fn reads_the_proxy_once_then_the_cache_fast() {
        let data = tempfile::tempdir().unwrap();
        let root = data.path().canonicalize().unwrap();
        let entry = root.join("cache").join("ab".repeat(32));
        fs::create_dir_all(&entry).unwrap();
        write_proxy(&entry.join(PROXY_FILE), 1600, 1067);
        let allow = |p: &Path| check_allowed(p, &[], &root);
        let first = histogram_in(&entry, None, allow).unwrap();
        assert_eq!(first.l.iter().map(|&n| n as u64).sum::<u64>(), 1600 * 1067);
        assert!(entry.join("histogram.json").is_file());
        // From the cache, even with the proxy gone; within 20 ms (plan 52's check), 50 ms in a debug build on a busy
        // machine (a decode of this proxy takes longer than either).
        fs::remove_file(entry.join(PROXY_FILE)).unwrap();
        let start = std::time::Instant::now();
        let again = histogram_in(&entry, None, allow).unwrap();
        let took = start.elapsed();
        assert_eq!(again, first);
        let budget = if cfg!(debug_assertions) { 50 } else { 20 };
        assert!(took.as_millis() < budget, "cached histogram took {took:?}");
        // A proxy written anew drops it.
        forget_plain(&entry);
        assert!(!entry.join("histogram.json").exists());
        forget_plain(&entry);

        // A developed proxy has its own file, keyed by the render key.
        let dh = "cd".repeat(32);
        let key = format!("{dh}-p3");
        write_proxy(&entry.join(proxy_name(&key)), 64, 32);
        let developed = histogram_in(&entry, Some(&key), allow).unwrap();
        assert_eq!(developed.r.iter().sum::<u32>(), 64 * 32);
        assert!(entry.join(format!("histogram-{key}.json")).is_file());
        // The develop pruning counts it with its develop hash.
        assert_eq!(develop_hash_of(&format!("histogram-{key}.json")), Some(dh.as_str()));
    }

    #[test]
    fn refuses_paths_out_of_scope_and_bad_keys() {
        let data = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let entry = data.path().canonicalize().unwrap().join("ab".repeat(32));
        fs::create_dir_all(&entry).unwrap();
        write_proxy(&entry.join(PROXY_FILE), 8, 8);
        // The cache entry is not under the app data dir nor an imported folder: refused before any read or write.
        let other = elsewhere.path().canonicalize().unwrap();
        let refused = histogram_in(&entry, None, |p| check_allowed(p, &[], &other));
        assert!(matches!(refused, Err(Error::OutOfScope(_))), "{refused:?}");
        assert!(!entry.join("histogram.json").exists());
        let root = data.path().canonicalize().unwrap();
        for bad in ["../x", "ab", &"g".repeat(64), &format!("{}-p4", "a".repeat(64))] {
            let err = histogram_in(&entry, Some(bad), |p| check_allowed(p, &[], &root));
            assert!(matches!(err, Err(Error::Invalid(_))), "{bad}: {err:?}");
        }
        // No proxy yet: an error, nothing cached.
        fs::remove_file(entry.join(PROXY_FILE)).unwrap();
        assert!(histogram_in(&entry, None, |p| check_allowed(p, &[], &root)).is_err());
        assert!(!entry.join("histogram.json").exists());
    }
}
