# Photobook Design Notes

Where these notes and [ODDHALLS_UI_PLAN.md](ODDHALLS_UI_PLAN.md) disagree on looks, the skin plan wins once its plans
(43–49) land; these notes stay the record of behaviour.

Oct 5, 2026. Visual direction for the editor and phone preview, drawn from the Mobbin references in [IMPLEMENTATION_PLAN.md](archive/IMPLEMENTATION_PLAN.md) plus a few more pulled while building phase 1. Keep this open while building UI.

## Shell: Library sidebar and the three stages

Oct 12, 2026 (workflow plan 05, [WORKFLOW_PLAN 14.1](archive/WORKFLOW_PLAN.md#141-sidebar-and-navigation)). The app is a
library first and projects second. Names are decided in [plans/README.md](plans/README.md#names-decided-oct-12-2026):
the sidebar is **Library**, the stage tabs **Cull · Develop · Design**; the word "display" is never shown.

- **Top bar** (44 px, every stage): left the **Project ▾** menu (in Design after the project's title, which still
  renames on click): Rename…, Save as…, Cull its photos, Preview, Downloads, Close project, the most recent other
  projects, and "All projects · New project…" (Home). Centre the stage tabs as one segmented control; the current one is filled.
  **Design** is disabled (40 % opacity, a tooltip) with no project open; Cull and Develop are disabled only with no
  imported folder. Right: Design keeps Edit | Preview, undo, redo, save status, Settings and Publish; the library
  stages show undo, redo, a red save error when a library write failed, and Settings.
- **Routes**: `/library/$folderId/cull`, `/library/$folderId/develop`, `/library/collection/$collectionId/{cull,develop}`
  (a built-in id or a saved collection's ULID), `/project/$id/cull` (plan 06), `/project/$id/design` (`/project/$id`
  redirects there; an `$outputId` joins it in plan 13). The library routes need an imported folder on disk or a known
  collection, else Home shows why.
- **Library sidebar** (220 px, Cull and Develop only): three titled sections in 12 px uppercase labels. *Folders*: name
  and photo count (from the folder index, so known before a scan), double-click to rename, a missing folder greyed with
  a red "Missing", *Import…* in the header. *Collections*: Kept, Edited, and Needs denoise once an ISO is known
  (plan 23), then the saved collections in the order saved, all with counts; right-click a saved one for a small menu
  (Rename…, which edits the name in place, and Delete in red; deleting the one on screen goes to the last folder). *Projects*: title, a dot on the open one, *Home* in the header. The current item is filled
  (`bg-line`); a folder or collection opens in the stage showing (Cull by default), a project in Design.
- **Cull / Develop stages**: a filter bar (search, sort, flag, minimum stars, an *Edited* toggle, *ISO ≥* once an ISO
  is known, *Hide in project* while a project is open, *Save as collection…*, *Add N to project* while a project is
  open and photos are selected, then on the right "n selected", the count, "Preparing n/N" while the folder scans and
  Clear filters) over the Cull view or the Develop view rendered in place (no Done button). The list is fixed while
  the filters and the scanned photos stay the same, so rating a photo out of a filter does not reshuffle it. Switching
  stages keeps the photo and the selection. A collection scans no folder: its members come from the folder indexes and
  only they get thumbnails.
- **Capture time and photo stats** (Oct 13, 2026, plan 38; [CULL_PLAN 5](CULL_PLAN.md#5-data)): no new UI. The sort
  called capture time is the Exif `taken` (the camera's clock, subseconds included, read as UTC) and falls back to the
  file's mtime, in the Cull and Develop lists and the Design filmstrip alike. Every prepared photo's index entry also
  holds its camera, lens, focal length, perceptual hash and six stats; `photobook stats <folder>` prints them.
- **Cull** (workflow plan 06): a full-window grid on the stage background, 12 px padding and 4 px gaps, 3 to 8
  columns (5 by default, J / K and Cmd+− / Cmd+=, remembered per machine). A cell is the thumbnail contained (not
  cropped) on `bg-line`, the flag badge top left, the edited dot top right, the stars bottom left and the file name in
  a bottom gradient on hover; rejects at 35 % opacity. Selected cells have a 2 px accent ring and a 10 % accent wash;
  the focused cell (the photo Space opens) a 2 px light outline 2 px out. One hint line under the grid lists the keys
  and the selection count. Click selects one, Shift+click a range from the anchor in the current sort, Cmd+click adds
  or removes one, Cmd+A selects what the filters show, Escape clears; arrows move the focus (Shift extends). Rating
  and flag keys act on the selection, else the focused photo, in one store update. Space or Enter opens Review in
  place on the focused photo; Escape there returns to the grid at the same scroll. A new source opens on the grid at
  the top. The selection is `ui.selection` (`{ keys, anchor }`), shared with Develop and the batch actions to come.
- **Groups in the grid** (Oct 13, 2026, plan 39; [CULL_PLAN 4.2](CULL_PLAN.md#42-groups)): with *Group* on (a
  filter-bar toggle with a ▾ menu, shown once the list has a group, on by default) a burst or re-shot subject is one
  cell. The group cell shows one frame (the focused one when the focus is inside, else the frame `,` / `.` last showed,
  else the kept frame when exactly one is kept, else the suggested best) on a stacked edge: a card behind it peeks out
  4 px at the top and right (`bg-panel-2`, 1 px `border-line`), the frame's face in front on `bg-line`. Bottom right,
  a 16 px badge reads `+N` (the other frames shown) and, once any is decided, `· k✓ r✕`; its colour says how far the
  group is: nothing decided `bg-stage/60`, some kept `bg-pick text-canvas`, every frame decided `bg-accent text-accent-ink`.
  A click on the badge (or G) opens the group in place: its frames start a new row, fill whole rows and carry a 2 px
  accent bar in the left padding; the next cell starts a new row after them; G again closes it. A filter that leaves
  one frame shows that frame as a plain photo. Arrows move by cell; a collapsed group takes the focus, the selection
  and the rating and flag keys through its shown frame, and auto-advance goes to the next cell. Cmd+G selects the
  group, C compares its frame with the suggested best, N surveys its frames. The ▾ menu: *Grouping* Tighter · Normal ·
  Looser (half or twice the 2 s and 30 s gaps), Merge selected, Split group (before the focused frame), Ungroup, and
  the known limits in one line; right-click adds Merge into one group, Split group here and Detach.
- **Decide view** (Oct 13, 2026, plan 40; [CULL_PLAN 4.3](CULL_PLAN.md#43-the-decide-pass)): a view of the Cull
  stage beside Compare and Survey (`components/cull/DecideView.tsx`), same 44 px header and key-hint line, on
  `bg-stage` with the picture on `bg-surround`. Header, left to right: *Decide*, then the progress `142 / 600 decided
  · 38 kept of ~60` in `text-fg-muted` tabular figures (without a target: kept only), then at the right *Target ▾* (a
  popover: a number and *photos* or *% of N*, Set and Clear; disabled with a hint when the list spans several
  folders) and *Done Esc*. The picture is the proxy, fit; Space shows it at 1× of the proxy centred on the sharpest of
  the 8 × 8 stat tiles (`stats.sharpestTile`; the centre without stats or once crop, rotate, flip or straighten moved the pixels), Space again fits; a kept or rejected photo
  carries the grid's flag badge top left. A group adds an 80 px strip under the picture: `Frame 3 of 9 · 6 undecided`,
  then 56 px thumbnails (the shown one ringed in accent, kept ones with the pick dot, rejected ones at 35 %); a click
  shows that frame. The key hint changes with the unit (group or single photo). Words in Cull: *Keep*, *Reject*,
  *Undecided* (the filter offers *Kept only* and *Undecided*; flag badges read Kept / Rejected); stars are off in the
  grid until the filter bar's *Stars*. The filter bar's Cull fragment starts with *Decide* (pressed while the view is
  open) and the `decided / total` fraction. The end: the picture area says `Culled: 58 kept, 542 rejected` with *Review
  rejects…* and *Rate the keepers* (Survey over the picks, Review for one); U brings the last decision back and the
  pass resumes. The pause nudge is one `text-fg` line above the key hint, "Good place to stop?" with a *Dismiss* that
  never takes the focus. A folder whose `culledAt` is set and has no undecided photo shows a `text-ok` ✓ before its
  count in the sidebar.
- **Lens badges** (Oct 13, 2026, plan 41; [CULL_PLAN 4.4](CULL_PLAN.md#44-technical-lenses)): Soft, Blown and Dark
  rank and explain; they never flag. In the grid a photo in a lens carries a dim 16 px glyph in the cell's top-right
  row, left of the edited dot and the needs-denoise badge (the row is one flex line, right to left): Soft a dashed
  ring, Blown a sun, Dark a crescent, each `text-fg-muted` on `bg-stage/60` (Blown over 5 % a step up, `text-fg-2`);
  its `aria-label` is the lens and its `Tooltip` the number ("Likely blown: 71 % clipped", "Soft: sharpest tile 4");
  the caveat is the filter bar's line only. The filter bar's *Lens* `Select` (No lens, Soft · n,
  Blown · n, Dark · n: the counts are over the list while no lens is on) sits after the Group controls; with a lens on,
  its caveat is one `text-fg-muted` 11 px line under the bar's controls, ending "A lens never flags: ⌘A then X rejects
  what it shows", and on Blown it counts the RAW sources (*RAW headroom*). Decide: the header names the shown photo's
  lenses as `Tag`s (with the tooltip); a group's strip marks its sharpest frame with a `bg-fg` dot top right and draws
  a 2 px bar along the bottom of each thumbnail, its `sharpnessMax` against the group's sharpest, and the strip's line
  adds "64 % of the sharpest ●" (or "sharpest ●"). Right-click on a grouped photo: *Select the group's softer frames*
  (all but the suggested best; X then rejects them). The sidebar's built-in *Worth a look* collection lists the photos
  in any lens, once some photo has stats.
- **Reject pile and the Trash** (Oct 13, 2026, plan 42; [CULL_PLAN 4.5](CULL_PLAN.md#45-rejects-to-the-trash)): the
  only way a photo leaves its folder. *Review rejects…* (Project ▾ while a Cull stage is mounted, the Cull grid's
  right-click menu, the Decide end state; disabled with no reject) opens the pile over the Cull view
  (`components/cull/RejectPileView.tsx`): the Survey header (*Rejects*, `542 photos · 3.1 GB`, the marked count,
  *Done Esc*) over a scrolling grid of 3:2 tiles (168 px minimum, 8 px gap, thumbnails contained on `bg-surround`, the
  reject badge top left, the name bottom right), and a footer with the key hint (U rescue, ⌘A all, Shift+click mark,
  arrows, Esc back) and a `danger` *Move 542 to the Trash…* on the right. The pile is every reject of the list's
  folders, never the filtered view. U makes the focused (or marked) photos undecided, outside undo; they leave the
  pile and the focus takes the next. The dialog (`DialogShell`, title *Move to the Trash*): "Move 542 photos (3.1 GB)
  to the macOS Trash? Photobook cannot undo this. They stay in the Trash until you empty it.", then, once the projects
  are read ("Checking which projects use them…" until then), "4 of them are placed in *Lisbon book*." with the
  checkbox *Keep those 4 in the folder* (on by default; off says "The projects keep them as Missing photos."); footer
  *Cancel* and the `danger` *Move 538 to the Trash* (the count follows the checkbox). The move closes the pile and
  goes back to the grid with the focus on the next photo that stays; up to 10 photos move at once, more run as a
  *Move to Trash* job (jobs bar ring and cancel) with a busy toast. The end toast: "Moved 538 photos to the Trash", or
  in `danger` and kept until dismissed "… Not moved: a.jpg (reason), …" naming up to three failures.
- **Compare and Survey** (workflow plan 07): two more views of the Cull stage's main area (`ui.cull.view`), no routes,
  each reading the same filter bar above it and Escape back to the grid. *Compare* (C): a 44 px header (title,
  "Candidate n / total", a Fit · 1× · 2× · 4× toggle group on the right), two equal panes with a 12 px padding and 4 px
  gap, a one-line key hint under them. A pane is a 28 px caption row (role, file name, size, stars, flag) over the 1600 px
  proxy on a 20 % black well; the one that takes the rating and flag keys has a 2 px accent ring, the other a 1 px line
  ring. Zoom and the loupe point (a fraction of the picture) are one state for both panes (`useLinkedViewport`), so a
  click on a detail of one shows it on both; a click zooms to 1× there (cursor `zoom-in`), a drag pans (`grab`), a
  second click fits; the point is held where the picture still fills the pane, and a pane on its thumbnail alone
  ("Preparing preview…" in its caption) keeps both at fit with the zoom buttons disabled. Rejects are at 40 % opacity. *Survey* (N): a header ("Survey", the count or "One photo remains",
  Done Esc), then the photos as CSS grid tiles with an 8 px gap and the columns chosen for the biggest pictures
  (`surveyColumns`); a tile is the proxy contained on a 20 % black well with flag (top left), stars (bottom left) and
  name (bottom right) badges; the focused tile has the grid's 2 px light outline, a Shift+clicked (marked) tile the
  accent ring and wash. X rejects and removes; the last tile refuses it; Escape selects the survivors in the grid.
- **Saved collections**: *Save as collection…* opens a small popover (name field, one line saying a collection is a
  filter, Save); it stores the source's condition and the filters at once (so the collection shows exactly what was
  on screen; picks with *Rejects only* shows an error instead) in `<appdata>/collections.json` and opens the new
  collection with the filters cleared. The search matches names containing every word typed. The project's own Cull (`/project/$id/cull`, Project ▾ → Cull its photos) is
  the same grid over the project's photos with the project's filters (*Hide used* hides photos on a page); its Cull
  tab stays on the project and D opens Develop over it.
- **Design stage**: the editor shell below. Its left panel has three tabs, **Project** (the project's filmstrip),
  **Library** (a folder picker, the library filters, an *Add N to project* button and a 3-column grid whose cells show
  flag, stars and a check when the photo is in the project, an *Add* button on hover, and drag onto the page) and
  **Layouts**. The Project tab's *Cull* button and R open Review over the editor on the project's photos, D opens
  Develop.
- **Design documents** (workflow plan 13): a project holds the book and other documents made from the same photos,
  social posts, prints and slideshows. A drop-down sits right of the stage tabs, showing the open
  document's kind icon and name: **Book** first, then each document with its icon, then **New…** (a kind picker:
  *Social post*, *Print*, *Slideshow*), and **Rename…**, **Duplicate** and
  **Delete…** (asks first; Cmd+Z brings it back) for the open document. Each document has its own canvas, page strip
  and page size (a post's is its network's, see *Social posts*), and the route says which one is
  open (`/project/$id/design/book`, `/project/$id/design/<id>`; plain `/design` goes back to the last one shown, and
  an unknown id goes to the book). The right of the top bar shows **Publish** for the book and **Export…** for any
  other document (a post's opens the export sheet; a print's reads **Export PDF…**, see *Print*; a slideshow's
  **Export video…**, see *Slideshow*); documents other than the
  book are never published. *Hide used* and the check badges in the filmstrip count the open document's pages. The UI
  never says "output" or "display".
- **Social posts** (workflow plan 14): **New… → Social post** asks for the network first (Instagram carousel, square,
  story; TikTok photo slideshow; Threads; Bluesky; X; Pinterest pin), each row with its ratio and the limits in its
  tooltip, and names the post after it. The network is data (`social/templates.ts`: pixel size, frame limit, safe-area
  insets, preferred format, caption limit, the date they were checked), never code per network. On the canvas the safe
  area is its own layer over the page (`SafeAreaGuides`, apart from the layout and snap guides): the edges the
  network's interface or the profile grid covers are shaded orange behind a dashed rectangle, labelled "Instagram
  safe area", shown with the *Show safe area* preference (the Instagram profile grid crop on the first frame only, since
  only that frame appears in the grid). The page strip numbers frames as the files will be named
  (01, 02, …) and its add tile shows the count against the limit (3/20); at the limit, adding or duplicating a frame
  shows a toast ("A Bluesky post holds up to 4 frames") instead. **Send to post…** is in every page's strip menu and,
  as **Send page to post…**, under *Share* in the page inspector: a small dialog lists the other posts with their
  ratio and frame count (full ones greyed) and **New post…** (the network list); the page is copied to the end, the
  toast says where it went and its **Show** opens that frame. With nothing selected on a post the inspector's header
  reads *Post and frame* and it starts with *Post* (network, size, frame count, **Add frame**) and *Caption* (a
  textarea with `n / limit` under it, red with "n over Bluesky's limit" past it; committed after a pause, so a burst
  of typing is one undo step). **Export…** opens a sheet: destination (read-only path with **Choose…**, defaulting to
  `Exports/Posts` in the project's folder), a line saying what it writes (`summer/01.jpg … 10.jpg and caption.txt`),
  format (JPEG or PNG, the network's marked), *Open folder when done*, and a warning when the caption is over the
  limit. The export runs as one job in the jobs list (progress counts frames) and ends in a toast, bottom-left above the photo export toasts, with
  **Reveal in Finder**.
- **Print** (workflow plan 15): **New… → Print** makes a print at once (no step), on the paper whose shape is the
  pages' (8 x 10 in for a 4:5 book), and opens it. A print has no pages of its own: the canvas and page strip show
  what it prints (the book's pages, or a post's frames) and edit them in place. With nothing selected the inspector's
  header reads *Print and page* and it starts with *Print*: a summary line ("A5 portrait spreads, 154 × 216 mm with
  bleed", then "12 pages on 7 PDF pages · crop marks") and six rows in the inspector's label-left, control-right style
  (*Prints*: the book or a post; *Paper*; *Orientation*; *Layout*: single pages or spreads; *Bleed (mm)*, committed on
  blur or Enter; *Photos*: dpi), a *Crop marks* checkbox (on by default), an amber "Post deleted; printing the book" line when its post is gone, an amber note when the pages' shape is not the paper's (it
  names the shape of each and the paper that fits), and a muted line with the PDF page size. *Presets* below has one
  full-width button per preset, its name left and what it sets right in muted text (**Zine** · A5 spreads, 3 mm bleed,
  crop marks). Every change is one undo step. The top bar's button reads **Export PDF…** and opens a sheet like the
  post's: a sentence on what the PDF holds (pages, PDF pages, the summary, marks, dpi), destination with **Choose…**
  (default `Exports/Print`), "Writes zine.pdf", *Show in Finder when done*, an amber *Replace the existing zine.pdf* checkbox when the file exists (Export PDF stays
  off until it is ticked), and the footer note that Chromium is
  needed and colours are sRGB. The job ("Zine · zine.pdf") shows in the jobs list; its toast ("Making zine.pdf of
  “Zine”…", then "Saved …" with **Reveal in Finder**) sits above the post export toasts. There is no trim or bleed
  overlay on the canvas yet.
- **Slideshow** (workflow plan 16): **New… → Slideshow** makes one at once with the defaults (the book's pages, 4 s a
  slide, crossfade, Ken Burns, 1080p landscape) and opens it. Like a print it has no pages of its own: the canvas shows
  its source's pages (a post's frames when the source is a post; the book's for the picks). With nothing selected the
  inspector's header reads *Slideshow and page* and it starts with *Slideshow*: rows in the label-left, control-right
  style (*Slides*: the book's pages, the picks or a post; *Order*; *Seconds per slide*, committed on blur or Enter;
  *Transition*: cut, crossfade, dip to black; *Motion*: still or Ken Burns), then the transition preview, *Size*, and
  *Audio* (the file's name, **Choose…**/**Change…** and **Remove**; "None: the video is silent"), and a muted summary
  ("12 slides · 0:48 · 1920 × 1080 · 30 fps"). The preview is a 132 px high box at the video's aspect: two gradient
  tiles numbered 1 and 2 loop through the chosen change (cut, crossfade, dip through black), zooming and panning when
  Ken Burns is on, still under reduced motion; it shows the kind of change, not the slides. An amber line says when
  the picks are empty ("No photo is picked yet: pick some in Cull."). The top bar's button reads **Export video…** and
  opens a sheet like the print's: a sentence (slides, length, size, fps, frame count, the audio's name), destination
  with **Choose…** (default `Exports/Videos`), "Writes trip.mp4", *Show in Finder when done*, an amber note with
  Export disabled when no FFmpeg is available (pointing to Settings → Tools), while FFmpeg's status is unknown or
  could not be read, and while the same slideshow is exporting (a muted line says so), and the footer note that
  Chromium is needed and the frames are deleted after the encode. **Export video** checks FFmpeg, the audio, the
  destination and the disk first (a red line with the reason when one fails) and asks "trip.mp4 already exists in …
  Replace it?" before replacing a file. One job shows in the jobs list ("Trip · trip.mp4": the gates, then the frames,
  then the encode's frame count); the toast ("Making trip.mp4 of “Trip”…", then "Saved …" with
  **Reveal in Finder**) sits above the print toasts. **Settings → Tools** is a section after *Models*: FFmpeg's title,
  download size and licence, **Download** (with a progress bar and **Cancel**) or **Delete**, **Check** (the version
  line, and whether it has the H.264 encoder), and which program slideshows use (downloaded or installed).
- **New project** (Home): title, page size, folder, and *Add to the project*: All photos, Picks only or Nothing.
- **Native shell** (Oct 13, 2026, plan 43; [ODDHALLS_UI_PLAN 6 (43)](ODDHALLS_UI_PLAN.md#43--native-shell-and-the-tauri-artifacts)):
  the app is **oddhalls** (window title, product name, the Home wordmark in Instrument Serif italic; the bundle
  identifier stays `com.photobook.editor`). The title bar is an overlay: the traffic lights sit in the 44 px top bar's
  78 px left inset and the window drags from the bar itself (`data-tauri-drag-region` on the bar, never its controls;
  Home has a 44 px strip instead). Nothing outside a text field can be selected (`user-select: none` with the
  `input, textarea, [contenteditable], .selectable` opt-in), no image drags a ghost, nothing bounces
  (`overscroll-behavior`), the browser's right-click menu never shows (a text field keeps the system's), and a
  release build ignores Cmd+R and F5. Every scroll container uses the `scrollbar` utility (8 px, the thumb only while
  hovered); the Design canvas scrolls only past fit. Folders (Rename…, Export…) and projects (Rename…, Reveal in
  Finder) have a right-click menu in the sidebar. The native menu bar (File, Edit, View, Photo, Window, Help) is behind
  `VITE_PHOTOBOOK_NATIVE_MENU=1` until plan 49.
- **Tokens v2** (Oct 13, 2026, plan 44; [ODDHALLS_UI_PLAN 2.2, 2.3](ODDHALLS_UI_PLAN.md#22-a-good-colour-for-photography)):
  colour, radius, elevation and motion come only from the tokens in `apps/editor/src/styles.css` (`stage`,
  `stage-mid`, `canvas`, `panel`, `panel-2`, `panel-3`, `hairline`, `line`, `fg`, `fg-2`, `fg-muted`, `accent`,
  `accent-ink`, `accent-soft`, `danger`, `warn`, `ok`, `guide`, `pick`; `--radius-xs|sm|md|lg|pill`;
  `--shadow-raised`, `--shadow-float`, `--highlight-top`; `--ease-out`, `--dur-fast|base|slow`, zero under reduced
  motion; plus `surround`). The accent is brass `oklch(0.80 0.11 80)` with `accent-ink` text on it, never on a photo except the Looks
  tile ring and a frame's selection outline. The stage is achromatic and fixed (scrims and chips over a photo); the
  photo wells (Develop, the Review loupe, the Design desk, the Cull grid) use `surround`, which follows **Settings →
  Appearance → Surround** (Black, the default · Charcoal · Mid grey, per machine). Durations: `duration-fast|base|slow`. Section titles are sentence case
  (`section-title`, 12 px medium `fg-2`); `tag` is the 10 px mono uppercase. A star rating on a chip over a photo is
  `fg`; rated stars in the chrome are `accent`. `/fixture` → Kitchen sink shows every token with its computed value
  and contrast. `pnpm lint` runs `scripts/check-palette.mjs`, which fails on any Tailwind palette or arbitrary colour class.
- **Primitives and the shell** (Oct 13, 2026, plan 45; [ODDHALLS_UI_PLAN 4.1, 3](ODDHALLS_UI_PLAN.md#41-buttons-and-controls)):
  every control comes from `apps/editor/src/components/ui/`: `Button` (primary · soft, the default · ghost · danger ·
  toggle; 28 or 24 px, 6 px radius, a half-pixel press, the focus ring with a gap), `IconButton` (a tooltip with the
  shortcut in mono), `Segmented` (the indicator slides under the active item), `Field`, `Input`, `NumberInput` (mono,
  the unit after it, Option + wheel), `Select`, `Checkbox`, `Switch`, `Menu` and `Menu.Context`, `Popover`, `Tooltip`
  (600 ms), `Toast` (one stack bottom-left; a job's carries a 16 px ring), `Tag`, `ProgressRing`, `DialogShell`
  (`panel-2`, 12 px radius, the title 15 px, rising 8 px as it fades in). One menu style for Project ▾, the document
  drop-down, View ▾ and the context menus (sidebar rows, the Develop strip: Make a version, Copy and Paste settings;
  the page strip): `panel-3`, a hairline, 28 px rows, the shortcut in mono at the right; every menu opens on Enter,
  Space and ArrowDown and gives the focus back on Escape. The stage tabs are a segmented control whose indicator slides
  to the new stage across the route change. The sidebar has no right border; its rows are 26 px, the current one
  `panel-3` with a 2 px accent bar, counts in mono counting up when it opens. The filter bar has no border. The jobs
  pill is a progress ring and the count. "Saved" fades in for 1.2 s after a write and goes; a failed save stays as a
  red "Not saved" with the reason on hover. `/fixture` → Kitchen sink has Primitives and Shell pages
  (`#/fixture?tab=sink&page=shell`). `scripts/check-palette.mjs` fails on a `<button>` drawn with `rounded-md border
  border-line` or `border-line bg-panel-2`.
- **Slider v2 and the Develop panel** (Oct 13, 2026, plan 46; [ODDHALLS_UI_PLAN 4.2, 4.3, 3](ODDHALLS_UI_PLAN.md#42-the-slider)):
  the Develop slider keeps its values, steps, keys and undo; only the look and the feel change. The label (`fg-2`) and
  the mono readout sit over a 4 px pill track (white 14 %, the fill from the default to the needle `fg` 70 %; the
  temperature, tint and colour-mix gradients at 70 % saturation). The thumb is a **needle** (4 × 16 px, `fg`, a 1 px
  `stage` ring), 6 × 18 px on hover and while dragging, the accent while the track has the keyboard focus; judged on
  the kitchen sink, it reads on every gradient track, so no knob anywhere. Ticks at the default, halfway to each end
  and at the ends fade in on hover. The whole row is the drag surface: a press on the track jumps to the pointer once
  it moves, a press on the label or the readout drags from the current value, and a click on the readout still types
  a value. The detent: within 1.5 % of the range from the default a drag holds the default (Shift, the fine drag,
  skips it) with a 1.15× bump of the needle and one haptic tick per crossing; a key or wheel nudge that lands on or
  passes the default ticks too. Option + wheel over a row nudges by a step (Shift ×10); a plain wheel scrolls the
  panel. A double-click springs the needle home (`linear()` where the webview has it, else `ease-out`, over `slow`)
  while the readout counts back through two values. A row off its default carries a 4 px accent dot before its label.
  **Haptics** (`lib/haptic.ts` → the `haptic` command, `NSHapticFeedbackManager`): the slider detent (the Angle
  slider's is straighten at 0°), a frame landing on a guide on the canvas, the canvas zoom reaching Fit or 100 %; at
  most one per 80 ms, none under reduced motion, **Settings → Appearance → Haptics** (on by default, per machine);
  silent without a Force Touch trackpad. The panel is cards (`panel-2`, 8 px radius, 8 px apart), titles in sentence
  case that toggle the card, the reset as a ghost icon at the right of the title row; the header is one row that never
  wraps: Develop, the Edited tag, the render dot, Presets and a ⋯ menu (Sync…, Copy, Copy…, Paste, Reset all). While a
  preview is late by more than 300 ms a 6 px accent dot pulses in the header, and on the Looks tile that asked for it;
  under 300 ms nothing shows. The batch bar is a `panel-3` pill over the foot of the picture that slides up with a
  selection (and counts the selection's jobs, "1 of 3"); the versions are a pill at the top of the picture. Looks
  tiles have a 4 px radius, the name under them, the chosen one the accent ring. A grip at the picture's left edge
  drags out a before / after split (the original on the left of the line; view only, never an undo step); drag it
  back to the edge or double-click it to close. The Crop, Before / After and Proof buttons are `toggle` buttons.
- **Design canvas chrome** (Oct 13, 2026, plan 48; [ODDHALLS_UI_PLAN 3, 6](ODDHALLS_UI_PLAN.md#48--design-canvas-chrome)):
  the desk keeps `canvas` with the dot grid at half the hairline's strength and the page's paper shadow. Every floating
  thing on the canvas is a `panel-3` pill with a hairline and the float shadow: the tool group (Select V, Frame F, as
  `toggle` icon buttons), the photo toolbar and the multi-selection toolbar beside the selection and the alignment
  toolbar over it (12 px radius, 32 px ghost icon buttons, `Button size="lg"`, with tooltips; Fix spacing under a hairline, its icon in the
  accent), the Adjust hint, and the zoom HUD bottom-right ("Fit · − ━ + · 77 %", Fit a toggle, the readout in mono).
  Handles are 8 px, `fg` with an accent edge and the raised shadow's top highlight. Colours over the page: snap lines,
  their measures and badges are the accent (the drag's feedback); ruler guides, the grid and the safe and hard margins
  are the guide blue; a post's safe area is `warn`; a slot under a dragged photo lights white, not accent; the accent
  otherwise marks only the selected frame's outline (`components/editor/canvasColors.test.tsx`). Rulers are `panel-2`
  with a hairline and mono numbers. Page strip tiles have a 4 px radius and mono numbers; the current one carries the
  accent ring 2 px out; the `+` tile is a dashed hairline. The inspector's sections are cards like Develop's (`panel-2`,
  8 px radius, 8 px apart, sentence-case titles, labels `fg-2`), its controls from `components/ui` (`Input`, `Select`,
  `Switch`, `Tag`, a segmented track for Slot ratio and Align; fields in a card fill with `panel`; the text size
  stays live per keystroke). The canvas notices
  ("This page is now custom" with Undo, a post's frame limit, "Sent to …") show in the one toast host, bottom-left, one
  at a time. `/fixture` → Kitchen sink → Design draws all of it on the fixture book.
- **Cull, Compare, Survey skin** (Oct 13, 2026, plan 47; [ODDHALLS_UI_PLAN 3, 4.4, 6](ODDHALLS_UI_PLAN.md#47--cull-compare-survey)):
  grid cells are the thumbnail on the surround with a 4 px radius and an empty `panel` cell (no skeleton, no icon)
  while it prepares; hover lifts a cell 1 px with a faint ring. **Selected** is a 2 px `fg` ring plus a white check
  disc beside the flag (top left); **focused** (what the keys act on) is the one `accent` ring, 2 px wide and 2 px out,
  a single element per grid that slides between cells over `base`, so arrowing re-renders no cell. The accent touches
  nothing on a photo: the edited dot and the "all decided" group badge are `fg`, the open group's bar `fg-2`. Stars pop
  (1 → 1.25 → 1 over `fast`) and the keep flag stamps (.6 → 1 over `base`) only when they change, a reject dims the
  photo over `base`, thumbnails blur up from 8 px as they load, and a grid that opens on a new list shows its cells in
  order 60 ms apart (`--stagger`, capped at the 24th cell; zero under reduced motion with every duration). A photo in a
  running batch gets a thin accent underline in the gap below its cell that fills as its item finishes. The selection's
  actions are a floating `panel-3` pill at the bottom centre ("2 selected · Export 2… · Denoise… · ⋯ · Clear",
  the ring and "23 of 58" while their jobs run), shared with Develop as `ui/Pill`; the grid's end padding grows
  by the pill's height while it shows, so the last row is never under it. Compare: the zoom is a segmented control,
  each picture has a caption under it (side, name, size, stars, flag), and the pane with the keys carries the accent
  ring outside its edge. Survey: marked tiles carry the white ring and check, the focused one the accent ring; X
  shrinks the removed tile to nothing while the others move to their places (a view transition where the browser has
  one, else a cut). Decide, the reject pile, the loupe's chrome and `CullFilters` use the primitives; the loupe's stars
  and every thumbnail strip's current tile are `fg`, not the accent. `/fixture` → Kitchen sink → Cull shows every state.
- **Home** (Oct 13, 2026, plan 50; [ODDHALLS_LAYOUT_PLAN 1](ODDHALLS_LAYOUT_PLAN.md#1-home)): a real top bar
  (`panel-2`, hairline, 44 px, the 78 px traffic-light inset, the window drags from it) with the small `oddhalls`
  wordmark in Instrument Serif italic left and Settings right; under it, on `canvas` with no dot grid, a 60 rem column:
  the Start row (Open a folder…, primary, imports the picked folder and opens it in Cull; New project…; Open project
  file…), Recent projects as 160 px cover cards (the first page through the shared `<Page>` on its paper inside a
  `panel-2` box, a hover lift, the focus ring on the card chrome, never an accent on the cover; title and ⋯ menu with
  Rename…, Reveal in Finder, Delete…; "24 pages · edited 2 d ago" under it; a project with no pages draws the empty
  paper; an unreadable one says why in `danger`), and Recent folders as 40 px rows (name, "612 photos · 58 kept ·
  culled ✓" with the check in `ok`, or "84 photos · 12 undecided", then Cull and Develop; a missing folder shows the
  red Missing tag and no buttons; right-click removes a folder from the list). Four of each, *See all N* expands in
  place. With no project and no folder: the Start row and one serif line, "Open a folder to start culling, or make a
  project to design." `/fixture` → Kitchen sink → Home draws it on synthetic data.
- **Shell panes** (Oct 13, 2026, plan 51; [ODDHALLS_LAYOUT_PLAN 2, 3, 4.3](ODDHALLS_LAYOUT_PLAN.md#2-the-shell-every-stage)):
  every stage is a top bar, a left pane, the centre, a right pane and a strip (`PaneShell`). Tab hides both side panes
  (or shows both), Shift+Tab the strip too; the state is per stage and per machine (`ui.panes`, localStorage), never in
  the project. Tab keeps its meaning in a text field, on a focused control, in a menu or a dialog, and in Compare
  (which pane the keys act on). Cull's left pane is the Library sidebar with a **Filters** section between Collections
  and Projects (flag, stars, Edited, ISO ≥, Hide in project / Hide used, Sort, then Cull's Decide, Stars, Group and
  Lens); the bar above the grid keeps search, "142/600 decided" in mono, *Decide*, the counts and Clear filters.
  Develop has no Library sidebar: its left pane (220 px) holds Looks (with Amount and the LUT picker), Presets, History
  (this photo's undo steps as rows, newest first, "Exposure +0.30", "Look: Wren", "Crop"; a row undoes back to it
  unless another photo's or the document's edit came after it, then it is greyed) and Versions (the chips' pill,
  moved from over the picture). The crop tool's panel shows even with the right pane hidden. Design hides the left
  panel, the inspector and the page strip. The built-in *Picks* collection reads *Kept*.
- **Cull mouse and the Photo pane** (Oct 14, 2026, plan 52; [ODDHALLS_LAYOUT_PLAN 3](ODDHALLS_LAYOUT_PLAN.md#3-cull)):
  the filter bar has the view switch, Grid · One · Two (One is the loupe in place, Two is Compare), and one zoom: in
  Grid a slider over the column count (to the right, bigger cells), in One and Two Fit · 1× · 2× · 4×, shared by both
  and remembered per machine. The mouse: in the grid a click selects (Shift range, Cmd toggle), a double-click opens
  One, a drag draws a marquee (`fg` hairline on a 10 % `fg` wash) that selects what it touches (Shift or Cmd adds);
  in One and Two a click focuses the pane, a double-click zooms to 1× at the point and again to fit, a drag pans.
  Right-click anywhere on a photo: Keep · Reject · Undecided · Develop this photo · Compare with best · Add to project
  · Export… · Merge / Split / Detach · Reveal in Finder · Move to Trash… (it only opens the reject pile), then the
  settings items; a text field keeps the system menu. The right pane, **Photo** (300 px, Tab hides it): Histogram
  (80 px, luminance as a soft `fg` area under red, green and blue drawn in `danger`, `ok` and `guide` with the screen
  blend, so their overlap reads white; an empty `stage` box while it loads), File (name, size, bytes, format, Keep /
  Reject toggles, stars), Camera (camera, lens, "50 mm · 1/250 s · f/2 · ISO 800", taken on the camera's clock, the
  coordinates with a small *map ▸* that opens Apple Maps), Signals when stats exist (sharpest tile, blown, median
  brightness; the lens caveats on an ⓘ tooltip), In projects (links). Several selected: the count, kept and rejected,
  the shared camera, the date range, and Keep, Reject, Export…, Clear. With no photo: "Select a photo".
- **Cull assist overlays and Group by** (Oct 14, 2026, plan 53; [ODDHALLS_LAYOUT_PLAN 3](ODDHALLS_LAYOUT_PLAN.md#3-cull)):
  One, Two and Decide share the overlays, all off by default and remembered per machine. *Assist* ▾ sits in the
  Compare and Decide headers (check items with their keys). F focus peak paints in-focus edges in the brass accent at
  60 %; Z zebra lays dark diagonal stripes over clipped highlights and lighter ones, the other way, over crushed
  shadows. Both are drawn by Rust over the developed preview (GPU, CPU reference) and shown as a layer over the picture,
  never stored. O cycles the composition guides: thirds, golden ratio, phi spiral, centre cross, diagonals (the crop
  tool's 45° ones), hairlines in `fg` at 50 %. Compare's fit moved to Shift+F. Under each Two pane a 4 px bar: this
  frame's sharpest tile against its group's sharpest (`fg` when it is the sharpest), or against the other pane
  outside a group. The Photo pane's Signals add "In its group: 0.82 of the sharpest ●". *Group by* in Cull's Filters
  (No dividers · Hour · Day · Camera · Lens · Place) adds divider rows to the grid: an 11 px `fg-2` label with the
  photo count on a hairline, a ▸ that collapses the section (remembered); the cells keep the list's order, so a
  section whose photos are apart gets a divider per run ("No capture time", "Unknown camera", "No location" for the
  photos without the fact); places are 500 m clusters labelled by coordinates. Bursts stay stacked inside a section.
- **Develop Basic ⇄ Advanced** (Oct 14, 2026, plan 54; [ODDHALLS_LAYOUT_PLAN 4.1, 4.5, 4.6](ODDHALLS_LAYOUT_PLAN.md#41-right-pane-adjust-in-the-owners-order-with-basic--advanced)):
  the right pane is seven cards in the order of operations, Crop, Light, Color, Detail, Sharpen & denoise, Effects,
  Masks; Light and Color start open. One **Basic ⇄ Advanced** segmented switch in the panel header, beside the ⋯
  menu, for every card, per machine (`ui.developAdvanced`, localStorage). Basic shows each card's common rows; the
  rest sits behind a ▸ row (a 28 px ghost row with the chevron and the label, "Curve", "Color mix", "Upright &
  transform", "Radius, detail, masking", one per Effects group, "Range & refine" on a mask component) that opens in
  place and stays open while stepping photos; an edit behind it shows as an accent `·edited` tag at the row's right.
  Advanced draws every ▸ open with its label as a section title. The cards and their ▸ parts are one manifest
  (`developCards.ts`). The Crop card is the crop tool's button (R) and a line saying what the crop is ("4:5 ·
  1.2°"); its reset is the whole geometry. The curve presets are pill chips above the curve (Linear · Soft S · Strong
  S · Matte · Faded · Reverse S; the matching one pressed): plain points, one undo step. Making a luminance or colour
  range mask opens its ▸. The header's **Before / After** is a split button: the click is the flip (\\), the ▾ offers
  Flip, Split (off with a crop, rotation or transform, as in plan 46) and Side by side (the original left, the edit
  right, one viewport as in Compare: a click zooms both to 1×, a drag pans both; it closes on stepping away or Reset
  all); **Y** cycles side by side → split
  → flip → off. The batch pill's first action is **Apply to all ▾** (Apply Light & Color to all n · Apply these
  sections… · Apply look to all n); with nothing selected and more than one photo in the strip the pill stays up with
  "Select photos in the strip to apply to several" and *Apply to all in the strip ▾* only. Develop's number fields
  stay as they are and commit, not per keystroke: a slider's readout (the Kelvin one too) on Enter or blur, Escape
  cancels; the crop tool's custom aspect on Enter or *Custom*. A typed value is one undo step and one render.
- **Color grading wheels** (Oct 14, 2026, plan 55; [ODDHALLS_LAYOUT_PLAN 4.2](ODDHALLS_LAYOUT_PLAN.md#42-color-grading-as-wheels-with-harmony-lock)):
  the grading's hue and saturation sliders become three 88 px wheels in a row (Shadows · Midtones · Highlights): a
  conic hue ring (0° red at the right, counter-clockwise) fading to a grey centre, a dot styled like the slider's
  needle (`fg` with a `stage` ring, larger on hover and drag, `accent` only with the keyboard focus; the colour field
  itself never carries the accent), the label above in `fg-muted`, the hue and saturation under it as two mono
  number fields. Shift holds the hue, Alt the saturation, double-click resets, arrows nudge. **Harmony lock ▾** sits
  above the wheels as a field `Select` (Free, Monochromatic, Complementary, Split complementary, Triadic, Tetradic,
  Analogous); the tied angles are thin `stage` spokes from the centre of each ring, and a dragged dot snaps onto the
  hue of a wheel that stays put with one `tick('alignment')`. Choosing a lock turns the tied wheels onto its angles
  around the most saturated one. The six presets are pill toggle chips under the wheels, like the curve presets. The
  ▸ *Luminance, global wheel* holds a full-width luminance slider per wheel (stacked: three columns truncated the
  labels) and a smaller 64 px Global wheel with its luminance beside it.
- **Masks, storytelling sorts and the chooser** (Oct 14, 2026, plan 56; [ODDHALLS_LAYOUT_PLAN 4.4, 5](ODDHALLS_LAYOUT_PLAN.md#44-masks-the-two-bugs-and-the-handle)):
  a new linear gradient is full where the drag presses and fades toward where it is released (Lightroom's way: press
  on the sky, pull down into the land); masks drawn before keep their points and look the same. Its end handles say
  which end is which on hover. Both gradients have the same rotate handle, a white disc with a turning arrow 24 px past
  the shape (the radial's edge, the linear's 50 % line), and a mono angle badge beside the pointer while turning;
  Shift snaps to 15°. Every mask row has an *Inv* toggle beside its on/off box. Right-click on a mask row, a component
  row or the picture under the tools: Delete (⌫) · Duplicate · Invert ✓ · Rename… (the name field in the menu) · Add
  to this mask ▸ (Subtract or Intersect, any tool) · Convert to… (linear ⇄ radial); Delete / Backspace removes the
  selected component, or the selected mask when no component is, one undo step, never from a text field. Design's
  Project tab has *Sort by* ▾ and *Group by* ▾ under its search; the Library tab has *Group by* ▾ under the folder and
  its *Sort* in the filters; Cull's Filters *Sort* lists the same orders: Capture time · Name · Rating · Sharpness ·
  Colour (the dominant colour's family, red to pink, then lightness, greys last) · Luminance (dark to light) · Aspect
  (portrait to landscape) · Warmth (cool to warm). Photos without the fact come last; sorting never writes anything.
  Group by (No grouping · Day · Place · Camera · Colour family · Aspect) draws a divider row: the label as a section
  title over a hairline, the count in mono at the right. **What's next for 58 keepers?** is a sheet over the canvas the
  first time a project with only the book opens on this machine, and New… in the document drop-down always: five cards
  (Export full quality · Export for social · Carousel · Photobook · Social post), then *Also:* Print · Slideshow ·
  Describe photos (AI) and Skip. Social post picks the ratio first (4:5 · 9:16 · 1:1 · 2:3), then the network.
  Keepers are the photos kept in Cull, or every photo but the rejects when none is.
- **Delight and polish** (Oct 14, 2026, plan 49; [ODDHALLS_UI_PLAN 4.4](ODDHALLS_UI_PLAN.md#44-delight-with-restraint),
  [ODDHALLS_LAYOUT_PLAN 6](ODDHALLS_LAYOUT_PLAN.md#6-loading-waiting-and-saving-the-animation-vocabulary)): changing
  stage (Cull, Develop, Design) crossfades the panels over `slow` and the picture (One's in Cull, Develop's) moves from
  where it was instead of fading; Develop opening over a project's Cull does the same; a webview without view
  transitions cuts. `\` crossfades the live render over `fast` (120 ms) instead of cutting. A job's toast completes its
  ring, draws the check (160 ms), holds the last running text 400 ms, then says what landed with Reveal in Finder; the
  jobs pill does the same and leaves. The Denoise loupe sweeps a line once from left to right as a result arrives,
  uncovering it. Every empty state is one line in Instrument Serif italic with its action under it. The tools have
  their own cursors (draw, rotate outside the crop, pan, panning), each with a standard fallback. Every icon-only button
  says what it does (and its key) in a tooltip, checked by a test; every keyboard focus shows the accent ring; the
  hand-drawn switches are `ui/Switch`. Reduced motion zeroes every duration token (`--dur-*`, `--stagger`), and
  Tailwind's spinner and pulse follow the tokens, so nothing animates and the end state shows at once. Cull: one
  *Group by* control (Bursts, the default · No grouping · By hour, day, camera, lens or place), Compare has no zoom of
  its own (the bar's is the one), and a side-panes button at the left of the filter bar does what Tab does. Develop's
  Versions are a card of pill chips. Settings has Home's bar (Back, title, status, Save). The native-menu flag stays
  until the owner has used it (plan 49's Status lists how to remove it); the site's screenshots are the owner's.

## Editor shell (three panels + page strip)

Reference screens:

- [Magnific editor](https://mobbin.com/screens/34a51d49-e479-4327-b912-36f2e7ceb2f2): the layout. Assets left, canvas center, inspector right, numbered page strip bottom.
- [Klaviyo editor](https://mobbin.com/screens/00d9cdde-80c9-4acf-b097-9271262da1e8): a light inspector with titled sections (Image, Alt text, Image layout), small labeled fields, a floating vertical toolbar that sits beside the selected element (duplicate, favorite, AI, crop, delete), a Desktop / Mobile segmented toggle above the canvas, and a top bar with Preview and Exit on the right.
- [Shopify image editor](https://mobbin.com/screens/5ec9f2d9-dd23-4551-897a-653b312f0256): dark near-black canvas with a faint dot grid, photo centered with breathing room, a right column of stacked collapsible panels (Crop and transform, Resize, Draw, Color background). Save and Discard top-right.
- [Telegram web editor](https://mobbin.com/screens/27f12475-04e5-47ec-8029-bab2d008302d): dark inspector with a color picker, alignment segmented control, size slider, and a scrollable font list where each name renders in its own face.
- [Flodesk layout picker](https://mobbin.com/screens/bd2437c0-d777-4c6d-b31b-300d135ccd60): Undo, Redo and a quiet "Saved" label in the bottom-right.
- [Obvious select layout](https://mobbin.com/screens/3bdd7dc4-c938-4014-a7de-87c805cf9057): wireframe layout thumbnails with names in a grid.

Decisions:

- **Theme**: dark chrome. Canvas background `#1a1a1a` with a subtle dot grid; panels `#222` to `#262626`; borders `#333`; text `#e5e5e5` primary, `#8a8a8a` secondary. The page itself is white (or its background color) so it reads like paper on a desk. Accent `#4f8cff` for selection and focus.
- **Shell grid**: left filmstrip 280 px, right inspector 300 px, bottom page strip 120 px, top bar 44 px. Center canvas fills the rest. Panels have 1 px borders, no shadows.
- **Top bar**: see *Shell* above (since plan 05 the centre holds the stage tabs and `Edit | Preview` moved to the right group).
- **Filmstrip**: search field pinned at top, sort select beside it, 3-column grid of square thumbnails with 4 px gap, used photos get a small check badge bottom-right and a dimmed overlay. Hashing progress is a 2 px bar under the search field with a count. A filter row under the search: Hide used, flag (all / hide rejects / picks / rejects) and minimum stars, with an "N of M photos · Clear filters" line while anything narrows the list. Review flags sit top-left (white pick flag, red reject cross with the thumbnail dimmed), stars bottom-left. Search, filters and scroll live in the UI store so switching tabs keeps them.
- **Review**: full-window loupe over the editor (Review in the Photos header, or double-click / Enter on a thumbnail). One photo fit to the window, step arrows at the sides, Pick / Reject buttons and five stars under it, a strip of neighbouring thumbnails at the bottom. It steps through the photos the filmstrip showed when it opened.
- **Canvas**: page centered with fit-to-window, zoom slider bottom-right of the canvas (25% to 400%). Selection is a 2 px accent outline with four corner handles for photo slots. A small floating toolbar appears beside the selection (rotate, replace, remove, open original) like Klaviyo's.
- **Canvas gestures** (Oct 13, 2026, workflow plan 29; the table is `pressAction` and `doubleClickAction` in
  `components/editor/gestures.ts`): a drag on any frame moves the frame, the way Canva, Keynote and Figma do it, snapped
  to the guides (Cmd skips snapping) with the guides drawn while it lasts; the selected photo frame's 8 px outline band
  is a larger grab area for the same move. Frames show the `move` cursor. Panning the picture inside is a mode,
  **Adjust photo** (`ui.canvas.adjusting`): double-click a filled photo frame or press Adjust at the top of its floating
  toolbar (pressed while on). In the mode the frame's outline is dashed, its handles and band are hidden, a hint
  under it reads "Adjust photo: drag to pan, scroll to zoom, Esc to finish", the cursor is `grab`, a drag pans and the
  wheel or a pinch over the frame zooms the photo around the pointer. Escape, a press anywhere else (inside or
  outside the canvas; the floating toolbar and the toast keep it), another selection, a page change, the Frame tool,
  Preview, or the frame's photo being removed or replaced leave it. Space + drag on the selected photo frame pans once without the
  mode. Outside the mode a pinch zooms the canvas everywhere; the original opens from the toolbar (double-click no
  longer opens it). Alt + drag still moves the photo to another slot; double-click or Enter edits a text box. Resize
  handles: Shift inverts the frame's ratio lock (frees a photo, keeps a text box's ratio), Alt resizes from the centre.
  Arrow keys nudge the selection one grid step, Shift ten; a single frame also snaps along the step, but only forward,
  so it can always step off a line, and the guides it lands on flash for 0.6 s. The first hand edit (move, resize,
  nudge) that turns a layout page custom shows a toast at the bottom of the canvas, "This page is now custom" with
  Undo, once per page per session; it closes after 6 s (paused while hovered or focused) or as soon as another undo step
  lands, so its Undo only ever reverts that edit, and gives the focus back to the canvas.
- **Smart guides and alignment** (Oct 13, 2026, workflow plan 30; the engine is `packages/shared/src/layouts/snap.ts`
  and `align.ts`). Besides margins, the grid, other frames and gutter gaps, a moved frame snaps to **equal spacing**
  with two neighbours in its row or column (centred between them, or after or before a pair at the pair's gap), and
  a resized frame snaps to a neighbour's **width or height**; the threshold (6 px on screen) and Cmd to skip snapping
  are unchanged (a resize from the centre, Alt, gets no size match: its size is twice the edge's travel). These
  guides draw no line across the page: an equal-spacing guide is a measure with end ticks in each
  equal gap, labelled "equal · 0.35 in" (folded into the gutter badge when the gap is also a gutter, "gutter · 0.20 in
  · equal"), and a size match is a dimension line just outside the resized frame and the neighbour it matches, with
  "same width · 2.00 in" (or height) on the frame's. A drag on any member of a multi-selection moves the whole
  selection as one block: its bounding box snaps like a frame and the block stops when its first member reaches the
  edge (photos may run into the bleed); a click without a drag (a real release, not a lost one or the window losing
  focus) selects that member alone. Over a multi-selection
  (above it, or under it when it touches the top of the page) sits the **alignment toolbar**: align left, centre,
  right, top, middle and bottom to the selection's bounding box; distribute horizontally and vertically (three or
  more, the outer two stay); match width and height to the last selected element; and **Tidy**, which gives each row
  of the selection one gap, its mean gap put through the photo-to-photo rule (join, gutter, wide gutter or as is;
  the mean itself when that would push the row past the page plus the bleed), and keeps the row centred. A row is
  frames whose centres lie inside each other's span, both ways, so a short top-aligned caption beside a tall photo is
  not a row with it; a single column is tidied vertically. Tidy only evens the gaps along each row: a 2×3 grid keeps
  its vertical gaps. A row or a selection whose frames overlap along the axis (a text box over a photo, a frame inside
  a bigger one) is left alone by Tidy and Distribute. Every button is one undo step; rows that Tidy, Distribute or Fix
  spacing lay out move back onto the page as a block, so their gaps stay equal, then each frame is kept on the page.
  The block clamp of a drag or a row gives up on an axis (no shift) when no shift fits every member. After a single
  frame is dropped into a row of three or more photos whose gaps are now uneven (standard deviation above 0.025 in)
  and more uneven than before the press, its floating toolbar ends with an accent **Fix spacing** button: it tidies
  that row at the gap the drop broke (the mean of the gaps that do not touch the dropped frame, or of all of them for
  the middle of three, through the same rule) and belongs to that drop only: it goes with the next undo step
  (including undo and redo), a selection change or a page change, and when the gaps are even again.
- **Rulers and page guides** (Oct 13, 2026, workflow plan 31; `components/editor/Rulers.tsx` and `pageGuides.ts`).
  Two 16 px rulers sit just outside the page's top and left edges and scroll with it (they are not pinned to the
  canvas edges, so at a high zoom they scroll out of view with the page's top and left). They count inches on the 8 in
  reference page, the unit of every other canvas measure (the templates carry no unit, so there is no mm ruler):
  whole inches labelled, with halves, quarters and eighths as the zoom gives them room, and a small sky-blue mark
  where each guide is. A drag from the top ruler onto the page pulls out a horizontal guide, from the left ruler a
  vertical one; while it moves, a badge gives its position ("4.00 in") and it lands on the nearest 1/100 in. Guides
  are 1 px sky-blue lines across the page (blue so they read apart from the accent snap lines) with a 5 px grab area,
  narrow so a frame edge beside a guide stays clickable: drag one to move it along its axis (it keeps the offset
  between the line and the press, and nothing moves before the pointer travels 3 px, so a click or a double-click
  never nudges it), drag it off the page (back onto its ruler) to remove it, double-click it (or focus it and press
  Enter) to type a position in inches, or in mm or cm with the unit ("64 mm"), press the arrow keys along its axis to
  nudge it 0.01 in (0.1 in with Shift; the arrows never reach the canvas from a guide), and press Delete on a focused
  guide to remove it. Each add, move, nudge and removal lands as one undo step; Escape cancels a drag. While a dragged
  frame is snapped to a guide, that guide is drawn 2 px wide and brighter. Guides read from a file are clamped onto
  the page, and a malformed one is dropped rather than rejecting the file. The guide layer sits over
  the frames and under the selection's handles and toolbars, so a frame snapped to a guide can still be resized from
  that edge; with the Frame tool or on a blank page it is lifted over the frame-drawing layer. Guides are stored on the
  page (`page.guides`, fractions of the page, schema v8), saved with the project, never drawn by the shared renderer
  (Preview, the viewer, page thumbnails) and stripped by publish. The snap engine takes them as `guide` lines with the
  strength of margins and page edges, labelled "guide", so a frame edge or centre snaps to them before another frame's
  edge. A **View ▾** menu in the Design top bar holds the canvas prefs, each per machine like the other UI prefs:
  Show grid, Show safe area / margins, **Show rulers and guides** (hidden guides do not snap either, so with rulers
  hidden **Snap to guides** has no effect on the page's ruler guides, as its hint says), **Snap to guides** (Cmd while
  dragging still skips it) and **Show guides while dragging** (off: frames still snap, but no snap
  lines or distance badges are drawn), plus "Remove this page's guides" (one undo step).
- **Inspector**: titled sections with 12 px uppercase labels. No selection: Page section (background color, layout button that opens the picker, notes textarea). Photo selected: Slot ratio segmented control, Zoom slider, Rotate button, Filter select. Text selected: Preset, Family, Size, Weight, Align, Color, Pill toggle.
- **Photo filter (`bw`, `fade`)**: still rendered by the page element (CSS filters on the slot) and still valid in published books, but superseded by the Develop presets "Black & white" and "Faded" (`lib/develop/presets.ts`), which act on the photo itself. The elements' filters are not migrated or removed.
- **Develop presets, Sync and Lightroom import** (step D6.3): the Develop panel header reads Develop, Presets, Sync…, Copy, Paste, Reset all (it wraps at 320 px). *Presets* is a menu: the built-in presets, the user's saved presets (each with a delete cross that asks first), "Save current as preset…" (name plus a checklist of Light, White balance, Curve, Color, Detail; the edited sections start checked) and "Export settings as XMP sidecar…" (Photobook, lossless, or Lightroom crs, lossy with its warning). *Sync…* opens a modal over the Develop view: what to apply (this photo's sections, or a preset), a section checklist (Basic, Curve, Color, Detail on; Transform and Upright and Masks off, with a note; the crop, rotation and flips are never synced) and a thumbnail grid of the photos the Develop view steps through (Select all, Select none, Shift-click for a range). The Inspector's photo section and the filmstrip header have "Import Lightroom settings…" (Cmd+Shift+I inside the Develop view): a modal with a table of what changes (setting, now, imported), a "Not imported" list, an "Imported, but unverified" list, a checkbox "Also apply the sidecar's rotation" when the sidecar turned the photo, and a note for exported JPEGs whose pixels already carry the settings.
- **Page strip**: horizontal scroll of page thumbnails (shared `<Page>` at ~90 px height) with the page number above each, current page outlined in accent, a `+` tile at the end. Drag to reorder.
- **Layout picker**: modal grid of wireframe tiles grouped by photo count (1 to 6), each tile drawn with the layout's frames as gray boxes on a white page, name under it, hover lifts it.

## Develop view

Oct 10, 2026. The Develop module ([DEVELOP_PLAN.md](archive/DEVELOP_PLAN.md), user guide [../DEVELOP.md](../DEVELOP.md)). Modelled on Lightroom's Develop module with the editor's own chrome; the dark stage and panel tokens are the shell's.

Decisions:

- **Shell**: a full-window dialog over the editor (`fixed inset-0`, stage background), not a route, so the book, selection and undo history stay as they were. A 44 px header, the picture area with a strip of neighbouring thumbnails under it (10 each side), and a 320 px right panel (`Adjustments`). Tab stays inside the dialog; closing gives focus back to where it came from.
- **Strip, batch bar and versions** (Oct 12, 2026, workflow plan 08): the strip lists the session's photos, which in
  the Develop stage are the Cull filter's (shared state, `ui.libraryView` or the project's `ui.filmstrip`) except that
  *All flags* hides rejects there (the select reads "All but rejects"). Strip cells are 56 px: the shown one has a 2 px
  accent ring, selected ones a 2 px light ring and an accent check top left, edited ones the accent dot top right, and a
  project photo that uses a version its name in a black 9 px tag bottom right (the filmstrip cell has the same tag).
  Click shows a photo; Cmd-click toggles it in `ui.selection` and Shift-click selects a range from the anchor (else
  from the shown photo), without changing the photo shown. The **batch bar** (36 px, top border) sits between the
  picture and the strip: "n selected" and *Clear* on the left (a one-line hint when empty), the registered slots on the
  right as small outlined buttons (`BatchButton`): *Sync selected…* (the Sync modal from the shown photo with the
  selection checked) and *Reset edits* (one undo step; above five edited photos it turns into "Reset edits of n
  photos? Reset · Cancel" in place). Paste (plan 10), Apply look… (20) and Denoise selected (27) register their own
  slots (`registerBatchSlot`). The **versions row** (36 px, bottom border) sits under the header: a muted "Versions"
  label, chips *Master*, `v2`, … (the shown one filled with the accent wash; the one the open project uses carries a
  6 px accent dot), *Make a version*, then *Use in this project* (accent outline, inside a project when the shown
  version is not the one the project uses), and for a shown version *Rename* (or double-click the chip: an inline
  field) and *Delete* (a red one-line reason when a project still uses it).
- **Header**: file name, "n / N", pixel size, an "In the book" badge when the photo is on a page; on the right the toggles **Crop** (R), **Before / After** (\), **Proof: sRGB** or **Proof: Display P3** (S) and **Done** (Esc). Crop, Before / After and Proof use the accent border when on; the last two are disabled for an unedited photo.
- **Picture**: the cached developed proxy with the live render layered exactly over it, fit with `object-contain`; step arrows at the sides (hidden while the crop tool or guides are open); the live render replaces the original as soon as a slider moves. **Before** shows the original with an "Original" tag.
- **Panel header**: **Develop** with an "Edited" badge, then Presets, Sync…, Copy, Paste, Reset all (see the presets bullet above); it wraps at 320 px.
- **Sections** (collapsible, each with a **Reset** that fades when already default), in this order: **Looks** (see below), **Basic** (open by default: White balance, then Light), **Curve** (Parametric sliders with split handles, then the point curve with Luma / R / G / B tabs), **Color** (Vibrance, Saturation, then Color mix: eight band swatches, Hue / Saturation / Luminance tabs, eight sliders), **Transform** (Upright segmented control Off, Auto, Level, Vertical, Full, Guided, with Update, Show structure, Draw guides n / 4, a status line, the seven manual sliders and Constrain Crop), **Detail** (Texture, Clarity, Dehaze, Sharpening with Alt-drag mask view, then the Denoise group), **Masks** (M).
- **Sliders**: label and readout above a thin track; the track is tinted where the value has a meaning (temperature blue to amber, tint green to magenta, hue, depth). Double-click resets, click the readout to type, Shift for fine, arrows nudge. A whole drag is one undo step. White balance for RAW is a log-scaled Kelvin track.
- **Crop tool**: replaces the adjustment sections with **Crop & Straighten** (Aspect with a Locked toggle and presets Original, Free, 1:1, 4:5, 5:7, 2:3, 16:9, Custom; Swap; Angle with Auto and the Straighten tool; rotate and flip icons; Constrain to image; Overlay; Cancel and Done pinned at the bottom). The picture is drawn whole with the crop frame, eight handles, and the area outside it dimmed. Overlays cycle with O: Thirds, Grid, Diagonal, Golden ratio, Off. Return applies, Escape cancels back to how the tool opened.
- **Guides overlay** (Guided Upright): the transformed picture with up to four draggable lines; each line carries a small button that flips it between horizontal and vertical. Escape or stepping ends it. **Show structure** draws the automatic Upright's segments over the developed picture, yellow for used and grey for rejected.
- **Mask overlay** (O): the selected mask tinted red at its opacity over the picture, with the active tool's handles (the gradient lines and handles, the radial ellipse with its rotation handle, green and red dots and boxes for AI prompts). A "Generating…" chip replaces the tint while an AI job rewrites the mask. Each mask has a swatch colour in the list, an apply checkbox and a name that renames on double-click.
- **AI feedback**: a bordered busy row in the Masks section ("Finding the subject…" and the stage) with Cancel, a red inline error with a dismiss cross, and a modal for first-use model downloads (each model's size and licence, the total, Download / Cancel). Denoise shows its state as a pill on its row and a progress bar with tile count and Cancel (see the Denoise bullet).
- **Denoise** (Oct 13, 2026, workflow plan 28; Detail section): the row holds the "Denoise" label, the state pill and
  the switch at the right. The pill is 10 px text in a full-round chip: *Needs apply* (amber wash), *Queued* and *Needs
  model* (`line` grey, muted text), *Running 37 %* (accent wash, tabular figures; *Cancelling* while a cancel lands)
  and *Applied* (green wash), *Checking…* (`line` grey) while a status is read; no pill while off. The pill holds its
  last state between a run ending and the status after it, so it never flashes *Needs apply* on the way to *Applied*. Under the row the 11 px muted
  camera badge ("Fujifilm X-T5 · ISO 6400 · suggests 55 · learned from 12 photos"). While off, a photo whose
  suggestion is under 15 shows only "Not needed at ISO 200" (or "Not needed (clean at ISO 6400)") in its place, a
  text button that unfolds the badge; it folds only once the measurement is in, never on the ISO first. While
  on: the **Amount** slider (double-click: the suggestion); the first-run model card (bordered, name · size · licence,
  one line of explanation, one **Download · 117 MB** button that becomes a progress bar with Cancel); a row with
  **Preview at 100 %** (pressed state with the accent border while the loupe shows) and **Apply** at the right,
  labelled with the estimate ("Apply · ~14 s"); the job's progress row in place of Apply while a run is queued or
  running; one muted 11 px line ("Runs in the background when you move on to another photo; publishing waits for
  it." or "Denoised at full size in 13.8 s."); a red alert line for errors; then an **Advanced** disclosure whose
  summary carries the values ("Luminance 55 · Colour 80 · Sharpen 25 · NAFNet · Colour: filter") and opens to
  Luminance, Colour and Sharpen sliders, the *Colour from* Filter / Model segmented pair with its hint, the Model
  select ("NAFNet (default)": the default comes from Settings → Models) with its hint, and **Reset** (disabled when
  Advanced is on the mapping and the defaults).
- **Denoise loupe** (plan 28): a square window over the Develop picture, 512 device px (the crop at 100 %; smaller
  only when the picture area is), centred on its point and kept inside the area, with a 1 px white ring and a soft
  shadow, `cursor: grab`. Inside: the after crop, the before crop over it clipped at the split, a 1 px white split
  line with a 12 px wide invisible handle (`role="slider"`, arrow keys; kept between 2 % and 98 % so it can always be
  grabbed, and kept in place, transparent, while before shows whole), small "Before" / "After" tags at the top
  corners, a close cross at the top right, and a 16 px spinner at the bottom right while a crop renders (the previous
  crop stays visible). A muted line replaces the picture while checking, rendering the first crop, without the model,
  or on an error. Drag moves the window with the pointer and pins the point on release; a press held 200 ms without
  moving shows the before crop whole until release; Before / After (\) does too; Escape closes it. Clicking the picture elsewhere moves
  the loupe there (crosshair cursor while it is open).
- **Looks** (Oct 13, 2026, workflow plan 20): the first panel section, open by default, header "Looks" with a ⋯ menu
  button (Save current as look…, Import LUT…, Match camera JPEG…, a rule, Manage looks…) and Reset. A horizontally
  scrolling strip of 64 px square cells (`role="listbox"`, each an `option`), cover-fit 240 px thumbnails on the `line`
  grey while loading, the name in 10 px under each (truncated, muted; the chosen one in `fg`); the chosen cell has a
  2 px accent ring offset 1 px from the panel. None is first. Under the strip: plan 22's "Suggested: … (fitted)" row,
  the **Amount** slider (0–100 %, only while a look is applied; disabled with a muted one-line reason when the look is
  not on this Mac), then a small "LUT" disclosure (11 px, muted, the LUT name and strength or "LUT missing: name" in
  red while closed) that opens plan 18's picker. The old standalone Look section is gone from the panel. The
  filmstrip cell shows the look's name (else the LUT's) in a black 9 px tag across the top, only while hovered or
  focused. The batch bar's *Apply look…* opens a 24 rem dialog: a Look select (None first), Amount, "Apply to n photos".
- **Built-in looks** (Oct 13, 2026, workflow plan 21): twelve looks after None, before the user's, named by bird (Oriole,
  Heron, Starling, Kingfisher, Kestrel, Rook, Magpie, Dove, Sparrow, Robin, Owl, Egret); the cell's tooltip is "Name:
  description" (the description names the kind of look, "Warm negative. …"), never a film brand. A click applies the
  look at its own starting Amount (75–100 %); the user's looks start at 100 %. Manage looks lists them as "(built in)".
- **Fixture page, Looks tab** (plan 21, `/fixture`, a developer page): a tab pair *Renderer · Looks* beside the
  title (12 px, the chosen tab on the accent wash). The Looks tab has a toolbar row (three photo selects listing every
  hashed photo of the imported folders as `folder/path`, a *Before* checkbox, an Amount select "Each look's starting
  Amount" / "100%", and a "Scan n folders without an index" button when needed), then one block per photo: its path in
  11 px mono, and a wrapping grid of 288 px cells (3:2 box on a dark wash, the proxy render contained in it, "Rendering…"
  or the error in muted 11 px until it arrives) captioned with the look's name, its Amount, "· before" while Before is
  on, and the description on a second muted line.
- **Dialogs** share one shell (`DialogShell`): Sync, Save as preset, Save as look, Manage looks, Apply look, Export settings as XMP sidecar and Import Lightroom settings; while one is open it owns every key.
- **Keys**: D opens (filmstrip, selected slot, Review); Left and Right step; R crop; \ before / after; S proof; M masks; O overlay (crop guides or mask tint by context); `[` `]` brush size, with Shift the feather (while the brush is the tool; otherwise they step through the looks); Cmd+Shift+C / V copy and paste; Cmd+Shift+I import Lightroom settings; Cmd+Z undo; Escape ends the tool in use, then closes.

## Phone preview

Reference screens:

- [Polarsteps Travel Books](https://mobbin.com/screens/dacbba04-e74b-4b8e-9397-e439473dff48): book inside a phone, a "5-6/14" counter, prev / next.
- [Givingli card preview](https://mobbin.com/screens/4410f33e-72d0-403a-b9d9-9b6abfc320af): a single page centered on a dark textured background with a small pill "2 of 2" counter under it.
- [Fresha gallery](https://mobbin.com/screens/7a57d715-5406-4cdd-82f7-b0ac1fe69d36): "1/149" counter at the top of a full-bleed photo viewer.

Decisions:

- **Stage**: `#0d0d0d` background. iPhone frame 393 × 852 CSS px with a 47 px radius, 12 px black bezel, no notch drawn (keep it simple). A `Phone | Desktop` toggle at the top-left switches to a 1200 px wide container so the 900 px breakpoint is visible.
- **Reader**: horizontal scroll-snap track, one page per viewport, 250 ms ease. Arrow keys and trackpad swipe. Pages letterbox vertically centered on the page background color if the book ratio is shorter than the phone.
- **Counter**: pill at the bottom center, "12 / 48", tap opens a thumbnail grid overlay (3 columns, shared `<Page>` at small size), tap a thumbnail to jump and close.
- **Exit**: "Back to editor" top-right, Escape also exits. "Open in preview" from the page strip context menu lands on that page.

## Typography and fonts

Self-hosted WOFF2 in `packages/shared/fonts`: Inter (UI and body), Fraunces (titles), JetBrains Mono (date stamps), Instrument Serif (captions). UI chrome uses Inter at 13 px; section titles are sentence case, 12 px medium (plan 44, `section-title`), and only tags are uppercase (10 px mono, `tag`).
