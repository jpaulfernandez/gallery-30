# 29 · Canvas: drag moves the frame

Status: done 2026-10-13. The gesture table is pure in `components/editor/gestures.ts` (`pressAction` → toggle-selection / move / pan / swap / deselect plus the Adjust photo mode after the press, `doubleClickAction`); `Canvas.tsx` only reads it. A plain drag on any frame (filled, empty or text) goes through `startElementMove` → `startFrameMove` (snapped, never touches the crop); `MoveBand` stays as the larger grab area. `ui.canvas.adjusting` with `setAdjusting` and the invariant `adjustingHolds` live in `store/ui.ts` (a UI and a book subscription end the mode when the frame stops being the only selection, the page or tool changes, or the photo goes), so Escape (`useEditorShortcuts`, before clearing the selection), a press anywhere else and the toolbar's Adjust toggle all reduce to state changes. In the mode the outline is dashed, handles and band hidden, a hint sits under the frame and the cursor is `grab` (`.editor-canvas[data-adjusting] .pb-photo.pb-selected` in `styles.css`; every other frame shows `move`). What leaves the mode (decided after review): any press outside the canvas `main` (inspector, panels, filmstrip, top bar, so also toggling Preview, which unmounts the canvas and clears it too), a press on another frame or the page background, Escape, another selection, a page or tool change, and the frame's photo being removed or replaced (a different photo dropped on it starts from its own crop); the floating toolbar and the toast are inside the canvas and keep it. Decisions: double-click no longer opens the original (the toolbar's Open original does); outside the mode a pinch zooms the canvas everywhere, inside it the wheel or a pinch over the frame zooms the photo (plain wheel at a fifth of the pinch rate); Space+drag pans only the already selected filled frame, once, without entering the mode; arrows while adjusting still nudge the frame; a press on a member of a multi-selection selects it alone and moves it (multi-frame drag is left for plan 30). Deviation: the nudge stays in the canvas key handler (needs canvas focus) rather than `useEditorShortcuts`, because the filmstrip, page strip and Develop use arrows at window level; it now snaps along the step's axis for a single selected frame, only forward (`snapNudge`, so a frame on a line can always step off it), and the axis's guides flash for 0.6 s through `CanvasGuides` (no gap badges); a multi-selection nudges by plain grid steps. The resize decision was not all "unchanged" in code: Shift now inverts the ratio lock (photos: free, as before; text: keeps the ratio) and Alt resizes from the centre (`resizeFromCentre`, new). Every pointer drag (move, resize, pan) goes through `trackPointerDrag` (gestures.ts), which also ends on window blur and on a move with no button down, so a release lost to Cmd+Tab or an OS dialog cannot leave the undo gesture open. Toast: no reusable toast or save-status slot existed in `components/editor` (the export toast is a separate, sticky component), so a small `Toast.tsx` (one message, optional action, 6 s paused while hovered or focused, an always-mounted `role="status"` live region, focus back to the canvas after Undo or Dismiss, bottom centre of the canvas) and `customPageNotice.ts`: after a move, resize or nudge burst (the nudge notice runs from the idle gesture's end through a new optional `onEnd` on `createIdleGesture` in `store/book.ts`, so its Undo is always the nudge step) turns a layout page (not blank, not already custom) custom, "This page is now custom" with Undo shows once per page per session; it closes as soon as another undo step lands, so its Undo only reverts that edit. Checks: `gestures.test.ts` (press and double-click table, `adjustingHolds`, store transitions), `frameMove.test.ts` (a plain drag on a filled frame moves it and leaves the crop alone in one undo step, Cmd skips snapping, a lost release by buttonless move or blur, `startFrameResize` with Shift and Alt for a locked photo, a free photo and text, the toast once per page across two pages with Undo and its closing, nudge steps, `snapNudge`, the guide flash, the nudge notice at the idle end and with a discrete edit inside the window, `resizeFromCentre`), `Canvas.test.tsx` (double-click enters with hint, pressed button and no handles, Escape leaves, the toolbar toggles, a background press, an outside press and unmounting leave, a replaced photo leaves; with a mocked page rect: plain drag selects and moves, drag pans in Adjust, Space + drag, wheel in and out of Adjust, arrow nudge through the canvas key handler, Shift+click, Alt + drag, double-click on text edits); `snap.test.ts` unchanged and passing; shared Vitest (renderer snapshots) unchanged and passing (nothing in `packages/shared` was touched); editor Vitest 920 passing; editor typecheck and Biome clean. Not tried in the running Tauri app (jsdom only). Docs: DESIGN_NOTES *Canvas gestures*, README *Design canvas keys and gestures*, the Inspector's photo hint and the frame section's ratio-lock tooltip and resize hint (Shift inverts the lock, Alt from the centre). The unused `startTextMove` was removed.

WORKFLOW_PLAN [11](../WORKFLOW_PLAN.md#11-canvas-moving-frames-guides-and-snapping) (W7). Size: 2 days. Depends on: nothing.

**Goal.** A drag on a photo frame moves the frame; panning the picture inside is a mode. Nudge with arrows. The
first move on a layout page says so once.

## Decisions

- Gesture table: drag = move (snapped, guides shown); double-click = *Adjust photo* mode (drag pans, wheel zooms,
  Esc or click outside leaves); toolbar button and Space+drag while selected also adjust; Alt+drag to another slot
  unchanged; resize handles unchanged with Shift (ratio from a corner) and Alt (from centre).
- Arrow keys nudge one grid step, Shift+arrows ten; the guides flash on a snapping step.
- `ui.canvas.adjusting: elementId | null`; the frame shows a dashed outline and a hint in adjust mode.
- Toast "This page is now custom" with Undo, once per page per session.

## Steps

1. `Canvas.tsx` and `gestures.ts`: pointer-down on a filled slot starts a move (through `frameMove.ts`) unless
   adjusting; `MoveBand` in `SelectionOverlay.tsx` stays as a larger grab area but is no longer the only one.
2. Adjust mode: double-click handler, Esc/outside exit, the existing pan and zoom code moved under the mode;
   the floating toolbar gets an *Adjust* button.
3. Nudge in `useEditorShortcuts.ts` through `setFrames` with snapping from `snap.ts`; guides flash via `CanvasGuides`.
4. Toast component (reuse the save-status area or a small `Toast.tsx`); the custom-page transition already exists.
5. Tests: `snap.test.ts` unchanged; new `gestures.test.ts` for the mode state machine; `frameMove` test that a plain
   drag moves and does not pan.

## Check

- Renderer output byte-identical for untouched pages (shared Vitest snapshot).
- A drag on first try moves a frame; double-click pans; Esc leaves; nudge moves by a grid step; the toast appears
  once.

## Docs

- `docs/design/DESIGN_NOTES.md` canvas gestures; `README.md` keys.
