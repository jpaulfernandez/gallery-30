# 38 · Index: capture time and photo stats

Status: done 2026-10-13. Landed: `crates/develop/src/stats.rs` (`photo_stats` over an 8 × 8 tile grid, `luma`,
`phash` through `image_hasher` 3.1, no feature) and `camera_meta.rs` `taken` / `lens` / `focal` / `serial`
(`taken_ms`; rawler fallback for CR3 and RAF); `PhotoFacts { taken, make, model, lens, focal, phash, stats }` in
`commands/assets.rs`, `#[serde(flatten)]` into `AssetInfo`, `ScannedFile` and `folders::IndexEntry` (`apply_index`
copies it), mirrored in `lib/tauri.ts` (`PhotoFacts`, `PhotoStats`, extended by `IndexEntry`, `ScannedFile`,
`AssetInfo`, `PhotoFile`); `prepare` computes hash and stats on the upright proxy pixels in memory (JPEG, PNG,
HEIC, both RAW paths), `cached()` backfills a `meta.json` whose `factsVersion` is below `FACTS_VERSION` (1) or lacks
`phash` / `stats` from the source's Exif and the cached `proxy.jpg`, and rewrites it; `PHOTO_FACT_KEYS`,
`photoFacts` and `captureTime` in `store/library.ts` (prepare patch, `indexOf`, `indexText`, `photoEntry`,
`loadIndex`); `libraryKeys` and the Design filmstrip (`components/filmstrip/visible.ts`) sort by `taken ?? mtime`;
`photobook stats <folder> [--json]` (`packages/publish/src/stats.ts`); eight synthetic fixtures and `reference.json`
in `crates/develop/tests/fixtures/stats/` from `scripts/make-stats-fixtures.py`, checked by `--test stats`. Index and
library stay at version 1; no engine bump. **Timing** (`prepare_timing_lisbon`, ignored test in `assets.rs`: cold
`prepare` of the 16 `fixtures/lisbon-demo` JPEGs one at a time, best of three, M-series, another agent's build
running at times): before 59.2 / 59.9 / 60.8 ms a photo, after 70.2 / 70.4 / 71.8 / 74.4 ms, so about +11 ms, under
the +20 ms rule: stats stay in the same pass. Deviations: `sharpestTile` lives inside `stats`; `motion` is
`1 − λmin / λmax` of the summed unit-trace tile tensors (the coherence form put the panned fixture at 0.599);
`phash` is Median + DCT (Mean + DCT let the DC term set nearly every bit alike) over a 64 × 64 box average; `taken`
is the camera clock read as UTC (offset tags ignored), so a photo with `taken` and one sorted by mtime can be off by
the time zone; `serial` is in `meta.json` only, not the index (section 4's list); the sharpness ranking is checked
over the six frames of one scene (the silhouette is another scene whose hard edge is legitimately sharper); one
test line in `commands/noise.rs` follows `make` / `model` into `info.facts`. Not verified: a CR3 or RAF (rawler's
date and lens fields; the CR2 path is covered by the ON1 sample test), a real folder in the running editor (no
`tauri dev` during wave 1), the backfill cost on a large old cache (one proxy decode plus stats a photo, once).
Review fixes (same day): a malformed `SubSecTimeOriginal` keeps the whole-second `taken`; `prepare_asset` reads the
cache permit-free only when `meta.json` needs no backfill (`cached_current`), so the backfill's proxy decode runs
under the `prepare` permit; a test parses an index as the webview writes it (integer `focal`, absent fields).
Follow-ups (not done): the `dateRange` filter in `store/collections.ts` still compares mtime, not `captureTime`;
`is_complete` now requires `taken`, so a TIFF-based RAW whose Exif lacks a date is also read through rawler.

CULL_PLAN [7 (38)](../../CULL_PLAN.md#38--capture-time-and-photo-stats-in-the-index), data in [CULL_PLAN 5](../../CULL_PLAN.md#5-data). Depends on: —

Size: 1.5 days. Depends on: nothing new (plans 02, 05, 23).

**Goal.** Every prepared photo records when it was taken, with what, a perceptual hash and six technical numbers, in
the folder index, so grouping and lenses are pure functions over the index.

**Decisions.** Stats are computed in `prepare` on the 8-bit proxy already in memory (RAW through `prepare_raw`'s
proxy too), about 10 to 15 ms a photo, in the same pass that encodes the thumbnail; nothing is decoded twice. A cache
hit (`cached()`) without stats in `meta.json` recomputes them from the cached `proxy.jpg`. `taken` uses `kamadak-exif`
(already a dependency); the hash uses the `image_hasher` crate (MIT / Apache-2.0), DCT 8×8. Sorting by *time* uses
`taken` when present, else mtime, in both `libraryKeys` and the Design filmstrip.

**Steps.**
1. Rust `crates/develop/src/stats.rs` (no Tauri): `photo_stats(gray: &[u8], rgb: &[u8], w, h, sigma: Option<f32>) ->
   PhotoStats` (tile Laplacian variance with noise correction, structure-tensor anisotropy, histogram clip shares and
   median) and `phash(gray, w, h) -> u64`; `camera_meta.rs` gains `taken`, `lens`, `focal`, `serial`.
2. `commands/assets.rs`: `Meta` and `AssetInfo` carry `taken`, `lens`, `focal`, `phash`, `stats`; `prepare` fills them;
   `cached()` backfills from `proxy.jpg` when `meta.json` predates the field.
3. `IndexEntry` (Rust and `lib/tauri.ts`), `PhotoFile`, the prepare patch in `store/library.ts` and `indexOf` carry the
   new fields; `scan_folder`'s `apply_index` keeps them on an unchanged file.
4. `libraryKeys` and the filmstrip sort by `taken ?? mtime`.
5. A `photobook stats <folder>` CLI subcommand (debug) prints the fields for a folder.

**Check.** Fixture photos under `crates/develop/tests/fixtures/` (a sharp, a defocused, a motion-blurred, a bokeh
portrait, a blown and a dark frame): the sharp ranks above the others on `sharpnessMax`, the portrait is not below the
defocused one, motion > 0.6 only on the panned frame, clip shares within 1 % of a Python reference; a JPEG with
`SubSecTimeOriginal "05"` yields `taken` ending in 050 ms; `cargo check --no-default-features` builds; a folder scanned
by the previous version gains the fields on the next prepare without a rescan (Vitest on the patch path).

**Docs.** `CLAUDE.md` index fields; `crates/develop/README.md` stats module.
