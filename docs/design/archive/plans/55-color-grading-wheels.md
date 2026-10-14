# 55 · Color grading wheels

ODDHALLS_LAYOUT_PLAN [7 (55)](../../ODDHALLS_LAYOUT_PLAN.md#7-plans), [4.2](../../ODDHALLS_LAYOUT_PLAN.md#42-color-grading-as-wheels-with-harmony-lock), [8](../../ODDHALLS_LAYOUT_PLAN.md#8-open-questions); IMPLEMENTATION_PLAN_38-56 [section 1](IMPLEMENTATION_PLAN_38-56.md#1-decisions-to-lock-before-wave-1) (Engine bump, Accent, Haptics), [section 4](IMPLEMENTATION_PLAN_38-56.md#4-cross-plan-interfaces) ("Haptics", "Primitives"), [section 8](IMPLEMENTATION_PLAN_38-56.md#8-gates) (the human check) and the wave 7 card. Size: 1.5 days. Depends on: 54 (19 done)

The Layout plan's section 7 has a table row for 55 and no step list of its own; the steps and the Check below are
copied from the sections it names (Layout 4.2, the section 7 row) and the implementation plan's card.

| 55 | **Color grading wheels**: the wheel control, harmony lock (`grading.harmony`), presets, per-wheel luminance (engine bump) | 54, 19 | 1.5 |

### 4.2 Color grading as wheels, with harmony lock

Replaces the hue + saturation sliders per wheel.

- Three **wheels** (Shadows · Midtones · Highlights), 88 px each in a row, a fourth smaller *Global* in Advanced. A
  wheel is a hue ring with a saturation radius: drag the dot (angle = hue, distance = saturation, the schema's
  `GradingWheel { hue, saturation }` unchanged), Shift constrains the hue, Alt the saturation, double-click resets;
  the hue and saturation numbers sit under each wheel in mono and are editable. The luminance offset per wheel is a
  thin slider under the number in Advanced (schema addition, default 0, engine bump with plan 19's).
- **Harmony lock** ▾ above the wheels: *Free · Monochromatic · Complementary · Split complementary · Triadic ·
  Tetradic · Analogous*. With a lock on, the three wheels' hues are tied by the harmony's angles (complementary:
  shadows = highlights + 180°, midtones free; triadic: 120° apart; analogous: ±30°; tetradic: 90°; monochromatic:
  one hue, saturation free); dragging any wheel turns the others with it, and the lock draws the tied angles as thin
  spokes on each ring. The lock is UI state saved with the settings (`grading.harmony`, optional, so old files load)
  and does not change the maths: it only decides what a drag writes.
- **Presets** as chips under the wheels: *Teal & orange · Warm/cool split · Bleach · Golden · Moody blue · Pastel*
  (hue/sat triples with Blending and Balance), authored like the built-in looks and listed in
  `packages/shared/src/develop/grading.ts`.

Implementation plan card. Layout 4.2, 7 (55). Size 1.5.
Owns: `components/develop/GradingWheel.tsx` (new), the harmony lock (`lib/develop/harmony.ts`, new, pure: the
angle constraints per harmony, what a drag writes), the presets in `packages/shared/src/develop/grading.ts` (new),
`EffectsSection.tsx` (wheels in Basic, Global and luminance in Advanced), the schema (`GradingWheelSchema.luminance`
default 0, `GradingSchema.harmony` optional, both no-ops when absent), the maths in `crates/develop/src/ops/`
(luminance offset per wheel, CPU then GPU, verified in `tests/gpu.rs`), and **the engine bump** to
`develop-engine/4` in both places with the parity fixtures regenerated (`UPDATE_DEVELOP_FIXTURES=1`,
`UPDATE_GEOMETRY_FIXTURES=1`) and the fixture renders under `crates/develop/tests/fixtures/` re-reviewed. Added
checks: a settings file with no `harmony` and `luminance` 0 renders byte-identical to engine 3 on the ON1 samples
(so the bump changes nothing but the hash); the harmony lock is UI state and does not appear in the canonical
settings unless set; `cargo check --no-default-features`.

- Check: a settings file with no `harmony` and `luminance` 0 renders byte-identical to engine 3 on the ON1 samples
  (the bump changes nothing but the hash); the harmony lock is UI state and does not appear in the canonical settings
  unless set; dragging under a lock moves the other wheels as `harmony.ts` says, with one `tick('alignment')` per
  angle snap; old settings without `luminance` / `harmony` parse unchanged; the luminance offset matches between the
  CPU and the GPU (`tests/gpu.rs`); `cargo check -p photobook-develop --no-default-features`; the wheels are
  registered in `developCards.ts` (`developCards.test.tsx`); the human check (implementation plan section 8): every
  cached render re-renders once on open, and the ON1 samples look identical.

Status: done 2026-10-14 (the owner's checks pending: every cached render re-renders once on open, and the ON1 samples
look identical in the app). Landed: **schema** (`packages/shared/src/develop/schema.ts`): `GradingWheelSchema.luminance`
(−100..100, default 0), `GradingSchema.global` (a fourth wheel, default 0/0/0) and `GradingSchema.harmony`
(`GRADING_HARMONIES`, optional, absent = Free); `hashableDevelop` leaves `luminance` out at 0, `global` out at its
defaults and `harmony` out always (`hashableEffects`), so settings written before plan 55 hash as before apart from
the engine string; the Rust mirror (`settings.rs`) carries `luminance` and `global` with `skip_serializing_if` and no
`harmony` (serde ignores it). No develop-settings or project version change (`DEVELOP_VERSION` 1, `CURRENT_VERSION` 8):
old settings parse through the Zod defaults. **Maths** (`ops/grading.rs`): `GRADING_LUMINANCE` 0.1 Oklab `L` at
±100 per band weight, the Global wheel's chroma and luminance at weight 1, same fade at black and white, `L` clamped
to 0..1; `GradingParams::extra` is `None` without them, so the engine 3 arithmetic runs unchanged. **GPU**
(`chain.wgsl` `grading_apply_wheels`, uniform `grading_c` / `grading_l` in `params.rs`): a second pipeline
`develop_wheels` (`kernels.rs`, the `GRADING_WHEELS` override constant; `engine.rs` picks it per render) because
Metal's fast math moved engine 3 pixels by a level whenever the plain kernel's code changed (an in-function branch
changed 132 of 396 ON1 digests, a call-site branch 5, including a render without grading); the plain `develop`
pipeline keeps engine 3's code. Parity: `tests/gpu.rs` `grading_wheels_match_the_cpu` (each wheel's luminance at both
signs, the Global wheel, all together, over every control; photo, chart, scene 1600): worst max 1 level, mean 0.0005.
**UI**: `GradingWheel.tsx` (88 px conic ring, angle = hue with 0° red at the right counter-clockwise, radius =
saturation; Shift holds the hue, Alt the saturation, double-click resets, arrows nudge with `data-no-step`; the dot
follows the slider needle, `accent` only on keyboard focus, none on the field; spokes; snaps with one
`tick('alignment')` per snap; hue and saturation as `NumberInput`s), `lib/develop/harmony.ts` (pure: `HARMONY_CHOICES`,
`dragWheel` (what a drag writes: the dragged wheel, plus the tied wheels' hues at the lock's offsets), `alignToHarmony`
(what choosing a lock writes: the tied wheels around the most saturated one), `spokes`, `snapTargets` (the hues of the
wheels that stay put during the drag, the Global wheel while tinted), `snapHue` (±`SNAP_DEGREES` 4°), `tiedWith`,
`normHue`), presets in `packages/shared/src/develop/grading.ts` (`GRADING_PRESETS` Teal & orange · Warm/cool split ·
Bleach · Golden · Moody blue · Pastel, `withGradingPreset`, `matchGradingPreset`), `EffectsSection.tsx` (Harmony lock
`Select`, the three wheels, preset chips in Basic; the new ▸ `effects.wheels` "Luminance, global wheel": a luminance
slider per wheel and the 64 px Global wheel with its luminance). Manifest (`developCards.ts`): the Effects card's
Basic lists the lock (`combobox`), each wheel (`application`) and its two numbers (`textbox`), the presets (`group`);
the `effects.wheels` part is new; `CardControl.role` gains `textbox` and `combobox`. Kitchen sink: Primitives →
*Grading wheels* (`components/fixture/GradingSink.tsx`, local state), `docs/design/reference/kitchen-sink-55.png`
(the Develop cards with Teal & orange, Complementary and a midtones luminance, Basic and Advanced). **Engine**:
`DEVELOP_ENGINE_VERSION` and `ENGINE_VERSION` are `develop-engine/4`.

Byte-identical check: `crates/develop/tests/engine_bump.rs` (new, ignored; needs `~/Pictures/ON1 Samples`) renders the
11 ON1 sample RAWs at the 1600 px proxy with 18 settings fixtures (the 6 parity fixtures without AI or denoise and the
12 built-in looks, all with grading but no luminance or Global wheel), on the CPU and the GPU, and writes a SHA-256 per
render: 396 digests before any change (run twice: deterministic), after the maths and again after the bump and the
fixture regeneration are identical byte for byte (`cmp`), CPU and GPU. Fixtures: the 8 parity fixtures, the 12
`looks/` and the 12 `looks/start/` fixtures changed only in the canonical string's suffix (`/3` → `/4`) and the hash
(settings trees compared equal); `grading-wheels.json` is new (luminance on two wheels, a Global wheel, a lock that the
canonical string does not contain); the 9 geometry fixtures are byte-identical (no engine version in them).

Checks: `pnpm typecheck` clean; `pnpm lint` exit 0 (`check-palette: ok`; one warning in plan 56's `MaskMenu.tsx`);
`pnpm --filter @photobook/shared test` 1105 of 1105; `pnpm --filter editor test` 1516 of 1516; `cargo test -p
photobook-develop --lib` 231, `--test gpu` 14, `--test parity` 4, `--test geometry` 31, `--test effects` 13,
`--test lut` 8 (also `PHOTOBOOK_FORCE_CPU=1 --test effects --test gpu_force_cpu`); `cargo check -p photobook-develop
--no-default-features`; `cargo test --lib` in `src-tauri` 224. Check list: byte-identical (above); the lock is never
in the canonical settings (`schema.test.ts`, the `grading-wheels` fixture); a drag under a lock moves the tied wheels
(`harmony.test.ts`, `EffectsSection.test.tsx`), one tick per snap (`GradingWheel.test.tsx`); old settings parse
unchanged (`schema.test.ts`); CPU and GPU match (`tests/gpu.rs`); the manifest walk (`developCards.test.tsx`, a
luminance edit tags `effects.wheels` ·edited). Seen in the browser on the kitchen sink under `editor-web`: the
wheels, the lock aligning and a drag turning the shadows opposite the highlights, the spokes, the chips, the ▸.

Deviations: (1) `grading.global` is a schema field the card did not list: the Global wheel needs one; it is hashed
only away from its defaults. (2) The lock is never hashed, set or not (like `look.applied`): it changes no pixel, so it
must not re-render; it is saved with the settings only while set. (3) The GPU work needed a second pipeline and a
line in `gpu/kernels.rs` and `gpu/engine.rs` (additive) besides `chain.wgsl` and `params.rs`. (4)
`lib/develop/looks.ts` (not owned) keeps the Global wheel's hue and rounds luminance when a look is scaled (two regex
alternations; `looks.test.ts`). (5) The Effects card's Basic hue / saturation sliders are gone (the wheels replace
them), so those manifest entries were replaced, not added. (6) No Delete-to-reset on a wheel: Develop's Delete
removes the selected mask component unless the focus is a slider. (7) The luminance sliders are stacked full width
under the ▸ (three columns under the wheels truncated their labels). (8) Snap rule (the coordinator's decision, review pass): under a
lock a drag snaps to the hues of the wheels that stay put (under the tight locks only the Global wheel, when tinted);
under Free it snaps to 180°, ±120°, ±90° and ±30° from every other wheel with saturation > 0 (the Global wheel too),
within `SNAP_DEGREES` 4°, one `tick('alignment')` per snap; with no other wheel tinted it never snaps. (9) The
byte-identical check is an ignored test (the ON1 files are not in the repo) against a committed digest baseline,
`crates/develop/tests/fixtures/engine-bump/digests-engine-4.txt` (the writing machine's digests). (10)
`isDefaultDevelop` leaves the harmony lock out, as the hash does: a lock alone is not an edit.
Not verified: the Tauri window (a real drag, the haptic on a Force Touch trackpad), the re-render once on open, and
the ON1 samples by eye (the owner's, implementation plan section 8).

Review fixes (same day): (1) Free-mode snaps (`FREE_SNAP_ANGLES` in `harmony.ts`; `harmony.test.ts`, and
`GradingWheel.test.tsx`: a Free drag near 180° from a tinted shadows wheel snaps and ticks once, an untinted one never
snaps); (2) `ops/grading.rs` `luminance_offsets_are_exact_at_full_weight` (Global +100 at grey L 0.5 gives L 0.6
± 1e-5; shadows +100 at L 0.1, where the shadows weight is exactly 1, gives 0.2); (3) `GradingWheel` keeps a snapped
(and a Shift-held) hue exact instead of rounding it to a whole degree; (4) `isDefaultDevelop` strips `harmony`
(`schema.test.ts`); (5) `tests/engine_bump.rs` compares against `tests/fixtures/engine-bump/digests-engine-4.txt`
(`UPDATE_ENGINE_DIGESTS=1` writes it; equal to the engine 3 digests by `cmp`; 396 renders byte-identical), the bump
procedure in the crate README. No maths, engine or existing-fixture change. Checks after the fixes: `npx vitest run
src/lib/develop src/components/develop/EffectsSection src/components/develop/GradingWheel` 189 of 189;
`pnpm --filter @photobook/shared test` 1105 of 1105; `cargo test -p photobook-develop --lib grading` 8 of 8;
`--test engine_bump -- --ignored` pass; `pnpm typecheck` clean; Biome clean on the changed paths.
