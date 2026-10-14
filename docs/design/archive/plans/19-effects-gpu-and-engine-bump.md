# 19 · Effects GPU port and engine bump

Status: done 2026-10-13. WGSL in `gpu/shaders/chain.wgsl` (`PASS_HALATION`, `PASS_VIGNETTE`, `PASS_GRADING`,
`PASS_GRAIN`; `halation_apply`, `vignette_gain`, `grading_apply`, `grain_apply`) at the CPU's places (halation →
vignette after colour, before the display look; LUT → grading → grain before the dither), on masked and unmasked pixels;
uniform fields filled by `ChainInputs::add_effects` (`gpu/params.rs`). Halation's glow is a whole-image GPU pre-pass:
`cell_mean_excess` (`guided.wgsl`) then the tile planes' blur (`blur_plane`: `convolve` / `box_blur`, factored out of
`TilePlanes::blur`) at the reduced size from `local::prepass::halation_reduction` (new, shared with the CPU), cached per
input image for the last `HalationKey` (counted in `prepass_count`), binding 15, sampled bilinearly, so tiles need no
overlap. Grain uses the CPU's integer lattice hash with both seeds in the prelude (`GRAIN_FINE_SEED` added to
`ops/grain.rs`); only the smootherstep blend is float. `gpu::unsupported` now returns `None` (mechanism kept, `supports`
logs by reason); the effects log line is gone; the editor had no fallback code, only a comment in `EffectsSection.tsx`
(updated). Tests: `tests/gpu.rs` `effects_match_the_cpu` (15 setting sets: each op at both signs and shape extremes,
all four, all four + every control, `effects.json`; on photo, chart, scene 1600, backlit edge; plus the display look,
Display P3, six masked cases, a straighten in both qualities), `effects_with_a_lut_match_the_cpu` (fixture LUT, also at
40 %), `effects_tiles_match_the_whole_image`, `halation_glow_is_cached_on_the_gpu`, ignored `timing_effects_proxy`;
tolerances unchanged (2 / 0.3), measured at most 1 level, worst mean 0.0012, tiles exact. The CPU-fallback tests in
`tests/effects.rs` and `tests/lut.rs` became GPU tests that assert the GPU really rendered (`last_backend`), and `inactive_effects_stay_on_the_gpu` became `inactive_effects_render_on_the_gpu` (no-op effect settings render on the GPU exactly like the defaults); the `unsupported(..).is_none()` asserts, which could no longer fail, are gone. Review additions: parity at vignette Amount +100 / Midpoint 100 / Feather 100, halation Threshold 0 and 100, `halation_cap_on_an_hdr_input_matches_the_cpu` (linear input up to about 20, past `MAX_EXCESS`, thresholds 0/30/100, radius 10/80, and with every effect) and `halation_glow_on_a_warped_input` (a straightened input: parity, then after amount, threshold and exposure changes the cached `Developer` equals a fresh one, one warp); all at most 1 level. Under `PHOTOBOOK_FORCE_CPU=1` every GPU parity test (`tests/gpu.rs`, and the GPU halves of `tests/effects.rs` / `tests/lut.rs`) prints SKIP and passes vacuously: that run only proves the CPU path and the CPU-only tests. Pre-bump check: 17 and 18 changed no existing output: the 38
full renders made under `develop-engine/2` in a real project (`~/Desktop/Cebu`, 4.5–60 MP, 8 of them cropped)
re-rendered pixel-identical with the current code, and their develop hashes recomputed to the ones in the file names;
the bump to `develop-engine/3` (`ENGINE_VERSION`, `DEVELOP_ENGINE_VERSION`) was made anyway per the locked decision.
Fixtures regenerated: the seven parity fixtures change only in the canonical string's suffix and the hash; the
geometry fixtures are byte-identical (they carry no engine version). Publish keys: an untouched JPEG/HEIC keeps its
key (published from the original); an untouched RAW and every edited photo get a new key once, from the engine version
only. Plan 24 (chroma denoise, in flight) may change denoise-on output; it must not need another bump, since the
denoise intermediate is keyed separately (`DENOISE_ENGINE`). Latency (1600 px proxy, every control + all four effects,
M3 Pro under load average ~30, median of 30): GPU about 4 ms per slider change (3–3.6 ms without effects; 4 ms also when
the drag recomputes the glow via threshold or exposure), CPU 140–600 ms across runs (the machine's load varied; the review measured 150–600 ms). The `develop` kernel now binds 12 of the 16 sampled textures a stage gets by default (binding 15 is the glow), so 4 remain for later passes. Deviations: crate tests run with `--release`
(the binaries existed; the disk had filled once during the session), clippy is not installed. Failing at the time,
all in other plans' in-flight code: `ops::noise` unit test and `tests/denoise.rs` chroma test (plan 24), `tests/parity.rs`
on `everything.json` (Rust serialises plan 24's new `chromaMode`, TS has no such field yet; regenerate the fixtures once
24 lands its schema), `@photobook/publish` `publish.test.ts` (`locked` in `site.json`) and `tsc` in
`packages/shared/src/publish/fingerprint.test.ts` (print output kind). Docs: `crates/develop/README.md` (Effects, Look,
GPU Effects bullet, engine version note), `docs/DEVELOP.md` (Effects paragraph, Performance, engine note).

WORKFLOW_PLAN [4.1](../WORKFLOW_PLAN.md#41-what-the-engine-is-missing) (W5.3), [7](../WORKFLOW_PLAN.md#7-decisions-to-lock-before-w11)
(engine version row). Size: 1.5 days. Depends on: 18.

**Goal.** Every op from 17 runs in WGSL and matches the CPU; the `Unsupported` fallback goes away; the engine
version moves to `develop-engine/3` once, and the fixtures are regenerated.

## Decisions

- Tolerances as in `tests/gpu.rs` today; grain uses the same integer hash in WGSL (no float noise), so it is exact.
- Halation on the GPU reuses the blur pre-pass pipeline at reduced size.
- Bump both `ENGINE_VERSION` (`crates/develop/src/lib.rs`) and `DEVELOP_ENGINE_VERSION`
  (`packages/shared/src/develop/schema.ts`) in the same commit, then regenerate:
  `UPDATE_DEVELOP_FIXTURES=1 pnpm --filter @photobook/shared test` and
  `UPDATE_GEOMETRY_FIXTURES=1 cargo test -p photobook-develop --test geometry`.
  Check first whether anything in 17 or 18 changed the output of existing settings; if nothing did, the bump is still
  made per the locked decision (one bump for the looks work) and the reason recorded in the status line.

## Steps

1. WGSL for grading, vignette, halation, grain in `crates/develop/src/gpu/` with the same op order as the CPU.
2. Remove the `Unsupported` guard and the editor fallback log line.
3. `tests/gpu.rs`: parity cases for each op and a combined case with a LUT.
4. Engine bump and fixture regeneration; `crates/develop/README.md` version note.
5. Measure slider latency with all effects on at proxy size; record it.

## Check

- `cargo test -p photobook-develop` with the GPU and with `PHOTOBOOK_FORCE_CPU=1`; `--no-default-features` builds.
- Vitest fixtures pass after regeneration; an untouched photo's publish key changes only because of the engine
  version (expected, once).

## Docs

- `docs/DEVELOP.md` engine note; `CLAUDE.md` Develop convention line unchanged (it already describes the pair).
