# Photobook Implementation Plan

Oct 5, 2026 · Derived from [PRD.md](PRD.md). No code was written for this plan.

The PRD lists four milestones. This plan regroups them into two deliverable phases you can start on immediately, plus a short note on what comes after:

| Phase | Delivers | PRD milestones covered | Usable gate |
| --- | --- | --- | --- |
| **1. Local editor + preview** | Tauri app that turns a folder into a designed book you can scrub through in a phone frame | Milestone 1 | A real trip folder becomes a 20+ page book, previewed on a phone frame, surviving quit and relaunch |
| **2. Publish to the web** | One-button publish to R2 and a viewer shell on Vercel behind the soft password | Milestone 2 | A friend opens the link on an iPhone over mobile data, types the word once, swipes the book, opens a photo |
| Later | Likes, download log, drawer, freeform boxes, Instagram page export, collections | Milestones 3 and 4 | See the last section |

Each phase is broken into steps that are individually shippable. Steps inside a phase are ordered by dependency; a step is done when its check passes.

---

## Decisions to lock before step 1.1

These are the choices the PRD leaves open or implies. Recommendation first, then why.

| Decision | Recommendation | Why |
| --- | --- | --- |
| Monorepo tooling | pnpm workspaces, Node 22, TypeScript strict, one `tsconfig.base.json`, Biome or ESLint+Prettier | Matches the three-package layout in the PRD; pnpm handles the Tauri app and the Node CLI in one tree |
| Schema library | Zod in `packages/shared`, with the project file and manifest types inferred from it | One source of truth for the editor, the CLI and the viewer; migrations become `version` checks |
| Ids | ULID via `ulidx` | PRD requires stable ids so likes survive reorders |
| Editor thumbnails and proxies | Rust in the Tauri core using `turbojpeg` (decode with DCT scaling) plus `fast_image_resize`; no Node sidecar in phase 1 | Scaled decode makes a 40 MP JPEG thumbnail take tens of ms instead of seconds. sharp is reserved for the publish CLI where AVIF and WebP are needed |
| HEIC in the editor | Shell out to `sips -s format jpeg` on macOS as a pre-step, cached by hash | Simplest working path on a Mac; same conversion the CLI will use |
| Canvas rendering | DOM page component in `packages/shared`, frames as fractions of the page, crops as CSS `transform` on an `img` inside an `overflow:hidden` box | PRD decision; the same component renders in editor, viewer and later in Playwright |
| Drag and drop | `@dnd-kit/core` for filmstrip to slot and for page strip reorder; raw pointer events for pan, zoom and box moves | dnd-kit handles the cross-panel case well; pointer events are simpler for continuous gestures |
| Editor state | Zustand with Immer; undo and redo via `zundo` on the document slice only | Small, fast, and undo tracks the project document rather than UI state |
| Viewer framework | Preact with `preact/compat` so the shared React renderer runs unchanged | The 100 KB gzipped budget is comfortable with Preact and tight with React |
| R2 client | `@aws-sdk/client-s3` pointed at the R2 S3 endpoint | Supports HEAD for skip-by-key, custom cache headers and parallel puts |
| Secrets | R2 keys and the admin token in a `.env` in the app data dir, edited through the editor Settings screen; never in the project file | The project file sits next to photos and may be synced or shared |
| Fonts | Four families, self-hosted WOFF2 in `packages/shared/fonts`: Inter, Fraunces, JetBrains Mono, Instrument Serif | PRD asks for four to six self-hosted; pick these and move on |

Tauri-specific gotcha to set on day one: in `tauri.conf.json`, set the main window's `dragDropEnabled` to `false`. Tauri's native file-drop handling swallows HTML5 drag events and breaks in-app drag and drop otherwise.

---

## Repository layout

```
photobook/
  apps/editor        Tauri 2 + React + Vite + Tailwind + TanStack Router
    src-tauri/       Rust: folder scan, hashing, thumbnails, proxies, HEIC pre-step
  apps/viewer        Vite + Preact static shell, deployed to Vercel
  packages/shared    Zod schema, ULIDs, layouts, book templates, page renderer, fonts, image URL helpers
  packages/publish   Node CLI: freeze, image versions, R2 upload, manifest, site.json
  worker/            (later) Cloudflare Worker + D1 for likes and the download log
  docs/              PRD, this plan, design notes
```

---

## Phase 1: Local editor + preview

Goal: everything a designer does before the publish button, on files in place, with the renderer that the viewer will reuse.

### Step 1.1 Scaffold and project file

**Build**

- pnpm monorepo with the four packages above (worker left empty).
- `packages/shared`: Zod schema for `book.photobook.json` exactly as the PRD data model, with `version: 1`. Export `createEmptyBook`, `loadBook(json)`, `migrate(json)`.
- `apps/editor`: Tauri 2 with the `dialog`, `fs` and `shell` plugins. Routes: `/` (open or create a book), `/book` (editor), `/book/preview`, `/settings`.
- Open flow: pick a folder with the native dialog. If `book.photobook.json` exists in it, load it; otherwise create one with the folder as `sourceFolder` and the Phone portrait template.
- Fs scope restricted to the chosen folder plus the app data dir.

**Check**: open a folder, see an empty book, relaunch and land back in it.

### Step 1.2 Folder scan, hashing, thumbnails

**Build (Rust side, exposed as Tauri commands)**

- `scan_folder(path)`: recursive walk, JPEG, PNG, HEIC; returns relative path, size, mtime. Skips hidden files and the project file.
- `hash_file(path)`: SHA-256, streamed, on a thread pool. Runs lazily in the background after scan, reports progress by event. The hash keys the asset entry and the cache.
- `thumbnail(path, hash)`: 256 px long edge, orientation applied, written to `<appdata>/cache/<hash>/thumb.jpg`. Uses turbojpeg scaled decode so the 25 MB file is never fully decoded.
- `proxy(path, hash)`: 1600 px long edge JPEG at the same cache location; the canvas renders this, never the original.
- HEIC: convert once with `sips` to a cached JPEG, then treat as JPEG.
- Return `width`, `height`, and orientation so the schema's `assets` entry can be filled.

**Build (UI)**

- Filmstrip panel on the left: virtualized grid of thumbnails (TanStack Virtual), used or unused badge, search by filename, sort by capture time or name.
- Progress bar while hashing and thumbnailing; the filmstrip fills in as thumbnails arrive.
- Images load into the webview through `convertFileSrc` on the asset protocol.

**Check**: a folder of 300 camera JPEGs shows a full filmstrip in under a minute on first open and instantly on second open.

### Step 1.3 Shared page renderer

The most important step. Everything downstream renders through this.

**Build (`packages/shared/renderer`)**

- `<Page page template theme resolve />`: a positioned div at the template's aspect ratio. Size is set by the parent through CSS; everything inside uses percentages from the fraction-based frames.
- `<PhotoElement>`: `overflow:hidden` box, `img` with `object-fit: cover`, crop applied as `transform: translate(x, y) scale(s)` with `transform-origin` at center, rotation in 90° steps, filter as a CSS class.
- `<TextElement>`: style preset to CSS, alignment, color, optional background pill.
- `resolve(assetId, targetWidth) -> { src, srcSet?, placeholder? }` is injected. The editor passes a resolver returning proxy file URLs; the viewer will pass one returning R2 URLs with `srcset`. The renderer never knows where images live.
- `editable` flag that adds data attributes and pointer handlers, so the editor can wrap elements with selection chrome without forking the component.
- Fonts: `@font-face` CSS shipped from the package and imported by both apps.

**Check**: a Storybook-free fixture page in `packages/shared` renders identically in the editor route and a plain Vite page in `apps/viewer`.

### Step 1.4 Book templates and layout templates

**Build**

- Book templates as data: Phone portrait 4:5 (default) and Square 1:1 for this phase. The other sizes are a data addition later.
- Layouts as data: every 1 to 6 photo layout in the PRD table, each as a list of slot frames in fractions, computed from the book's `margin` and `gutter` settings, with a landscape-heavy and a portrait-heavy variant. About 20 layouts.
- Layout picker: a grid of wireframe thumbnails grouped by photo count, as in Obvious's named layout grid. Applying a layout to a page keeps existing photos in order and pours them into the new slots; extra photos are dropped from the page but stay in the filmstrip.
- Inspector slot ratio control: 3:2, 4:3, 1:1, 4:5, 2:3, 3:4. Resizes around the slot's center, clamped to the page.

**Check**: pick any layout, fill it, switch to another layout, photos survive in order.

### Step 1.5 Canvas interactions and inspector

**Build**

- Editor shell: filmstrip left, canvas center with zoom slider and fit-to-window, inspector right, page strip bottom. The Magnific layout is the reference.
- Selection: click selects an element, Escape clears, Delete removes a photo from a slot but keeps the slot.
- Drag from filmstrip to slot with dnd-kit; drop on an occupied slot swaps. Drop onto empty page area is ignored in this phase.
- Pan inside a slot by dragging the photo; zoom with a slider in the inspector and with trackpad pinch over the slot. Zoom clamps so the photo always covers the slot.
- Rotate 90° button. Filter dropdown is stubbed to "none" only.
- Double-click a slot to open the full-resolution original in a modal for inspection.
- Inspector fields: slot ratio, zoom, rotate, filter; page background color.

**Check**: build a hero-plus-two page in under thirty seconds with a mouse.

### Step 1.6 Text snippets

**Build**

- Text element with the four presets: title, caption, date stamp, body. Preset defines family, size as a fraction of the page height, weight, line height.
- Inspector: preset, family (from the four), size, weight, alignment, color, pill background toggle.
- Inline editing with a `contenteditable` box that commits on blur.
- Baseline snap: text frame `y` snaps to the page grid (default 8 pt, in page units).
- Layouts with a caption slot include a text element in the preset.
- Per-page notes field in the inspector, flagged `notes` in the schema and stripped by publish.

**Check**: add a caption, change its preset, and confirm two pages' captions align in the preview.

### Step 1.7 Page strip and page operations

**Build**

- Bottom strip with numbered page thumbnails rendered by the shared `<Page>` at small size (no image generation needed).
- Add page (opens the layout picker), duplicate, delete with undo, reorder by drag with dnd-kit.
- Page background: color, or a full-bleed photo behind the slots.
- Keyboard: left and right arrows move between pages when the canvas has focus.

**Check**: reorder ten pages and confirm element ids and page ids are unchanged in the project file.

### Step 1.8 State, undo and redo, autosave

**Build**

- Zustand store with a `document` slice that is exactly the project file and a `ui` slice for selection, zoom, panels.
- Undo and redo through `zundo` on the `document` slice, grouped per gesture so a drag is one step.
- Autosave: debounce 500 ms, write to a temp file then rename, keep one `.bak`. Save status in the bottom-right like Flodesk's "Saved".
- Missing files: on open, any asset whose path is gone is searched by hash within the folder and relinked; otherwise flagged in the filmstrip with a "Locate" action.

**Check**: kill the app mid-edit and relaunch without losing more than the last half second.

### Step 1.9 Phone preview mode

**Build**

- `/book/preview` route: the current page inside an iPhone frame at real proportions on a dark background, with the page rendered by the shared `<Page>` at phone pixel density.
- Swipe with trackpad, arrow keys, and a page counter that opens a thumbnail grid, matching what the viewer will do. Polarsteps' Travel Books preview is the reference feel.
- Toggle between iPhone frame and a wider desktop container so the 900 px side-panel breakpoint can be checked early.
- "Open in preview" from the page strip jumps to that page.

**Check**: scrub the whole book at 60 fps with proxies; text is crisp at any zoom.

### Phase 1 definition of done

- All nine checks pass on a real folder from a trip.
- The project file matches the PRD schema and validates with the shared Zod schema.
- The renderer in `packages/shared` has no imports from `apps/editor`.

---

## Phase 2: Publish to the web

Goal: one command from the editor turns the project file into optimized images, a manifest and a site file on R2, and a viewer shell on Vercel serves any book by slug behind the soft password.

Steps 2.1 to 2.4 are the CLI and only depend on the schema from step 1.1. Steps 2.5 and 2.6 are the viewer and only depend on the renderer from step 1.3. They can be worked in parallel with the tail of phase 1.

### Step 2.1 Publish CLI skeleton and freeze

**Build (`packages/publish`)**

- `photobook publish <project.json> [--dry-run] [--prune]` with a plan output.
- Freeze: load and validate the project file, resolve every referenced asset on disk, compute or reuse the SHA-256 (the editor's hash is trusted when size and mtime are unchanged).
- Plan: compare against `publish.lastPublishedAt` and a local `.photobook-publish/state.json` that records which hashes already exist on R2, and print what will be processed, uploaded and skipped.

**Check**: dry run on a saved book prints the right counts and uploads nothing.

### Step 2.2 Image versions with sharp

**Build**

- Per used asset, derive from the original on disk into `.photobook-publish/out/<hash>/`:
  - `download.jpg`: 4096 px long edge, mozjpeg quality 88, EXIF kept. Both numbers read from app settings.
  - `share.jpg`: 2048 px, quality 85, orientation applied, other EXIF stripped.
  - `w480`, `w960`, `w1440`, `w2048` in AVIF (q 52) and WebP (q 76), orientation applied.
  - `placeholder`: 24 px WebP inlined as a data URL in the manifest.
- HEIC pre-step with `sips`, cached by hash.
- Concurrency equal to CPU cores minus one; per-asset timing in the log.
- Outputs are keyed by hash so a second run processes nothing that already exists on disk.

**Check**: 180 photos process in a few minutes; sizes land in the PRD's ranges.

### Step 2.3 R2 upload

**Build**

- R2 setup (manual, documented in `docs/PUBLISHING.md`): bucket, public custom domain, CORS rule allowing the book domain for GET and HEAD, API token with object read and write.
- Keys: `books/<slug>/<r2Prefix>/<hash>-<variant>.<ext>` for images. `r2Prefix` is generated once and stored in the project file.
- Skip by HEAD before PUT; parallel uploads with a concurrency of 8; three retries with backoff; on final failure stop and print the missing keys. Re-running resumes from the state file.
- Cache headers: `public, max-age=31536000, immutable` for images; `no-cache` for `manifest.json` and `site.json`.
- `--prune` lists keys under the book prefix not referenced by the new manifest and deletes them.

**Check**: run twice; the second run uploads only the manifest.

### Step 2.4 Manifest, site file and password

**Build**

- Manifest derived from the project file: no notes, no local paths, assets replaced by the image record described in the PRD, page thumbnails pointed at the `w480` variants of the page's first photo for now (full page thumbnails arrive with Playwright later).
- `site.json`: `{ password: { hash, salt, version, expiresAt }, books: [listed books with slug, title, cover] }`. Publish reads the existing `site.json`, merges this book in or out based on `visibility`, and writes it back. Changing the password in Settings bumps `version` and rewrites `site.json` alone.
- Slugs: designer-chosen for listed books; `<slug>-<4 random chars>` by default for unlisted, with a "regenerate" action.
- Password hash: SHA-256 over `salt + word`, which the viewer can compute with Web Crypto. Soft by design, as the PRD states.

**Check**: two books publish without touching each other's prefix; flipping one to unlisted removes it from `site.json` only.

### Step 2.5 Viewer shell

**Build (`apps/viewer`)**

- Routing: `vercel.json` rewrites `/:slug` and `/:slug/:page` to `index.html`; the shell parses the path. Root `/` with no slug is the list route.
- Boot: fetch `site.json`; read `localStorage.access = { version, grantedAt }`; mismatch shows the password field over the blurred cover; a correct word stores the flag. Then fetch `books/<slug>/manifest.json`; a 404 shows a not-found page.
- Root behavior: more than one listed book shows a cover grid; exactly one redirects to it; none shows a blank page.
- Reader: a horizontal scroll-snap track of `<Page>` components, one per viewport, with slide easing of about 250 ms; tap zones on the left and right edges; keyboard arrows; the page number in the URL; last page per book in local storage.
- Page counter at the bottom opens a thumbnail grid rendered by the same `<Page>` at small size; tapping a thumbnail closes the grid on that page.
- Images: `picture` with AVIF and WebP `srcset` from the ladder, JPEG share version as the fallback `img`, blurred placeholder as the background, `loading="eager"` for current and adjacent pages and lazy beyond.
- Lightbox: tap a photo on the page to open the uncropped share version, close, counter, thumbnail strip at the bottom, matching the Weverse and Apple Photos lightbox pattern. Download and Share buttons are visible but only Download works in this phase, through the download version and an anchor with the `download` attribute. The iPhone long-press hint and the display-name prompt come with the Worker in a later phase.
- Pinch to zoom on a page with double-tap reset.
- Above 900 px: page centered at its own ratio, right column holds the photo list for the current page (the future side panel).
- Landscape books on a portrait phone letterbox with a rotate hint.
- Bundle budget enforced in CI: fail the build over 100 KB gzipped.

**Check**: Lighthouse mobile on a 4G throttle shows first page visible under 2 s; swipe is smooth on an iPhone in Safari.

### Step 2.6 Vercel deploy

**Build**

- One Vercel project pointed at `apps/viewer`, custom domain, env var for the R2 public base URL.
- `pnpm --filter viewer deploy` wrapping `vercel deploy --prod`. Documented as "run only when viewer code changes".
- A preview deployment per branch for testing the shell against real books.

**Check**: an existing book published to R2 appears at its slug with no redeploy.

### Step 2.7 Publish from the editor

**Build**

- Settings screen: R2 endpoint, bucket, keys, public base URL, site password, download size and quality. Stored in the app data dir.
- Book settings in the inspector when no element is selected: title, slug, listed or unlisted, regenerate slug.
- Publish button runs the CLI as a Tauri sidecar (Node binary bundled, or the system Node through the `shell` plugin during development) and streams its progress into a panel with per-step timing.
- On success, write `publish.lastPublishedAt`, show the link with a copy button, and show "unpublished changes" when the document hash differs afterwards.

**Check**: folder to shared link in one sitting, under 10 minutes for a 60-page book.

### Step 2.8 Smoke checks

**Build**

- A fixture book with six photos in `packages/publish/fixtures`.
- A script that publishes it to a test slug, asserts the expected keys exist, the manifest validates, `site.json` lists it, and a second run uploads only the manifest. Then unpublishes it.
- Run manually before a viewer deploy; a GitHub Action can run it later if the repo moves to GitHub.

### Phase 2 definition of done

- A real book is live at `https://<domain>/<slug>` and a friend has read it on an iPhone.
- Republish after a caption change takes seconds and rewrites only the manifest.
- Password change prompts every device again on the next load.

---

## Dependency map

```
1.1 scaffold + schema ──┬── 1.2 scan/thumbs ── 1.5 canvas ── 1.6 text ── 1.7 pages ── 1.8 state ── 1.9 preview
                        ├── 1.3 renderer ──── 1.4 layouts ─┘                                        │
                        │        └────────────────────────── 2.5 viewer shell ── 2.6 vercel ─────────┤
                        └── 2.1 CLI freeze ── 2.2 sharp ── 2.3 R2 ── 2.4 manifest/site ── 2.7 editor publish ── 2.8 smoke
```

Two tracks can run side by side once 1.1 and 1.3 exist: the editor track (1.4 to 1.9) and the publish track (2.1 to 2.6).

---

## Rough sizing

| Step | Size | Notes |
| --- | --- | --- |
| 1.1 | S | Mostly scaffolding |
| 1.2 | M | Rust image work; turbojpeg integration is the risky bit |
| 1.3 | M | Small code, big design weight |
| 1.4 | M | Mostly data entry for about 20 layouts |
| 1.5 | L | The fiddliest UI in the plan |
| 1.6 | M | |
| 1.7 | S | |
| 1.8 | S | |
| 1.9 | S | Reuses the renderer |
| 2.1 | S | |
| 2.2 | M | sharp tuning |
| 2.3 | M | Setup plus retry logic |
| 2.4 | S | |
| 2.5 | L | The second large step; Safari testing takes time |
| 2.6 | S | |
| 2.7 | M | Sidecar packaging |
| 2.8 | S | |

---

## UI references from Mobbin

Screens to keep open while building. Links go to Mobbin.

**Editor shell (phase 1)**

- [Magnific editor](https://mobbin.com/screens/34a51d49-e479-4327-b912-36f2e7ceb2f2): asset panel on the left with a search field, canvas with a floating element toolbar and selection handles, inspector on the right, numbered page strip at the bottom with a zoom slider. This is the closest match to the PRD's three-panel layout.
- [Adobe Express editor](https://mobbin.com/screens/46c4778d-78f9-4e68-b0c1-0f62210eb9fa): template and photo panel on the left, page counter pill at the bottom, vertical page strip. Useful for the "Page 1 of 7" counter and the Download and Share buttons in the header.
- [Flodesk layout picker](https://mobbin.com/screens/bd2437c0-d777-4c6d-b31b-300d135ccd60): layouts shown as full-size previews in the right panel, with Undo, Redo and "Saved" in the bottom-right corner. Reference for the autosave indicator and the layout list.
- [Obvious select layout](https://mobbin.com/screens/3bdd7dc4-c938-4014-a7de-87c805cf9057): a grid of wireframe layout thumbnails with names. Reference for the layout picker grouped by photo count.
- [Pinterest design your pages](https://mobbin.com/screens/db928a1d-ae4b-4daa-beed-a17acfd20b25): a layers list on the left, a single 4:5 page centered, a stepper at the bottom. Reference for the later freeform page with z-order.

**Reader and preview (phase 1 preview, phase 2 viewer)**

- [Polarsteps Travel Books](https://mobbin.com/screens/dacbba04-e74b-4b8e-9397-e439473dff48): a printed-book preview on a phone with a "5-6/14" counter and page navigation. Reference for phone preview mode and the page counter.
- [Weverse photo viewer](https://mobbin.com/screens/d8f4f967-1c71-4dae-af9e-f3dc801c008c): full-screen photo on black, close top-left, download top-right, "1/2" counter and a thumbnail strip at the bottom. Reference for the lightbox.
- [Apple Photos viewer](https://mobbin.com/screens/6a012417-7088-411c-a285-08337b11e49f): filmstrip plus an action bar with share, like and info. Reference for the lightbox action bar.
- [Google Photos viewer](https://mobbin.com/screens/f1b395be-4213-46a5-8b2e-e9e324313e03): labeled actions Share, Edit, Add to, Trash. Reference for labeled drawer actions in the later phase.
- [Fresha gallery](https://mobbin.com/screens/7a57d715-5406-4cdd-82f7-b0ac1fe69d36): "1/149" counter at the top and a heart with a count on the photo. Reference for like placement in the later phase.
- [Cosmos save sheet](https://mobbin.com/screens/00961b39-5ee3-4cfb-8b59-396c3783e769) and [Savee](https://mobbin.com/screens/92b796aa-e569-4078-bef5-581d66593cad): a floating pill bar with share, save and more. Reference for the collection toggle and the bottom drawer handle.

---

## Risks specific to this plan

| Risk | Where | Mitigation |
| --- | --- | --- |
| turbojpeg or fast_image_resize build issues in Tauri | 1.2 | Fallback is the `image` crate with `imageops::thumbnail`, slower but dependency-free; or shell out to `sips -Z` on macOS |
| HTML5 drag and drop inside the Tauri webview | 1.5 | Set `dragDropEnabled: false`; dnd-kit uses pointer events anyway |
| Loading hundreds of proxies into the webview | 1.2, 1.9 | Virtualize the filmstrip and only mount the current and adjacent pages in preview |
| Renderer diverges between editor and viewer | 1.3 | Keep it in `packages/shared` with no app imports; add a fixture page both apps render |
| Sidecar packaging of Node for the CLI | 2.7 | Use the system Node through the shell plugin first; bundle a sidecar only for the installable build |
| Safari scroll-snap and pinch-zoom quirks | 2.5 | Test on a real iPhone from step 2.5 onward through a Vercel preview URL |
| Jump grid without page PNGs | 2.5 | Render the grid with the shared component at small size; replace with publish-time thumbnails when Playwright lands |
| Bundle over 100 KB | 2.5 | Preact, no router library, manual code split for the lightbox and grid, size check in CI |

---

## What phases 1 and 2 must leave in place for later

- Stable ULIDs on pages and elements, never regenerated on reorder, so likes and the download log attach cleanly.
- The renderer accepts an `editable` flag and an injected resolver, so Playwright can render it headless for page PNGs.
- The lightbox already has Download and Share buttons wired to the download and share versions, so the display-name prompt and event logging can be added without layout changes.
- The viewer keeps a `drawer` region reserved under the page on phones and a side column above 900 px, so the drawer becomes a sheet rather than a redesign.
- The publish CLI has a step list with hooks so page rendering slots in as step 3 later, as the PRD's pipeline describes.

**Later work, in PRD order**: Worker and D1 for likes and events, drawer and side panel, display name prompt, Downloads tab in the editor; then freeform boxes and snapping, saved custom layouts, Playwright page PNGs, Share page to Feed or Story, collections and zip, filters, A4 and Story templates.
