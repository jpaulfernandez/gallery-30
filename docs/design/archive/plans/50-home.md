# 50 · Home

ODDHALLS_LAYOUT_PLAN [1](../../ODDHALLS_LAYOUT_PLAN.md#1-home) (Home), [7 (50)](../../ODDHALLS_LAYOUT_PLAN.md#7-plans);
IMPLEMENTATION_PLAN_38-56 [section 6, wave 5](IMPLEMENTATION_PLAN_38-56.md#wave-5) (the 50 card). Size: 1 day.
Depends on: 44, 45, 40

The Layout plan's section 7 has only the table row for 50 ("**Home**: Start row, project cover cards, folder rows
with cull state, empty state"), so the steps below are its section 1, copied verbatim, and the Check list is the
section 6 card's.

What you see when the app opens, instead of the current title plus two lists.

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  oddhalls                                                       Settings  ·  Help    │
│                                                                                       │
│  Start                                                                                │
│  [ ▢ Open a folder… ]   [ + New project… ]   [ ⤓ Open project file… ]                 │
│                                                                                       │
│  Recent projects                                                            See all  │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                                         │
│  │ cover  │ │ cover  │ │ cover  │ │ cover  │   title · 24 pages · edited 2 d ago     │
│  └────────┘ └────────┘ └────────┘ └────────┘                                         │
│                                                                                       │
│  Recent folders                                                             See all  │
│  ▢ Lisbon 2026          612 photos · 58 kept · culled ✓        Cull  Develop         │
│  ▢ Studio tests          84 photos · 12 undecided              Cull  Develop         │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **Start row** first, three actions, the first one primary. A folder is the way in for Cull and Develop; a project is
  the way in for Design. The New project dialog is unchanged (title, page size, folder, what to add).
- **Recent projects** as cover cards (the first page rendered by the shared renderer at ~160 px, like Weavy and
  Riverside do with a frame) with title, page count and when it was last edited; the ⋯ menu holds Rename, Reveal,
  Delete. Four most recent, *See all* expands in place.
- **Recent folders** as rows (not cards: a folder has no cover) with the count, the cull state from the index
  (kept / undecided / culled ✓, plan 40) and two buttons that open the folder in that stage. A missing folder shows
  the red *Missing* and no buttons.
- **Empty state**: the Start row and one serif line, "Open a folder to start culling, or make a project to design."
- What goes: the "Photobook" title and tagline, the stacked lists, the dot grid. The wordmark is small, top-left.

References: [Riverside](https://mobbin.com/screens/6b8d37c6-06f4-4dc5-91ef-0012ed598168) (action cards over a
projects grid), [Weavy](https://mobbin.com/screens/a37af3e8-294a-4052-a30c-dd784e8350fe),
[MagicPath](https://mobbin.com/screens/77bb103c-dca2-4181-b1b3-a60d7cd0f96b) (a card's ⋯ menu).

From the card: owns `routes/home.tsx` (Start row, cover cards, folder rows, See all, the empty state), a
`ProjectCover` component (the first page through the shared renderer at 160 px, cached as a data URL per project id
+ modified time), the folder row's cull state (reads the index counts and 40's `culledAt`). Touches:
`store/projects.ts` (last edited, page count in the registry listing, additive). Plan 43's follow-up: the Home drag
strip paints over scrolled content, so Home gets a real top bar (the drag region and the 78 px traffic-light inset).

- Check: a folder marked missing shows no buttons; the cover render of a project with no pages shows the empty
  paper, not an error.


Status: done 2026-10-13. Landed: `routes/home.tsx` re-laid: a real top bar (`header`, `data-tauri-drag-region="deep"`,
44 px, `panel-2` with a hairline, the 78 px traffic-light inset; the small `oddhalls` wordmark in Instrument Serif
italic left, Settings right) replacing plan 43's floating strip; under it a scrolling 60 rem column on `canvas` (the
dot grid, title and tagline gone). `StartRow`: Open a folder… (primary: imports the picked folder, or finds it
imported, and opens it in Cull), New project… (the dialog unchanged), Open project file…. `ProjectCards`: Recent
projects (last opened first, as listed), four, *See all N* / *Show fewer* in place; each card is the cover as a button
(opens Design; hover lift, the focus ring on the card chrome, no accent on the cover), the title with a ⋯ `Menu`
(Rename… inline, Reveal in Finder, Delete… through the existing Trash dialog) and "24 pages · edited 2 d ago"
(`editedAgo` over the listing's `updatedAt`); an unreadable project is disabled, shows its error in `danger` and keeps
Reveal and Delete. `FolderRows`: Recent folders (last seen, then last imported, so missing ones sink), four, *See all
N*; name, "612 photos · 58 kept · culled ✓" or "84 photos · 12 undecided", Cull and Develop buttons; a missing folder
shows the red Missing `Tag` and no buttons; Remove from the list moved to the row's right-click menu
(`Menu.Context`). The counts come from the index (`useLibraryFolders`: each folder's `index.json` read into the
library store, its library loaded, as the sidebar does) through `folderCull` (picks are kept; undecided and culled ✓
are plan 40's `folderUndecided` / `folderCulled`, `culledAt` and no undecided photo). `EmptyLine`: with no project
and no folder once the lists are read, the Start row and the serif line. `components/home/ProjectCover.tsx` (new):
`ProjectCover` draws the first page through the shared `<Page>` (the strip's and viewer's renderer, the host's
resolver onto the cached thumbnails) on its paper in a 160 px `panel-2` box; a project with no pages draws the empty
paper in the theme's background; `useProjectCover` / `loadCover` cache the inputs. Kitchen sink: a Home page
(`components/fixture/HomeSink.tsx`, `#/fixture?tab=sink&page=home`; fixture pages as covers, every folder state, the
empty line), `docs/design/reference/kitchen-sink-50.png`.

Cover cache policy: key = project id + the file's modified time (`updatedAt`); value = the first page (notes and
guides dropped), page size, theme, the cached thumbnail path of each photo on it, and the page count; in memory (48
entries, least recently used out) and in localStorage `photobook.home.covers` (24 entries and 200 000 characters,
oldest out); a new modified time drops the project's older key; a stored entry of another book schema version, or one
that no longer parses (`PageSchema`, `ThemeSchema`), is read again; concurrent reads of one key share one
`readProject`.

Deviations: (1) The cache holds the renderer's inputs, not a raster data URL: the shared renderer draws DOM, and
rasterizing it (canvas or SVG `foreignObject` over asset-protocol images) would be a second render path, which the
brief rules out; the cover is the same `<Page>` the strip draws, and Home still opens without reading a project file
whose modified time is unchanged. (2) `store/projects.ts` is unchanged and no Rust changed: "last edited" is the
listing's existing `updatedAt` and the page count comes with the cover read (cached as above), TS only. (3) Covers
use the photos' source thumbnails (`<appdata>/cache/<hash>/thumb.jpg`, the cache root read off the listing's
`coverThumb`), not their developed renders; a project whose cover photo has no cached thumbnail draws its page with
empty slots. (4) No Help item: the editor has no help target yet. (5) Folder Remove is a right-click item, not a
button, so a missing folder shows no buttons. (6) Settings keeps plan 43's floating strip (`routes/settings.tsx` is
not this plan's file).

Checks: `pnpm --filter editor exec tsc --noEmit` clean for these files (the remaining `pnpm typecheck` errors are in
`components/cull/CompareSurvey.test.tsx`, plan 47's, running in parallel); `pnpm biome check` on this plan's paths
clean and `check-palette: ok` (the rest of `pnpm lint` fails only on plan 47's `components/cull/*` in progress);
`pnpm --filter editor test` 1409 of 1415: the 6 failures are not this plan's (`color.test.ts` expects no `--stagger`
duration token, which plan 47 is adding; `CropTool`, `TransformSection` and `router.test.tsx` pass when run alone).
New tests: `routes/home.test.tsx` (cards, the ⋯ menu, See all, the empty paper; folder rows, a missing folder with no
buttons, right-click Remove; `folderCull` with and without `culledAt`; `editedAgo`), `components/home/ProjectCover.test.tsx`
(one read per id + modified time, a new key on save, the 24-entry cap, an invalid stored entry ignored, the cache root
and thumbnail paths, the page through `<Page>`, a project with no pages drawing the empty paper), and the kitchen
sink's Home page without `invoke`. Check list: a folder marked missing shows no buttons (`home.test.tsx`, and on the
sink); the cover render of a project with no pages shows the empty paper (`ProjectCover.test.tsx`, `home.test.tsx`,
and on the sink). Not verified: the Tauri window (agents cannot capture it): the real registry, the drag from the new
bar and the traffic lights in the inset, the covers' thumbnails through the asset protocol, and the counts on real
folders are the owner's checks.

Review fixes (same day): (1) a cover whose project has no cached cover photo takes the cache root from any listed
project's `coverThumb` (`sharedCacheRoot`; they all share `<appdata>/cache`), and a first page with photos but no known
root is drawn without them and not cached, so the next visit reads it again instead of staying blank until the file
changes; (2) `folderCull` returns null until the folder's library is loaded, so a row never shows every photo
undecided and then jumps; (3) folder rows take the focus (`tabIndex={0}`, the focus ring), so the context-menu key or
Shift+F10 opens Remove from the list without a pointer, and a missing folder still has no buttons; (4) the stored
cover list is parsed once per session into a module map; (5) Home reads the folders registry once (its own load,
before the projects) and keeps the folders ready with a local `useFolderIndexes` (index read, library loaded, as
`useLibraryFolders` does) instead of also calling `useLibraryFolders`, which loaded the registry a second time.
Owner check: the covers use the photos' source thumbnails (`thumb.jpg`, 256 px): uncropped by develop and unedited, so
a developed or cropped photo looks different on Home than in Design until developed thumbnails are used (follow-up).
Checks after the fixes: `npx vitest run src/routes/home src/components/home src/components/fixture` 33 of 33;
`pnpm typecheck` clean; Biome clean on this plan's files (`KitchenSink.tsx` now reports an import order from plan
47's `CullSink` import, not this plan's line); `check-palette: ok`.
