# 11 · Export from Develop: core

Status: done 2026-10-13, with these deviations. There is no Cull batch bar and no help overlay: Export… is a Develop
batch bar slot (order 60, the selection or else the photo shown), an item of the Cull grid's right-click menu, and a
right-click menu on sidebar folders and built-in collections (an item in a saved collection's menu); Cmd+Shift+E is one
window listener installed from `main.tsx` (`components/export/entryPoints.tsx`: the photo Develop shows, else the Cull
selection or the focused photo), documented in `CULL_KEYS`, the README's Cull keys and DEVELOP.md's Keys. The export
develops at full resolution exactly as `render_develop_full` (`develop_full_image`, extracted from `render_full_file`
in `commands/develop.rs`, which also had five items made `pub(crate)`), then fits the 8-bit output with Lanczos3 and
sharpens it; `render_to_size`, the output sharpening and the PNG/WebP encoders live in a new
`crates/develop/src/export.rs`, not `render.rs`. WebP is lossy libwebp through the `webp` 0.3 crate (vendored C built
with `cc`; `--no-default-features` still builds), wrapped by hand in a `VP8X` container with an `ICCP` chunk; PNG
carries `iCCP`; WebP is limited to 16383 px a side. Metadata is already `all` / `copyright` (Copyright and Artist
rewritten with kamadak-exif, also read from TIFF-based RAW) / `none`, JPEG only; the schema and Rust accept Display P3
but the dialog does not offer it (plan 12). Output sharpening is Off/Low/Standard/High (the sharpen op on `log2 Y` with
σ 0.6–0.7 output px); the built-ins Social and Web use Low (the plan did not say); Custom is JPEG 90 at the developed
size with all metadata. `presetHash` is 16 hex digits of SHA-256 over the canonical parsed options plus
`EXPORT_ENGINE_VERSION` (`export/1`), computed in TS and recomputed in Rust; the cache keeps the 3 newest develop hashes
per photo and preset hash. Progress is `export:progress` with a stage (decode, render, encode, copy), not items, since a
job is one photo; cancel reuses `cancel_develop` and its job-id set. A photo with denoise on waits for its denoise job
(joined when queued) and Rust never caches a render made without its intermediate. "Already exported" is the cache
entry's size and a destination written after the entry (2 s slack for exFAT). `{seq}` pads to at least three digits, `{date}` is the file time until EXIF
dates are read, and a name repeated in one folder gets ` 2`, ` 3`. A custom destination is checked with the dialog's fs
scope (`check_export_dest`), never added as a root, so a remembered one outside the imported folders must be picked
again after a restart (the dialog says so). Reveal is `reveal_export` (`open -R`, macOS only; there is no opener
plugin). Cmd+Shift+E opens on the last preset used, not on unsaved changes to it. Checked by Rust tests (a Full
quality export is byte for byte the `render_develop_full` file; twelve photos re-exported after editing three encode
three and skip nine, a deleted destination is copied from the cache; a cancel after the decode or the render leaves no
file; presets round-trip through `export-presets/`; PNG and WebP decode back with their profile; the Exif options read
back) and Vitest (naming tokens, preset hash, preset JSON round trip, planning, the jobs, the dialog, the shortcut).
Not run: an in-app smoke test of the dialog (no screen in this session). After review: `scan` skips a folder's
top-level `Exports/` (exports never come back as photos); `export_status` reports `replaces` (a destination file that
is not an export of that photo: an earlier export of it with another edit does not count), the dialog says "N existing
files will be replaced" and keeps Export off until Replace is ticked, and `export_photo` refuses to overwrite such a
file without `replace`; export jobs are deduped by preset hash, cache entry and destination, and each run keeps its
own toast; `export_photo` recomputes the preset hash (`photobook_develop::export::preset_hash`, pinned to the same
values as the TS tests) and refuses a mismatch, and the hash leaves out PNG quality and PNG/WebP metadata; the cancel
is also checked before the decode; Reveal always passes `-R`; pruning never removes the entry just written and a
cache entry gone before its copy is encoded again; a libwebp failure is an error, not a panic; *All* metadata from a
RAW or PNG source is rewritten through kamadak-exif (descriptive primary tags, the Exif sub-IFD without the maker note,
GPS); the destination keeps its own time (no longer stamped with the cache entry's); saved preset names are unique.

WORKFLOW_PLAN [14.4](../WORKFLOW_PLAN.md#144-export-from-edit) (W4.0), [2.3](../WORKFLOW_PLAN.md#23-destructive-edits-no).
Size: 2 days. Depends on: 09.

**Goal.** Developed photos leave the app as new files: one dialog with presets, single or bulk, cached so a re-export
after editing three photos re-encodes three files. Formats here: JPEG, PNG, WebP. The rest is plan 12.

## Decisions

- Presets as data: `Social` (2048 px JPEG 88 sRGB, strip EXIF keep copyright), `Web` (1600 px JPEG or WebP 85 sRGB,
  strip), `Full quality` (original size JPEG 95; HEIC and P3 come in 12), `Custom`. Saved in `<appdata>/export-presets/<ULID>.json`.
- Destination default `<folder>/Exports/<preset>/`; naming tokens `{name}`, `{seq}`, `{date}`, `{rating}`.
- Cache `<folder>/.photobook-cache/export/<presetHash>/<hash>-<dh>.<ext>`; the exported file is a copy of the cache
  entry; "skip photos already exported with these settings" compares the destination file's size and mtime.
- Output sharpening for screen reuses the output sharpen op at the target size.
- Rust owns resize and encode: `render` + `fast_image_resize` + `turbojpeg`/`png`/`webp` crates; no `sharp`.

## Steps

1. **Shared.** `packages/shared/src/export.ts`: `ExportPresetSchema`, built-ins, `presetHash`, `fileName(pattern, ctx)`.
2. **Rust.** `commands/export.rs`: `export_photo(folderId, path, hash, settings, preset, destDir, name, job)` with
   `develop:progress`-style events, cancel via the existing job token; temp + rename; `reveal_in_finder(path)`
   (opener plugin). `crates/develop/src/render.rs` gains `render_to_size(long_edge)` and WebP/PNG encode.
3. **Store and queue.** `lib/jobs/export.ts` enqueues one job per photo (concurrency 2); results collected for the
   completion toast with Reveal.
4. **Dialog.** `components/export/ExportDialog.tsx` (Cmd+Shift+E): preset list with Save/Delete, the common options,
   a count ("12 photos, 3 already exported"), Export. Opens from Develop (open photo), the Cull batch bar (selection),
   a collection or a folder in the sidebar.
5. **Keys and menu.** Cmd+Shift+E in Develop and Cull; the help overlay.

## Check

- Exported JPEGs match the publish renders pixel-for-pixel at the same size (Vitest in `packages/publish` or a Rust
  test comparing against `render_develop_full`).
- Re-export after editing three of twelve photos re-encodes three (log lines count); cancel mid-way leaves no partial.
- Naming tokens tested; a preset round-trips through disk.

## Docs

- `docs/DEVELOP.md` Export section; `README.md` features; `CLAUDE.md` caches (`.photobook-cache/export/`).

## Out of scope

AVIF, HEIC, TIFF, watermark, border, EXIF options, Original + sidecar (12).
