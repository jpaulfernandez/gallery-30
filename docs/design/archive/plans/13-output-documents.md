# 13 · Output documents

Status: done 2026-10-13. Shared `packages/shared/src/outputs.ts` holds `BOOK_OUTPUT_ID`, `pagesOf`, `templateOf`, `locatePage`, `allPages`, `usedAssetIdsOf`, `nextOutputName` (generic, so Immer drafts use them); the store actions are a slice in `store/outputs.ts` spread into the book store. Deviations: page actions do not take an `outputId` argument; they find the page by id in the book or any output (`locatePage`; page ids are unique across the book) and fit crops, layouts, captions and frames to that document's template, and only `addPage`/`movePage` take an optional `outputId` defaulting to the Design stage's (`ui.design.outputId`, registered with `setOutputContext` because the book store cannot import the UI store). The canvas files read a cached view `useDesignBook()`/`currentDesignBook()` (`store/design.ts`: the book with `pages` and `template` from `pagesOf`/`templateOf`, the book itself for `book`) instead of calling `pagesOf` at each site, so Canvas, PageStrip, Inspector, LayoutsPanel and the frame/snap/text helpers changed by one line each (LeftPanel reads no pages). A post's frames are 4:5 (`SOCIAL_DEFAULT_TEMPLATE`) until plan 14 gives posts a network; a print shows the book's pages; an unknown output id has no pages. Plain `/design` goes to the document shown last when the project still has it (else `book`), not always `book`. A new post starts with one blank frame; Duplicate gives the copy's frames and elements new ids. Export… is shown disabled for outputs (plan 14 wires it). The filmstrip's Hide used and check badges count the open document's pages; the project Cull's Hide used and Review/Develop still count the book's pages only. `reapplyLayouts` and `setTemplate` touch the book's pages only. `referencedAssetIds` (relink: missing vs pruned) and `replaceAssetId`/`removeCustomLayout` walk output frames. Checks: store Vitest `store/outputs.test.ts` (add, rename, duplicate, delete with undo; frame edits leave `pages` untouched; crops fit the post template), `router.test.tsx` (book, output id, last-shown redirect, unknown id to book), `OutputMenu.test.tsx`; publish `--dry-run` of the `six` fixture with a post added reports the same 3 pages, 6 photos and upload plan as without it. Not yet tried in the running Tauri app (jsdom tests only). After review: with a post open the inspector hides the book settings (size, theme, publish) and the preview entries (Edit | Preview, Open in preview) are disabled, since Preview shows the book; each document reopens on the page it was left on (`ui.design.pageIndexes`, session only); duplicates get unique names (`uniqueOutputName`); the schema rejects a page id used twice across the book and its outputs; a publish test (`packages/publish/src/outputs.test.ts`) checks a project with a post publishes the same keys, fingerprint and manifest as without it. Known limitation: undo is one history for the whole project, so Cmd+Z with the book open can undo an edit made in a post (and the reverse) without showing it.

WORKFLOW_PLAN [1.3](../WORKFLOW_PLAN.md#13-how-displays-fit-the-schema) (W4.1). Size: 1 day. Depends on: 04.

**Goal.** A project holds several outputs: the book plus output documents (social posts now, print and slideshow
later). The Design stage has a drop-down to switch between them; each has its own canvas and its own Publish or
Export button.

## Decisions

- `outputs` is the array (03); the book itself is not an entry, it is the project's
  `pages`, listed first in the drop-down as *Book*.
- Route `/project/$id/design/$outputId` with `book` as the reserved id for the pages.
- Store actions `addOutput(kind, name)`, `renameOutput`, `deleteOutput` (confirm), `duplicateOutput`; all undoable.
  `ui.design.outputId` holds the current one. The UI never says "output" either: the menu lists Book, Post, Print, Slideshow.

## Steps

1. **Store.** The actions above in `store/book.ts`; page actions (`updatePage`, `updateElement`, frames, text) take a
   an `outputId` context so the same reducers edit `outputs[i].frames` when an output is open. Prefer one helper
   `pagesOf(book, outputId)` returning a Draft array than duplicating reducers.
2. **Router.** The `$outputId` segment; `/design` redirects to `/design/book`.
3. **Top bar.** A drop-down next to the Design tab: Book, then each output with its kind icon, **New…** (kind picker: Social post; Print
   and Slideshow greyed until 15 and 16), Rename, Duplicate, Delete.
4. **Canvas.** `Canvas.tsx`, `PageStrip.tsx`, `Inspector.tsx` and `LeftPanel.tsx` read pages through `pagesOf`; the
   template (page ratio, margins) comes from the output's template when one is open.
5. **Publish button.** Shows *Publish* for the book and *Export…* for an output (wired in 14).
6. **Dangling ids.** The schema refinement covers output frames (03); `removeAssets` and relink walk outputs too.

## Check

- Store Vitest: add, rename, duplicate, delete; undo each; element edits inside an output do not touch `pages`.
- Routes render for `book` and an output id; an unknown id redirects to `book`.
- Publish `--dry-run` of a project with an output is unchanged (outputs are not published).

## Docs

- `docs/design/DESIGN_NOTES.md` Design stage; `README.md` one line.
