# 44 · Tokens v2

Status: done 2026-10-13; review fixes applied the same day. Landed: `styles.css` `@theme static` with every token of
section 4 of the implementation plan plus `surround` (`stage`, `stage-mid`, `surround`, `canvas`, `panel`, `panel-2`,
`panel-3`, `hairline`, `line`, `fg`, `fg-2`, `fg-muted`, `accent`, `accent-ink`, `accent-soft`, `danger`, `warn`,
`ok`, `guide`, `pick`; `--radius-xs|sm|md|lg|pill` 4/6/8/12/9999 px; `--shadow-raised`, `--shadow-float`,
`--highlight-top`; `--ease-out`, `--dur-fast|base|slow` 120/200/320 ms), sRGB hex first and OKLCH in an
`@supports (color: oklch(0 0 0))` block, durations 0 under `prefers-reduced-motion`. The durations are also
registered as `--transition-duration-fast|base|slow` (Tailwind v4's theme namespace for `duration-*`, read from
`node_modules/tailwindcss`), so `duration-fast|base|slow` are real utilities and follow reduced motion; Tailwind's
default transition duration and easing point at `--dur-fast` and `--ease-out`, so a bare `transition` follows them
too. The `label` utility is renamed `section-title` (sentence case, 12 px medium `fg-2`, 64 uses) and there is a new
`tag` (10 px mono uppercase); the text-field selection uses `accent-soft` (43's `color-mix` stand-in gone); the
dot grid uses `hairline`. `ui.surround` (`black | charcoal | mid`, `photobook.ui.surround`, per machine like the
other ui prefs) and `lib/surround.ts`, which sets `--color-surround` on `:root` (installed in `main.tsx`); Settings →
Appearance (`components/settings/AppearancePanel.tsx`, the first section of `routes/settings.tsx`).
`scripts/check-palette.mjs` in `pnpm lint`: any Tailwind palette class and any arbitrary colour class
(`-[#…]`, `-[rgb(…)]`, `-[oklch(…)]`, `-[hsl(…)]`, `-[color(…)]`) in `apps/editor/src` fails. The `/fixture` Kitchen
sink tab (`components/fixture/KitchenSink.tsx`, `color.ts`; open it directly at `#/fixture?tab=sink`): every colour
token with its computed value, hex and OKLCH chroma, the surround's chroma beside the switch, the four contrast
pairs against the table, the elevation steps and shadows, radii, the type scale, the three durations with a Play
button; it calls no `invoke`. The sweep: 266 palette-class replacements (a shadow pair counts once) and 64 `label`
renames in 95 files, class names only, by a script (mapping table below), then the review's fixes by hand. Tests:
`components/fixture/color.test.ts` (every token defined, `surround` defaults to the stage, stage and stage-mid
chroma 0, each hex fallback equals its OKLCH value, the contrast pairs within 0.7 of the table, reduced motion zeroes
the durations), `components/fixture/KitchenSink.test.tsx` (every swatch renders, no `invoke`, the surround switch),
`lib/surround.test.ts`.

Deviations and decisions: (1) **`surround`, a token added by the review** (coordinator's decision): the surround
preference never moves `stage`. `--color-surround` defaults to `var(--color-stage)`; Black clears the override,
Charcoal is `oklch(0.27 0 0)`, Mid grey `stage-mid`, all achromatic. `bg-surround` is on the photo wells only: the
Develop picture well and its sharpening-mask image (`DevelopMode.tsx`) and the Review loupe (`ReviewMode.tsx`). The
Design desk (`Canvas.tsx`) stays on `canvas` (`oklch(0.22 0.004 75)`), as UI 2.2 and 3 name it: the surround is a
photo-well preference, and the desk is a desk (decided by the orchestrator, Oct 13, after review). Scrims, chips and
marks over a photo keep `stage/NN` and stay black. The Cull grid
well (`components/cull/CullGrid.tsx`, plan 39's) still uses `bg-stage`: the follow-up sweep of 39's files changes it
to `bg-surround`, and Compare and Survey with it.
Cull, Compare and Survey wells moved to `bg-surround` 2026-10-13. (2) The hex fallbacks are the OKLCH values converted (`stage-mid`
`#747474`, `panel-2` `#2d2b28`, …), not the rounded hex of UI 2.2. Measured contrast: `fg` on `panel` 13.0 (table
12.6), `fg-2` 6.4 (6.4), `fg-muted` 3.7 (3.6), `accent-ink` on `accent` 9.2 (9.8); the sink's "match" allows 0.7, and
every pair keeps the table's WCAG grade. (3) Text on a `danger` fill is `canvas`, not `fg` (`fg` on `danger` is about
2.7 : 1): the reject badge (`FilmstripCell.tsx`, `LibraryPanel.tsx`) and Settings → Models' delete button. (4)
`shadow-black/NN` with a size class became one elevation token (sm → `shadow-raised`, md/lg/xl/2xl →
`shadow-float`), and bare `shadow-lg` on menus and pills became `shadow-float` (the Masks, Looks and Presets menus,
the jobs pill and its error card, the guides loupe). The Design page keeps its paper shadow, `shadow-xl
shadow-stage/50` (UI 3; 48 owns canvas chrome). (5) Context rules over the plain table: `text-white` / `text-black`
on a `bg-accent` fill → `accent-ink`; the guide-blue ruler badge's text → `canvas`; the pick badge
`bg-white text-black` → `bg-pick text-canvas`; a star rating on a chip over a photo → `fg` (the accent never sits on
a photo), rated stars in Review's chrome → `accent`. (6) `BookSettings.tsx`'s `PrefSwitch` type excludes `surround`
(it takes boolean prefs only), the one non-class change in the swept files. (7) Arbitrary colours: the preview's
reader overlay `bg-[#0d0d0d]/95` → `bg-stage/95`, its photo panel `bg-[#141414]` → `bg-stage`, the Blank layout's
dashed margin `border-[#c9d0cc]` → `border-fg-2`. (8) No check for `rounded-md border border-line` on a button yet:
45 adds a hard check once `components/ui` exists. (9) `duration-150` (layout cards) and `duration-200` (the filmstrip
progress bar) became `duration-fast` and `duration-base`.

Recorded for later plans (no code here): the radius tokens shift every existing class (`rounded-sm` 4 → 6 px,
`rounded-md` 6 → 8 px, `rounded-lg` 8 → 12 px, `rounded-xs` 2 → 4 px); 45 and 47 decide per control. The brass
edited dot on a thumbnail (`FilmstripCell.tsx`, `bg-accent` over the photo) breaks "the accent never sits on a
photo"; 47 restyles it.

Plan 39's files (`components/cull/*`, `components/shell/LibraryFilterBar.tsx`, `store/cull.ts`) were skipped by this
plan and converted by a separate sweep with the same table.

Verified: `pnpm typecheck`, `pnpm lint` (Biome and `check-palette: ok`), `pnpm --filter editor test` (131 files, 1263
tests); in a browser on `editor-web` (Vite only), `#/fixture?tab=sink` renders every token; the stage's computed
colour is `oklch(0.17 0 0)` (chroma 0) and stays so under Mid grey while `--color-surround` becomes
`oklch(0.56 0 0)`; radii 4/6/8/12/9999 px; durations 120/200/320 ms; `.duration-fast` compiles to
`transition-duration: var(--transition-duration-fast)` and computes to 0.12 s; `bg-surround` comes after `dot-grid`
in the stylesheet, so it wins on the Design desk; `section-title` 12 px / 500 / `fg-2` / no transform. Screenshot:
`docs/design/reference/kitchen-sink-44.png`. Not verified: the Tauri window itself (agents cannot capture it), the
Develop, Review and Design wells in a browser (they need a project or a folder, so Tauri), reduced motion in a
browser (the test reads the stylesheet), and the look of every swept screen (the sweep is reviewed as a diff; 45–48
restyle them anyway).

ODDHALLS_UI_PLAN [6 (44)](../../ODDHALLS_UI_PLAN.md#44--tokens-v2), [2.2](../../ODDHALLS_UI_PLAN.md#22-a-good-colour-for-photography), [2.3](../../ODDHALLS_UI_PLAN.md#23-type-radius-elevation-motion). Size: 1.5 days. Depends on: 43

The colour, type, radius, elevation and motion system from section 2, as `@theme` tokens, and the hard-coded
palette colours replaced.

- `styles.css`: the token table in 2.2 and 2.3 (OKLCH with hex fallbacks via `@supports`), `--radius-*`,
  `--shadow-raised`, `--shadow-float`, `--highlight-top`, `--ease-out`, `--dur-fast|base|slow`, the `scrollbar`
  utility, `label` becomes sentence case (rename to `section-title`; keep `tag` for the 10 px mono uppercase).
- Surround preference: `ui.surround` (`black | charcoal | mid`, per machine) sets `--color-stage` on `:root`;
  Settings → Appearance; the Develop well, Cull, Compare and Survey read it.
- Replace every `text-red-*`, `text-amber-*`, `text-emerald-*`, `bg-sky-*`, `text-white`, `bg-black/*` and `bg-white/*`
  in `apps/editor/src` with the semantic tokens (`danger`, `warn`, `ok`, `guide`, `fg`, `stage/60`, `fg/6`). A Biome
  `noRestrictedImports` cannot catch class names; add a tiny `scripts/check-palette.mjs` that greps for the Tailwind
  palette and runs in `pnpm lint`.
- `/fixture` gains a **Kitchen sink** tab: every token swatch with its contrast ratio, the type scale, radii, the
  elevation steps, and every primitive from plan 45 in every state (used for review screenshots and the visual
  regression tests to come).
- Check: `scripts/check-palette.mjs` passes; the kitchen sink renders every token; no pixel of the stage has a hue;
  contrast ratios on the sink match the table.

## Sweep mapping

Applied by script to `apps/editor/src` (95 files), class names only; variants (`hover:`, `focus-visible:`,
`group-hover:`, `group-focus-visible:`) and opacity modifiers carry over. Context rules (deviation 5) run first.

| Old class | Token class |
| --- | --- |
| `text-red-200`, `text-red-300`, `text-red-400` | `text-danger` |
| `bg-red-400`, `bg-red-500`, `bg-red-500/NN` | `bg-danger`, `bg-danger/NN` |
| `bg-red-950/40` | `bg-danger/10` |
| `border-red-400`, `border-red-500`, `/NN` | `border-danger`, `border-danger/NN` |
| `text-amber-200`, `text-amber-300`, `text-amber-300/90` | `text-warn`, `text-warn/90` |
| `bg-amber-300`, `bg-amber-500/20`, `border-amber-300/60` | `bg-warn`, `bg-warn/20`, `border-warn/60` |
| `text-amber-300` on a rating chip over a photo / rated stars in the chrome | `text-fg` / `text-accent` |
| `text-emerald-200`, `text-emerald-400`, `bg-emerald-500/20` | `text-ok`, `bg-ok/20` |
| `bg-sky-300`, `bg-sky-400/80`, `bg-sky-500` | `bg-guide`, `bg-guide/80` |
| `shadow-sky-300`, `fill-sky-400`, `border-sky-400` | `shadow-guide`, `fill-guide`, `border-guide` |
| `text-white`, `text-white/NN` | `text-fg`, `text-fg/NN` |
| `text-white` / `text-black` on `bg-accent` | `text-accent-ink` |
| `text-white` on the guide badge (`bg-sky-500`) | `text-canvas` |
| `bg-white`, `bg-white/NN`, `border-white/NN` | `bg-fg`, `bg-fg/NN`, `border-fg/NN` |
| `bg-white text-black` (pick badge), `bg-white` (pick dot) | `bg-pick text-canvas`, `bg-pick` |
| `text-black` (elsewhere) | `text-canvas` |
| `bg-black`, `bg-black/NN` | `bg-stage`, `bg-stage/NN` |
| `border-black/NN`, `stroke-black/NN`, `from-black/NN` | `border-stage/NN`, `stroke-stage/NN`, `from-stage/NN` |
| `shadow-black/NN shadow-sm` | `shadow-raised` |
| `shadow-black/NN shadow-md` / `-lg` / `-xl` / `-2xl` (and `group-hover:`) | `shadow-float` |
| bare `shadow-lg` on a menu or pill (review fix) | `shadow-float` |
| `shadow-black/50 shadow-xl` on the Design page (review fix) | `shadow-stage/50 shadow-xl` |
| `text-fg` on a `bg-danger` fill (review fix) | `text-canvas` |
| `duration-150`, `duration-200` (review fix) | `duration-fast`, `duration-base` |
| `bg-[#0d0d0d]/95`, `bg-[#141414]`, `border-[#c9d0cc]` (review fix) | `bg-stage/95`, `bg-stage`, `border-fg-2` |
| `bg-stage` on a photo well (review fix) | `bg-surround` |
| `label` (utility) | `section-title` |

Counts: `text-danger` 59, `text-warn` 20, `bg-stage/NN` 34 (plus 3 `hover:`), `hover:` / `focus-visible:bg-fg/NN` 32,
`text-accent-ink` 20, `shadow-float` 23, `shadow-raised` 4, `section-title` 64; the rest one to eight each.

