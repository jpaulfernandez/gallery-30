# 12 · Export formats and extras

Status: done 2026-10-13, with these deviations. Formats `avif`, `heic`, `tiff` and `original` join `EXPORT_FORMATS` /
`ExportFormat`; the encoders live in `crates/develop/src/export.rs` (plan 11's module, not `render.rs`) and
`export_heic.rs` (ImageIO, `#[path]` submodule, macOS + `heic-imageio` only; `export_capabilities` tells the dialog,
which hides HEIC elsewhere). TIFF and HEIC are developed into 16 bits per channel: the CPU pipeline is now generic over
the output sample (`OutputSample` in `ops/output.rs`, u8 dithered exactly as before, u16 rounded; `develop_with_masks16`,
`render::render_full16_with_options`, the editor's `develop_full_image16`); that render is CPU-only (the GPU writes
8-bit). 8-bit outputs are byte for byte unchanged, so `EXPORT_ENGINE_VERSION` stays `export/1` and the plan 11 hash
test values are unchanged (watermark and border are optional and absent when off; new hash values for a full plan 12
preset and for Original are pinned in both Rust and TS). AVIF is `ravif` 10-bit 4:4:4, speed 6, sRGB only (see
"After review" below). HEIC is ImageIO from
a 16-bit `CGImage` in sRGB or Display P3: 10-bit with an ICC `colr` box (checked by decoding back). TIFF is the `tiff`
crate, RGB16, Deflate + horizontal predictor, the ICC in tag 34675 (UNDEFINED). Metadata: JPEG as plan 11; HEIC *all*
copies the source's TIFF/Exif/GPS/IPTC dictionaries as ImageIO reads them (orientation reset), *copyright* writes
Copyright and Artist; TIFF gets only the descriptive primary TIFF tags (no Exif sub-IFD); PNG/WebP/AVIF profile only.
Watermark (`ops/watermark.rs`): text in the shared WOFF2 fonts unpacked with `wuff` (MIT) and rasterised with
`ab_glyph`, or a PNG imported by `import_watermark` into `<appdata>/watermarks/<sha256>.png` (the preset stores the
hash, so the cache key follows the content; the export checks it); nine positions, size/margin as fractions of the
photo's long edge, opacity, blended on the encoded values. Deviation: sharpening runs before the watermark and the
border (the plan said after), so text and frame edges get no halos. Border: px or percent of the file's long edge;
with a long edge the photo is fitted to the long edge less both borders, so the file keeps the preset's size. Original
+ sidecar is a fifth built-in (format `original`, keeps the source extension, `{name}` tokens as usual): the source is
copied byte for byte, no cache, and `<name>.xmp` holds our packet with the `crs:` packet merged in (new
`xmp::export_sidecar`, sharing `write_xmp_sidecar`'s packet code); skipped when the same bytes and sidecar are there.
Full quality becomes HEIC 10-bit 90, Display P3, all metadata where HEIC can be written (`builtInExportPresets`),
JPEG 95 sRGB elsewhere. Dialog: Format with per-format default quality (JPEG 90, WebP 85, AVIF 70, HEIC 85) and
Colour, Metadata, Watermark, Border as groups collapsed by default with a summary; Display P3 is offered when a photo
is a RAW or HEIC, or the book is Display P3 (a wide-profile JPEG is not detected). Checked by Rust tests (AVIF size and
primaries, decoded by ImageIO on macOS; TIFF 16-bit lossless with its ICC and tags; HEIC 10-bit with its profile and
Copyright/Artist read back with kamadak-exif, skipped off macOS; the 16-bit render matches the 8-bit one; watermark
position and opacity; border size and colour; every font unpacks; export_one for every format; Original copy +
sidecar read back exactly; watermark import) and Vitest (hashes, schemas, dialog groups, Original naming). Not
performed: importing an Original + sidecar export into Lightroom (manual check, no Lightroom here); no in-app smoke
test of the dialog. After review: AVIF is sRGB only (ravif writes BT.709 into the AV1 sequence header and cannot set
other primaries, so the P3 re-wrap with `avif-serialize` was removed along with that dependency; the dialog switches
AVIF to sRGB and Rust refuses AVIF + P3); measured AVIF encode of a 6000 × 4000 photo, quality 70, speed 6, release
build: 23.4 s, and the render permit is now released after the develop, before finish and encode (`export_one`'s
`rendered` callback), so an AVIF encode no longer holds the render lane. The text watermark never exceeds the photo
less its margins (a long line is set smaller until it fits; layout stops at the edge) and is unkerned in practice
(`ab_glyph` reads only a `kern` table; the shared fonts kern through GPOS); the shared WOFF2s are Latin subsets, so
other scripts draw missing glyphs (documented). The watermark PNG is decoded once per run and its scaled overlay
cached by content hash and size (`image_overlay_cached`), and is capped to the photo too. An incomplete watermark (no
text, no image) keeps Export off with a message and `startExport` refuses it before queueing. Original: a sidecar at
the destination that is not this copy's own counts as `replaces` in `export_status` and in `export_original` (needs
Replace); `export_status` takes the settings, orientation and size so "already exported" also means an identical
sidecar; names of an Original export are unique by stem (`uniqueFileNames(names, { byStem })`: `IMG_1.nef` +
`IMG_1.jpg` → `IMG_1.nef`, `IMG_1 2.jpg`). The preset hash leaves out the watermark's `imageName` and the fields of
the kind not in use (`text`/`font`/`colour` for an image, `image` for text); the pinned full-preset value is now
`9c77f4b4907ad2c8` in both Rust and TS (Original's `21d61ae3a1acf283` unchanged). Picking a lossy format resets the
quality to its default unless the old format had a default and the quality differs from it. Collapsed groups show a
chevron; the position buttons are 28 × 24 px.

WORKFLOW_PLAN [14.4](../WORKFLOW_PLAN.md#144-export-from-edit). Size: 1 day. Depends on: 11.

**Goal.** The remaining export formats and options: AVIF, HEIC 10-bit, TIFF 16-bit, Display P3 output, EXIF keep or
strip, watermark, border, and the Original + sidecar hand-off preset.

## Decisions

- AVIF through `ravif`; HEIC through ImageIO behind the `heic-imageio` feature (macOS only; the option is hidden
  elsewhere); TIFF 16-bit through the `tiff` crate from the linear f32 frame.
- EXIF: *keep all*, *strip*, *strip but keep copyright and artist*; written with `img-parts`/`kamadak-exif`
  (JPEG) or ImageIO (HEIC); AVIF and WebP get the ICC profile only.
- Watermark: text (font from the shared fonts, size as a fraction of the long edge) or a PNG, nine positions, opacity;
  border in pixels or percent with a colour. Both are composited in Rust after resize, before output sharpen.
- Original + sidecar: copies the source file and writes `<name>.xmp` with our packet plus the Lightroom-readable tone
  part through the existing `write_xmp_sidecar`.

## Steps

1. `crates/develop/src/render.rs`: encoders for AVIF, TIFF16, HEIC (feature-gated), P3 output selection from the
   project's `outputProfile` or the preset; ICC embedding for each container.
2. `crates/develop/src/ops/watermark.rs` (text rasterised with `ab_glyph`, PNG alpha-composited) and `border`.
3. `commands/export.rs`: EXIF handling, the sidecar preset path, options plumbed from the preset.
4. `ExportDialog`: format picker with per-format quality, Colour (sRGB / Display P3 when the source is wide),
   Metadata, Watermark and Border groups collapsed by default; the `Full quality` built-in gains HEIC 10-bit.

## Check

- Each format decodes back (Rust test) with the expected size and profile; HEIC test skipped off macOS.
- EXIF strip leaves copyright when asked (read back with `kamadak-exif`).
- A sidecar export imports into Lightroom with the same tone sliders (manual check noted in the plan's status).

## Docs

- `docs/DEVELOP.md` Export formats; `docs/INSTALLATION.md` HEIC note.
