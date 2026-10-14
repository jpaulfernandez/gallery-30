# 51 · Shell panes

ODDHALLS_LAYOUT_PLAN [7 (51)](../../ODDHALLS_LAYOUT_PLAN.md#7-plans), [2](../../ODDHALLS_LAYOUT_PLAN.md#2-the-shell-every-stage) (the three panes), [3](../../ODDHALLS_LAYOUT_PLAN.md#3-cull) (the left pane), [4.3](../../ODDHALLS_LAYOUT_PLAN.md#43-left-pane-looks-luts-presets-history-versions); IMPLEMENTATION_PLAN_38-56 [section 4](IMPLEMENTATION_PLAN_38-56.md#4-interfaces-between-plans) ("Pane state", "CullFilters") and the wave 5 card. Size: 1 day. Depends on: 45, 46

The Layout plan's section 7 has a table row for 51 and no step list of its own; the steps and the Check below are
copied from the sections it names (Layout 2, 3, 4.3, the section 7 row) and the implementation plan's card.

**Shell panes**: left/right/strip hide keys per stage, pane contents moved (Filters section, Looks to the left in
Develop), the Develop header ⋯ menu.

- Three panes and a strip in every stage, so the eye learns one map. `Tab` hides both panes (the picture takes the
  window, the Lightroom key); `Shift+Tab` hides the strip too; the state is per stage and per machine.
- The **right pane is always the tools for the stage** (Cull: decide and inspect; Develop: adjust; Design: inspect
  the selection). The **left pane is always context** (Cull: Library and filters; Develop: Looks and history; Design:
  project photos, library, layouts). Nothing moves between stages.
- **Left pane: Library and filters.** The sidebar as today (Folders, Collections, Projects) plus a **Filters** section
  between Collections and Projects that takes over the filter bar's controls: flag, stars, *Edited*, *ISO ≥*, *Group*
  (plan 39), *Lens* (plan 41), *Sort* (time, name, rating, sharpness, and the colour and luminance sorts of section
  5). The filter bar above the grid keeps only search, the view switch, the zoom, the progress fraction, *Decide* and
  the clear-filters chip, so it stops being a row of eleven controls.
- **4.3 Left pane: Looks, LUTs, presets, history, versions.**
  - **Looks** at the top as the strip is today (plan 20) with Amount; **LUTs** (plan 18) as a row under it;
    **Presets** (the user's) as a list with Save current as preset…. The pane is the "pick a starting point" side;
    the right pane is "adjust".
  - **History**: the undo stack of this photo as rows (Exposure +0.30, Look: Wren, Crop 4:5); click one to jump back
    (the Lightroom history panel, which users ask for first when they come from it). Reads the book store's undo
    history filtered to this asset; no new storage.
  - **Versions** (plan 08's row) moves here as chips under History; *Use in this project* stays with it.

Implementation plan card. Owns: `ui.panes` in `store/ui.ts`, the Tab / Shift+Tab keys (`useEditorShortcuts.ts`,
`keys.ts`, `DevelopMode.tsx`, one handler each), the Filters section in `Sidebar.tsx` (re-parents `CullFilters` plus
flag, stars, Edited, ISO ≥, Sort), `LibraryFilterBar.tsx` reduced to search, view switch, zoom, progress, Decide and
the clear chip, the Develop left pane (`components/develop/DevelopLeftPane.tsx`, new: Looks + Amount, LUTs, Presets,
History, Versions as chips; `LooksSection` and `VersionStrip` move there, their files unchanged), History (reads the
book store's undo entries filtered to the shown asset, no new storage). Pane state: `ui.panes[stage] = { left, right,
strip }`, per machine like `loadCullColumns`; `Tab` and `Shift+Tab` toggle them; every stage's layout reads it. 50's
Home and 52's Photo pane mount inside it.

- Check: the hidden-pane state is per stage and per machine (never in the project file); Tab and Shift+Tab never
  fire inside a text field, a menu or a dialog; the Develop keys (`[` `]`, Cmd+Shift+C / V) still reach their actions
  with the left pane hidden; the Filters section holds the filter controls and the bar keeps search, progress, Decide
  and the clear chip; Looks, Presets, History and Versions show in Develop's left pane.

Status: done 2026-10-13. Landed: `ui.panes` in `store/ui.ts` (`PaneStage` cull | develop | design, `StagePanes`
`{ left, right, strip }`, `loadPanes` under `PANES_KEY` = `photobook.ui.panes`, kept by `reset()`, `setPanes`,
`togglePanes`: Tab hides both side panes when either shows, else shows both; Shift+Tab hides all three when any shows,
else shows all); `paneKeyAction` in `components/cull/keys.ts` (no Cmd / Ctrl / Alt, no key repeat so a held Tab toggles once; never in a text field, on a
focused `a`, `button`, `input`, `select`, `textarea`, `summary` or slider, in a menu or in a dialog) read by one handler
each: `useCullPaneKeys(enabled)` (`components/shell/Panes.tsx`, called by the two Cull routes, by the library route
with `stage === 'cull'` so Tab on Library Develop never touches Cull's panes; not while Develop is open over
Cull, not in Compare, which keeps Tab for its panes, not with a dialog open), `DevelopMode` (`ui.panes.develop`) and
`useEditorShortcuts` (`ui.panes.design`; not with the original modal, the layout picker or text editing open).
`PaneShell` (`components/shell/Panes.tsx`: top bar, left, centre, right, strip) lays out `routes/library.tsx`,
`routes/projectCull.tsx` and `routes/book.tsx`; plan 52's Photo pane is Cull's `right` there. The sidebar's
**Filters** section (Cull only, between Collections and Projects; the project's `filmstrip` view on a project's Cull):
`LibraryFilters` (flag, stars, Edited, ISO ≥, Hide in project / Hide used, Sort, exported from `LibraryFilterBar.tsx`)
and `<CullFilters />` re-parented whole. `LibraryFilterBar` with `filtersInSidebar` (the Cull stages) keeps search, its
own "n/N decided" fraction and *Decide* (`DecideBar`, from `decideProgress` / `openDecide`), the counts and Clear
filters. `components/develop/DevelopLeftPane.tsx` (220 px, mounted by `DevelopMode` while the left pane shows):
`LooksSection` (Amount and the LUT picker inside it), Presets (`PresetsMenu`, moved from the right panel's header),
History (`developHistory.ts`: `historyRows` over `[...pastStates, current]` of `useBookStore.temporal`, the steps that
changed this photo's settings, newest first, labelled by `describeDevelopChange`: "Exposure +0.30", "Red hue −12",
"Look: Wren", "Crop", "Transform", "Reset all", else the sections; a row undoes back to it with `undo()` when every
later step changed this photo and nothing else (`onlyThisPhoto`: the two undo states share every reference but this
asset's book `develop` and its library entry, so Sync…, Reset edits on a selection or a paste across photos block the
jump), otherwise it is listed only (`aria-disabled`, greyed, and one muted line under the list: "Older steps also
changed other photos; use Undo."), since undo is one stack for the project; accessible names "History: …"), Versions (`VersionStrip` in a 48 px box, moved from over the picture). The right
panel (`DevelopPanel`) lost Looks and Presets. The built-in *Picks* collection is labelled *Kept* (id `picks` kept).
Kitchen sink → Shell: the Filters section (the real `LibraryFilters`), the bar's fraction and Decide, Tab and a
toggle button for the panes. Tests: `components/shell/Panes.test.tsx` (state per stage and machine, not in the book,
the guards, `PaneShell`, Compare and Develop leave Cull's Tab alone, the Design keys),
`components/develop/DevelopLeftPane.test.tsx` (the pane's cards, History rows, jump and the greyed row, Tab / Shift+Tab,
`[` `]` and Cmd+Shift+C / V with the left pane hidden, a Sync… step blocking the jump, the labels), `router.test.tsx` (Filters in the sidebar, not in
the bar; Tab from the search field does nothing, from the page hides the sidebar, per stage).
Decision (review, 2026-10-13): Tab and Shift+Tab keep the Lightroom behaviour Layout 2 locks: they toggle from the
page and from a focused grid cell, and real controls keep their Tab. Follow-ups: a keyboard-only way out of the grid
(a region-cycling key or a visible pane toggle) goes to plan 49's accessibility sweep; an "Original" row at the foot of
History (the photo before the first step shown) is not in this plan.
Deviations: the Layout plan has no step list for 51 (the steps above are its sections 2, 3, 4.3 and the card). Library
Develop shows no Library sidebar (Layout 2: Develop's left pane is Looks and history), so its filters stay in the bar
there, as in the Design stage's Library tab. `CullFilters` still draws its own Decide and fraction, so on Cull they
show twice (sidebar and bar) until plan 47 removes the fragment's copies (47 owns the file). LUTs stay inside
`LooksSection` (its file unchanged) instead of a row of their own; Versions keep the pill's look in the pane (the
file unchanged), for plan 49 to restyle as chips. Cull has no strip and no right pane yet: Shift+Tab stores the strip
and 52's Photo pane will read `right`. The crop tool's panel shows with the right pane hidden (it holds Apply and
Cancel). The Develop header ⋯ menu was already plan 46's. With the left pane hidden, `DevelopMode` loads the saved
looks itself so `[` `]` reach them. Not verified: the panes in the running Tauri editor (no `tauri dev`); checked in
the kitchen sink's Shell page under Vite (Tab hides and shows the sidebar) and by the tests.
