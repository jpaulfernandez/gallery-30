# 45 · Primitives and the shell

ODDHALLS_UI_PLAN [6 (45)](../../ODDHALLS_UI_PLAN.md#45--primitives-and-the-shell), [4.1](../../ODDHALLS_UI_PLAN.md#41-buttons-and-controls), [3](../../ODDHALLS_UI_PLAN.md#3-direction-a-darkroom-not-a-cockpit) (Shell, Library sidebar); ODDHALLS_LAYOUT_PLAN [6](../../ODDHALLS_LAYOUT_PLAN.md#6-loading-waiting-and-saving-the-animation-vocabulary) (the progress ring and jobs pill, sidebar counts, "Saved"). Size: 2.5 days. Depends on: 44

`apps/editor/src/components/ui/`: `Button` (variants from 4.1, `size: sm | md`, `icon`), `IconButton`, `Segmented`
(sliding indicator, `aria-pressed`, keyboard arrows), `Field`, `Input`, `NumberInput` (mono, unit, wheel with Option),
`Select`, `Checkbox`, `Switch`, `Menu` and `MenuItem` (one implementation for Project ▾, the document drop-down, View ▾,
the Cull menu, the Presets menu, the sidebar context menus), `Popover`, `Tooltip` (with `shortcut`), `Toast`, `Tag`,
`ProgressRing`, `DialogShell` (replacing `components/develop/DialogShell.tsx` and the three export sheets' bespoke
shells). Then the shell migrates: top bar, stage tabs, Project ▾, sidebar, filter bar, jobs pill, Home, Settings.

- Each primitive has a Vitest test for its states and keys, and a kitchen-sink entry.
- No component outside `ui/` writes `rounded-md border border-line …` any more; a Biome rule is not possible, so the
  palette script also greps for `border-line bg-panel-2` on a `<button`.
- Check: the shell screenshots on the sink's "Shell" page match the direction in section 3; Tab order and focus rings
  unchanged or better; every menu opens on Enter, Space and ArrowDown, closes on Escape and returns focus.

## Radius per control

Plan 44 shifted every `rounded-*` class one step (`rounded-sm` is 6 px now); 45 decides per control (UI 2.3:
buttons 6, cards 8, pills and floating toolbars 12 or full, thumbnails 4).

| Control | Class | px |
| --- | --- | --- |
| `Button`, `IconButton`, popover triggers, segment items and the indicator | `rounded-sm` | 6 |
| `Input`, `NumberInput`, `Select` | `rounded-sm` | 6 |
| `Menu` and `Popover` panels (UI 4.1: 6 px, 2 px inset) | `rounded-sm` | 6 |
| Menu rows inside the 2 px inset, `Tooltip`, `Tag`, `Checkbox` | `rounded-xs` | 4 |
| `Segmented` track, `Toast`, the jobs notice card | `rounded-md` | 8 |
| `DialogShell`, the New project dialog | `rounded-lg` | 12 |
| `Switch` track and knob, the jobs pill | `rounded-pill` | full |
| Sidebar rows | `rounded-sm` | 6 |

Status: done 2026-10-13. Landed: `apps/editor/src/components/ui/` with the section 4 API: `Button` (`variant`
primary | soft | ghost | danger | toggle, `size` sm 24 px | md 28 px, `icon`, `pressed`; `buttonClass()` for links and
triggers; the focus ring with a gap; a half-pixel press; disabled 40 %), `IconButton` (`label`, `shortcut`, a
`Tooltip`), `Segmented` (`aria-pressed`, one Tab stop, arrows / Home / End, the indicator slides on `base`) and
`SegmentedTrack` (the same track around links, with `memoryKey` so a track that mounts anew slides from where the
last one was, over two frames: the stage tabs; a ResizeObserver re-measures it after a late webfont), `Field`, `Input`, `NumberInput` (mono, right-aligned, `unit`, Enter / blur commit,
Escape reverts, arrows and Shift × 10, Option + wheel through a non-passive listener, a plain wheel left to the
panel), `Select` (native, with a chevron), `Checkbox`, `Switch` (`role="switch"`), `Menu` + `MenuItem` /
`MenuSeparator` / `MenuLabel` / `useMenu` and `Menu.Context` with `useContextMenu`, `Popover` (`PopoverButton` moved
from `components/editor/Popover.tsx`, which re-exports it), `Tooltip` (600 ms hover, at once on keyboard focus,
Escape), `Toast` + `ToastHost` + `toast.show|update|dismiss|pause|resume`, `Tag`, `ProgressRing` (16 px, busy,
done), `CountUp` (from the `--dur-slow` token, so reduced motion shows the number at once; `memoryKey` keeps the last
number per sidebar row, so the library and the project's Cull do not recount on a route switch), `DialogShell` (moved;
`components/develop/DialogShell.tsx` re-exports it until 49; `panel-2`, 12 px, title 15 px, body 13 px, a fade and
an 8 px rise via `starting:`; `DialogButton` is a `Button`, with an optional `variant`), `floating.ts`, `testing.ts`
(the shared menu-key check), `index.ts`. Every entrance (menus, popovers, toasts, dialogs) uses Tailwind's
`starting:` variant (`@starting-style`) with the duration tokens; no new CSS. The shell: `TopBar.tsx` (hairline
under the bar, the title a ghost button and an `Input`, `IconButton` undo / redo with ⌘Z / ⇧⌘Z, Edit | Preview on
`SegmentedTrack`, Settings a ghost link, Export… and Publish primary, `SaveIndicator`), the library top bar in
`routes/library.tsx` (the same undo / redo, `SaveIndicator`, Settings), `StageTabs.tsx` (`SegmentedTrack` around the
links, `memoryKey="stages"`), `ProjectMenu.tsx`, `ViewMenu.tsx` (check items with their hint as a second line) and the
document drop-down `design/OutputMenu.tsx` (New… and the networks swap the list in place; Rename is a form in the
menu) on `Menu`; `Sidebar.tsx` (no right border; rows from `shell/SidebarRow.tsx`: 26 px, `panel-3` plus the 2 px
accent bar, `fg-2`, a 6 % hover; counts in mono counting up; rename fields are `Input`; folder, project and saved
collection menus on `Menu.Context`; plan 40's `CulledMark` line kept), `export/ExportSourceMenu.tsx` (the built-in
collections' Export menu) on `Menu.Context`, `LibraryFilterBar.tsx` (no border; `Input`, `Select`, toggle `Button`s,
Clear filters ghost; `<CullFilters />` mounted as it was, plan 40's labels kept), `SaveCollectionButton.tsx`,
`JobsBar.tsx` (the pill is a ring over all running jobs' counts plus the count in mono, `panel-3`, pill radius; each
running row has a ring, no bar; `JobsPillLabel` and `jobsPillClass` exported for the sink), `routes/home.tsx` and
`routes/settings.tsx` (controls only), the Develop strip's right-click menu (`DevelopMode.tsx` `Strip`: Make a
version, Copy settings ⇧⌘C, Paste settings ⇧⌘V onto the selection when the photo is in it) and the page strip's
(`PageStrip.tsx`, the same items as before, opened above the point) on `Menu.Context`; `shell/SaveIndicator.tsx`
("Saved" fades in for 1.2 s after a write, `slow`; "Not saved" in `danger`, the reason on hover; nothing while
editing; the live region holds the words only while they show, and a hidden visual copy fades). Toasts: one
`ToastHost` in `main.tsx`, at z 65 (above a dialog's scrim at 60, under tooltips at 70); all four export toasts migrated (`export/ExportToast.tsx`,
`design/PostExportToast.tsx`, `PrintExportToast.tsx`, `SlideshowExportToast.tsx` render `Toast` cards in the host,
with the ring while running and the check when done; the 38 px stacking offsets are gone). The canvas toast
(`editor/Toast.tsx`, "This page is now custom") is unchanged. The hard check: the 33 `<button>`s still drawn with
`rounded-md border border-line` or `border-line bg-panel-2` became `Button` (`WritePopover`, `BatchBar`,
`CropPanel`, `LookSection`, `MasksSection`, `downloads/sections`, `BookSettings`, `FramePopovers`, `Inspector`,
`PublishPanel`, `ShapeSection`, `ExportDialog`, `ExportExtras`, `Filmstrip`, `MissingCell`, `LooksFixture`,
`routes/downloads`), then `scripts/check-palette.mjs` fails on any such `<button>`, `PopoverButton` or `Popover`
`className` outside `components/ui` (the TypeScript parser finds the elements and also reads any same-file `const` the
`className` names, two levels deep; a plain failure). Review fix: that const resolution found 35 more, in
`settings/ToolsPanel`, `AiPanel`, `ModelsPanel`, `develop/DenoiseGroup`, `design/SendPageDialog`, `PrintPanel`,
`PostPanel`, `SlideshowPanel`, `editor/FramePopovers` (the Stepper), `FrameSection` and `ai/CaptionBookDialog`: each
file's class const is now `buttonClass()` from `components/ui/Button` (imported as `buttonLook`; the toggles in
`DenoiseGroup` are the `toggle` variant), so every handler, `disabled`, aria and `type="submit"` stays as it was.
`components/cull/` (7 buttons in `CullFilters` and `DecideView`, plans 39–42) is exempt from the check until plan 47
restyles Cull and removes the exemption. The
kitchen sink has Tokens · Primitives · Shell pages (`#/fixture?tab=sink&page=primitives|shell`;
`fixture/PrimitivesSink.tsx`, `ShellSink.tsx`), no `invoke`. Tests: `ui/Button.test.tsx` (variants, sizes, toggle,
tooltip delay, keyboard focus, Escape), `Segmented`, `Field` (field, select, number input keys and wheel, checkbox,
switch), `Menu` (keys through the shared helper, arrows / Home / End, disabled, check items, outside press, window
keys; `Menu.Context` at the pointer, the native-menu guard, focus return), `Popover` (moved), `Toast`,
`ProgressRing`, `Tag`, `CountUp`, `DialogShell`; `shell/menus.test.tsx` (Project ▾, the document drop-down and View ▾
through `expectMenuKeys`; the page strip through `expectContextMenuKeys`), `shell/SaveIndicator.test.tsx`, the
Develop strip menu in `develop/DevelopMode.test.tsx` (`expectContextMenuKeys`, copy and paste), the sink's pages in
`fixture/KitchenSink.test.tsx`; `OutputMenu.test.tsx` and `Rulers.test.tsx` read menu items by their menu roles now.

Deviations: (1) Reveal in Finder is not in the Develop strip menu: there is no command that reveals a photo
(`reveal_export` is limited to export destinations) and this plan adds no Rust; plan 52 brings it with the Cull menu.
(2) The Cull menu (`components/cull/CullMenu.tsx`, plans 40 and 47), the Presets menu, the Looks ⋯ menu and the Masks
menu (`components/develop/`, plans 46 and 56) are not on `Menu` yet: their owners move them (the shared helper is
ready for their tests). (3) "No component outside `ui/` writes `rounded-md border border-line`" holds for buttons
(the check) everywhere but `components/cull/` (exempt until 47); buttons in those files draw the `Button` look through
`buttonClass()` on their own `<button>`, not the `Button` component. Text fields, selects and panels (mostly in files
of plans 46–48) still draw `rounded-md border border-line` and move to `Input` / `Select` when those plans restyle
their areas. (4) The library top bar (`routes/library.tsx`) was migrated
with Design's, since it is the same bar in Cull and Develop; its save error now reads "Not saved" with the reason on
hover. (5) `Select` stays the native control (its menu is the system's), styled as a field. (6) `Tooltip` knows a
keyboard focus by the last input (a key or a pointer), not `:focus-visible`, which jsdom cannot test. (7) The busy
ring turns with `animation: spin calc(var(--dur-slow) * 3)`, so it stops under reduced motion with the tokens.
(8) The New project dialog on Home keeps its own shell (50 re-lays Home), restyled to the DialogShell look.

Checks: `pnpm typecheck`, `pnpm lint` (Biome and `check-palette: ok`), `pnpm --filter editor test` (143 files, 1335
tests; 1336 after the review fixes). In a browser on `editor-web` (Vite only): `#/fixture?tab=sink&page=shell` renders the top bar with the 78 px
inset, the stage tabs (the indicator's `left` moves 2 → 48 px with a 0.2 s transition on a click), Project ▾ (opens
on a click, Space, Enter and ArrowDown with the focus on Rename…, ArrowDown moves, Escape closes and the focus is back
on the trigger; the panel is `oklch(0.33 0.007 75)`, 6 px radius, 28 px rows), the sidebar with counts and the accent
bar, the filter bar and the jobs pill; "Simulate a save" shows "Saved" (`duration` 0.32 s) and it is gone after
1.2 s; the Primitives page opens a `Menu.Context` on a right-click with the focus on its first item, Escape closes it.
Screenshots: `docs/design/reference/kitchen-sink-45.png` (Shell), `kitchen-sink-45-primitives.png`. Not verified:
the Tauri window (agents cannot capture it): the traffic lights beside Project ▾, dragging the window from the bars
with the tooltip wrappers in them, the keys in WKWebView (checked in the pane's Chromium and jsdom only), the
`starting:` entrances in WKWebView (Safari 17.5+; without `@starting-style` they cut, which is acceptable), the real
Sidebar, Home and Settings screens with data (they need Tauri), and the look of the 33 swept buttons in their screens
(reviewed as a diff; 46–48 restyle those areas).
