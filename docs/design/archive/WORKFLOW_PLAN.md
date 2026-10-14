# Photobook Workflow Plan: Projects, Cull → Edit → Display, Looks, Denoise v2

Oct 12, 2026 · Ideation and implementation plan. No code was written for this document. It follows
[PRD.md](../PRD.md), [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) and [DEVELOP_PLAN.md](DEVELOP_PLAN.md) and assumes
the Develop module as it stands in the tree (every step D1.1 to D6.3 implemented, uncommitted).

Split into session-sized implementation plans in [plans/README.md](../plans/README.md) (Oct 12, 2026); part three of this
document supersedes sections 1.1, 2.1 and 2.2 and the plans follow it.

The questions this answers, in the order they were asked:

1. Turn the editor into a workflow, **Cull → Edit → Display**, where Display is a photobook, a social post, or
   something else. What else?
2. Replace "open a folder" with **Create a project → point it at a folder**, so two projects can share a folder. What
   happens to the edits then, and do we ever edit destructively?
3. **Copy and paste edits.**
4. **Film simulation presets** ("looks").
5. **AI denoise**: split luminance and colour noise, denoise each, merge back into one image. Which Hugging Face
   models?

Added later the same day (part two, sections 9 to 13):

6. Is there a denoise model **per camera sensor** (Fuji, Sony, Olympus)?
7. Improve the **denoise UI and UX**.
8. On the canvas, photo frames **cannot be dragged across the page**; add repositioning, guides and snapping.
9. An **AI captioning tool** with bring-your-own-key, per page or per book, a first-use interview, editorial tone,
   and a cost model for image input.

---

## 0. What already exists (so this plan extends rather than re-invents)

| Ask | Already in the tree | Where |
| --- | --- | --- |
| Cull | **Review** mode: one photo at a time, 1–5 stars, P pick, X reject, U unflag; filmstrip filters by flag and rating and can hide used photos. Ratings and flags live on `book.assets[id]` (schema v5). | `components/review/ReviewMode.tsx`, `store/book.ts` `reviewAssets`, `schema.ts` `AssetSchema.rating/flag` |
| Edit | **Develop**: non-destructive per-photo settings on `book.assets[id].develop`, renders keyed by develop hash, GPU with CPU fallback, RAW, masks, AI masks, denoise, XMP import. | `components/develop/*`, `crates/develop`, `commands/develop.rs` |
| Display | One kind: the **book**, published to R2, plus per-page 4:5 feed and 9:16 story PNGs the viewer offers as "Share". | `packages/publish/src/pages.ts` |
| Copy / paste | Header buttons **Copy** / **Paste** (Cmd+Shift+C / V), a **Sync…** dialog that copies chosen sections onto several photos, and presets (saved + built-in `bw`, `fade`). | `DevelopPanel.tsx`, `SyncDialog.tsx`, `lib/develop/{sync,presets}.ts`, `commands/presets.rs` |
| Film looks | Only the two built-in presets. No 3D LUT, grain, colour grading, vignette or halation in the engine. | `lib/develop/presets.ts`, `crates/develop/src/ops/` |
| Denoise | One model (NAFNet w32, SCUNet fallback), tiled at 512 px, result blended in **Oklab per channel**: `L = lerp(L_in, L_out, luminance)`, `ab = lerp(ab_in, ab_out, chroma)`, then an edge-masked luminance unsharp mask. One 16-bit PNG intermediate keyed by `(hash, model, params)` feeds the develop pipeline. | `crates/develop/src/ai/{denoise,tiling}.rs` |

So the honest framing: copy/paste and the "one denoised image from a luminance/chroma blend" already exist. The
work is a project model, a workflow shell, more display targets, a looks engine, and a better chroma path.

---

## 1. The workflow: Cull → Edit → Display

### 1.1 Three stages, one top bar

Today the editor opens on the book canvas and Review and Develop are modal overlays reached with keys. The proposal
makes the stages first-class and puts them in a persistent top bar, left to right in the order you work:

```
[ Project ▾ ]   Cull   Edit   Display ▾        [ Publish ]   [ Settings ]
```

| Stage | What the screen is | Carries forward |
| --- | --- | --- |
| **Cull** | A grid (the filmstrip grown to the full window, 3–8 columns, J/K zoom) plus the existing one-photo Review when you press Space or Enter. Rating, flag, compare (C: two up), survey (N: picks side by side), filters, sort. **Multi-select** (Shift / Cmd click, Cmd+A) is new and is what batch actions and paste act on. | The set of picks and ratings, shared by every project on the folder (section 2). |
| **Edit** | Develop as it is, but the bottom strip shows the Cull filter (default: picks and unflagged, rejects hidden). Batch actions on the selection: paste settings, apply a look, denoise queue, sync. | Per-photo develop settings, shared by every project on the folder, with per-project versions when wanted (section 2). |
| **Display** | A drop-down of output documents in this project: the book (as today), social posts, exports, and later print and slideshow. Each has its own canvas and its own Publish or Export button. | The display documents, which belong to the project. |

Review and Develop keep their keys (D, R, Esc) so nothing regresses; the tabs are the discoverable route.

### 1.2 Display targets: what "display" can be

| Target | What it produces | Renderer | Effort | Priority |
| --- | --- | --- | --- | --- |
| **Photobook** (exists) | Published web book on R2, viewer, likes, downloads | shared `<Page>` | 0 | — |
| **Social post** | A set of frames: Instagram feed carousel (4:5, up to 20 frames), Instagram / Facebook story (9:16), TikTok photo-mode slideshow (9:16, up to 35 images), Threads / Bluesky / X (4:5 or 1:1, 4 images), Pinterest (2:3). Output: numbered PNG/JPEG files in a folder, plus a caption `.txt`, ready for the phone or a scheduler. No API posting (every network's API needs a developer app and review; out of scope). | shared `<Page>` with a per-network template (safe areas drawn as guides) | S–M | 1 |
| **Export files** | Resized JPEG/HEIC/AVIF copies of the edited photos (long edge, quality, sRGB/P3, optional watermark and border, filename pattern, EXIF keep/strip). This is the "send the edited photos to someone" case, and the only place where edits leave the project as files. | `renderDeveloped` + `sharp` in a sidecar, or Rust `render` + encode | S | 1 |
| **Print PDF** | The book as a print-ready PDF: spreads, bleed and trim marks, 300 dpi, CMYK optional later. Same pages as the web book, so a zine print is one click. Uses the headless renderer the CLI already has (Playwright) with `page.pdf`. | shared `<Page>` at print size | M | 2 |
| **Slideshow video** | MP4 (H.264, 1080p/4K) of the pages or the picks with Ken Burns, cross-fades and optional audio; for TikTok/Reels/YouTube. Needs an `ffmpeg` sidecar (bundled, GPL — ship as a separate download, or use the LGPL build without x264 and encode with VideoToolbox on macOS). | frames rendered by the headless renderer, assembled by ffmpeg | M–L | 3 |
| **Web gallery** | A plain grid gallery (no pages) on the same viewer, for client delivery. Mostly a viewer mode of the book. | viewer | S | 3 |
| **Contact sheet / proof** | PDF grid with filenames and ratings, for clients to pick from. | shared renderer | S | 3 |
| **Wallpaper / lock screen** | Phone and desktop crops at device sizes. | crop + render | XS | 4 |
| **Collage / poster** | One large page with many photos, printed. Already possible as a custom page; only needs a print-size template. | shared `<Page>` | XS | 4 |

Recommendation: ship **Social post** and **Export files** first (both are small, both reuse the renderer and the
develop renders, and together they cover "I edited these, now put them on my phone"), then **Print PDF**. Video
is the only target that needs a new binary and is third.

### 1.3 How displays fit the schema

Keep the project file a `Book` (the CLI, viewer and worker all consume it), and add sibling documents:

```ts
// packages/shared/src/schema.ts, version 8
displays: z.array(DisplaySchema).default([]),

const DisplayBase = { id, name: z.string(), createdAt: z.number() };
DisplaySchema = z.discriminatedUnion('kind', [
  z.object({ ...DisplayBase, kind: z.literal('social'), network: SocialNetworkSchema, frames: z.array(PageSchema), caption: z.string() }),
  z.object({ ...DisplayBase, kind: z.literal('export'), ...ExportSettings, assets: z.array(id) }),
  z.object({ ...DisplayBase, kind: z.literal('print'), ...PrintSettings }),           // later
  z.object({ ...DisplayBase, kind: z.literal('slideshow'), ...SlideshowSettings }),   // later
]);
```

The book's `pages` stay at the top level, so migration 7 → 8 only adds `displays: []`. A social post's `frames` are
`Page`s (same elements, same renderer, same inspector), with `template` fixed by the network. "Send this page to a
post" is a copy of the page into a social display. Every display references `book.assets` ids, so the dangling-id
refinement extends to displays.

---

## 2. Projects, folders and where edits live

### 2.1 Projects

Today a project *is* a folder: `<folder>/book.photobook.json`, one per folder, `recent.json` remembers the last one.
Proposal:

- **Project registry** in app data, `<appdata>/projects.json`: `[{ id, name, folder, file, createdAt, openedAt }]`.
  Home becomes a project list (name, folder, thumbnail, last opened) with **New project…** (name, folder, template)
  and **Open folder…** (which creates a project named after the folder, as today).
- The **project file stays in the folder** as `<folder>/<slug>.photobook.json` (`book.photobook.json` is read as
  the legacy name and becomes a project called after the folder on first launch). Several project files in one folder
  are fine. Keeping the file in the folder preserves what the README promises ("opens any photo folder in place"),
  keeps a folder portable (copy it to another Mac with its projects), and keeps `ensure_source_root` unchanged.
- The `recent.json` command pair becomes `list_projects` / `upsert_project` / `remove_project`;
  `read_book` / `write_book` take the file name (validated: `*.photobook.json`, no path separators).

### 2.2 Where do edits live when two projects share a folder?

This is the real decision. Three options:

| | A. Per project (status quo) | **B. Per folder: a library** | C. XMP sidecar per photo |
| --- | --- | --- | --- |
| Where | `book.assets[id].develop/rating/flag` | `<folder>/.photobook/library.json`, keyed by content hash | `<photo>.xmp` next to each file |
| Two projects, one folder | Two independent edits and two cull passes | One edit and one cull pass, seen by both; per-project **versions** when a project wants a different edit | One edit; Lightroom can read the tone part |
| Masks, AI masks, denoise | Fine | Fine | Our own packet only (Lightroom ignores it); AI masks need the raster cache anyway |
| Writes into the user's folder | One file | One hidden folder (already exists: `.photobook-cache`) | Hundreds of sidecar files next to the photos |
| Relink after a move | by size + hash (exists) | by hash: the library key *is* the hash | by filename |
| Caches | keyed `(hash, developHash)`: already shared | same, unchanged | same |

**Recommendation: B**, a per-folder library, with C available as an *export* ("Write Lightroom sidecars", which
the XMP module can already produce). Shape:

```ts
// packages/shared/src/library.ts
LibrarySchema = z.object({
  version: 1,
  photos: z.record(hash, z.object({
    rating, flag,                       // cull state, shared
    develop: DevelopSchema.optional(),  // the "master" edit
    versions: z.record(versionId, z.object({ name, develop: DevelopSchema })).default({}),  // virtual copies
  })),
});
```

and on the project side `book.assets[id]` gains `version?: string` (which virtual copy this project uses; absent
means the master). Rules:

- The library is the source of truth for rating, flag and develop. The book's `rating`, `flag` and `develop` fields
  become legacy: still parsed (v8 keeps them optional), lifted into the library on open when the library has no entry
  for that hash, then dropped from the book on the next save. This lift needs the folder, so it happens in
  `loadFromFolder`, not in the pure `migrate.ts`.
- Project asset ids stay ULIDs (likes and the download log key on them). The library never sees ids; it sees hashes.
  Duplicated files (same hash, two paths) share one library entry, which is right.
- Writes go through the same temp-file-and-rename as `write_book`, with a `.bak`. One app instance at a time; if a
  second instance is a real case later, an mtime check before write and a reload on mismatch.
- "Make a version" in Edit creates a virtual copy for *this project*; other projects keep the master. The filmstrip
  shows a small "v2" badge. Publishing renders whichever the project points to; render names already include the
  develop hash, so versions never collide in `.photobook-cache`.
- Publish fingerprints keep working: they hash the resolved develop settings, not where they were read from.

### 2.3 Destructive edits: no

Keep every edit non-destructive. The arguments are technical, not only taste:

- The whole relink, cache and render system keys on the **content hash of the source**. Overwriting a source changes
  its hash: every project that references it would see a missing asset, every cached render and AI mask would be
  orphaned, and likes keyed on the asset id would survive only through relink.
- RAW cannot be written back; JPEG and HEIC re-encode with loss each time.
- The user ask ("two projects on one folder") is exactly the case where a destructive edit in one project would
  silently change the other.

What people actually want from "destructive" is files they can hand over: that is the **Export files** display
(section 1.2), which writes *new* files to a chosen folder and never touches the source. If "replace originals" is
ever requested, it should be a separate, confirmed, backed-up action, not an editor mode.

---

## 3. Copy and paste edits

Exists: Copy / Paste of the whole settings (Cmd+Shift+C / V) inside Develop, and Sync… for many targets. Gaps and
the plan:

| Feature | Today | Plan |
| --- | --- | --- |
| Choose what to copy | Whole settings | **Copy Settings dialog** (Shift+Cmd+C opens it; Cmd+Shift+C copies with the last choice): the same section checklist as Sync, plus Crop, Transform and Masks off by default, and "Denoise" as its own box. |
| Paste onto many | Paste only onto the open photo; Sync… picks targets by hand | Paste acts on the **selection**: in Edit the bottom strip's selection, in Cull the grid selection. Sync… stays for "from this photo to these". |
| Paste without opening Develop | No | Cull grid: select, Cmd+Shift+V. Also **Apply look…** and **Reset edits** on the selection. |
| Paste previous | No | **Paste from previous** (Cmd+Alt+V): copy from the photo before this one in the strip, Lightroom's habit for burst editing. |
| Across projects / sessions | In-memory only | The clipboard holds JSON on the system clipboard as `application/x-photobook-develop` plus a text fallback; works across projects and after a restart. With the library (section 2) a paste in one project shows in the other anyway. |
| Masks when pasting | Copied at the same position | Unchanged, with a warning line as Sync has. AI masks re-run on the target (their cache is keyed by component hash and source hash). |
| Undo | One step | Batch paste is one undo step across all targets (`reviewAssets` already batches ratings this way). |

Implementation is small: `lib/develop/sync.ts` already has the section maths; the dialog is `SyncDialog` with the
target list removed; multi-select in the filmstrip is the only new UI state (`ui.filmstrip.selection: string[]`).

---

## 4. Film simulation presets ("Looks")

### 4.1 What the engine is missing

A convincing film look is not reachable with the current sliders alone. The engine needs:

| Op | Why | Where in the pipeline | Maths |
| --- | --- | --- | --- |
| **3D LUT** | The portable form of a look; also lets users bring `.cube` files | After the tone curve and colour mix, in sRGB-encoded (display-referred) space, before the output transform | `.cube` 3D (17³/33³/65³) and HALD CLUT parsed to a texture; **tetrahedral** interpolation (CPU and WGSL); strength = lerp with input |
| **Colour grading** | Shadows / midtones / highlights hue-saturation wheels, blending and balance; the "split tone" of every film look | After the LUT | Oklab: add a chroma vector per luminance band with smooth band weights |
| **Grain** | Film texture; without it every look reads as "a filter" | Last, before output encode | Per-pixel hash noise shaped by a blue-ish spectrum (two octaves), scaled by luminance (more in midtones), size in reference pixels so it is resolution-independent and matches between proxy and full render |
| **Vignette** | Post-crop, soft | Before grain | Radial falloff on L, midpoint/feather/roundness |
| **Halation / bloom** (optional) | The red glow of highlights on film | Before grain | Thresholded highlights, blurred, added with a warm tint; expensive on CPU (use the existing blur pre-pass at reduced size) |
| **Calibration** (optional) | Primary hue/saturation shifts, the Lightroom "Calibration" panel many film presets rely on | Before the tone curve | 3×3 matrix tweak per primary |

All of these are new ops in `crates/develop/src/ops/`, mirrored in the GPU path and covered by the CPU–GPU parity
tests, with `ENGINE_VERSION` and `DEVELOP_ENGINE_VERSION` bumped to `develop-engine/3` and the fixtures regenerated.
Schema: a new `effects` section on `DevelopSchema` (`grading`, `grain`, `vignette`, `halation`) and a `look`
section (`lut: { id, strength } | null`), with `prefault` defaults so every existing project parses unchanged and
`develop_hash` of an untouched photo stays the same (the canonicaliser skips default sections).

### 4.2 Looks as a kind of preset

A look is a preset flagged `look: true` whose sections include `effects` and `look`. UI: a **Looks** section at the
top of the Develop panel with a strip of thumbnails rendered on the photo's proxy (cheap: the proxy is 1600 px, one
GPU pass per look, cached by `(hash, presetId)`), an **Amount** slider, and a "Save current as look". Amount scales a
parametric look linearly from the defaults (`value = default + amount × (preset − default)`), and is the LUT strength
for a LUT look. Lightroom's "Amount" works the same way.

User LUTs: **Import .cube** copies the file to `<appdata>/luts/<sha256>.cube`; the preset references it by hash.
Because renders happen on the user's machine, publishing needs nothing extra. Sharing a project that uses a LUT with
another machine would need the file: the project file records the LUT's hash and name so the editor can say what is
missing. Looks with a LUT in a `.photobook-cache` render are keyed by the LUT hash through the develop hash.

### 4.3 Where the looks come from (licensing)

Two web checks on Oct 12, 2026 found no clearly permissive (MIT / Apache / CC0) set of Kodak or Fuji emulation
`.cube` files: free packs state "free to use" without a licence, and the film names are trademarks
([darktable LUT generator](https://pypi.org/project/darktable-lut-generator/),
[PictureFX](https://picturefx.itch.io/picturefx-tactical-visor),
[Fujifilm profiles thread](https://discuss.pixls.us/t/fujifilm-film-simulation-profiles-for-adobe-and-other-raw-processors/38197),
[spectral simulation thread](https://discuss.pixls.us/t/spectral-film-simulations-from-scratch/48209?page=31),
[film sims from scratch](https://kevinmartinjose.com/2021/04/27/film-simulations-from-scratch-using-python/)).
The rule from DEVELOP_PLAN (permissive licences only, pinned) applies to LUT data too. So:

1. **Ship parametric looks we author ourselves** (curve + colour mix + grading + grain), named descriptively, never
   by brand: *Warm negative*, *Cool negative*, *Chrome*, *Slide*, *Cine print*, *Pushed black and white*, *Bleach
   bypass*, *Faded*, *Portrait soft*. Ten to twelve, tuned on the lisbon fixtures and a portrait set.
2. **Let users import their own LUTs** (`.cube`, HALD) and **fit LUTs from their own camera**: a camera that shoots a
   film simulation JPEG next to the RAW (Fuji, and the picture-profile JPEGs of other brands) gives paired images from
   which a 3D LUT can be estimated by least squares, which is what darktable-lut-generator does. A "Match camera
   JPEG" tool is honest, licence-free and genuinely useful for Fuji owners. Candidate for phase W5c.
3. For RAF files, read the in-camera film simulation tag and *suggest* the matching user-fitted look.

---

## 5. AI denoise v2: luminance and chroma

### 5.1 What exists, and what the "split" idea means

The current pipeline already produces **one** denoised image from one model run, blended per channel in Oklab:
luminance from a lerp on L, colour from a lerp on a and b, then one 16-bit intermediate that the develop pipeline
decodes instead of the source. So "AI denoising will create one image" is how it works today, and the Luminance and
Colour sliders are the two blend weights.

What the split idea improves is the *source* of each half. Luminance noise is fine-grained and detail-sensitive; a
real-noise network (NAFNet trained on SIDD) is the right tool. Chroma noise is low-frequency blotching with almost no
image detail in it, which classical filters remove well and cheaply, and which SIDD models tend to over-smooth into
desaturated patches on JPEGs and web images. Options:

| Option | How | Verdict |
| --- | --- | --- |
| 1. **NN for L, classical for ab** | Run the model once (as now) for L. For a and b, run a guided/bilateral filter at quarter resolution (chroma noise survives downscaling; the filter is a few ms on the GPU) guided by the denoised L so edges hold; the Colour slider blends classical-ab in, with the NN-ab result available as "Model" mode. | **Do this.** No new model, no new download, works on JPEG and RAW, fixes over-smoothing, and makes the mask-level `noise` slider (currently disabled) implementable from the classical path at preview speed. |
| 2. Two networks, one per channel | A luminance-specialised and a chroma-specialised model | No permissive public pair exists; would need training. Not worth it while option 1 is untested. |
| 3. A model with a strength input | DRUNet / FFDNet take a noise-level map, so the sliders could steer the model instead of blending | Gaussian-trained; real noise is not Gaussian after the ISP. Keep as an experiment for RAW, where noise is closer to Poisson-Gaussian before demosaic. |
| 4. Frequency-aware merge | Wavelet-split L: take the NN's low and mid bands, keep the input's finest band scaled by the Luminance slider | Cheap refinement of the blend; better grain retention than a flat lerp. Second step after option 1. |

Merging stays as it is: one Oklab image, one intermediate PNG, keyed by `(hash, model, model version, luminance,
chroma, chromaMode, sharpen)`. The cache key gains the new fields, so old intermediates are simply not reused.

### 5.2 Model candidates to evaluate (Hugging Face and elsewhere)

Checked Oct 12, 2026 ([Heliosoph/scunet-onnx](https://huggingface.co/Heliosoph/scunet-onnx),
[huggingworld/onnx-image-models](https://huggingface.co/huggingworld/onnx-image-models),
[notaneimu/onnx-image-models](https://huggingface.co/notaneimu/onnx-image-models),
[pmndrs/denoiser](https://github.com/pmndrs/denoiser),
[NTIRE 2026 denoising report](https://arxiv.org/pdf/2606.16031),
[Simple Baselines for Image Restoration](https://www.ecva.net/papers/eccv_2022/papers_ECCV/papers/136670017.pdf)).
The Hub's ONNX "collections" mix licences per file (one lists CC BY-NC-SA next to MIT files), so every file must be
checked on its own card, as `models.toml` already requires.

| Candidate | Licence | Status | Why evaluate |
| --- | --- | --- | --- |
| NAFNet-SIDD-width32 (have) | MIT | Pinned, working, 14 s / 24 MP | Baseline |
| NAFNet-SIDD-width64 | MIT | Qualcomm AI Hub export, fixed 256²; or our own export script | +0.3 dB; the "High quality" option the schema already names (`nafnet-w64`) but the manifest lacks |
| SCUNet color_real_psnr (have) | Apache-2.0 | Pinned, CPU-only, 12 min | Only as a JPEG fallback until it compiles for Core ML; re-export with static shapes and no `Einsum` might fix the 141 partitions |
| Restormer (real denoising) | MIT | No ONNX; export needed | Quality reference; 4× NAFNet's MACs, so a "slow, best" tier at most |
| DRUNet / FFDNet | MIT | Export needed | Noise-level map = a real strength input (option 3) |
| KBNet_s, Uformer-B | MIT | Weights availability unclear | Only if a clean checkpoint appears |
| PMRID, ELD, LED (raw domain) | Apache / MIT | Export needed; need our demosaic to run after them | The right place to denoise RAW; depends on D6.1 owning demosaic |
| Intel OIDN port (pmndrs/denoiser) | Apache-2.0 | ONNX exists | Trained on path-tracing noise, probably wrong for photos; cheap to test and rule out |
| NTIRE 2026 entries | Per entry | Read the report; most are research code | Source of newer permissive real-noise models, if any release weights under MIT/Apache |

The evaluation itself is a fixture job: a RAW + JPEG set at ISO 1600–12800, PSNR against a long-exposure frame
where one exists, and a side-by-side export for eyes. The plan's open gate "at least as clean as Lightroom's Detail
panel" is still unmet and should be settled here.

### 5.3 Workflow integration

- **Denoise queue**: in Cull or Edit, select photos, *Denoise selected* with the current defaults; a job list in the
  status bar with progress and cancel (the `develop:progress` event and `cancel_develop` exist). The intermediates
  are produced ahead of time so Edit is instant and Publish does not stall on them.
- **Auto-suggest**: an ISO threshold (from EXIF, default 3200) marks photos "would benefit from denoise" in Cull.

---

## 6. Phases and steps

Each step is individually shippable; a step is done when its check passes. Sizing is in developer-days for one
person with the agents used so far (Opus for Rust and maths, Sonnet for UI, Haiku for verification).

### Phase W1: Projects and the library (foundation) — about 8 days

| Step | Work | Check |
| --- | --- | --- |
| W1.1 Schema | `LibrarySchema` in `packages/shared/src/library.ts`; book v8 (`displays: []`, `assets[].version?`, legacy `rating/flag/develop` kept optional); `migrate.ts` case 7 → 8; `develop_hash` unchanged for untouched photos. | Vitest: v7 fixtures migrate; parity fixtures unchanged. |
| W1.2 Library commands | `read_library` / `write_library` (`<folder>/.photobook/library.json`, temp + rename, `.bak`), scoped by `ensure_source_root`. | Rust tests; corrupt file falls back to `.bak`. |
| W1.3 Store | `store/library.ts` slice; `reviewAssets`, `setAssetDevelop` and friends write through the library keyed by the asset's hash; lift legacy fields on open; `versions` actions (`createVersion`, `useVersion`). Resolver and publish read the resolved develop. | Editor Vitest; dev-log smoke test: edit in project A, open project B on the same folder, see the edit. |
| W1.4 Project registry | `projects.json` commands; Home becomes the project list with New project… and Open folder…; `recent.json` migrated; project file name `<slug>.photobook.json`, legacy `book.photobook.json` adopted. | Two projects on one folder open and save independently; CLI `--dry-run` on each. |
| W1.5 Docs | README, `docs/DEVELOP.md` ("Per photo" paragraph), PUBLISHING (file name), CLAUDE.md caches list. | Reviewed. |

### Phase W2: The workflow shell — about 7 days

| Step | Work | Check |
| --- | --- | --- |
| W2.1 Top bar and routes | `/project/$id/cull`, `/edit`, `/display/$displayId`; the book canvas becomes the first display. Review and Develop keys still work. | Routes render; shortcuts test. |
| W2.2 Cull grid | Filmstrip as a full-window grid with zoom, multi-select, batch rating/flag, compare (C) and survey (N) views built from `ReviewMode`. | Component tests; keyboard parity with Review. |
| W2.3 Edit strip | Develop's bottom strip follows the Cull filter and selection; batch actions bar (Paste, Apply look, Denoise, Sync, Reset). | Component tests. |
| W2.4 Job queue | `store/jobs.ts` for long work (denoise, full renders, exports) with progress, cancel and a status-bar list; the existing `develop:progress` events feed it. | Cancel mid-job leaves no partial cache file. |

### Phase W3: Copy and paste — about 2 days

| Step | Work | Check |
| --- | --- | --- |
| W3.1 Copy Settings dialog | Section checklist (reuse `SyncDialog`), remembered choice, Cmd+Shift+C / Shift+Cmd+C. | Component test. |
| W3.2 Paste to selection | Paste in Edit and Cull onto the selection as one undo step; Paste from previous (Cmd+Alt+V); system clipboard JSON. | Vitest on the store; clipboard round-trip. |

### Phase W4: Display targets — about 9 days (social + export), print later

| Step | Work | Check |
| --- | --- | --- |
| W4.1 Display documents | `displays` UI: list, create, rename, delete; the Display drop-down. | Store tests. |
| W4.2 Social post | Network templates (sizes, frame counts, safe-area guides), frames as `Page`s on the existing canvas and inspector, "Send page to post", caption field. Export: headless render (the CLI's Playwright path, run from the editor like `developPublish`) to PNG/JPEG + caption `.txt` in a chosen folder, revealed in Finder. | A 10-frame carousel exports at 1080×1350 with the developed renders. |
| W4.3 Export files | Settings (long edge, format, quality, profile, watermark, filename pattern, EXIF) and the job; Rust `render` + encode for JPEG/HEIC/AVIF (the crate already encodes JPEG; AVIF via `ravif`, HEIC via ImageIO). | Exported files match the publish renders pixel-for-pixel at the same size. |
| W4.4 Print PDF (later) | Spreads, bleed, marks, `page.pdf` at 300 dpi. | PDF opens in Preview at the trim size. |
| W4.5 Slideshow (later) | ffmpeg sidecar decision, frame rendering, transitions, audio. | 1080p MP4 plays on an iPhone. |

### Phase W5: Looks — about 10 days

| Step | Work | Check |
| --- | --- | --- |
| W5.1 Effects ops (CPU) | `ops/{grading,grain,vignette,halation}.rs`, `effects` schema section, canonicaliser, engine `develop-engine/3`, fixtures regenerated. | Parity fixtures; grain identical between proxy and full render at the same reference size. |
| W5.2 LUT op | `.cube` and HALD parser, tetrahedral interpolation CPU + WGSL, `look.lut` section, `<appdata>/luts/`, import command. | A 33³ identity LUT is a no-op within 1/4096; CPU = GPU. |
| W5.3 GPU port | WGSL for every W5.1 op. | `tests/gpu.rs` parity. |
| W5.4 Looks UI | Looks section with thumbnails (cached per `(hash, presetId)`), Amount, Save as look, Import LUT; `amount` scaling in `lib/develop/presets.ts`. | Component tests; thumbnail strip renders in under 300 ms for 12 looks on the proxy. |
| W5.5 Built-in looks | Author 10–12 parametric looks; a fixture gallery page in `/fixture`. | Visual review (needs the window). |
| W5.6 Match camera JPEG (optional) | Fit a LUT from RAW + camera JPEG pairs (least squares on a 33³ grid with smoothness), RAF film-sim tag suggestion. | Fitted LUT applied to the RAW is within ΔE 2 of the camera JPEG on the pair. |

### Phase W6: Denoise v2 — about 6 days plus evaluation

| Step | Work | Check |
| --- | --- | --- |
| W6.1 Classical chroma path | Quarter-res guided filter on Oklab a/b guided by denoised L; `chromaMode: 'model' | 'filter'`; cache key extended; mask-level `noise` slider enabled using the filter path on the preview. | PSNR on the synthetic fixture not worse than today; visual check on ISO 12800 JPEG shows no desaturated patches. |
| W6.2 Frequency-aware L merge | Wavelet (à trous, 3 levels) blend of input vs model L. | Parity CPU/GPU; grain retention visible at Luminance 50. |
| W6.3 Model evaluation | Export NAFNet w64 (own script, fp16, static 512) and pin it; test SCUNet static re-export for Core ML; DRUNet σ-map experiment; raw-domain models noted for after demosaic ownership. | `models.toml` gains w64 verified; a written comparison against Lightroom Denoise on 5 photos. |
| W6.4 Queue and suggestions | Denoise selected (W2.4 queue); ISO badge in Cull. | Smoke test in the app. |

Rough total: about 42 developer-days for W1–W4.3, W5 and W6; print and slideshow are extra.

---

## 7. Decisions to lock before W1.1

| Decision | Recommendation | Why |
| --- | --- | --- |
| Where the project file lives | In the folder, `<slug>.photobook.json` | Portable folder, unchanged scope rules, several projects per folder |
| Where edits live | Per-folder library keyed by content hash, with per-project versions | One edit for every project on the folder; hash keys already drive relink and caches |
| Destructive edits | Never; Export files writes copies | Hash-keyed caches, ids and relink would break; RAW cannot be written back |
| Display documents | Sibling `displays` array in the `Book`; book pages stay top-level | Migration is one field; CLI, viewer and worker untouched |
| Social posting | Files + caption, no network APIs | Every API needs an app review; files work with every scheduler |
| Look data | Author our own parametric looks; users import LUTs; fit LUTs from their camera | No permissive film LUTs found; film names are trademarks |
| Chroma denoise | Classical guided filter on a/b first, models stay for L | No permissive chroma model exists; the filter is fast and works on JPEG |
| Engine version | One bump to `develop-engine/3` at the end of W5.3, not per op | Each bump invalidates every cached render |

## 8. Open questions

- Multi-window or two app instances on one library: ignored for now (one instance). Revisit if the registry makes
  people open two projects at once.
- Should ratings be per project after all (a cull for the zine is not the cull for the client)? The library holds the
  master; a per-project "selection" (which assets are in `book.assets`) already differs per project. If a second cull
  is needed, a project-level flag override is a small addition later.
- Social templates change (frame counts, safe areas); keep them in `packages/shared` as data with a date, not in code.
- ffmpeg licensing and bundle size for slideshows (GPL x264 vs VideoToolbox through an LGPL build).
- Whether WKWebView can render the social frames fast enough in-app for a live preview, or whether the headless CLI
  path is needed for every export (likely fine in-app: the shared `<Page>` already renders the canvas).
- Halation on the CPU path may be too slow for 24 MP full renders without the GPU; measure in W5.1 and consider
  reduced-size blur as in `local/prepass.rs`.

---

# Part two (Oct 12, 2026, later)

## 9. Denoise per camera sensor

**Short answer: no public model is trained per brand, and none should be.** What the commercial tools and the open
projects do differently per camera is not the network; it is the **noise profile** that feeds it. Checked Oct 12, 2026:

| Project | What is camera-specific | Licence | Source |
| --- | --- | --- | --- |
| darktable *denoise (profiled)* | A database of measured noise curves per camera model and ISO (Poisson-Gaussian `a`, `b` per channel); the filter is classical (wavelets / NLM) | GPL-3 (the JSON data too) | [manual](https://github.com/darktable-org/dtdocs/blob/master/content/module-reference/processing-modules/denoise-profiled.md), [calibration data](https://deepwiki.com/darktable-org/darktable/3.3-camera-profiles-and-calibration-data) |
| darktable *neural restore* | One network; Bayer sensors are denoised on the mosaic with demosaic folded in, X-Trans is demosaiced first and denoised in linear Rec.2020 | GPL-3 | [manual](https://docs.darktable.org/usermanual/development/en/module-reference/utility-modules/shared/neural-restore/) |
| Ansel *AI raw denoise* | One set of weights for every profiled camera, Bayer and X-Trans; trained on synthetic Poisson-Gaussian noise drawn from the per-camera profiles, so a newly profiled camera works without retraining. Still collecting training RAWs (July 2026) | GPL-3, data not yet public | [docs](https://ansel.photos/en/doc/views/darkroom/modules/ai-raw-denoise/), [call for RAWs](https://github.com/aurelienpierreeng/ansel/discussions/1023) |
| ELD (CVPR 2020) | A physics-based noise model calibrated per camera (shot, read, row, quantisation noise), then one network trained on synthesised noise | MIT code | [paper](https://openaccess.thecvf.com/content_CVPR_2020/papers/Wei_A_Physics-Based_Noise_Formation_Model_for_Extreme_Low-light_Raw_Denoising_CVPR_2020_paper.pdf) |
| PMRID (ECCV 2020) | A small network trained on synthetic noise for one measured sensor; outperforms big generic models on that sensor | Apache-2.0 code | [paper](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123510001.pdf) |
| ICCV 2021 / 2023 noise synthesis | Show that careful per-camera calibration matters more than the network, and propose general low-light noise models that imitate different sensors | Research | [2021](https://openaccess.thecvf.com/content/ICCV2021/papers/Zhang_Rethinking_Noise_Synthesis_and_Modeling_in_Raw_Denoising_ICCV_2021_paper.pdf), [2023](https://openaccess.thecvf.com/content/ICCV2023/papers/Zhang_Towards_General_Low-Light_Raw_Noise_Synthesis_and_Modeling_ICCV_2023_paper.pdf) |
| DxO DeepPRIME, Lightroom Denoise | Per-camera calibration inside a closed raw-domain model | Proprietary | — |

So "a Fuji denoiser" means: a raw-domain model that knows the **gain-dependent noise level** of the sensor at the
ISO the photo was shot at, and for Fuji specifically a pipeline that handles **X-Trans** (demosaic first, as darktable
does). The plan, in order of payoff:

1. **Self-profiling from the photo** (no database, works for every camera, JPEG included). Fit `variance = a·mean + b`
   on flat patches of the decoded image per channel, giving a noise level map. Feed it to the classical chroma
   path (W6.1) and, when a σ-map model (DRUNet / FFDNet) is pinned, to the model. This is one Rust module,
   `ai/noise_profile.rs`, and the measurement is cached per `(hash)`.
2. **Learned profiles per camera + ISO**, built from the user's own photos: every self-profile is also written to
   `<appdata>/noise-profiles/<make>-<model>.json` by ISO, averaged over time. A new photo from a known camera
   starts from the stored curve, which is more robust than a single frame's fit on a busy image. No bundled
   GPL data, no trademark problem, and a Fuji owner ends up with a Fuji profile.
3. **Raw-domain model conditioned on the profile** (after D6.1 owns demosaic). Bayer: denoise on the mosaic
   (PMRID / ELD style, synthesised training noise from the profile); X-Trans: demosaic, then denoise in linear
   RGB (darktable's route). This is a training project (weeks, needs a RAW corpus), so it is last and optional;
   Ansel's public dataset, if it lands, is the natural training set to watch.

What this means for the UI: a camera badge in the Denoise group ("Fujifilm X-T5, ISO 6400, profile: learned from
12 photos") and an Amount default that comes from the profile rather than from a fixed ISO table.

## 10. Denoise UI and UX

### 10.1 What is there now, and what is wrong with it

`DenoiseGroup` (Detail section): an on/off switch, a model picker, Luminance / Chroma / Sharpen sliders, a download
card, **Apply** with tile progress and Cancel, a 512 px crop preview that must be opened by hand, a before/after
toggle inside it, and a "stale" status whenever the sliders change after a run. Everything is correct and nothing
is pleasant:

- Five controls and a model choice are in the main path; the common case is "make the noise go away".
- The preview is hidden by default, so sliders are tuned blind; the stale state is a sentence of text.
- Apply is a separate step that is easy to forget; nothing says what will happen at publish time.
- There is no sense of how long it will take, or whether this photo needs it at all.

### 10.2 References

Looked at on Mobbin: [Adobe Edits' Reduce noise](https://mobbin.com/screens/a1498532-513f-4f4e-9bf6-2efb1308678d)
(one slider, full-screen preview, confirm or cancel), [Magnific's Enhance panel](https://mobbin.com/screens/7e4ff51f-2eee-4468-8962-1072825d901e)
(a version picker, two sliders, one primary button, a version strip on the right), [(Not Boring) Camera's style
intensity](https://mobbin.com/screens/0bb588a4-81d9-4b2d-9f3c-8040828463de) (one Intensity slider with a sentence
explaining it), [Higgsfield's Upscale](https://mobbin.com/screens/e856550c-454e-47d3-9d4e-730d071fbb3d) (split
before/after on the image, advanced settings folded away), and [Telegram's editor](https://mobbin.com/screens/d21a9252-e0f8-439c-a8df-dcd5a6abb83f)
(plain slider list). The pattern that repeats: **one slider in front, a live before/after on the picture, advanced
controls behind a disclosure, one primary action**.

### 10.3 Proposal

```
Denoise                                   [●] on     Applied ✓
Fujifilm X-T5 · ISO 6400 · suggests 55
Amount        ───────●────────  55
▸ Advanced    Luminance 55 · Colour 80 · Sharpen 25 · NAFNet · Colour: filter
[ Preview at 100 % ]                 [ Apply · ~14 s ]
```

- **Amount** is the one slider. It sets Luminance; Colour follows (`min(100, amount + 25)`) until Advanced changes
  it; Sharpen stays at its default. The schema is unchanged: Amount is a UI mapping.
- **Suggested amount** comes from the noise profile (section 9) or, before that exists, from the ISO; the row
  under the title says why. Photos below the threshold show the group collapsed with "Not needed at ISO 200".
- **Live loupe instead of a hidden preview.** Turning the switch on opens a loupe: a 100 % window pinned to a
  point you drag on the photo (the `center` state exists), with a split handle (`SplitHandles` exists) and
  press-and-hold for before. The 512 px crop preview re-runs itself when the sliders settle (debounced about
  600 ms); with the chroma filter path (W6.1) the colour half updates instantly, only the luminance half waits
  for the model.
- **Apply becomes a state, not a chore.** The pill on the row reads *Applied*, *Needs apply* or *Running 37 %*;
  the Apply button shows the estimate from the last run's per-tile timing. Leaving the photo with *Needs apply*
  queues the full run in the job queue (W2.4) so it is done by the time you publish, with a note in the publish
  dialog ("3 photos still denoising"). The current "publish renders denoise first" behaviour stays as the backstop.
- **Model choice moves to Settings → Models** as a default, with a per-photo override under Advanced. The
  first-run download card stays, with the size and one button.
- **Batch**: *Denoise selected* in Cull and Edit (section 5.3).

Check: a new user at ISO 6400 gets a clean preview within 2 s of turning the switch on without touching anything
else, and publishes without ever pressing Apply.

## 11. Canvas: moving frames, guides and snapping

### 11.1 Why dragging a photo does not move it

It is a design choice, not a missing feature, and the choice is wrong for most people. In `Canvas.tsx` a drag
inside a filled photo slot **pans the photo within its frame**; the frame itself moves only when you drag the 8 px
**band along the selection outline** (`MoveBand` in `SelectionOverlay.tsx`), and Alt+drag hands the photo to
another slot. Text boxes move on a plain drag. So moving a frame works, but only from a thin invisible handle. The
snapping engine underneath (`packages/shared/src/layouts/snap.ts`) is already good: page edges, centre, margins,
other frames' edges and centres, equal gaps with a distance badge, and the grid, with a 6 px threshold and Cmd to
bypass.

### 11.2 Proposal

**Invert the gesture**, the way Canva, Keynote and Figma do it: a drag on any frame moves the frame; panning the
picture inside is a mode.

| Gesture | Now | Proposed |
| --- | --- | --- |
| Drag a photo frame | Pans the photo | **Moves the frame** (snapped, guides shown) |
| Pan the photo inside | Drag | **Double-click** enters *Adjust photo* (the crop/pan mode: drag pans, wheel zooms, Esc or click outside leaves); also a toolbar button and Space+drag while selected |
| Move the photo to another slot | Alt+drag | Alt+drag (unchanged), plus drag onto a page in the page strip to move it there |
| Resize | Eight handles (exists) | Unchanged; Shift keeps the ratio from a corner, Alt resizes from the centre |
| Nudge | — | Arrow keys one grid step, Shift+arrows ten; the guides flash on the step that snaps |
| Layout page | First move makes the page custom (exists) | Unchanged, with a one-time toast "This page is now custom" and Undo |

**Guides and snapping** build on the engine rather than replace it:

- **Equal spacing** across three or more frames (Figma's pink distribution guides): snap when the gap being made
  equals the gap between the neighbours, label "equal".
- **Size match**: snap a resize to the width or height of a neighbouring frame, label "same width".
- **Alignment toolbar** for a multi-selection: align left / centre / right / top / middle / bottom, distribute
  horizontally / vertically, match width / height, and **Tidy** (equal gaps on the current rows). One undo step.
- **Rulers and a drag-out guide**: rulers along the canvas edges in inches / mm (the template unit), a drag from a
  ruler drops a persistent guide stored on the page (`page.guides`, schema v8), which the engine then snaps to.
- **Snap toggle** in the view menu (the `bypass` flag exists) and a persistent "Show guides while dragging" pref.
- **Smart layout hints**: when a frame is dropped so that it breaks the page's gutter rhythm, a subtle "Fix
  spacing" button in the floating toolbar runs Tidy on that row.

Schema: `PageSchema.guides: z.array(z.object({ axis: z.enum(['x','y']), value: z.number() })).default([])`.
Everything else is editor state. Sizing: about 5 days; most of it is the gesture inversion and the alignment
toolbar, the engine additions are a day.

Check: a new user moves a photo frame on first try without being told how; Tidy on a three-up row yields gaps
within 1/1000 of each other; the renderer output is byte-identical for pages that were not touched.

## 12. AI captions (bring your own key)

### 12.1 What it does

A **Write with AI** action that produces captions for the photos on a page, in an editorial voice, from the
photos themselves plus a short project brief. Three scopes:

| Scope | Input to the model | Output | When |
| --- | --- | --- | --- |
| **Element** | The one photo (or the page it is on) and the brief | Three variants for this text box | Inspector of a selected text element, or the caption slot of a captioned layout |
| **Page** | The rendered page (one image) and the brief | A caption per photo on the page, or one page caption, placed in the layout's caption slots (captioned layouts exist) or as a new caption element | Page toolbar, *Caption this page* |
| **Book** | A text **index** of every photo (built once, see 12.3) and the brief, then one request per page | Captions for every page, reviewed in a list before they land | Display → Book, *Caption book…* |

Also produced for free on every run: **alt text** per photo (`asset.alt`, published to the viewer for
accessibility) and a suggested **title** for the page when it has a title slot.

### 12.2 First use: the brief

The first time the action runs in a project, a short interview (one dialog, five fields, all optional except the
first) collects the context that makes captions specific instead of generic:

1. What is this book about? (free text: "A week in Lisbon with friends, June 2026")
2. Who is the photographer and how should they be referred to? ("Jan Paul; first person plural, 'we'")
3. Where and when? (pre-filled from EXIF dates and GPS when present)
4. Who is in the photos? (names the model may use; anyone not listed stays unnamed)
5. Voice: **Editorial** (default), Diary, Minimal, Playful; plus a free "avoid" line and up to three example
   captions in your own words. If the book already has captions, "Use my existing captions as examples" is
   checked by default.

The brief is saved in the project file (`book.captions.brief`: it is not a secret and it belongs to this book) and
can be edited any time from the dialog. The default **Editorial** voice is a fixed style sheet in the system
prompt: present tense, concrete nouns, one or two sentences of 12 to 30 words, place and time when known, no
exclamation marks, no hashtags, no emoji, no restating what is obvious in the picture, no names that are not in
the brief, no superlatives. Variants differ in angle (what is happening / where we are / a detail), not in tone.

References looked at on Mobbin: [Later's Caption Writer](https://mobbin.com/screens/5a70c39d-c20f-4e01-858a-57dbd217c8c4)
(variants with Rephrase / tone chips next to the post), [Buffer's AI Assistant](https://mobbin.com/screens/ff1e037e-1a9f-4bd3-8264-45189fe6ec0e)
(Insert / Retry / Shorten / Expand), [Wix's AI Text Creator](https://mobbin.com/screens/46123347-03b4-426e-9afc-55c06104a1e2)
(site info + tone chips + one button), [Grammarly's voice settings](https://mobbin.com/screens/be218681-12a2-4317-a98c-c23f49223c1c)
(a one-time voice profile reused everywhere), and [Canva's Magic Write](https://mobbin.com/screens/123b8aa9-092f-40ca-aeb0-2c94905b89ae)
(inline prompt box). The pattern to copy: a one-time voice profile, then variants with small fix-up chips
(Shorter, More specific, Different angle) rather than a prompt box.

### 12.3 Cost, and why "scan the whole book" is fine

Image input is priced by pixels: roughly `width × height / 750` tokens per image. So:

| Image sent | Tokens | Cost at Opus 5.5 ($4 / M input) | At Haiku 5.5 ($0.10 / M) |
| --- | --- | --- | --- |
| One photo proxy, 768 px long edge (4:5) | about 800 | $0.003 | $0.00008 |
| One rendered page, 1080 × 1350 | about 1,950 | $0.008 | $0.0002 |
| 90 photos at 768 px (a 30-page book) | about 72,000 | $0.29 | $0.007 |
| 30 pages at 1080 × 1350 | about 58,000 | $0.23 | $0.006 |

A whole-book index costs well under a dollar on the default model. What would be expensive is sending **all the
photos again on every request**, so the design is:

1. **Index once, cache by hash.** The Book scope first runs one request per photo (or per batch of 8 photos, each
   at 768 px) asking for a two-line description, the people count, the setting, the time of day and a mood word,
   as JSON. Results are written to the **library** (section 2) as `photos[hash].ai.description` with the model
   and date, so they are shared by every project on the folder and never computed twice. Re-running a book that
   has changed indexes only the new photos.
2. **Caption requests carry text, not pixels.** A page caption request sends the brief, the index of the whole
   book as text (about 60 tokens per photo, so 90 photos are about 5,400 tokens), and **only the current page's
   image**. The book context the user wanted is there, at text prices.
3. **Prompt caching.** The system prompt (style sheet + brief + book index) is marked `cache_control` with a
   one-hour TTL; the 30 page requests of a book run read it from cache at a tenth of the price.
4. **Show the cost before running.** The Book dialog shows "about 60,000 tokens, roughly $0.25 on Claude Opus 5.5"
   computed from the image sizes and the pricing table, with the `count_tokens` endpoint for the text part.
   Element and Page scopes are cheap enough to run without a prompt.
5. **The Batch API for the index.** When the user is not waiting (Book scope on 100+ photos), the index can go
   through Message Batches at half price; the queue (W2.4) polls it.

### 12.4 Bring your own key

- **Providers.** Anthropic first, through the Messages API, default model `claude-opus-5-5` with a picker for
  `claude-sonnet-5-5` and `claude-haiku-5-5` in Settings → AI (the user chooses the price point; the index is a
  good fit for Haiku, captions for Opus). The provider interface (`describe photos`, `caption page`, `count
  tokens`, `estimate cost`) is small, so OpenAI and Gemini adapters can follow if asked; nothing else in the
  editor knows which provider is in use.
- **Key storage.** Settings → AI stores the key in `<appdata>/ai.env` with owner-only permissions, exactly as
  `write_publish_settings` already does for the R2 credentials; macOS Keychain via the `keyring` crate is a
  later upgrade. The key never enters the project file, the library, or the webview: requests are made from a
  Rust command (`commands/ai.rs`, `reqwest` against `POST /v1/messages`, since there is no official Rust SDK),
  which reads the key from disk per call. The webview sends asset ids and page ids, never image bytes.
- **Request shape.** Images are the existing 1600 px proxies downscaled to 768 px long edge by the command
  (JPEG, base64). Thinking is adaptive (the default), effort `low` for the index and `medium` for captions,
  structured output (`output_config.format`, a JSON schema: `{ captions: [{ target, text, alt }] }`) so nothing
  is parsed from prose, and `stop_reason` is checked before reading content (a refusal shows as "The model
  declined this page" with the reason, never as an empty caption).
- **Privacy line in the dialog**, stated once: photos on the page are sent to the provider you configured, and
  to nobody else; nothing is sent until you press Generate.

### 12.5 UI

- **Element**: the inspector of a text element gets a ✦ *Write* button. A popover shows three variants as cards,
  Use / Shorter / More specific / Different angle chips, and the current text as "Keep mine". Insert replaces the
  text in one undo step.
- **Page**: *Caption this page* in the page toolbar; a sheet lists each photo on the page with its proposed
  caption and alt text, Apply places them (captioned layout slots first, else a caption element at the bottom
  margin per `captionFrame`).
- **Book**: a dialog with the brief summary, the cost estimate, a scope choice (pages without captions only /
  all pages), then a progress list by page; each row has Accept / Edit / Skip, and Accept all. Nothing lands
  until accepted.
- **Settings → AI**: provider, key (masked, Test button that calls `count_tokens`), model, and a usage line
  (tokens and estimated spend this month, kept locally from `usage` in each response).

### 12.6 Schema

```ts
// Book, version 8 (same bump as the displays)
captions: z.object({
  brief: z.object({ about, photographer, placeTime, people: z.array(z.string()), voice, avoid, examples }).optional(),
}).default({}),
// AssetSchema
alt: z.string().optional(),
// Library (section 2.2)
photos[hash].ai: { model, at, description, people, setting, timeOfDay, mood }
```

Sizing: about 7 days (Rust command and provider adapter 2, index and cache 1, three UIs 3, settings and cost 1).

Check: on the lisbon fixture, the Book scope captions 20 pages for under $0.30 on Opus 5.5 with the index cached;
re-running costs under $0.05; the key is absent from every file under the source folder; a refusal on one page
leaves the other pages' captions intact.

## 13. Added phases and decisions

| Phase | Work | Days | Depends on |
| --- | --- | --- | --- |
| **W6.0 Noise profile** (added to W6) | `ai/noise_profile.rs` self-profiling, per-camera learned profiles in app data, camera badge and suggested Amount | 3 | — |
| **W6.5 Denoise UX** (added to W6) | Amount mapping, loupe with live crop preview, state pill and queued Apply, model default in Settings | 3 | W2.4 queue |
| **W7 Canvas** | Gesture inversion, Adjust photo mode, nudge, equal-spacing and size-match guides, alignment toolbar, rulers and page guides | 5 | — |
| **W8 AI captions** | Settings → AI, `commands/ai.rs`, index with library cache, element / page / book UIs, cost estimate | 7 | W1 (library) for the cache; works per project without it |
| W6.6 Raw-domain profiled model (optional, later) | Training project on a RAW corpus | weeks | D6.1 demosaic ownership |

| Decision | Recommendation | Why |
| --- | --- | --- |
| Per-camera denoise | Noise profiles (self-measured, then learned per camera), not per-brand models | That is what every serious tool does; no permissive per-brand model exists |
| Canvas drag | Drag moves the frame; pan is a double-click mode | Matches every other layout tool; the band is undiscoverable |
| AI provider | Anthropic first, default `claude-opus-5-5`, model picker in Settings | One provider interface keeps adapters possible |
| Where the key lives | `<appdata>/ai.env`, 0600, read by a Rust command | Same pattern as the publish credentials; never in the webview or the folder |
| Book context | Text index cached by hash in the library + the current page image | Keeps "the model knows the whole book" at text prices |
| Caption voice | Editorial by default, defined as a fixed style sheet; the brief adds specifics | Consistent voice across the book; variants change angle, not tone |

---

# Part three (Oct 12, 2026): revised model, library first

This supersedes sections 1.1, 2.1 and 2.2. The change: **folders are imported into a library that exists
independently of any project; Cull and Edit work on the library; a project is only an output** (a book, a social
post, a print) and carries its own context for the AI features. Export of developed photos belongs to Edit, not to
a project.

## 14. The three layers

```
Library  (per folder, shared by everything)          Project  (an output)
┌───────────────────────────────────────┐            ┌──────────────────────────────────┐
│ photos by content hash                │            │ name, kind(s): book, social, …   │
│   rating, flag                        │  referenced│ assets: id → { hash, version? }  │
│   develop (master) + versions         │◄───────────│ pages / frames / print settings  │
│   ai.description (index, cached)      │            │ captions brief (AI context)      │
│ renders: .photobook-cache/<hash>-<dh> │            │ publish info, fingerprint        │
└───────────────────────────────────────┘            └──────────────────────────────────┘
          ▲
          │ decodes, never writes
   Source files (JPEG / HEIC / RAW)
```

| Layer | Lives in | Owned by | Changes when |
| --- | --- | --- | --- |
| Source files | the user's folder | the user | never (we never write them) |
| Library entry | `<folder>/.photobook/library.json`, keyed by SHA-256 of the file | the folder | you cull, edit, or index a photo |
| Render cache | `<folder>/.photobook-cache/develop/<hash>-<dh>[-p3].jpg` and the app cache (thumb, proxy per `(hash, dh)`) | nobody; rebuilt on demand | the develop hash changes |
| Project | `<appdata>/projects/<ULID>/project.photobook.json` (or any path chosen with Save as) | the project | you design, caption, publish |

### 14.1 Sidebar and navigation

```
┌ Library ─────────────┐
│ Folders              │   Cull    Edit    [ Project ▾ ]  Display   Publish
│   Lisbon 2026   312  │
│   Portraits     58   │
│ Collections          │
│   Picks         44   │
│   Edited        61   │
│   Needs denoise 12   │
│ Projects             │
│   Lisbon zine        │
│   IG carousel        │
└──────────────────────┘
```

- **Folders** are imported once (*Import folder…*) and stay listed; the registry is `<appdata>/folders.json`
  (path, name, last seen, counts). Removing a folder from the sidebar leaves its `.photobook/` files in place.
- **Collections** are saved filters over the library (flag, rating, edited, ISO, date, camera), not copies.
- **Cull** and **Edit** always show the library (the selected folder or collection). They do not need a project.
- **Projects** list the outputs. Opening one adds a *Project* filmstrip tab: the photos in that project, with a
  *Library* tab beside it to drag more in. Display and Publish are project views.
- The scope rules change from "one source root" to "the set of imported folders plus app data": `scope.rs`
  `ensure_allowed` takes the registry's roots; `ensure_source_root` becomes `ensure_imported_root`.

### 14.2 What a project references when a photo is edited

A project never stores pixels or develop settings. Each asset entry is:

```ts
assets[id] = {
  hash: 'sha256…',          // the photo, wherever it lives
  folder: 'folderId',       // hint for resolving; relink by hash if the file moved
  path: 'DSCF1234.RAF',     // hint, same
  version?: 'ulid',         // a virtual copy in the library; absent = the master edit
  publishedDh?: 'dh…',      // develop hash the last publish used (change detection)
}
```

Resolution at render time, everywhere (canvas, viewer preview, export, publish):

```
hash (+ version) ─► library.photos[hash].develop ─► develop_hash(settings) = dh
                                                 ─► render cache <hash>-<dh>.jpg (make it if absent)
```

So when you edit a photo in Edit:

- every project that references that hash (master) shows the new edit immediately, because the reference is live
  and the cache key is the develop hash;
- nothing is copied: the render is made once and shared by all projects and exports;
- the project's `publishedDh` no longer matches, so the filmstrip shows an *edited since publish* badge and the
  publish dialog lists "7 photos changed" (the publish fingerprint already includes the develop hash, so
  republish uploads exactly those);
- if one project must **not** follow (the zine wants the B&W, the carousel the colour), *Make a version* in Edit
  creates a virtual copy in the library and points that project's asset at it. Versions are listed under the
  photo in Edit as a small strip.

If a project should be frozen against later edits, *Snapshot edits* copies the develop settings of its assets
into the project file (`assets[id].developSnapshot`) and the resolver prefers the snapshot. Off by default; it is
the exception, not the rule.

### 14.3 How photos are optimised for a project

They are not optimised **in** the project; the project borrows from the pipeline below, and only the last step is
specific to the output:

| Step | Keyed by | Made by | Shared by |
| --- | --- | --- | --- |
| Decode + thumb 320 / proxy 1600 | `hash` | editor cache (`cache/<hash>/`) | every project, Cull, Edit |
| Developed thumb / proxy | `(hash, dh)` | Edit on commit (3 kept per photo) | every project |
| Full developed render | `(hash, dh, profile)` | before export or publish, in the job queue | every project and export |
| Output encode | `(hash, dh, outputPreset)` | publish CLI (AVIF / WebP / JPEG sizes + download copy, keyed `<hash>-<dh>`), export (one file per preset), social frames (page render) | that output |

Republish already uploads only changed keys. Export gets the same property: an export preset's output is cached
under `.photobook-cache/export/<preset-hash>/<hash>-<dh>.jpg`, so re-exporting a folder after editing three
photos re-encodes three files.

### 14.4 Export from Edit

Single (the open photo) and bulk (the Cull or Edit selection, a collection, a folder). One dialog, Lightroom's
shape, with presets:

| Preset | Long edge | Format | Quality | Colour | Metadata | For |
| --- | --- | --- | --- | --- | --- | --- |
| **Social** | 2048 px | JPEG | 88 | sRGB | strip, keep copyright | Instagram, Threads, TikTok (they downsize to 1080 themselves; 2048 survives their recompression better than 1080) |
| **Web** | 1600 px | JPEG or WebP | 85 | sRGB | strip | sites, chat |
| **Full quality** | original | JPEG 95, or HEIC 10-bit for wide gamut | — | Display P3 when the source is wide | keep all EXIF | archive, print lab, clients |
| **Original + sidecar** | — | copy of the source file | — | — | plus a `.xmp` with our packet and the Lightroom-readable tone part | hand-off to Lightroom |
| Custom | any | JPEG / WebP / AVIF / HEIC / PNG / TIFF 16-bit | any | sRGB / P3 | keep / strip | — |

Common options: destination folder (default `<folder>/Exports/<preset>/`), file naming (`{name}`, `{seq}`,
`{date}`, `{rating}`), output sharpening for screen (the existing output sharpen op at the target size),
watermark text or PNG with position and opacity, a border, "skip photos already exported with these settings",
and *Reveal in Finder* on completion. Presets are saved in `<appdata>/export-presets/`. Runs in the job queue with
per-file progress and Cancel. Keyboard: Cmd+Shift+E opens the dialog with the last preset.

This replaces the *Export files* display of section 1.2; the *Social post* display stays, because it is a designed
sequence of frames, not a resized photo.

### 14.5 AI context per project

The split falls out of the layers: the **photo index** (descriptions by hash) is library data and is reused by
every project, the **brief** is project data. A caption request sends the project's brief, the index of the
photos *in that project*, and the current page image. Two projects on the same photos can have different briefs
and voices and share the index.

### 14.6 Migration from today's files

- A `<folder>/book.photobook.json` found at import is turned into a project (`<appdata>/projects/<ULID>/`), its
  `assets[].rating/flag/develop` lifted into the folder's library, its asset entries rewritten to `{hash, folder,
  path}`. The old file is left in place renamed `book.photobook.json.imported` until the user deletes it.
- The publish CLI takes the project path as before and resolves folders through the project's `folders` map, so
  `photobook publish <project.json>` is unchanged for the user.
- Schema v8: `assets[id]` loses `rating`, `flag`, `develop` and gains `hash` (required), `folder`, `version?`,
  `publishedDh?`, `developSnapshot?`; `sourceFolder` becomes `folders: Record<id, { path }>`; `displays` and
  `captions` as in sections 1.3 and 12.6.

### 14.7 Changes to the phases

W1 becomes **Library and projects**: folders registry and scope (1 day), library file and commands (2), the
Cull/Edit views reading the library without a project (2), projects in app data with the `folders` map and the
migration (2), relink by hash across folders (1), CLI resolution (1). About 9 days, replacing the 8 of the earlier
W1. **Export** is a new W4.0 of about 3 days (dialog, presets, queue, cache), replacing W4.3. Everything else
stands.

| Decision | Recommendation | Why |
| --- | --- | --- |
| Library vs project | Library per folder, shared; project = output only | Cull and edit once, use many times |
| Project file location | App data, with Save as anywhere | A project spans folders, so it cannot live in one |
| Reference | `hash` + optional `version`, resolved live through the library | No copies, one render per edit, edits propagate |
| Freezing | Opt-in snapshot per project | Following the latest edit is what people expect; a frozen output is the exception |
| Export | In Edit, preset-based, cached by `(hash, dh, preset)` | Re-export re-encodes only what changed |

---

## 15. Platform: stay on Tauri, measure, then go hybrid if needed (Oct 12, 2026)

**The app is already "built in Rust" where it matters.** Decode, RAW, the develop maths, the wgpu/Metal pipeline,
ONNX through Core ML, masks, denoise, XMP, caches and every file write live in `crates/develop` and the Tauri
commands. The webview holds the UI and the DOM page renderer, which the viewer and the publish CLI share. On macOS
Tauri uses the system WKWebView (no bundled Chromium), so the shell costs tens of MB, not Electron's hundreds.

Where the webview is the real ceiling, and what to do inside Tauri before considering anything else:

| Cost | Why | Fix, in order |
| --- | --- | --- |
| Develop slider latency | Each change is render → JPEG encode → IPC → WebKit decode → paint | 1. A custom protocol that streams raw RGBA (no encode) into a WebGL/WebGPU canvas. 2. A native Metal `CAMetalLayer` under a transparent region of the webview for the Develop preview and the loupe (objc2 through `with_webview`); the UI stays web, the picture is native. |
| Full-render memory | A 24 MP f32 RGBA frame is 384 MB; two or three in flight is a gigabyte | Tile the full render on the Rust side; keep previews at proxy size. Independent of the GUI toolkit. |
| Many bitmaps in WebKit | Every `<img>` is its own decoded bitmap in WebKit's cache | Virtualised strips (exists), thumbnails at 320 px, revoke blob URLs off-screen |
| Canvas with many pages | DOM renderer | Render only the visible spread; page thumbnails as images |

Budgets to measure before any decision: resident memory with 300 photos imported and 20 pages designed; slider to
paint latency on a 1600 px proxy (target under 30 ms, acceptable under 60); full render time and peak memory on a
24 MP RAW.

Alternatives, and why not now:

- **Swift/SwiftUI + the Rust crate over FFI** (uniffi / swift-bridge): best feel and memory on a Mac, but the
  shared DOM renderer would need a native twin or a hidden WKWebView anyway, and Linux and Windows go away.
- **Rust-native GUI** (egui, iced, gpui, Dioxus native): egui is excellent for the picture-editing half and poor
  for a designed-book canvas with real typography; gpui and Dioxus native are promising and young.
- A rewrite only pays if the hybrid (web UI, native picture surface) cannot meet the budgets above.

**Packaging** (not in this workstream; recorded so it is not forgotten):

- `pnpm tauri build` already produces `.app` and `.dmg` on macOS, `.msi` / NSIS on Windows, `.deb` / `.AppImage` /
  `.rpm` on Linux (`bundle.targets: "all"` in `tauri.conf.json`). Universal macOS binary with
  `--target universal-apple-darwin`; `ort`'s prebuilt binaries exist for both architectures.
- macOS needs Developer ID signing and notarisation (Apple Developer Program, about $99 a year;
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` for the bundler), or Gatekeeper reports
  the app as damaged. Windows wants an Authenticode certificate for a clean SmartScreen.
- The publish CLI and Playwright are Node: ship the CLI as a single-file sidecar (`bundle.externalBin`, built
  with Node SEA or `bun build --compile`; the editor already launches it through `cli_launcher`), and render page
  images in an offscreen Tauri window instead of Playwright. The clean long-term route is porting the image
  step to Rust (JPEG exists; `ravif`, `webp`), which also removes `sharp`.
- Auto-update with `tauri-plugin-updater` and a signed `latest.json` on GitHub Releases; `tauri-action` builds
  every platform on a tag. A Homebrew cask is the easiest extra channel. Expected bundle: 100 to 150 MB with ORT
  linked statically; models stay on-demand downloads.

---

## 16. Going public: what to host, what to keep local (Oct 12, 2026)

The question: a web version of the editor seems to imply a large server and hosting people's photos. Does it, and
is a hosted "upload, we host the book" service the better public release?

| Option | Who computes | Who stores what | Your cost | Onboarding | Verdict |
| --- | --- | --- | --- | --- | --- |
| **A. Desktop app, their cloud** (today) | Their Mac | Their R2 bucket, their Worker | Zero | Cloudflare account, keys, a Worker deploy: hours, technical | Fine for us and for technical friends; not a public product |
| **B. Desktop app, our hosting** ("Photobook Cloud") | Their Mac | **Only published outputs** (web sizes + download copies) in our R2, keyed per account | Storage only: a 30-page book of 100 photos is roughly 100 × (1.5 MB web sizes + 5 MB download) ≈ 650 MB ≈ $0.01/month on R2, no egress fees | Sign in, press Publish | **The public release.** No originals leave the machine, no servers run the pipeline |
| **C. Browser editor, local-first** | Their browser: the Rust crate compiled to wasm, wgpu on WebGPU, `onnxruntime-web` on WebGPU, files through the File System Access API | Same as B | Same as B plus static hosting | Open a URL | Plausible later: wgpu and ort both target the browser; Safari lacks the File System Access API for folders, and a 24 MP RAW pipeline in wasm needs the tiling work of section 15 first |
| **D. Full SaaS: upload originals, we develop and host** | Our GPU servers | Originals (gigabytes per shoot) and outputs | Storage of originals, GPU time for develop and denoise, upload bandwidth, ops, backups, abuse handling | Upload, wait | The expensive one, and it turns a privacy feature (nothing leaves your Mac) into a liability. Not now |

So: yes, releasing publicly is easier as "they upload and we host the website", with one correction. **They upload
the finished renders, not the photos.** The editor stays local (desktop now, browser maybe later); the publish
step uploads what the viewer serves. The project already works this way with the user's own bucket, so B is a
change of target and of accounts, not of architecture:

- **Accounts and tenancy in the Worker.** Sign in (passkeys or magic link), one R2 prefix per account, the
  likes/downloads D1 tables keyed by account + book, publish through signed upload URLs issued by the Worker
  instead of raw R2 keys in the app. Quotas per plan.
- **The editor's publish target** gains "Photobook Cloud" next to "My R2 bucket"; the CLI gets `--target cloud`.
  Self-hosting stays supported, which is also the honest answer to "what if you shut down".
- **The viewer** is already static and multi-book; it needs the account's book list and the custom-domain story
  (`<name>.photobook.app`, and bring your own domain through Cloudflare for SaaS).
- **Pricing shape**: free for a couple of books and a few GB, paid per storage tier; downloads of full-quality
  copies are the only real bandwidth, and R2 charges none.

What would make C worth building: a Windows and Linux audience without maintaining three desktop builds, and a
"try it in the browser" funnel. The crate was written without Tauri dependencies for this reason; the blockers
are Safari's folder access and the memory budgets. Measure those after section 15's budgets, not before.
