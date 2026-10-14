# 10 · Copy settings and paste to selection

Status: done 2026-10-13, with these deviations. `tauri-plugin-clipboard-manager` (Rust crate, the JS package and
`clipboard-manager:allow-read-text` / `allow-write-text`) is text only, so there is no typed
`application/x-photobook-develop` entry on the system clipboard: the JSON carries it as `type` (`{ type, version,
sections, settings }`, `lib/develop/clipboard.ts`; `zod` is now a direct editor dependency for its schema) and the typed
form is the in-memory copy (`components/develop/copyPaste.tsx`), which wins over the system clipboard within a session;
the system text is read only when memory is empty (after a restart), on a user's paste, and foreign text is ignored.
`settings` holds only the copied sections. Sections: Sync's, with Detail split into Detail and **AI denoise** and **Crop
and straighten** added (rect, angle, aspect; shrunk into the warped picture when constrained); rotation and flips are
never copied. The store's `copyDevelop(id, sections)` now returns the payload and `pasteDevelop(ids, clip)` applies it
(Sync shares the same `pasteSections`); the module-level clipboard in `store/book.ts` is gone. `ui.copySections` is
persisted per machine (`photobook.ui.copySections`); the dialog's **Remember** box (on by default) sets it. Paste from
previous uses the remembered sections and leaves the clipboard alone. The panel keeps Copy and Paste (this photo) and
gains Copy…; Cmd+Shift+V pastes onto the strip selection, else the photo shown; the batch bar slot is *Paste to
selected*. The Cull grid had no context menu: `CullMenu` is new (Copy settings, Copy settings…, Paste settings, Reset
edits; right-click selects the photo first when it is outside the selection). There is no help overlay in the app; the
keys went into `CULL_KEYS`, the Cull grid's hint line, `docs/DEVELOP.md` and the README. Alt combinations match
`e.code` (Alt changes `e.key` on a Mac). After review: a pasted crop is fitted like the crop tool fits one (`fitCropTo` in `lib/develop/cropEdit.ts`: aspect
lock in the target's frame, inside the rotated or warped picture with constrain on; `keepCropInWarped`, which the 90°
turns and flips use, is unchanged); masks that match ids aside are kept, so a second paste is no change and no undo
step; `pasteDevelop` skips the photo copied from (`clip.source`, known only for a copy made in this session); the Cull
grid ignores keys while a dialog is open; a payload marked as ours that this build cannot read (another version,
invalid, or past 100 masks / 100,000 brush points / 4 M characters, checked before validation) shows a notice
(`PasteNotice`, in the batch bar and under the Cull grid); `syncTone` is gone (Sync uses `applySections`); Sync and
Copy Settings share `SectionChecklist`. Verified by Vitest (payload round trip and foreign text, sections honoured,
paste onto 20 photos one undo step, paste from previous under name and capture-time sort, system clipboard read after
the memory copy is gone, keys ignored in a contenteditable and behind an open dialog, a straightened 3:2 crop pasted
onto a portrait photo, a second mask paste is no change, size bounds and the unreadable-clip notice). Not verified: a real restart of the app (needs the built
app; the restart path is covered only with the plugin mocked), and macOS asking for pasteboard access on read.

WORKFLOW_PLAN [3](../WORKFLOW_PLAN.md#3-copy-and-paste-edits) (W3.1, W3.2). Size: 2 days. Depends on: 08.

**Goal.** Choose what to copy, paste onto many photos in Develop or Cull in one undo step, paste from the previous
photo, and keep the clipboard across projects and restarts.

## Decisions

- Keys: Cmd+Shift+C copies with the last section choice; Shift+Cmd+Alt+C opens the Copy Settings dialog;
  Cmd+Shift+V pastes onto the selection (or the open photo); Cmd+Alt+V pastes from the previous photo in the strip.
- Clipboard payload: system clipboard with `application/x-photobook-develop` JSON `{ version, sections, settings }`
  and a text fallback (the same JSON), written and read through `tauri-plugin-clipboard-manager` (text) plus an
  in-memory copy for the typed form. The dialog choice is remembered in `ui.copySections`.
- Default sections on: everything except Crop, Transform and Masks; Denoise is its own checkbox.
- Masks paste at the same position with the warning line Sync uses; AI masks re-run on the target (cache is keyed by
  component hash and source hash).

## Steps

1. **Dialog.** `components/develop/CopySettingsDialog.tsx` from `SyncDialog` with the target list removed; sections from
   `lib/develop/sections.ts`; Check all / none; "Remember".
2. **Lib.** `lib/develop/clipboard.ts`: `encode(settings, sections)`, `decode(text)` with Zod, `applySections` from
   `sync.ts`; `previousOf(refs, current)`.
3. **Store.** `pasteDevelop(refs, payload)`: one Immer batch across all targets, one zundo step (same pattern as
   `reviewAssets`); library write-through per hash.
4. **Wiring.** Keys in `DevelopMode` and in the Cull grid; **Paste** mounts in the batch bar (08); Cull context menu
   gets Paste settings and Reset edits.
5. **Shortcuts.** Add to the shortcuts test and the help overlay; make sure Cmd+Shift+C/V do not fire inside the
   text editor on the canvas.

## Check

- Vitest: round-trip encode/decode, sections honoured, paste onto 20 refs is one undo step, paste from previous picks
  the right neighbour under each sort.
- Restart the app, paste: the settings copied before quitting apply.

## Docs

- `docs/DEVELOP.md` copy and paste; `README.md` keys.
