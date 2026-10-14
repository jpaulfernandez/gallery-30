# Code map

Which file owns which feature, and where caches and data live. `CLAUDE.md` holds the invariants and commands; plan
numbers here refer to `docs/design/archive/plans/`.

## Packages

- `apps/editor` (`editor`): Tauri 2 + React 19 + Vite 6 + Tailwind v4 + TanStack Router (code routes in `src/router.tsx`).
- `apps/viewer` (`viewer`): Vite + Preact.
  - `preact/compat` stands in for React so the shared renderer runs as-is.
- `apps/site` (`site`): static landing page for gallery30.janpaulfernandez.com (plain HTML in `public/`, no build).
  - Vercel project `gallery30`; deploy with `pnpm --filter site run deploy`.
  - Screenshots: `node apps/site/scripts/optimize-images.mjs`.
- `packages/shared` (`@photobook/shared`): Zod schema, ids, book templates, migrations, fonts, renderer, layouts, publish
  contracts, cull groups and *Group by* sections (`src/cull/`), the develop schema, looks and curve presets (`src/develop/`).
- `packages/publish` (`@photobook/publish`): Node CLI `photobook publish <project.json> [--dry-run] [--prune]`.
  - `photobook stats <folder> [--json]` (`src/stats.ts`, plan 38): prints a folder index's capture facts and stats.
- `crates/develop` (`photobook-develop`, details in its `README.md`): pure-Rust develop pipeline, no Tauri.
  - `settings` / `canonical`: serde mirror of the Zod `DevelopSchema`, `develop_hash` and `ENGINE_VERSION`
    (`develop-engine/4` since plan 55; `tests/engine_bump.rs`, ignored, compares ON1 sample render digests with
    `tests/fixtures/engine-bump/digests-engine-<n>.txt`, written with `UPDATE_ENGINE_DIGESTS=1`).
  - `decode`: JPEG / PNG / HEIC (ImageIO) / RAW (`rawler`).
  - `color`: matrices, Oklab, CCT/tint, curves, camera matrices, output ICC (sRGB / Display P3).
  - `ops`: per-control maths.
  - `local`: guided filter and blur pre-passes.
  - `cpu`: the reference `Developer`.
  - `gpu`: wgpu/WGSL port verified against the CPU.
  - `geometry`: homography, crop, manual / guided / auto Upright, warp.
  - `masks`: rasterise, composite, blend, AI cache.
  - `ai`: model registry (`models.toml`), downloader, `ort` runtime, segment / depth / refine / denoise.
  - `xmp`: Lightroom `crs:` import / export and our own packet.
  - `render`: preview / full render and JPEG encode.
  - `preview_modes` (plan 53): focus peak and zebra over a preview's 8-bit output (`apply_preview_mode`, the CPU
    reference `apply_preview_mode_cpu`; the GPU pass is `gpu/preview_mode.rs` with `shaders/preview_mode.wgsl`); outside
    the develop hash, checked by `--test preview_modes`.
  - `stats` (plan 38): `photo_stats` (tile sharpness, motion, clip shares, median luma) and `phash` of an 8-bit proxy;
    fixtures in `tests/fixtures/stats/` (`scripts/make-stats-fixtures.py`, checked by `--test stats`). Plan 56:
    `palette` (five `#rrggbb`, k-means in Oklab at 240 px, fixed seed) in the same module.
  - A root `Cargo.toml` workspace holds it and `apps/editor/src-tauri` (shared `target/`, `Cargo.lock`).
  - Features `ai`, `raw`, `heic-imageio` are on by default.
- `worker/` (`@photobook/worker`): Cloudflare Worker + D1 for likes and the download log.
  - `wrangler.toml` is a template; real deployments use the git-ignored `wrangler.local.toml`.

## Editor

### Shell and routes

- `src/router.tsx`: code routes. Plan 49: a navigation that changes the stage (Cull, Develop, Design) runs as a view
  transition (`router.shouldViewTransition` set in an `onBeforeNavigate` subscription from `isStageChange`); the rest
  are cuts.
- `src/lib/viewTransition.ts` (plan 49): `withViewTransition` (feature-detected `document.startViewTransition`, a cut
  without it; Survey's tile removal and Develop opening over a project's Cull), `stageOf`, `isStageChange`, and
  `STAGE_PICTURE`, the `view-transition-name` of One's picture (`ViewportPicture`'s `transitionName`) and the Develop
  picture (`DevelopImage`), so the picture stays put while the panels crossfade (CSS in `styles.css`).
- `src/store/book.ts`: Zustand store.
- `src/lib/tauri.ts`: typed `invoke` wrappers, one per Rust command.
- `src-tauri/src/lib.rs`: registers plugins and commands.
- `src-tauri/src/commands/<area>.rs`: the commands, one file per area.
- `src/components/shell/`: the Library sidebar, the stage tabs (Cull · Develop · Design) and the Project ▾ menu.
- `src/components/shell/JobsBar.tsx`: job status pill (a progress ring and the count) and list (mounted in `main.tsx`).
  Plan 49: when the last active job finishes with no failure, a "Done" pill holds the full ring and its check, then
  fades out (`beat-out`) and leaves on `animationend`.
- `src/components/shell/SaveIndicator.tsx`: the top bars' "Saved" (fades in for 1.2 s after a write) and "Not saved".
- `src/components/shell/SidebarRow.tsx`: the Library sidebar's row class (26 px, the accent bar) and its counting-up
  count, shared with the kitchen sink.
- Shell panes (plan 51):
  - `src/store/ui.ts` `ui.panes[stage] = { left, right, strip }` for `cull` | `develop` | `design` (`PaneStage`), per
    machine under `PANES_KEY` (`loadPanes`), kept by `reset()`, never in the project; `setPanes`, `togglePanes`
    (Tab: both side panes; Shift+Tab: all three).
  - `src/components/shell/Panes.tsx`: `PaneShell` (top bar, left, centre, right, strip; shows what `ui.panes[stage]`
    has on) used by `routes/library.tsx`, `routes/projectCull.tsx` and `routes/book.tsx`; `useCullPaneKeys` (Cull's
    Tab listener, called by the two Cull routes). Plan 52's Photo pane is Cull's `right`.
  - The keys: `paneKeyAction` in `components/cull/keys.ts` (the guards: no modifier, not in a text field, on a control,
    in a menu or a dialog), read by `useCullPaneKeys`, `DevelopMode` (its own panes) and `useEditorShortcuts` (Design).
  - `src/components/shell/LibraryFilterBar.tsx`: `LibraryFilterBar` (`filtersInSidebar` on the Cull stages: search,
    the view switch and zoom (`CullViewBar`, plan 52; the only zoom control since plan 49), the Decide fraction and
    button, counts, Clear filters; plan 49's `PanesToggle`, the visible Tab: the side panes' button) and `LibraryFilters` (flag, stars, Edited, ISO ≥, Hide in project
    / Hide used, Sort), rendered by `Sidebar.tsx`'s Filters section (with `CullFilters`) on Cull and inline in the bar in
    Develop and the Design stage's Library tab.
- Native shell (plan 43):
  - `src/lib/nativeShell.ts`: the document guards installed in `main.tsx` (no browser context menu outside text fields
    or `data-native-menu`, no native `dragstart`, no reload keys in release builds).
  - `src/styles.css` base layer: `user-select: none` with the text-field opt-in (`styles.test.ts` checks it), no image
    drag, `overscroll-behavior`; the `scrollbar` utility on every scroll container.
  - `src-tauri/src/menu.rs`: the native menu bar (`install_native_menu`, `set_text_focus`), installed by
    `src/lib/nativeMenu.ts` (items, accelerators, the keydown each item dispatches) only with
    `VITE_PHOTOBOOK_NATIVE_MENU=1`; `src/lib/nativeMenuActions.ts` runs the items that have no key.
  - The window has an overlay title bar (`tauri.conf.json`); top bars carry `data-tauri-drag-region` and a 78 px left
    inset for the traffic lights. The main window sets `backgroundThrottling: "disabled"` so a hidden window keeps
    its JS-driven jobs (scans, exports, publish) running: macOS suspends an invisible webview after a few seconds
    otherwise (`src/lib/tauriConfig.test.ts` guards the setting).
- Tokens v2 (plan 44):
  - `src/styles.css` `@theme`: every colour, radius, shadow and duration token (hex, then OKLCH under `@supports`;
    durations zero under reduced motion, and `duration-fast|base|slow` utilities) and the `section-title`, `tag`,
    `scrollbar` utilities. Use only these. Plan 49 adds `--dur-check` (160 ms, the check's stroke) and `--dur-hold`
    (400 ms, a finished job's hold), points Tailwind's `animate-spin` / `animate-pulse` at the tokens, and adds the
    stage crossfade (`::view-transition-*(root | stage-picture)`), the `beat-in` / `beat-out` / `check-draw` /
    `loupe-sweep` utilities, the tools' cursors (`cursor-draw`, `cursor-rotate`, `cursor-pan`, `cursor-panning`, SVGs in
    `apps/editor/public/cursors/`, each with a standard fallback keyword) and the base-layer accent outline for any
    focused control without a focus style of its own. `KitchenSink.test.tsx` checks every `--dur-*` and `--stagger`
    computes to 0 under reduced motion.
  - `scripts/check-palette.mjs` (in `pnpm lint`): fails on a Tailwind palette class or an arbitrary colour class
    (`bg-[#…]`, `-[rgb(…)]`, `-[oklch(…)]`) in `apps/editor/src`.
  - `src/lib/surround.ts`: `ui.surround` (Settings → Appearance, `components/settings/AppearancePanel.tsx`) sets
    `--color-surround` on `:root`; installed in `main.tsx`. `bg-surround` is for photo wells only; `stage` is fixed.
  - `src/components/fixture/KitchenSink.tsx`: the `/fixture` Kitchen sink tab (`#/fixture?tab=sink`), every token
    with its computed value and contrast (`color.ts`); no `invoke`, so it renders under Vite alone (`editor-web`).
- Primitives (plan 45): `src/components/ui/`, the only place controls are drawn (ODDHALLS_UI_PLAN 4.1).
  - `Button.tsx`: `Button` (`variant` primary | soft | ghost | danger | toggle, `size` sm | md, `icon`, `pressed`),
    `buttonClass()` for a `<Link>` or trigger that must look like one, `IconButton` (`label`, `shortcut`), `focusRing`.
  - `Menu.tsx`: `Menu` (a menu button) + `MenuItem` / `MenuSeparator` / `MenuLabel`, `useMenu`; `Menu.Context` (a
    menu at a point) opened by `useContextMenu().onContextMenu`, which leaves the system menu to text fields and
    `data-native-menu` (plan 43's guard). Keys: Enter, Space, ArrowDown open; Escape closes and returns the focus.
    `testing.ts` holds the shared check (`expectMenuKeys`, `expectContextMenuKeys`) every menu test uses.
  - `Popover.tsx` (moved from `components/editor/`, which re-exports it), `Tooltip.tsx`, `Segmented.tsx`
    (`Segmented`, and `SegmentedTrack` around links: the stage tabs), `Field.tsx` (`Field`, `Input`, `NumberInput`,
    `Select`, `Checkbox`, `Switch`), `Tag.tsx`, `ProgressRing.tsx` (plan 49: the done check draws in `--dur-check`), `CountUp.tsx`, `floating.ts` (panel
    placement). `Tooltip`'s `className` replaces its `inline-flex` wrapper (a grid cell passes `flex [&>*]:flex-1`, an
    absolutely placed button passes its placement). `iconButtons.test.ts` fails on an icon-only `Button` or `<button>`
    outside a `Tooltip` (an `IconButton` always has one).
  - `EmptyState.tsx` (plan 49): every empty state, one line in Instrument Serif italic with the action under it (`lg`
    for a stage or Home, `md` in a panel or section).
  - `Pill.tsx` (plan 47): the floating batch pill shared by Develop's `BatchBar` and Cull's `CullPill`: `Pill` (`shown`,
    `label`; slides up, inert while hidden), `PillCount` ("12 selected" with the progress ring and "23 of 58"),
    `PillDivider`, `PILL_CLEARANCE` (the end padding a list adds while its pill shows).
  - `Toast.tsx`: `ToastHost` (mounted once in `main.tsx`, bottom-left; the four export toasts render `Toast` cards in
    it), `toast.show` / `update` / `dismiss` for the rest. The canvas notices ("This page is now custom", a post's
    frame limit, "Sent to …") show in it too (plan 48): `components/editor/Toast.tsx` is no longer a component, only
    `showToast` / `dismissToast` (one canvas notice at a time, over `toast.show`) and `useToastStore` (the notice
    showing). Plan 49, the completion beat: a toast that turns `done` after running holds its last running text and
    the check for `--dur-hold`, then shows what landed and its actions (CSS only, so reduced motion shows it at once).
  - `DialogShell.tsx`: every dialog and sheet (the old `components/develop/DialogShell.tsx` path is gone since plan 49).
  - The kitchen sink's Primitives and Shell pages: `components/fixture/PrimitivesSink.tsx`, `ShellSink.tsx`
    (`#/fixture?tab=sink&page=primitives|shell`); plan 48's Design page, `DesignSink.tsx` (`page=design`): the real
    `Canvas`, `Inspector` and `PageStrip` on the fixture book (it holds the book and assets stores while shown).
  - `scripts/check-palette.mjs` also fails on a `<button>` (or popover trigger) outside `components/ui` whose
    `className` (or a same-file `const` it names) has `rounded-md border border-line` or `border-line bg-panel-2`;
    no directory is exempt since plan 47.
- Design canvas chrome (plan 48), in `src/components/editor/`:
  - `AlignToolbar.tsx` also exports `canvasPill`, the floating pills' look (`panel-3`, hairline, float shadow); their
    icon buttons are `Button` / `IconButton` `size="lg"` (32 px), the zoom HUD's `shape="pill"`; used by `SelectionOverlay.tsx` (handles, the photo and multi-selection
    toolbars, Fix spacing, the Adjust hint) and `Canvas.tsx` (the tool group and the zoom HUD).
  - Colours over the page: `CanvasGuides.tsx` `SNAP_COLOR` (accent: snap lines, measures, badges) and
    `LAYOUT_GUIDE_COLOR` (guide blue: grid, margins), `components/design/SafeAreaGuides.tsx` `SAFE_AREA_COLOR` (`warn`);
    ruler guides are `bg-guide` in `Rulers.tsx`. `canvasColors.test.tsx` checks them and that the accent marks only
    the selected frame's outline and handles.
  - `inspectorUi.tsx`: `Section` is a card (`panel-2`, 8 px radius) providing `ui/Field`'s `FieldSurfaceContext`
    `'card'` (fields fill with `panel`), `Field` a label row; `inputClass` is `textFieldClass('card', { fixedHeight:
    false })` from `ui/Field`, for textareas and the design panels' and export sheets' fields.
- Settings (`routes/settings.tsx`): plan 49's `SettingsPage`, Home's bar shape (44 px, `panel-2`, drag region, 78 px
  inset) with Back, the title, the status and Save; the page scrolls under it.
- Home (plan 50): `routes/home.tsx` (the top bar, `StartRow`, `ProjectCards`, `FolderRows`, `EmptyLine`; the folder
  rows' cull state is `folderCull` over the library store's index-read folder and its library, `folderCulled` from
  `store/decide.ts`; Home keeps the folders ready with `useFolderIndexes`, as `useLibraryFolders` does, and reads
  the registry once).
  - `src/components/home/ProjectCover.tsx`: the cover card's picture, the project's first page through the shared
    `<Page>` with a resolver onto the cached `<appdata>/cache/<hash>/thumb.jpg` files (the cache root is read off the
    listing's `coverThumb`). The first page, page size, theme, thumbnail paths and page count are read once per project
    id + modified time (`readProject`, `parseBook`; a project without a cached cover photo takes the cache root of
    another listed project, `sharedCacheRoot`) and cached in memory (48) and in localStorage `photobook.home.covers`
    (24 entries, 200 000 characters, oldest first out; a project's older key is dropped).
  - `src/components/fixture/HomeSink.tsx`: the kitchen sink's Home page (`#/fixture?tab=sink&page=home`).
- Haptics (plan 46): `src/lib/haptic.ts` `tick(kind)` (`alignment` | `levelChange` | `generic`; 80 ms rate limit,
  off with `ui.haptics` (Settings → Appearance) or reduced motion; also ticks on the canvas zoom reaching Fit or
  100 %) → `src-tauri/src/commands/haptic.rs` (`haptic`, `NSHapticFeedbackManager` via `objc2-app-kit`, macOS only,
  `Ok` everywhere). Callers: the Develop slider's detent, `setSnapGuides` in `components/editor/snap.ts`; plan 55's
  harmony-lock snaps (`GradingWheel.tsx`).
- Project routes: `/project/$id/design/$outputId` (`book` or an output id; `/project/$id` and `/design` redirect),
  `/project/$id/preview`, `/project/$id/downloads`.
  - `requireProject` loads the id.
- Library routes: `routes/library.tsx` is the Cull and Develop stages.
  - `/library/$folderId/{cull,develop}`
  - `/library/collection/$collectionId/{cull,develop}`
  - `/project/$id/cull` is the project's own grid.

### Scope and folders

- `src-tauri/src/scope.rs`: every disk path goes through `ensure_allowed`.
  - Allowed: an imported folder or the app data dir only (`ImportedRoots`).
  - Commands taking a `folder` require it to be exactly one imported root (`ensure_imported_root`).
  - Folders become roots through `add_root` (picked in the dialog or in the registry). A project's content never makes a
    root.
- Registry: `<appdata>/folders.json`.
  - `commands/folders.rs` and `store/folders.ts`.
  - Loaded into the scope at startup.
- Book v8: `folders: Record<id, { path }>` (absolute, or relative to the project file) replaces `sourceFolder`.
  - Every asset names its `folder`.
  - The editor's `folder` is the project's primary folder (the first imported one; the filmstrip scans it whole).
  - An asset in another folder (relinked there) resolves its path, library and renders through `assetFolderPath`.
  - Its `files` entry is keyed by `fileKey` (look files up by asset id with `fileOfAsset`).
  - New projects use the registry folder id as the book's folder id.
- `captions` and `page.guides` are in the schema with no UI yet.
  - `outputs` have the Design drop-down (plan 13) and are never published.
  - Guides and notes never reach the manifest or the fingerprint.

### Projects

- Files: `commands/projects.rs`, `store/projects.ts`, and in `store/book.ts` `loadProject` / `createProject` / `saveAs`.
- Layout: `<appdata>/projects/<ULID>/project.photobook.json` (+ `.bak`, and the CLI's `.photobook-publish/`).
  - The directory listing is the registry.
- Files saved elsewhere (Save as, Open project file): `<appdata>/projects.json` `[{ id, path }]`.
- `recent.json` is `{ project, opened }`.
- A legacy `<folder>/book.photobook.json` becomes a project at folder import and at startup, renamed `.imported` after.
- Delete moves to the Trash (`trash` crate).
- Writes go through `write_project` (temp file + rename, previous version kept as `project.photobook.json.bak`;
  `src-tauri/src/atomic.rs`).
  - Secrets never go in the project file.
- Relink: assets missing on open are relinked by size + hash (`store/relink.ts`).
  - First in their folder, then across every imported folder.
  - A hit rewrites `folder` and `path` through `relinkAssets`, keeping their ids.
  - The rest show as Missing in the filmstrip with a Locate action when a page uses them, and are dropped from
    `book.assets` otherwise.

### Outputs

- Workflow plan 13: `book.outputs` are the project's other documents (social posts).
- The open one is `ui.design.outputId`.
- Page actions find a page by id in the book or any output and fit it to that document's template.
  - `locatePage`, `pagesOf`, `templateOf` in `packages/shared/src/outputs.ts`.
- The canvas reads `useDesignBook()` / `currentDesignBook()` (`store/design.ts`).
- `addOutput` and friends: `store/outputs.ts` (plan 56: `addPhotoPost`, the Carousel's one photo per frame).
- Plan 56: `components/design/NextChooser.tsx`, the "What's next" sheet on `DialogShell`, mounted by `routes/book.tsx`:
  `chooserDue` (outputs empty and not `chooserSeen`, per machine under `photobook.design.chooserSeen.<projectId>`),
  `openNextChooser` (New… in `OutputMenu.tsx`), `keeperIds`; its cards call `openExport` with a built-in preset,
  `addPhotoPost`, `addOutput` and `describePhotosAction`. The kitchen sink's Design page shows it (`ChooserSheet`).

### Library and Cull

- Library (plan 05): `src/store/library.ts`.
  - The per-folder library slice of the book store: ratings, flags, develop by hash in `<folder>/.photobook/library.json`.
  - `useLibraryStore`: every imported folder's photos (`folders[id].photos`, scan / hash / prepare, one scan and one hash
    job at a time).
  - Folder index `<folder>/.photobook/index.json`: `read_index` / `write_index` in `commands/folders.rs`; `scan_folder`
    copies matching entries onto the scan.
  - `commands/library.rs`, `LibrarySchema` in `packages/shared/src/library.ts`.
  - Index fields (plan 38): `PhotoFacts` (`taken`, `make`, `model`, `lens`, `focal`, `phash`, `stats`; plan 52:
    `shutter`, `aperture`, `gps`; plan 56: `palette`) in `commands/assets.rs` and `lib/tauri.ts`, flattened into
    `IndexEntry` / `ScannedFile` / `AssetInfo` / `PhotoFile`. The Exif ones come from
    `crates/develop/src/decode/camera_meta.rs`. `prepare` computes the proxy ones (`proxy_facts`: hash, stats, palette)
    on the proxy pixels; `cached()` backfills an older `meta.json` (`factsVersion` below `FACTS_VERSION`, now 3, or a
    missing `phash` / `stats` / `palette`; the cached `proxy.jpg`). `PHOTO_FACT_KEYS`, `photoFacts` and `captureTime` in
    `store/library.ts`.
- A photo is a `PhotoRef` `{ folder, path, hash }`.
  - Review, Develop and every develop action take a photo id: a project asset id or a library key `${folderId}/${path}`
    (`photoKey`, `photoMeta`, `hasPhoto`).
- `store/assets.ts`: maps the open project's assets onto the library store (`files` is derived).
  - Relinks, renders (`developed` lives on the folder's photo) and adds photos (`addToProject`, `addFolderPhotos`, book
    store `addPhotos`).
- Library data rule: ratings, flags and develop settings are written through the book store actions.
  - They call `writePhotoFields`, which also updates the in-memory book mirror.
  - Read them with `assetDevelop` / `assetRating` / `assetFlag` / `resolvedAssets` / `libraryBook` (`store/library.ts`),
    never straight from `book.assets[id]`.
  - Develop resolves everywhere through `resolveAssetDevelop` (`packages/shared/src/library.ts`): `developSnapshot`, then
    the library (the asset's `version` or the master), then the legacy `asset.develop`.
  - The saved book leaves the mirror out of hashed assets (`bookForDisk`); the publish CLI reads each folder's
    `library.json`.
- Cull (plan 06): `components/cull/`.
  - `CullGrid`, its keys in `keys.ts`.
  - `CullView` switches grid and Review by `ui.cull.view`.
  - The selection is in `ui.selection` (`{ keys, anchor }`).
  - Skin (plan 47): `CullGrid.tsx` draws the cells (`CullCell`: 4 px radius, hover lift, white selection ring and
    check, star pop, flag stamp, reject dim, blur-up, the opening stagger through `data-opening` and `--i`), one
    sliding `FocusRing` per grid, and `CullPill` (the floating batch pill on `ui/Pill`; the grid's end padding grows by
    `PILL_CLEARANCE` while it shows). `marks.tsx` holds what every Cull tile shares (`SelectCheck`, `FlagStamp`,
    `tileRings`, `dimClass`, `useChanged`) and the batch underline (`WorkLine` over `batchWork(jobs)`). Survey's tile
    removal is a view transition (`withViewTransition` in `SurveyView.tsx`; CSS in `styles.css`). The motion
    (`star-pop`, `flag-stamp`, `cell-in`, `--stagger`) is in `styles.css`.
  - `src/components/fixture/CullSink.tsx`: the kitchen sink's Cull page (`#/fixture?tab=sink&page=cull`): every cell
    state, the pill, and a live `CullGrid keys={false}` on a synthetic folder (the sink's own arrows move the focus;
    it holds the library, book, jobs and ui stores while shown). `/fixture` is routed in development builds only.
- Cull mouse and the Photo pane (plan 52):
  - The view switch and the one zoom: `CullViewBar` in `components/shell/LibraryFilterBar.tsx` (Grid · One · Two on
    `ui.cull.view`; the zoom is `ui.cull.columns` in Grid and `ui.cull.zoom` in One and Two, per machine under
    `CULL_ZOOM_KEY`). `useLinkedViewport` (`components/cull/viewport.ts`) reads and writes `ui.cull.zoom`. Compare's
    header has no zoom control of its own since plan 49 (K / J / Shift+F still zoom there).
  - `components/cull/CompareView.tsx`: `ViewportPicture` (a photo on the viewport: click focuses, double-click 1× and
    back, drag pans, right-click), `usePictureSource`, and `OnePicture` (One's picture, used by `ReviewMode` in place).
  - `CullGrid.tsx`: the marquee (`cellsInRect`); double-click opens One.
  - `components/cull/CullContextMenu.tsx`: the right-click menu of the grid, One and Two (`useCullContextMenu`,
    `bestOf` for Compare with best), on `Menu.Context`; it reuses `CullMenuItems` (`context`, `head`) and
    `CullGroupItems` from `CullMenu.tsx`.
  - `components/cull/PhotoPane.tsx`: Cull's right pane (Histogram, File, Camera, Signals, In projects; the
    multi-select summary), mounted by `routes/library.tsx` and `routes/projectCull.tsx`. In projects uses
    `placedInProjects` (`rejectPile.ts`, which returns the project `ids`).
  - `src-tauri/src/commands/develop/histogram.rs`: `histogram(hash, developHash?)`; `open_map(lat, lon)` in
    `commands/assets.rs`.
- Cull assist overlays and Group by (plan 53):
  - `components/cull/AssistOverlays.tsx`: `AssistOverlays` (drawn by `ViewportPicture`'s `overlay` in One and Two and
    by `DecidePicture`), `AssistMenu` (Compare's and Decide's *Assist* ▾), `useAssistKeys` (F, Z, O; `assistKeyAction`
    in `keys.ts`; Compare's fit is Shift+F), `SharpnessBar` / `useGroupSharpness` (Two's bars, the Photo pane's "In its
    group" row). State: `ui.cull.assist` (`CullAssist`, per machine under `CULL_ASSIST_KEY`). Focus peak and zebra are
    `render_develop_preview(..., modes)` JPEGs kept in memory (`requestModePreview`, serialised, 12 blob URLs), never a
    cache file.
  - `src-tauri/src/commands/develop.rs`: `render_develop_preview`'s `modes` argument (`parse_preview_modes`,
    `with_modes`); `lib/tauri.ts` `PreviewMode`.
  - `packages/shared/src/cull/groupBy.ts`: `groupBy(entries, key)` → `{ key, label, ids }[]` by hour, day, camera,
    lens or place (500 m), pure (plan 56 reuses it in Design). `CullGrid.tsx` lays the units out in list order with a
    divider row per run of a section (`ui.cull.groupBy` and `ui.cull.collapsed`, per machine under `CULL_GROUP_BY_KEY`
    / `CULL_COLLAPSED_KEY`; `rowTops`, `DividerRow`, `GroupBySelect` in `CullFilters`). Plan 49: `GroupBySelect` is
    the one *Group by* control: Bursts (`ui.cull.grouped`, the default), No grouping, or a divider key (bursts stay
    stacked); plan 39's Group toggle is gone, its ▾ options stay beside the select.
- Storytelling sorts and Group by in Design (plan 56): `packages/shared/src/cull/sorts.ts` (pure: `PhotoSort`,
  `PHOTO_SORTS`, `storyComparator`, `sortKey`, `hexToOklab`, `colourFamily`, `paletteWarmth`, `StoryGroupBy`,
  `storyGroups` over `groupBy` plus colour family and aspect). `FilmstripSort` is `PhotoSort` (`store/ui.ts`;
  `FilmstripView.groupBy` is Design's grouping); `visibleItems` (`components/filmstrip/visible.ts`) and `libraryKeys`
  (`store/collections.ts`) sort through `storyComparator`; `itemSections` / `gridRows` lay out the divider rows of
  `Filmstrip.tsx` (Sort by ▾, Group by ▾; `GroupDivider`, `rowSize`) and `LibraryPanel.tsx` (Group by ▾); the
  sidebar's `LibraryFilters` Sort lists `PHOTO_SORTS`.
- Cull groups (plan 39): `groupPhotos`, `suggestedBest`, `GroupSettings` in `packages/shared/src/cull/groups.ts` (pure,
  over the index's `PhotoFacts`; never stored).
  - `store/cull.ts`: `cullGroups` / `useGroups` (a list's folders grouped whole, one cached result), `cullUnits`,
    `shownFrame`, `groupCounts`, and the override writers (`mergeSelected`, `splitGroup`, `detach`, `ungroup`) on
    `photos[hash].cull.group` through `patchPhoto` outside undo; `useCullStore` holds the spacing and the `,` / `.`
    frame per group; `useCullStageMark` (called by `CullStage`) is what lets `CullFilters` show on Cull only.
  - `CullGrid` lays the units out (group cell, the group open in place, `ui.cull.grouped | expanded`);
    `components/cull/CullFilters.tsx` is Cull's filter fragment (Stars, the Group toggle and menu, the Lens select),
    rendered by the sidebar's Filters section (plan 51; *Decide* and the fraction are the filter bar's since plan 47);
    `CullMenu` (on `Menu.Context`) has Merge, Split and Detach.
  - `scripts/make-burst-fixture.py` writes the git-ignored `fixtures/burst/` for looking at groups by eye.
- Cull Decide pass (plan 40): `components/cull/DecideView.tsx` (`ui.cull.view: 'decide'`; Enter on the grid or the
  filter bar's *Decide*), its keys `decideKeyAction` / `DECIDE_KEYS` in `keys.ts`.
  - `store/decide.ts`: the decisions (`decideKeep`, `decideReject`, `decideUndo`, `decideStep`, `decideFrame`,
    `decideCompare`, `openDecide`) over `cullUnits`, flags written in one store update outside undo (`writeFlags`),
    the pass's own log in `ui.cull.decide` (dropped by `useCullSource` on another source), `decideProgress`,
    `targetCount`, `listFolder`, `setCullTarget`, `markCulled`, `folderCulled`, the pause nudge (`pauseDue`).
  - Library top level `cull?: { target, culledAt }` (`LibraryCullSchema`), written with the book store's
    `patchLibrary` (outside undo). `components/cull/CulledMark.tsx` is the sidebar folder row's ✓.
  - The flag filter's `'undecided'` (`FlagFilterSchema`, `matchesFilter`, `visibleItems`).
- Cull technical lenses (plan 41): `packages/shared/src/cull/lenses.ts` (pure: `LensSchema`, `LENS_THRESHOLDS`,
  `folderStats` (the Soft decile), `lensOf`, `inLens`, `lensesIn`, `lensDetail`, `LENS_CAVEATS`, `groupSharpness`).
  - The lens is `lens` on `FilmstripView` (`store/ui.ts`) and `CollectionFilterSchema.lens`; `matchesFilter` /
    `libraryKeys` (`folderLensStats`, `lensEntry` in `store/collections.ts`) and `visibleItems` (the project's files as
    one folder) filter by it; the built-in *Worth a look* collection is `inLens('any')`. A lens never writes a flag.
  - `store/lenses.ts`: `lensReading` / `useLensReading` (a Cull list id's verdict). `CullFilters` has the *Lens*
    select and caveat (`scope` from `LibraryFilterBar`), `CullGrid` the cell badges, `DecideView` the header tags and
    the strip's sharpest mark and bars, `CullMenu` *Select the group's softer frames* (`softerFrames`).
- Reject pile and the Trash (plan 42): `components/cull/RejectPileView.tsx` (the pile, shown by `CullView` over any
  view while `useRejectPileStore.open`; its `TrashDialog`) and `components/cull/rejectPile.ts` (`useRejectPile`: every
  reject of the Cull list's folders, never the filtered view; `openRejectPile`; `placedInProjects`; `moveToTrash`).
  - `src-tauri/src/commands/photos.rs` `trash_photos(folder, relPaths) -> [{ path, ok, error?, sidecars }]`: the only
    command that removes photos (the macOS Trash, through `projects::move_to_trash`); `ensure_imported_root`, then
    `resolve_rel` and `resolve_in_root` per file, regular photo files only, `.xmp` sidecars by the pair rule.
  - The book store's `dropPhotos(folderId, relPaths)` (library slice in `store/library.ts`): the folder's photos, its
    `index.json` and the library entries no other file of the folder shares; not an undo step.
  - Entry points: Project ▾ (on the Cull stage), the Cull grid's menu, the Decide end state (`onReviewRejects`).
- Collections: built-in in `store/collections.ts`.
  - Saved collections: `<appdata>/collections.json` (`commands/collections.rs`, `useCollectionsStore`,
    `SavedCollectionSchema` in `packages/shared/src/collections.ts`).

### Develop

- `src/components/develop/`: the Develop view.
  - `DevelopMode` owns the keys and the strip.
  - `DevelopPanel` holds the sections.
  - `BatchBar` is the selection's actions; add one with `registerBatchSlot` in `batchSlots.ts`.
  - Plan 54: `DevelopPanel` is seven cards (Crop = `TransformSection`, Light and Color inline, Detail and Sharpen &
    denoise = `DetailSection` / `SharpenSection`, `EffectsSection`, `MasksSection`) under the Basic ⇄ Advanced switch
    (`ui.developAdvanced`, a per-machine pref in `store/ui.ts`). `developCards.ts` is the card manifest (cards, their
    basic controls, their ▸ parts with labels and `edited` tests; `developCards.test.tsx` walks it): a new control is
    registered there. `CardMore.tsx` draws a ▸ part (`CardViewProvider` from the panel: the switch and the opened
    parts). The curve presets are `packages/shared/src/develop/curvePresets.ts` (points only). Before | After modes
    (`CompareMode`, `nextCompareMode`, `Y`) are in `DevelopMode.tsx`; side by side is `SideBySide.tsx` (its own
    viewport state over the pure helpers of `components/cull/viewport.ts`, never Cull's saved zoom). *Apply to all ▾* is `BatchBar.tsx`'s `apply-all` slot (order 0;
    the one slot shown with nothing selected, over `BatchContext.all`). The kitchen sink's Primitives page draws the
    cards (`components/fixture/DevelopSink.tsx`, Basic and Advanced side by side).
  - `VersionStrip` is the photo's versions (plan 08); since plan 49 a card of pill chips in the left pane.
  - Grading wheels (plan 55): `GradingWheel.tsx` (one wheel: angle = hue, radius = saturation, Shift / Alt hold one,
    the lock's spokes and snaps with `tick('alignment')`, the two numbers under it), used by `EffectsSection.tsx` (the
    harmony lock `Select`, the three wheels and the preset chips in Basic; the `effects.wheels` ▸ with the luminance
    sliders and the Global wheel). The lock's maths is `src/lib/develop/harmony.ts` (pure: `dragWheel`,
    `alignToHarmony`, `spokes`, `snapTargets`, `snapHue`); the presets are `packages/shared/src/develop/grading.ts`
    (`GRADING_PRESETS`, `withGradingPreset`, `matchGradingPreset`). The kitchen sink's Primitives page has a Grading
    wheels block (`components/fixture/GradingSink.tsx`, local state).
  - Masks (plan 56): `MaskTools.tsx` draws and edits the shapes (a new linear gradient stores `from` = the release,
    `to` = the press: full at the press; the rotate drags with Shift 15° and the angle badge; Delete / Backspace on a
    selected mask without a component), `MaskOverlay.tsx` the tint plus the shared `RotateHandle`, `AngleBadge`,
    `ROTATE_GAP`, `HANDLE_R`, `MaskMenu.tsx` the right-click menu (`MaskContextMenu`, `useMaskContextMenu`,
    `startComponent`, `convertGradient`) used by `MaskTools` and `MasksSection` (rows with the *Inv* toggle).
  - Plan 51: `DevelopLeftPane.tsx` is the left pane (`LooksSection`, `PresetsMenu`, History, `VersionStrip`), mounted by
    `DevelopMode` while `ui.panes.develop.left`; History is `developHistory.ts` (`historyRows`, `describeDevelopChange`)
    over the book store's undo states (`useBookStore.temporal`), no storage of its own; jumping back is `undo()`.
  - Plan 46: `Slider.tsx` (the needle, the detent, Option + wheel, the edited dot); `PanelCard.tsx` (the panel's
    cards, the reset in the title row; also `ResetIcon`, `MoreIcon`); `renderProgress.tsx` (`usePreview` marks a render
    pending, `useRenderSlow` after 300 ms, `RenderDot`: the header's and the Looks tile's pulsing dot); `BatchBar` and
    `VersionStrip` are pills (`BatchBar` over the picture, `VersionStrip` in the left pane since plan 51); `SplitHandle` in `DevelopMode.tsx` is the view-only before / after split.
- `src/lib/develop/`: pure TS (crop maths, masks, presets, sync, XMP import, curve, geometry twins of the Rust maths).
- `src-tauri/src/commands/{develop,models,xmp,presets}.rs`: Develop renders, AI masks and denoise (all through
  `crates/develop`), model download / delete, Lightroom / Photobook XMP, saved presets.
  - `lib/tauri.ts` has the wrappers.
- Noise profiles (plan 23): `commands/noise.rs`, `crates/develop/src/ai/noise_profile.rs`.
  - `meta.json` carries `exif: { make, model, iso }`.
  - The folder index carries `iso` and `noise` (σ) for the "Needs denoise" collection.
- Full renders: `store/assets.ts` `renderDeveloped` records them and `makeResolver` prefers them when they match the
  asset's `develop`.
- `lib/developPublish.ts`: queues the denoise and render jobs the CLI needs.
- User 3D LUTs (plan 18): `commands/luts.rs`, `store/luts.ts`, `crates/develop/src/lut.rs`; `develop.look.lut` names one
  by id.

### Looks

- Workflow plan 20.
- `lib/develop/looks.ts`: `applyLook` (Amount scaling), `replaceLook`, `lookBase`; a look is a preset with `look: true`.
- `store/looks.ts`.
- `components/develop/LooksSection.tsx`: strip, Amount, ⋯ menu, the _Apply look…_ batch slot; in the left pane (plan 51).
- `render_look_thumbs` in `src-tauri/src/commands/develop/looks.rs`.
- Built-in looks (plan 21): data in `packages/shared/src/develop/looks.ts` (`BUILT_IN_LOOK_DEFS`, bird ids that never
  change; the editor's `BUILT_IN_LOOKS` presets are `builtin:<bird>`).
- Listed by `photobook looks [--json]`.
- Rust fixtures: `crates/develop/tests/fixtures/looks/`.
- Review renders: `--test effects -- --ignored look_review`, the `/fixture` Looks tab, and the synthetic CC0 portrait
  `fixtures/portrait/` (`scripts/make-portrait-fixture.py`).

### AI captions and photo index

- AI captions (plan 32): `src-tauri/src/commands/ai.rs`.
  - Commands: `read_ai_settings`, `write_ai_settings`, `ai_test`, `ai_count_tokens`, `ai_describe`, `ai_caption`,
    `ai_cancel`.
- `src-tauri/src/ai/`: the `Provider` trait, the Anthropic Messages API over `reqwest`, image downscaling, the cancel
  token.
- The key is in `<appdata>/ai.env` (owner-only, read per call, never sent to the webview).
- Requests take photo refs (hash + develop hash, resolved to the cached proxy) or a page render path.
- `store/ai.ts`: settings, usage this month.
- `lib/ai/cost.ts`: estimate.
- `packages/shared/src/ai/pricing.ts`: dated price table.
- `components/settings/AiPanel.tsx`.
- Photo index (plan 33): `photos[hash].ai` on the library entry.
  - `LibraryPhotoAiSchema`, optional, library stays v1; a bad value drops only `ai`.
  - Holds `{ model (requested), servedBy?, at, description, people, setting, timeOfDay, mood }`.
- `lib/jobs/aiIndex.ts`: `planIndex`, `estimateIndex`, `runIndex`, `indexPhotos`.
  - Sends batches of 8 through `describePhotos` as one `ai` job (lane of one).
  - Writes through the book store's `patchPhoto` outside undo.
- `components/ai/DescribePhotos.tsx`: the batch bar slot, the Cull menu item and the cost dialog.
- `indexText(book, library)` in `packages/shared/src/ai/photoIndex.ts`: the index as caption system text.
  - `Photo N` in book order; scope `placed` by default, or `all`.

### Job queue

- Workflow plan 09: `src/store/jobs.ts` (not undoable).
  - Holds long work as jobs `{ kind, label, ref?, project?, done, total, state, error?, ... }`.
  - `enqueue({ kind, label, ref?, project?, dedupe?, run(ctx) })` returns `{ id, created, result }`; `result` never
    rejects.
- Lanes: renders and denoise share one (the GPU), publish one, exports two, `files` one (plan 42's `trash` job).
- Adapters in `src/lib/jobs/`: `enqueueRender`, `enqueueDenoise`.
- `lib/publishRunner.ts`: runs the CLI as a `publish` job.
- `lib/developPublish.ts`: queues the denoise and render jobs it waits on.
- `components/shell/JobsBar.tsx`: status pill (progress ring and count) and list.
- Closing a project cancels its jobs (`lib/jobs/projectClose.ts`).
- Every Rust writer in a job writes a temp file and renames it, so a cancelled job leaves no partial file.

### Export

- Workflow plan 11.
- `packages/shared/src/export.ts`: `ExportPresetSchema`, built-ins, `presetHash`, `fileName`.
- `crates/develop/src/export.rs`: fit, output sharpening, JPEG / PNG / WebP encode, Exif options.
- `src-tauri/src/commands/export.rs`: `export_photo`, `export_status`, presets, `reveal_export`.
  - A custom destination must be dialog-picked this session, never added as a root.
  - `export_photo` recomputes the preset hash with `photobook_develop::export::preset_hash` and refuses a mismatch.
  - It overwrites a file that is not an export of that photo only with `replace`.
- `src/lib/jobs/export.ts`: one `export` job per photo, deduped by cache entry and destination.
- `src/store/exports.ts`: presets with unique names, dialog target, one run per export.
- `src/components/export/`: dialog, toasts, entry points (Cmd+Shift+E, the batch bar slot, the Cull menu, the sidebar
  menus).
- `scan` skips a folder's top-level `Exports/` (`EXPORTS_DIR` in `commands/assets.rs`).
- Plan 12 adds AVIF (sRGB only), HEIC (10-bit, macOS: `crates/develop/src/export_heic.rs`), TIFF (16-bit) and Original +
  XMP sidecar.
  - Watermark and border: `crates/develop/src/ops/watermark.rs`.
  - Commands `export_capabilities` (HEIC available) and `import_watermark` (PNG to `<appdata>/watermarks/<sha256>.png`).

### Slideshow

- Workflow plan 16.
- `packages/shared/src/slideshow/`: settings, frame plan, slides.
- `store/slideshow.ts`: `setSlideshowSettings`.
- `lib/jobs/slideshowExport.ts`: preflight, then one job: gates, CLI `render-slideshow`
  (`packages/publish/src/slideshow.ts`) into `.photobook-publish/slideshow/<id>/frames-<run>/`, then FFmpeg.
- `commands/video.rs`: frames, preflight, encode, audio import.
- `commands/tools.rs` + `tools.toml`: pinned LGPL FFmpeg download, Settings → Tools.
- `commands/process.rs`: process-group kill for CLI children.

### Caches and on-disk layout

| Location                                                                    | Contents                                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `<appdata>/cache/<hash>/`                                                   | `thumb.jpg`, `proxy.jpg`, `meta.json` (source variants; meta holds exif, `phash`, `stats`, `palette`) |
| `<appdata>/cache/<hash>/`                                                   | `{proxy,thumb}-<dh>[-p3].jpg` + `develop-<dh>.json` (developed; `dh` = develop hash, 3 kept)   |
| `<appdata>/cache/<hash>/histogram[-<dh>[-p3]].json`                         | The proxy's 4 × 256 bins (plan 52; pruned with its develop hash)                               |
| `<appdata>/cache/<hash>/noise.json`                                         | The photo's measured noise curve + make / model / ISO (plan 23)                                |
| `<appdata>/cache/<hash>/develop/masks/`                                     | `<componentHash>.png` and `depth-*.png` (AI masks)                                             |
| `<appdata>/cache/<hash>/develop/`                                           | `denoise-<key>[-proxy].png` (+ `.json`; 3 keys kept per photo)                                 |
| `<appdata>/cache/looks/`                                                    | `<baseDh>-<presetKey>-<dh16>.jpg` (240 px Looks strip thumbnails, plan 20; last 3 bases kept)  |
| `<appdata>/models/<name>/<version>/`                                        | Downloaded AI models                                                                           |
| `<appdata>/presets/<ULID>.json`                                             | Saved develop presets                                                                          |
| `<appdata>/luts/<sha256>.cube` + `.json`                                    | User 3D LUTs (plan 18)                                                                         |
| `<appdata>/projects/<ULID>/`                                                | Projects (`project.photobook.json`, `.bak`, `.photobook-publish/`)                             |
| `<appdata>/noise-profiles/<make>-<model>.json`                              | Learned per-camera noise curves (per ISO, RAW and processed apart; plan 23)                    |
| `<appdata>/export-presets/<ULID>.json`                                      | Export presets (plan 11)                                                                       |
| `<appdata>/watermarks/<sha256>.png`                                         | Export watermark PNGs (plan 12)                                                                |
| App cache dir, `gpu-crash-flag`                                             | GPU crash flag                                                                                 |
| `<folder>/.photobook/library.json` (+ `.bak`)                               | Ratings, flags, develop by content hash                                                        |
| `<folder>/.photobook/index.json`                                            | The folder's photo index                                                                       |
| `<source>/.photobook-cache/develop/<hash>-<dh>[-p3].jpg`                    | Full renders                                                                                   |
| `<source>/.photobook-cache/export/<presetHash>/<hash>-<dh>.<ext>`          | Export cache (3 per photo and preset hash), copied to the destination                          |

The develop hash (`dh`) keys every cache and render file name; see `CLAUDE.md` for when it changes.
