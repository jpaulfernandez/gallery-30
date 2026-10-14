# 37 · Tiled full render (next, not started)

WORKFLOW_PLAN [15](../archive/WORKFLOW_PLAN.md#15-platform-stay-on-tauri-measure-then-go-hybrid-if-needed-oct-12-2026)
("Full-render memory: tile the full render on the Rust side"). Size: 2 days. Depends on: 36 (the measurements).
Written by plan 36 because its full-render budget found the problem; nothing here is implemented yet.

**Goal.** A full-resolution render (publish, export, `render_develop_full`) that never holds the whole image at full
precision more than once, so two renders at a time stay well under the editor's 1.5 GB alarm.

## Why

[PLATFORM_BUDGETS.md](../PLATFORM_BUDGETS.md), 2026-10-13: a 22.1 MP CR2 with no edit peaks at a 1.25 GB footprint (median of three runs)
(56 bytes per pixel), 1.73 GB with masks and a crop; 42 MP is 1.92 GB and 50 MP 2.08 GB. The editor runs two full
renders at once (`MAX_RENDERS` in `commands/develop.rs`) plus the export lanes, on top of its own 0.4 GB. Time is not
the problem (0.53 s for 22 MP, of which the RAW decode is 0.37 s).

The GPU path already develops in 2048 px tiles (`gpu::engine::TILE_SIZE`), but around it the whole frame exists several
times: the decoder's buffers, the linear f32 RGB `LinearImage` (12 B/px), the GPU's rgba16float source (8 B/px) and
warp (16 B/px), the 8-bit output (3 B/px) and the JPEG, while the caller (`develop_full_image`) still holds the f32
image during the render.

## Steps

1. Measure per stage before changing anything: a peak-footprint probe (`task_info` `phys_footprint`, or a counting
   allocator in the test) after decode, after upload, after render and after encode, in `budget_full_render_24mp`.
   Write the split into PLATFORM_BUDGETS.md.
2. Free early: give `render_full_with_options` an owned-image variant so the f32 source is dropped once it is on the
   GPU (or once the warp exists); drop the decoder's buffers before the develop starts (`decode_raw` returning only the
   linear image). Expected: about 12 B/px less.
3. Band the GPU input: upload only the source region a tile row needs (the tile plus overlap, mapped back through the
   geometry's inverse for a warp, with the bounding box of the four corners), instead of the whole rgba16float frame
   and its full-size warp. The halation glow and other whole-image pre-passes keep their reduced-size planes.
4. Encode by rows: write the JPEG as tile rows finish (libjpeg-turbo's scanline API; the `turbojpeg` crate only takes
   whole images, so pick a crate or a thin FFI and record the choice), so the 8-bit output is never whole either. TIFF
   and the 16-bit HEIC path keep whole frames unless they can stream too (the `tiff` encoder writes strips).
5. Make the render permit memory-aware: weight `MAX_RENDERS` by megapixels (one 50 MP render, or two up to 24 MP).
6. Keep the CPU reference whole (`develop_with_masks`); the GPU must still match it (`tests/gpu.rs` tiles tests) and
   full renders stay pixel-identical, so no engine bump.

## Check

- `budget_full_render_24mp` peak footprint under 600 MB for the 22 MP file with no edit, and under 900 MB with
  `everything.json`; two concurrent renders under 1.2 GB.
- Full renders byte-identical to before on the ON1 samples and a real project (as plan 19 checked), so the develop
  hash and every cached render stay valid.
- Render time within 10 % of the 2026-10-13 numbers.
