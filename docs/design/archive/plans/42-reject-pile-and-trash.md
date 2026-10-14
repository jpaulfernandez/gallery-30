# 42 · The reject pile and the Trash

Status: done 2026-10-13 except the human check (below).
Landed: `src-tauri/src/commands/photos.rs` (new) `trash_photos(folder, relPaths) -> Vec<{ path, ok, error?, sidecars }>`
(`assets::source_root`, i.e. `ensure_imported_root`; per file `resolve_rel` then `resolve_in_root`, which also holds
the path to that one root after symlinks; only a regular, non-link photo file the scan would list, no hidden
component; `<file>.xmp` always goes along, `<stem>.xmp` only once no other photo of that stem stays, so a RAW+JPEG
pair's sidecar goes with the last of the pair; names in any case; moved with `projects::move_to_trash`, the
`NSFileManager` route of Delete project; a failure is that file's result, never the call's; registered in `lib.rs`,
`mod.rs`), its Rust tests on a temp root with a stand-in Trash (`..`, `./`, absolute, empty and sibling-root paths and
a symlink out of the root refused; folders, links, hidden, `.photobook-cache` and non-photo files refused; a RAW moves
with its `.xmp`, the other RAW keeps its own; the pair rule in one call and in two; a failing file does not stop the
rest; a sidecar that stays is reported on a moved photo; the result's JSON); `trashPhotos` / `TrashResult` in
`lib/tauri.ts`; the book store's `dropPhotos(folderId, relPaths)` on the library slice (`store/library.ts`): the
library store's folder loses the photos (progress adjusted), `index.json` is written at once, and the library entries
whose hash no file left in the folder has are deleted outside undo (autosave writes `library.json`);
`components/cull/rejectPile.ts` (new: `pileFolders`, `rejectPile`, `useRejectPile`, `useRejectPileStore` /
`openRejectPile` / `closeRejectPile`, `sizeLabel`, `placedInProjects`, `trashEntries`, `moveToTrash`, `outcomeText`);
`components/cull/RejectPileView.tsx` (new: the pile and `TrashDialog`); `CullView` shows the pile over any view while
open and hands `openRejectPile` to `DecideView`'s `onReviewRejects`, `CullStage` and a new source close it; the entry
points: Project ▾ *Review rejects…* while a Cull stage is mounted, the Cull grid menu's *Review rejects…*, the Decide
end state's existing button (all disabled with no reject); `store/jobs.ts` kind `trash` on a new `files` lane (one at a
time). Vitest `components/cull/RejectPileView.test.tsx` (11): the pile is the folder's full reject set with *Kept only*
on and the dialog says 3 (the full pile); U rescues the focused photo (undecided, leaves the pile, focus to the next),
Cmd+A then U the rest, no undo step; Esc back; the placed-in-project line (the open project from memory, another
project from its file, a project on another folder never read), the checkbox on by default and the count following
it; after a move with one failure the store, `index.json` and `library.json` lose the moved photos only, the pile
closes, the grid focus lands on the next photo that stayed and the toast names the failure; a library entry stays
while another file has the same bytes; a project placing a moved photo keeps its asset id and has it in `missing`; a
pile over `TRASH_INLINE_MAX` runs as one `trash` job in chunks of 20; Project ▾ and the grid menu open the pile, Project
▾ only on Cull and disabled with no reject. `DecideView.test.tsx`: *Review rejects…* now opens the pile.
Deviations: the pile is every reject of the folders the Cull list draws from (`ui.review`): for a folder that is the
folder's pile whatever the filter, for a collection the rejects of the folders it shows; an empty list (a filter that
shows nothing) has no pile. The move runs from the webview in chunks of 20 per `trash_photos` call (CULL says "not a
job"; the brief asked for a job past a handful): up to 10 photos inline, more as a `trash` job with a busy toast, and
a cancel stops between chunks; each chunk's moved photos are dropped at once, so a cancel leaves the store true to the
disk. "Placed in a project" means the project has the photo as an asset (as *Hide in project*), the safe reading;
other projects are read from their files through the folder paths Home resolves. Moving placed photos anyway marks
the open project's assets Missing in `useAssetsStore.missing` at once (a project not open finds them Missing on its
next open). A file put back from the Trash comes back undecided with no edits: its library entry was dropped (CULL 4.5).
After the move the pile closes and the Cull view goes back to the grid. The Rust test never touches the real Trash
(the `trash` crate cannot aim at a temp directory): a stand-in Trash takes the moves, and the refusals are asserted.
The `trash` crate was already a dependency (5.2.9 in `Cargo.lock`, MIT; Delete project), so `Cargo.toml` is
unchanged. `DecideView.tsx` is unchanged: its end state already had the button and the prop.
Review fixes: `trash_photos` refuses a path whose resolved form differs from `root.join(rel)` (a symlink anywhere in
it, e.g. `pics -> .photobook-cache`) and a top-level `Exports/` (the scan skips it), with a comment on the
check-then-move race (accepted for a local single-user app); new Rust tests: a hidden component past the first, an
in-root symlinked folder, a duplicate path, a root given through a symlink. The placement check no longer fails open:
a project listed with an error, one whose file cannot be read or is not JSON, and a project list that cannot be read
are named in `unchecked` and their folders' photos (every pile folder when unknown) are kept by default with the
placed ones (`keptByDefault`); the dialog says "N projects could not be checked (…)"; folder paths compare without a
trailing slash. The dialog shows the count and size it moves beside the whole pile ("Move 2 of the 3 photos (4 MB of 6
MB)"), reads the projects once per pile (keyed on the ids), and the toast counts files moved before a later error. The
thumbnail effect was not dead (it calls the library store's `prepare` for index-only photos); a test now covers it.
Vitest `RejectPileView.test.tsx` 16 (5 added).
Checks: `cargo test --lib` in `src-tauri` (217 passed, the 12 `commands::photos` tests among them); `cargo check`;
`pnpm typecheck`; `pnpm lint` (Biome clean, `check-palette: ok`, one pre-existing warning in `apps/site`); `pnpm
--filter editor test`: 1368 passed, the 15 failures all in `components/develop/DevelopMode.test.tsx` and
`routes/developStage.test.tsx` (the Develop panel and strip that plans 46 and 48 are changing in this wave; they fail
the same with this plan's Project ▾ hook taken out). Not verified: the pile and the dialog in the running editor (no
`tauri dev` during wave 4), a real move to the macOS Trash. **Human check** (owner): move the rejects of a *copy* of a
real folder to the Trash, put one back from the Trash in Finder, rescan the folder and see it in the grid again.

CULL_PLAN [7 (42)](../../CULL_PLAN.md#42--the-reject-pile-and-the-trash), the flow in [CULL_PLAN 4.5](../../CULL_PLAN.md#45-rejects-to-the-trash), data in [CULL_PLAN 5](../../CULL_PLAN.md#5-data). Depends on: 40

Size: 1.5 days. Depends on: 40, 01 (scope), the `trash` crate path in `commands/projects.rs`.

**Goal.** One staged, bounded path from rejects to the macOS Trash: review the whole pile, rescue, confirm with the
real count, keep the place.

**Decisions.** Rust `trash_photos(folder, relPaths) -> Vec<{ path, ok, error? }>`: `ensure_imported_root`,
`resolve_rel` per file, `move_to_trash` (NsFileManager, recoverable), a sibling `.xmp` with the same stem goes along,
`.photobook-cache` renders are not touched. The command is not a job (it is seconds) but is cancel-safe per file. The
pile is always the source's full reject set, never the filtered view. Photos placed in any project are listed and
excluded by default; moving them anyway leaves Missing assets (the relink path already handles it). After the move the
index and library entries are dropped (the library entry only when no other file in the folder has the hash), the
grid focus goes to the next unit, and a toast says how many moved and names the failures. Capability: nothing new
(`trash` is native); `README.md` states the files go to the Trash and can be put back from there.

**Steps.**
1. Rust `commands/photos.rs` (new): `trash_photos`; register in `lib.rs`; tests on a temp root (out-of-root path
   refused, sidecar moved, result per file).
2. `lib/tauri.ts` wrapper; `store/library.ts` `dropPhotos(folder, relPaths)` (index, library, in-memory `folders[id]`).
3. `RejectPileView.tsx`: the Survey layout over the full reject set, U rescues, Cmd+A, the bottom bar with the size
   sum and the button; the dialog with the count, size, the projects line and the checkbox; the toast.
4. Entry points: Project ▾ → *Review rejects…*, the Cull menu, the Decide end state; disabled with zero rejects.
5. Docs: a *Deleting photos* paragraph in `README.md` and the DESIGN_NOTES dialog spec.

**Check.** Rust: a path with `..` or outside the root is refused; a RAW with its `.xmp` moves both; a failure on one
file does not stop the rest. Vitest (wrapper mocked): the pile ignores the active filter; rescue removes from the pile
and sets undecided; the placed-in-project count and exclusion; after a move the index and library lose the entries and
the focus lands on the next unit; the project keeps its asset id and shows Missing. A person moves rejects on a copy
of a real folder and puts one back from the Trash.

**Docs.** `README.md`, `DESIGN_NOTES.md`, `CLAUDE.md` (the command and the rule that the Trash is the only delete).
