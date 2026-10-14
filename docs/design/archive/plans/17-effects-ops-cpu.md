# 17 · Effects ops on the CPU

Status: done 2026-10-13. Schema `effects` (one block in `develop/schema.ts`, `prefault`) and the serde mirror; the
develop hash leaves the section out while it equals its defaults (TS `HASH_OPTIONAL_SECTIONS` / `hashableDevelop`,
Rust `skip_serializing_if = "Effects::is_default"`; the "canonicaliser skips default sections" the plan assumed did
not exist, so this adds it for `effects` only, and plan 18 can add `look` to the same list). The five existing parity
fixtures are byte-identical (the fixture writer now writes `hashableDevelop(settings)`); one new `effects.json` case.
Ops in `crates/develop/src/ops/{grading,grain,vignette,halation,effects}.rs`; halation's glow is a cached pre-pass in
`local/prepass.rs` (`halation_plane`, LRU of one by `HalationKey`), computed from the decoded image with the
threshold divided by exposure × white-balance grey gain (other tone sliders do not move the glow source). Order:
colour → halation → vignette → display look → output, then after the curves grading → grain → dither; masked rows
get the same effects. Decisions taken: grading is display-referred (after the curves, so the LUT of plan 18 slots in
before it); grain uses one fixed seed, pixel-corner sampling at `(x, y)·2048/long edge` and is monochrome; vignette
is a linear-light gain (±2 EV), not a blend to white or black. Halation and vignette run in scene-linear light
before the RAW display look (the plan's order), so Threshold 75 picks out a different brightness on RAW than on
JPEG. GPU: `gpu::unsupported(settings)` is true only when a pass is active (`EffectsParams::new`; a grain Size with
Amount 0 or a wheel hue at saturation 0 stays on the GPU, while the hash still follows `is_default`), checked by
`supports` in every caller (log line `[photobook:gpu] unsupported: effects ...` at info when the effects change, at
debug for repeats), and `engine::render` refuses too; the editor needed no change since the crate falls back itself (this fallback and its log line were removed in plan 19, which ports the effects to the GPU). UI: `EffectsSection.tsx` (Color grading,
Vignette, Halation, Grain; group and section resets) after Detail; `effects` added to `DEVELOP_SECTION_KEYS`
(presets, also `SECTIONS` in `commands/presets.rs`), Sync and Copy sections, on by default (tests updated:
`sync.test.ts`, `SyncDialog.test.tsx`, `PresetsMenu.test.tsx`, `book.test.ts`). Grain check: a 2048 px render's even
pixels equal a 1024 px render's grain within the 1-level dither over a 200×100 crop (`tests/effects.rs`); at the
real 1600 px proxy against an export the ratio is not an integer, so the grain is the same field sampled at each
size (spread within 10 % at 1600 vs 4000 px, `ops/grain.rs`), not pixel for pixel. Halation
timing (24 MP synthetic scene, release, CPU, best of 3 on a busy machine): 96 ms with halation against 82 ms
without; the pre-pass alone about 8 ms at Radius 30 and 100; all four effects about 0.5 s (grading's Oklab round trip
dominates). Not done: Lightroom XMP import/export of grain, vignette and grading (out of scope); no engine bump.

WORKFLOW_PLAN [4.1](../WORKFLOW_PLAN.md#41-what-the-engine-is-missing) (W5.1). Size: 2 days. Depends on: nothing.

**Goal.** Colour grading, grain, vignette and halation as new ops in the CPU reference pipeline, an `effects`
section in the schema, and a plain Effects section of sliders in the Develop panel so they can be used today.

## Decisions

- Schema `effects` on `DevelopSchema`, every field defaulting to a no-op so `develop_hash` of an untouched photo is
  unchanged (the canonicaliser skips default sections):
  `grading: { shadows, midtones, highlights: { hue 0–360, saturation 0–100 }, blending 0–100 (50), balance −100–100 }`,
  `grain: { amount 0–100, size 0–100 (25), roughness 0–100 (50) }`,
  `vignette: { amount −100–100, midpoint 0–100 (50), feather 0–100 (50), roundness −100–100 }`,
  `halation: { amount 0–100, threshold 0–100 (75), radius 0–100 (30) }`. Calibration is left out.
- Pipeline order: grading after the colour mix (and after the LUT once 18 lands), vignette on L post-crop, halation
  before grain, grain last before output encode. Grain is a hash of `(x, y, seed)` in reference pixels (long edge
  2048) shaped by two octaves, scaled by a midtone weight, so proxy and full render match.
- No engine bump here: new ops are no-ops at defaults. The GPU `Developer` returns `Unsupported` when `effects` is
  non-default and the caller falls back to the CPU until plan 19. (Removed in plan 19.)
- Halation on the CPU uses the reduced-size blur of `local/prepass.rs`; measure a 24 MP full render.

## Steps

1. **TS schema.** `packages/shared/src/develop/schema.ts` `EffectsSchema` with `prefault`; `sections.ts` gains
   `effects`; `sync.ts` section list; `canonical` tests show an untouched photo's hash is unchanged.
2. **Rust.** `settings.rs`/`canonical.rs` mirror; `ops/{grading,grain,vignette,halation}.rs`; `cpu` pipeline wiring;
   unit tests per op (identity at defaults, grain deterministic, vignette symmetric, grading hue wheel at 0 and 180).
3. **Fixtures.** Add effects cases to the parity fixtures (`UPDATE_DEVELOP_FIXTURES=1`), new reference images only
   for the new cases; existing fixtures must not change.
4. **GPU guard.** `gpu` returns `Unsupported` for non-default effects; the editor falls back with a log line.
5. **UI.** `components/develop/EffectsSection.tsx` (four groups, sliders from `Slider.tsx`, the grading wheels as hue +
   saturation sliders for now); registered in `DevelopPanel.tsx`; reset per group.

## Check

- `cargo test -p photobook-develop` (CPU and `PHOTOBOOK_FORCE_CPU=1`), `--no-default-features` still builds.
- Grain identical between the proxy and the full render at the same reference size (test with a crop compare).
- Vitest parity fixtures unchanged for existing cases; Effects section component test.
- Halation full render time noted in the status line.

## Docs

- `docs/DEVELOP.md` Effects; `crates/develop/README.md` ops list.

## Out of scope

LUT (18), WGSL (19), looks UI (20).
