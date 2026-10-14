# Workflow plans: index

Plans 01–36 and 38–56 are done and archived in [../archive/plans/](../archive/plans/) (each has its `Status:` line;
[49's](../archive/plans/49-delight-and-polish.md) collects the owner's checklist for 38–56: the native-menu flag, the
site screenshots and the checks only a real folder and window can show). Only open plans stay in this folder.

## Open work

- Next: a region-cycling key (F6) for Cull, designed with 51's Tab (plan 49 left the keyboard trap in the Cull grid as
  a documented limitation).
- [37 · Tiled full render](37-tiled-full-render.md), not started.
- The owner's checklist for 38–56 ([plan 49's Status](../archive/plans/49-delight-and-polish.md)).

Oct 12, 2026 · [WORKFLOW_PLAN.md](../archive/WORKFLOW_PLAN.md) split into session-sized implementation plans. One file is one
coding session (roughly one to two developer-days with agents), cut vertically: each plan goes schema → Rust →
store → UI → tests → docs for one feature, and is done when its **Check** list passes. Part three of the workflow
plan (library first, project = output) supersedes its sections 1.1, 2.1 and 2.2, and these plans follow part three.

## How to run a plan

1. Read the plan, then the WORKFLOW_PLAN sections it cites. The plan is the contract; the section is the reasoning.
2. Lock the decisions listed under *Decisions* in the plan before writing code.
3. Finish the Check list, run `pnpm typecheck`, `pnpm lint`, the Vitest suites and `cargo test` where Rust changed.
4. Update the docs the plan names, and add a one-line status under the plan's title (`Status: done <date>` or what was
   left out and why).

## Names (decided Oct 12, 2026)

The sidebar is **Library** (Folders, Collections, Projects); the stage tabs are **Cull · Develop · Design**; the action
is **Publish**. Code identifiers follow them (`/cull`, `/develop`, `/design`, `components/cull`, `components/design`).
The WORKFLOW_PLAN calls the stages Cull / Edit / Display: "Edit" collides with the canvas's existing *Edit | Preview*
toggle and "Develop" is already the module's name, and "Display" is replaced by **Design** for the stage and by
**output** for the documents a project holds (the schema field is `outputs`, the UI says Book, Post, Print, Slideshow;
the word "display" is not used anywhere user-facing). The bird taxonomy goes on names of things people pick or make
(the app and cloud names, the built-in looks in plan 21, templates), not on navigation.

## Decisions to lock before plan 01

From WORKFLOW_PLAN sections 7, 13 and 14.7, condensed, plus two this split adds.

| Decision | Recommendation | Why |
| --- | --- | --- |
| Where edits live | Per-folder library `<folder>/.photobook/library.json`, keyed by content hash; per-project versions | One cull and one edit for every project on a folder; hash keys already drive relink and caches |
| Project file | `<appdata>/projects/<ULID>/project.photobook.json`, Save as anywhere | A project spans folders, so it cannot live in one |
| Asset reference | `{hash, folder, path, version?}` resolved live through the library; opt-in `developSnapshot` | No copies, one render per edit, edits propagate |
| Destructive edits | Never; Export writes copies | Hash-keyed caches, ids and relink would break; RAW cannot be written back |
| Schema bump | One bump to v8 in plan 03 carrying every new field (`folders`, asset refs, `outputs`, `captions`, `page.guides`) | One migration, not four |
| Engine bump | One bump to `develop-engine/3` at the end of plan 19, not per op | Each bump invalidates every cached render |
| Social posting | Files plus a caption `.txt`, no network APIs | Every API needs an app review; files work with every scheduler |
| Look data | Author parametric looks; users import LUTs; fit LUTs from their camera | No permissive film LUTs found; film names are trademarks |
| Chroma denoise | Classical guided filter on a/b; models stay for luminance | No permissive chroma model exists; the filter is fast and works on JPEG |
| Per-camera denoise | Noise profiles (self-measured, then learned per camera), not per-brand models | What every serious tool does |
| Canvas drag | Drag moves the frame; pan is a double-click mode | Matches every other layout tool |
| AI provider | Anthropic first, `claude-opus-5-5` default, key in `<appdata>/ai.env` read by a Rust command | Same pattern as the publish credentials; never in the webview or the folder |
| **Stage labels** (decided) | Cull · Develop · Design, with Library as the sidebar | See *Names* above |
| **Outputs field name** (decided) | `outputs`, not the source plan's `displays` | A field named after a word the UI never shows ages badly; renaming after v8 ships is another migration |

## The plans

| # | Plan | WORKFLOW_PLAN | Days | Depends on |
| --- | --- | --- | --- | --- |
| 01 | [Folders registry and scope](../archive/plans/01-folders-registry-and-scope.md) | 14.1, 14.7 | 1 | — |
| 02 | [Library file and write-through](../archive/plans/02-library-file-and-write-through.md) | 2.2, 14 | 2 | 01 |
| 03 | [Project schema v8, migration, CLI resolution](../archive/plans/03-project-schema-v8-and-cli.md) | 1.3, 11.2, 12.6, 14.2, 14.6 | 2 | 02 |
| 04 | [Projects in app data, Home, relink](../archive/plans/04-projects-home-and-relink.md) | 14, 14.6 | 2 | 03 |
| 05 | [Library browsing: Cull and Develop without a project](../archive/plans/05-library-browsing-and-stages.md) | 14.1, 2.1 (W2.1) | 2 | 04 |
| 06 | [Cull grid, selection, collections](../archive/plans/06-cull-grid-and-selection.md) | 1.1, W2.2 | 1.5 | 05 |
| 07 | [Cull compare and survey](../archive/plans/07-cull-compare-and-survey.md) | 1.1, W2.2 | 1 | 06 |
| 08 | [Develop strip, batch bar, versions](../archive/plans/08-develop-strip-batch-bar-versions.md) | 1.1, 2.2, 14.2, W2.3 | 1.5 | 06 |
| 09 | [Job queue](../archive/plans/09-job-queue.md) | W2.4, 5.3 | 1 | 05 |
| 10 | [Copy settings and paste to selection](../archive/plans/10-copy-paste.md) | 3, W3 | 2 | 08 |
| 11 | [Export from Develop: core](../archive/plans/11-export-core.md) | 14.4, W4.0 | 2 | 09 |
| 12 | [Export formats and extras](../archive/plans/12-export-formats-and-extras.md) | 14.4 | 1 | 11 |
| 13 | [Output documents](../archive/plans/13-output-documents.md) | 1.3, W4.1 | 1 | 04 |
| 14 | [Social post](../archive/plans/14-social-post.md) | 1.2, W4.2 | 2 | 13 |
| 15 | [Print PDF (later)](../archive/plans/15-print-pdf.md) | 1.2, W4.4 | 2 | 13 |
| 16 | [Slideshow video (later)](../archive/plans/16-slideshow-video.md) | 1.2, W4.5 | 3 | 13, 09 |
| 17 | [Effects ops on the CPU](../archive/plans/17-effects-ops-cpu.md) | 4.1, W5.1 | 2 | — |
| 18 | [3D LUT op](../archive/plans/18-lut-op.md) | 4.1, 4.2, W5.2 | 2 | 17 |
| 19 | [Effects GPU port and engine bump](../archive/plans/19-effects-gpu-and-engine-bump.md) | 4.1, W5.3 | 1.5 | 18 |
| 20 | [Looks UI](../archive/plans/20-looks-ui.md) | 4.2, W5.4 | 2 | 19, 08 |
| 21 | [Built-in looks](../archive/plans/21-built-in-looks.md) | 4.3, W5.5 | 1.5 | 20 |
| 22 | [Match camera JPEG (optional)](../archive/plans/22-match-camera-jpeg.md) | 4.3, W5.6 | 2 | 18 |
| 23 | [Noise profile](../archive/plans/23-noise-profile.md) | 9, W6.0 | 2 | — |
| 24 | [Classical chroma denoise path](../archive/plans/24-chroma-filter-path.md) | 5.1, W6.1 | 2 | 23 |
| 25 | [Frequency-aware luminance merge](../archive/plans/25-wavelet-luminance-merge.md) | 5.1, W6.2 | 1 | 24 |
| 26 | [Denoise model evaluation](../archive/plans/26-denoise-model-evaluation.md) | 5.2, W6.3 | 2 | 24 |
| 27 | [Denoise queue and suggestions](../archive/plans/27-denoise-queue-and-suggestions.md) | 5.3, W6.4 | 1 | 09, 08, 23 |
| 28 | [Denoise UX](../archive/plans/28-denoise-ux.md) | 10, W6.5 | 2 | 27, 24 |
| 29 | [Canvas: drag moves the frame](../archive/plans/29-canvas-drag-moves-frame.md) | 11, W7 | 2 | — |
| 30 | [Canvas: smart guides and alignment toolbar](../archive/plans/30-canvas-smart-guides-and-alignment.md) | 11, W7 | 2 | 29 |
| 31 | [Canvas: rulers and page guides](../archive/plans/31-canvas-rulers-and-page-guides.md) | 11, W7 | 1 | 30, 03 |
| 32 | [AI settings and the Messages command](../archive/plans/32-ai-settings-and-command.md) | 12.4, 12.5, W8 | 2 | — |
| 33 | [Photo index](../archive/plans/33-photo-index.md) | 12.3, 14.5, W8 | 1 | 32, 02, 09 |
| 34 | [Caption brief and element captions](../archive/plans/34-caption-brief-and-element-captions.md) | 12.1, 12.2, 12.5, W8 | 2 | 33 |
| 35 | [Page and book captions, alt text](../archive/plans/35-page-and-book-captions.md) | 12.1, 12.3, 12.5, W8 | 2 | 34 |
| 36 | [Platform budgets (optional)](../archive/plans/36-platform-budgets.md) | 15 | 1 | — |
| 37 | [Tiled full render (next, not started)](37-tiled-full-render.md) | 15 | 2 | 36 |
| 38 | [Index: capture time and photo stats](../archive/plans/38-index-capture-time-and-stats.md) | [CULL](../CULL_PLAN.md) 7 | 1.5 | — |
| 39 | [Groups in the grid](../archive/plans/39-cull-groups.md) | CULL 4.2, 6, 7 | 2 | 38 |
| 40 | [The Decide pass, target and progress](../archive/plans/40-decide-pass.md) | CULL 4.3, 7 | 2 | 39 |
| 41 | [Technical lenses](../archive/plans/41-technical-lenses.md) | CULL 4.4, 7 | 1 | 38, 39, 40 |
| 42 | [The reject pile and the Trash](../archive/plans/42-reject-pile-and-trash.md) | CULL 4.5, 7 | 1.5 | 40 |
| 43 | [Native shell and the Tauri artifacts](../archive/plans/43-native-shell-and-tauri-artifacts.md) | [UI](../ODDHALLS_UI_PLAN.md) 1, 4.3, 6 | 2 | — |
| 44 | [Tokens v2](../archive/plans/44-tokens-v2.md) | [UI](../ODDHALLS_UI_PLAN.md) 2.2, 2.3, 6 | 1.5 | 43 |
| 45 | [Primitives and the shell](../archive/plans/45-primitives-and-shell.md) | [UI](../ODDHALLS_UI_PLAN.md) 4.1, 3, 6 | 2.5 | 44 |
| 46 | [Slider v2 and the Develop panel](../archive/plans/46-slider-v2-and-develop-panel.md) | UI 4.2, 4.3, 6 | 2 | 45 |
| 47 | [Cull, Compare, Survey skin](../archive/plans/47-cull-compare-survey-skin.md) | UI 3, 4.4, 6 | 1.5 | 45, 40 |
| 48 | [Design canvas chrome](../archive/plans/48-design-canvas-chrome.md) | [UI](../ODDHALLS_UI_PLAN.md) 3, 6 | 1.5 | 45 |
| 49 | [Delight and polish pass](../archive/plans/49-delight-and-polish.md) | UI 4.4, 6; [Layout](../ODDHALLS_LAYOUT_PLAN.md) 6 | 1.5 | 46, 47, 48, 56 |
| 50 | [Home](../archive/plans/50-home.md) | [Layout](../ODDHALLS_LAYOUT_PLAN.md) 1, 7 | 1 | 44, 45, 40 |
| 51 | [Shell panes](../archive/plans/51-shell-panes.md) | [Layout](../ODDHALLS_LAYOUT_PLAN.md) 2, 3, 4.3, 7 | 1 | 45, 46 |
| 52 | [Cull mouse and the Photo pane](../archive/plans/52-cull-mouse-and-photo-pane.md) | [Layout](../ODDHALLS_LAYOUT_PLAN.md) 3, 7 | 2 | 38, 45, 47, 39, 42 |
| 53 | [Cull assist overlays and Group by](../archive/plans/53-cull-assist-overlays-and-group-by.md) | [Layout](../ODDHALLS_LAYOUT_PLAN.md) 3, 7 | 1.5 | 41, 52 |
| 54 | [Develop Basic ⇄ Advanced](../archive/plans/54-develop-basic-advanced.md) | [Layout](../ODDHALLS_LAYOUT_PLAN.md) 4.1, 4.5, 4.6, 7 | 2 | 46, 51 |
| 55 | [Color grading wheels (engine bump)](../archive/plans/55-color-grading-wheels.md) | [Layout](../ODDHALLS_LAYOUT_PLAN.md) 4.2, 7 | 1.5 | 54 |
| 56 | [Masks, storytelling sorts, the chooser](../archive/plans/56-masks-and-storytelling-sorts.md) | [Layout](../ODDHALLS_LAYOUT_PLAN.md) 4.4, 5, 7 | 2 | 43, 52, 51 |

Plans 38–56 each have an archived file; their contracts are the three source documents, and
[IMPLEMENTATION_PLAN_38-56.md](IMPLEMENTATION_PLAN_38-56.md) holds the dependency graph above, the eight waves, file
ownership, the cross-plan interfaces and the gates. A plan's file (`NN-<slug>.md`, names listed there) is created from
its source section when its session starts.

## Order and parallel tracks

Plans 01 to 05 are the foundation and run in order. After 05 the tracks are independent and can run side by side,
one session each:

- **Shell**: 06 → 07, 08, 09, then 10.
- **Outputs**: 11 → 12; 13 → 14 (→ 15, 16 later).
- **Looks**: 17 → 18 → 19 → 20 → 21 (→ 22). Only 20 needs the shell (08).
- **Denoise**: 23 → 24 → 25, 26; 27 → 28 need 08 and 09.
- **Canvas**: 29 → 30 → 31. Independent of the library work except 31 (`page.guides` lands in plan 03).
- **Captions**: 32 → 33 → 34 → 35. 33 caches in the library (02) and runs in the queue (09).

Plans 38–56 run in eight waves across three tracks (Cull, Skin, Layout). Plans in one wave run side by side:

1. Wave 1: 38 ∥ 43.
2. Wave 2: 39 ∥ 44.
3. Wave 3: 40 ∥ 45.
4. Wave 4: 41 ∥ 42 ∥ 46 ∥ 48.
5. Wave 5: 47 ∥ 50 ∥ 51.
6. Wave 6: 52 ∥ 54.
7. Wave 7: 53 ∥ 55 ∥ 56.
8. Wave 8: 49.

Dependencies, file ownership, cross-plan interfaces and gates are in
[IMPLEMENTATION_PLAN_38-56.md](IMPLEMENTATION_PLAN_38-56.md) section 3 and after; the working rules every agent follows
are in [RULES.md](RULES.md).

## Not split

- WORKFLOW_PLAN section 16 (going public, "Photobook Cloud") is a product decision with its own workstream (Worker
  accounts, signed uploads, a cloud publish target). It needs its own plan once the hosting decision is made.
- Section 15's alternatives (Swift shell, Rust-native GUI, wasm) are not planned; plan 36 only measures the budgets
  that would justify them and tries the one in-Tauri fix that pays regardless.
- Section 14.7's W1.5 docs step is folded into each plan's *Docs* list.
- The cull workflow redesign ([CULL_PLAN.md](../CULL_PLAN.md), plans 38–42) and the oddhalls skin and layouts
  ([ODDHALLS_UI_PLAN.md](../ODDHALLS_UI_PLAN.md), 43–49; [ODDHALLS_LAYOUT_PLAN.md](../ODDHALLS_LAYOUT_PLAN.md),
  50–56) are planned in their own documents and scheduled in
  [IMPLEMENTATION_PLAN_38-56.md](IMPLEMENTATION_PLAN_38-56.md); their files appear here as each session starts.

## Why these names

The ask was an information architecture of the app's own without abandoning the words photographers know. The
reasons behind the decision above:

- *Cull* and *Develop* are Lightroom's and Photo Mechanic's words and already the README's. "Edit" collides with the
  canvas's Edit | Preview toggle and with "the editor". "Curate" overlaps with what the Design stage does (choosing
  what goes where).
- *Design* names the activity; "Canvas" names a surface (Develop has one too), "Display" is ambiguous with screens
  and settings. The kind of output (Book, Post, Print, Slideshow) is the Design stage's drop-down, which is where the
  word "project" meets the user.
- A bird taxonomy, as in bowr, works best on the things people pick or make, not on navigation: the app and cloud
  names, the built-in looks (section 4.3 bans film brand names, and bird names are free and memorable: a pushed
  black and white called *Rook*, a cool negative called *Heron*), templates. Navigation labels carry the cost of
  being learned once per user, and the familiar words pay that cost for free.
