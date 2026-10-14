# 43 · Native shell and the Tauri artifacts

Status: done 2026-10-13 except the checks only the owner can run (below). Landed: `productName` and window title
`oddhalls`, overlay title bar (`hiddenTitle`, `theme: Dark`, traffic lights at x 16, y 15), `identifier` unchanged and
`dragDropEnabled: false` kept; the `index.html` title and the Home wordmark (Instrument Serif italic); the `styles.css`
base layer (`user-select: none` with the `input, textarea, [contenteditable], .selectable` opt-in and their children,
`-webkit-user-drag: none` on `img, svg, canvas`, `::selection` transparent in the chrome and shown in the opt-in
and in `select-text` elements, `overscroll-behavior: none`
on `html, body`); the `scrollbar` utility and the audit below; `lib/nativeShell.ts` (contextmenu, dragstart and
release-only Cmd+R / Cmd+Shift+R / F5 guards, installed in `main.tsx`); `src-tauri/src/menu.rs` (`install_native_menu`,
`set_text_focus`) with `lib/nativeMenu.ts` and `lib/nativeMenuActions.ts`; `data-tauri-drag-region="deep"` on the top
bars (Design, library, preview, downloads; Develop and Review when they cover the window), so the window drags from
anywhere in a bar but its buttons, links and fields (Tauri's drag script skips those; Project ▾ is a button, the stage
tabs are links), with a 78 px left inset, and a drag strip on Home (44 px) and Settings (32 px, so it ends above the
Back button); the Design canvas scroll box (`overflow: hidden` up to fit, `auto` past it with the bar hidden,
whole-pixel content box from a floored measure); right-click menus on sidebar folders (Rename…, Export…) and projects
(Rename…, Reveal in Finder). Tests: `lib/nativeShell.test.ts`, `lib/nativeMenu.test.ts`, `styles.test.ts` (the
opt-in, and every `*Input*` / `TextEditor` component renders an element it matches), `menu::tests` in Rust.
Deviations: (1) the flag is `VITE_PHOTOBOOK_NATIVE_MENU=1` (Vite exposes only `VITE_*`), and the webview installs the
menu through `install_native_menu`, so Rust and the webview read one flag. (2) The keydown handlers are not edited:
an item that stands for a key dispatches that keydown to the focused element, so the handler that owns the key today
acts; a press the page saw first is dropped (`recentKey`: stamped in the capture phase, pending until its dispatch
ends, then 300 ms), so a key acts once whether the menu or the page gets it first. The text focus is synced once at
install too. While a text field has focus the six Edit items become the system items and every other item with
an accelerator is disabled. (3) Photo → Make a version and Reveal in Finder are left out (no action without the photo
on screen; they come with the context menus of 45 and 52); File → New project opens Home; View → Cull / Develop open the
last library folder; Cmd+Shift+V keeps its Design meaning (split vertically) under the Paste settings label.
(4) Custom context menus: only the sidebar here, as section 1 of the implementation plan locks; the sidebar's existing
point-anchored menu (`CollectionMenu`, now `RowMenu`) is used, since `Popover` anchors to a button. (5) Horizontal
strips keep a thin hover bar instead of a hidden one: none turns a mouse wheel into a horizontal scroll, so hiding it
would strand mouse users; the canvas past fit hides it. `scrollbar-gutter: stable` is a per-panel class, not part of
the utility (it would add a gutter to strips and the canvas). (6) No `accent-soft` token yet: a text field's selection
uses `color-mix` of `accent` at 35 %; 44 swaps it. (7) Also touched for the overlay title bar: `capabilities/default.json`
(`core:window:allow-start-dragging`, which the drag region needs), `routes/preview.tsx`, `routes/downloads.tsx`,
`routes/library.tsx`, `routes/settings.tsx` (the drag strip), the Develop and Review headers.
Verified: `pnpm typecheck`, `pnpm lint`, `pnpm --filter editor test`, `cargo check` and `cargo test --lib` in
`src-tauri`; in a browser on `editor-web`, Home's computed styles (chrome `user-select: none`, text fields and
`.selectable` `text`, `overscroll-behavior: none`, `-webkit-user-drag: none`, an 8 px `scrollbar`) and a drag and a
triple-click across Home's text select nothing; `vite build` flattens the utility's nested rules. Not verified (the
owner's, by hand): traffic lights in the top bar and the window dragging from it (Project ▾ and the stage tabs still
click), no selection anywhere in the Tauri window, right-click showing ours or nothing, the canvas showing no bar and
no bounce on a two-finger scroll over a fitted page, Cmd+Z in a text field undoing typing with the flag on, the
`[photobook:menu]` dev-log line once per press of every item (needs `tauri dev`, not run while plan 38 runs), the
plain-key items (P, X, U, 0–5, D) under the menu, and the release `.app` having no Inspect Element. Follow-up: the
Home and Settings drag strips are fixed over their scrolling pages, so they sit over (and drag from) content
scrolled under them; 50 re-lays Home and should give both a real bar.

ODDHALLS_UI_PLAN [6 (43)](../../ODDHALLS_UI_PLAN.md#43--native-shell-and-the-tauri-artifacts), the audit in [1](../../ODDHALLS_UI_PLAN.md#1-where-we-are-an-audit-of-the-current-skin), [4.3](../../ODDHALLS_UI_PLAN.md#43-tactility-that-only-a-native-app-can-do). Size: 2 days. Depends on: —

Rename to oddhalls, fix the three artifacts, make the window native.

- `tauri.conf.json`: `productName` "oddhalls", window `title` "oddhalls", `titleBarStyle: "Overlay"`, `hiddenTitle:
  true`, `theme: "Dark"`, `trafficLightPosition` to sit on the 44 px bar. **Keep `identifier`** `com.photobook.editor`:
  changing it moves `<appdata>` (projects, caches, models, the registry) to a new directory. A rename of the
  identifier is its own later plan with a one-time move of the old directory. `index.html` title, the Vite dev title
  and the Home wordmark change now; `README`, docs and the site when the product is announced.
- `styles.css` base layer: `* { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none }` with
  `input, textarea, [contenteditable], .selectable { -webkit-user-select: text; user-select: text }`;
  `img, svg, canvas { -webkit-user-drag: none; pointer-events: … unchanged }`; `::selection` inside chrome
  transparent, inside text fields `accent-soft`; `html, body { overscroll-behavior: none }`; every scroll container
  `overscroll-behavior: contain`.
- `main.tsx`: a `contextmenu` listener that cancels the default unless the target is a text field or has
  `data-native-menu`; a `dragstart` listener that cancels any drag not started by dnd-kit (dnd-kit uses pointer events,
  so simply cancelling all native `dragstart` is correct; `dragDropEnabled: false` stays on the window). A `keydown`
  guard for Cmd+R / Cmd+Shift+R / F5 in release builds (WKWebView reloads on them).
- Custom context menus where the browser one showed: the Develop strip (Make a version, Copy settings, Paste,
  Reveal in Finder), the Design canvas (the floating toolbar's actions), the page strip, the sidebar rows (already
  there for collections; add folders and projects).
- Scrollbars: a `scrollbar` utility (8 px, thumb white 18 % `pill`, track transparent, thumb only while the
  container is hovered, `scrollbar-gutter: stable` on panels) applied to every list; `[&::-webkit-scrollbar]:hidden`
  on strips that scroll by wheel or drag only. The Design canvas scroll area switches to `overflow: hidden` while the
  page fits and `overflow: auto` only past fit; its content box is floored to whole pixels. Audit the 33
  `overflow-*` containers in one pass and record each decision in the plan's PR.
- Native menu bar (`tauri::menu`): File (New project, Open project file, Save as, Close project, Import folder,
  Export…), Edit (Undo, Redo, Cut, Copy, Paste, Select all, Copy settings, Paste settings), View (Show grid, rulers,
  safe area, Zoom to fit, 100 %, stage switches), Photo (Pick, Reject, Unflag, ratings, Make a version, Develop,
  Reveal in Finder), Window, Help. Items carry accelerators; **the native menu owns them** and emits one event per
  item (`menu:<id>`) that the webview dispatches to the same action functions the keydown handlers call today, and
  those keydown handlers drop the combos the menu owns. Text fields keep native Edit behaviour because Edit's
  items use the predefined `MenuItem::undo/redo/cut/copy/paste/select_all` for the system responders when a text field
  is focused (the webview reports focus state through a small `set_text_focus` command). Behind a flag for one session
  so the two paths can be compared.
- Check: no selection highlight can be made anywhere outside a text field; right-click shows our menu or nothing;
  a two-finger scroll over a fitted page shows no scrollbar; no region bounces; traffic lights sit in the top bar and
  the window drags from it; Cmd+Z in a text field undoes typing, outside it undoes the book; the release `.app` has
  no Inspect Element (already true, now verified in the Check).

## Scrollbar audit

Every `overflow-*` scroll container in `apps/editor/src` (34), with the decision. *Panel*: `scrollbar
overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]`. *List*: `scrollbar overflow-x-hidden overflow-y-auto`
(the horizontal bar of a vertical list was always unintended; the Develop panel's header now wraps instead of
scrolling). *Log*: `scrollbar overflow-auto` (long lines scroll both ways). *Strip*: `scrollbar overflow-x-auto`.

| Container | Decision |
| --- | --- |
| `shell/Sidebar.tsx` nav | Panel |
| `develop/DevelopPanel.tsx` | Panel |
| `develop/CropPanel.tsx` | Panel |
| `editor/Inspector.tsx` | Panel |
| `layouts/LayoutsPanel.tsx` | Panel |
| `filmstrip/Filmstrip.tsx` | Panel |
| `filmstrip/LibraryPanel.tsx` | Panel |
| `cull/CullGrid.tsx` | Panel |
| `develop/DialogShell.tsx` body | List |
| `develop/XmpImportDialog.tsx` (2) | List |
| `develop/SyncDialog.tsx` grid | List |
| `develop/MatchCameraDialog.tsx` | List |
| `shell/JobsBar.tsx` list (was `overflow-auto`) | List |
| `ai/WritePopover.tsx` | List |
| `preview/Reader.tsx` overlay | List |
| `preview/PhotoPanel.tsx` | List |
| `editor/LayoutPicker.tsx` body | List |
| `routes/settings.tsx` page | List |
| `routes/downloads.tsx` main | List |
| `routes/home.tsx` page, folder list, New project dialog (3) | List |
| `shell/JobsBar.tsx` error `<pre>` | Log |
| `editor/PublishPanel.tsx` `<pre>` (2) | Log |
| `routes/settings.tsx` `<pre>` | Log |
| `routes/fixture.tsx` (dev only) | Log |
| `develop/VersionStrip.tsx` | Strip |
| `develop/LooksSection.tsx` | Strip |
| `editor/PageStrip.tsx` | Strip |
| `preview/Reader.tsx` page carousel | Unchanged: already hidden, `overscroll-x-contain` (swiped) |
| `editor/Canvas.tsx` scroll area | `overflow-hidden` up to fit; past fit `overflow-auto overscroll-contain` with the bar hidden (wheel and trackpad scroll it) |
