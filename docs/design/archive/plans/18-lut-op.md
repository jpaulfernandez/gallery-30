# 18 · 3D LUT op

Status: done 2026-10-13. Schema `look: { lut: { id (64 hex), name, strength 0–100, default 100 } | null }` in
`develop/schema.ts` (own block) and the serde mirror (`Look`, `LutRef`); `look` joined `HASH_OPTIONAL_SECTIONS` and
`skip_serializing_if = "Look::is_default"`, so untouched hashes are unchanged: the six existing parity fixtures are
md5-identical, plus a new `look.json` naming the committed 9³ `crates/develop/tests/fixtures/luts/2a09ead0….cube`.
Rust: `crates/develop/src/lut.rs` (cube parser with `LUT_3D_SIZE` 2–129, `DOMAIN_MIN/MAX` and Resolve's
`LUT_3D_INPUT_RANGE`, 1D refused; HALD conversion; `to_cube`; tetrahedral `Lut3d::apply`; a process-wide store
`set_lut_dir` / `get` / `insert` / `forget` the render reads by id) and `ops/lut.rs` (`LutParams` on
`OutputParams::lut`, applied in `encode_row_with` after the curves, before grading, so masked rows get it;
`missing_lut`). GPU: `PASS_LUT`, a `size³` `rgba32float` 3D texture at binding 14 (the uploaded texture is kept while the
render's `Arc<Lut3d>` is the same, so a slider drag uploads it once) and `lut_apply` in chain.wgsl. Tests
(`tests/lut.rs`, unit tests): identity 33³ within 1/4096 and byte-identical on lisbon IMG_01; a known 2³ LUT;
domain; malformed files; CPU vs GPU on the LUT case at most 1 level (ramp, chart, photo, IMG_01, curves + LUT,
identity) and tiles equal to the whole image; LUT + an active effect falls back to the CPU with the LUT applied.
`cargo test -p photobook-develop` passes on the GPU and with `PHOTOBOOK_FORCE_CPU=1`; `--no-default-features` builds.
Editor: `commands/luts.rs` (`import_lut`, `list_luts`, `delete_lut`, `lut_present`; source must be dialog-picked or
in scope; a `<id>.json` sidecar holds name and size; `init` sets the crate's LUT dir at startup). Ids (review fix):
every import stores the canonical text (`lut::canonical_cube`: no title or comments, LF, six decimals) and the id
is its SHA-256, so CRLF copies, re-commented files and the same HALD under two names dedupe; the first import's
name is kept for identical LUTs; a stored file that is not exactly that text is rewritten on import, presets `SECTIONS` gains `look`;
`lib/tauri.ts` wrappers, `store/luts.ts`, `components/develop/LookSection.tsx` above Effects (picker, Import…,
Strength, "LUT missing: name" with Locate…, Delete LUT file…), `look` in `sections.ts`, Sync, Copy and presets
(on by default in Sync and Copy). Decisions: the LUT runs on the output-encoded values in the output's primaries
(a Display P3 render applies it to P3-encoded values rather than converting to sRGB, which would clip P3 gamut);
output clamped to 0..1 after the strength blend. Missing file: previews and cached proxies skip the op (logged
once per id; cached meta records `missingLut`, `DevelopRenderMeta.lutMissing`, and the cached render is redone once
the file is back), but full renders and exports (`develop_full_image`) fail with "LUT missing: name …" instead of
writing a render without its look under a key that names it. Locate imports the picked file and re-points the look
to its id (keeping strength), so a different file is accepted. Review fixes: `lut::get`
re-reads a cached LUT when its file is gone or its mtime changed, refuses a file that does not parse or hash to its
id, and remembers failures for 5 s; `lut_present` uses the same check, so the UI and renders agree. When a LUT
comes back (any import, including Locate on the same file, or a check that flips missing to present) `store/luts.ts`
bumps an `epoch` that `usePreview` follows for photos with a LUT, and `refreshLutMissing` (store/assets.ts) drops
and redoes developed renders recorded with `lutMissing`. Publish (`renderBeforePublish`) and Export (the dialog's
Export button) check first and stop with one message listing the photos and their LUTs (`lib/lutPreflight.ts`).
Parser: BOM stripped, `TITLE` read before comments, non-finite domains refused, extra entries stop the parse, HALD
size checked from the header, control characters stripped from names and titles. Tests added: a random 5³ LUT
against a sorted-axis tetrahedral reference (and shown distinct from trilinear), CPU vs GPU on a noise image with a
random LUT; the GPU tolerance on the LUT cases is now max 1 level and mean 0.001. Not done: the manual app check
(import a 33³ cube, 50 %, `publish --dry-run`, delete the file) was not run in the GUI; the new key follows from
the hash tests (`schema.test.ts`, `tests/lut.rs`). No engine bump (plan 19).

WORKFLOW_PLAN [4.1](../WORKFLOW_PLAN.md#41-what-the-engine-is-missing), [4.2](../WORKFLOW_PLAN.md#42-looks-as-a-kind-of-preset) (W5.2).
Size: 2 days. Depends on: 17.

**Goal.** Users bring their own `.cube` or HALD CLUT files; the engine applies them with tetrahedral interpolation
on the CPU and the GPU, with a strength slider.

## Decisions

- Schema `look: { lut: { id: sha256, name, strength 0–100 } | null }` defaulting to `null`.
- Files live in `<appdata>/luts/<sha256>.cube` (HALD PNGs converted to `.cube` on import so the engine reads one
  format). Sizes 2 to 129 accepted; 1D LUTs rejected with a message. `LUT_3D_SIZE`, `DOMAIN_MIN/MAX` honoured.
- Applied in display-referred sRGB-encoded space after the tone curve and colour mix, before grading; strength is a
  lerp with the input.
- A missing LUT file: the op is skipped, the render carries a warning, the Look section shows "LUT missing: name"
  with Locate. The develop hash still includes the LUT id, so renders stay distinct.

## Steps

1. **Rust.** `crates/develop/src/lut.rs`: parser (cube, HALD), `Lut3d { size, data }`, tetrahedral `apply`, tests
   (identity 33³ within 1/4096, a known 2³ LUT, malformed files). `ops/lut.rs` in the CPU pipeline; `gpu`: the LUT as
   a 3D texture and WGSL tetrahedral sampling; parity test.
2. **Commands.** `commands/luts.rs`: `import_lut(path) -> { id, name, size }`, `list_luts`, `delete_lut`, `lut_present(id)`.
   Scope: the picked file (dialog) in, app data out.
3. **TS.** Schema and `sections.ts`; `lib/tauri.ts` wrappers; `store/luts.ts`.
4. **UI.** `components/develop/LookSection.tsx` (shares the panel slot with 17's Effects, above it): LUT picker with
   Import…, strength slider, missing state. Plan 20 grows this into the Looks strip.
5. **Fixtures.** One LUT case in the parity fixtures with a small LUT committed under `fixtures/`.

## Check

- `cargo test` CPU and GPU parity on the LUT case; the identity LUT is a no-op on the lisbon fixture.
- Import a 33³ `.cube`, apply at 50 %, publish `--dry-run` shows a new key; delete the LUT file, render warns.

## Docs

- `docs/DEVELOP.md` LUTs; `CLAUDE.md` caches (`<appdata>/luts/`).
