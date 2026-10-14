# Platform budgets

Workflow plan 36 ([plan](archive/plans/36-platform-budgets.md), [WORKFLOW_PLAN section 15](archive/WORKFLOW_PLAN.md#15-platform-stay-on-tauri-measure-then-go-hybrid-if-needed-oct-12-2026)).
Numbers before opinions: the three budgets that would justify a hybrid shell (a native picture surface under the web
UI), and the one in-Tauri change that was supposed to pay regardless (raw RGBA preview frames instead of JPEG). The
procedure is [`scripts/measure/README.md`](../../scripts/measure/README.md); add a dated row when you measure again.

## Results

Measured 2026-10-13 on an Apple M3 Pro (11 cores, 18 GB), macOS 15.7.3, with other agents' builds running (load
average 3 to 10). The editor ran as the `pnpm dev` build (Rust in the dev profile, the develop crate's GPU path on);
the full render ran as a release test binary.

| Budget | Target | Result (2026-10-13) | Verdict |
| --- | --- | --- | --- |
| Resident memory, 300 photos imported, 20 pages designed | record; alarm above 1.5 GB | **238 MB** physical footprint in the Design view (editor 32 MB + WebKit WebContent 154 MB, GPU 30 MB, Networking 18 MB); 237 MB in the Cull grid of the 300; 406 MB in Develop after the slider runs | Far below the alarm |
| Slider → paint on a 1600 px proxy | under 30 ms good, under 60 ms acceptable | **49 ms** median for one Exposure step on a synthetic JPEG (p90 53), **54 ms** on a real 22 MP RAW (p90 60); 23 to 26 ms median per painted frame during a 60 Hz drag | Acceptable, not good |
| Full render, 24 MP RAW | record | **0.53 s and 1.25 GB peak** (median of three runs) for a 22.1 MP CR2 with no edit (decode 0.37 s, GPU render 0.09 s, JPEG q95 0.08 s); 1.16 s and 1.73 GB with every section, masks and a crop | Time fine; memory is the problem (below) |
| Experiment: raw RGBA preview instead of JPEG | — | **−3 to −4 ms** per step (45 against 49 ms synthetic, 51 against 54 ms real RAW); −1 to −4 ms per drag frame. Within the p90 spread of one loaded run | Not worth switching |

### Memory, in detail

`scripts/measure/sample-memory.sh`, 15 s into each 30 s hold of the bench, two runs (the first one cold: thumbnails and
proxies made during the run; the second from the cache). Physical footprint (Activity Monitor's Memory) summed over
`photobook-editor` and the three WebKit processes the window started; the RSS sum double-counts shared pages and is
given for reference only.

| View | Footprint, run 1 | Footprint, run 2 | RSS sum, run 2 |
| --- | --- | --- | --- |
| Design, the 20-page book open, 300-photo filmstrip | 234 MB | 238 MB | 458 MB |
| Cull grid of the 300 photos (virtualised) | 212 MB | 237 MB | 354 MB |
| Develop, after 130 live previews on both paths | 414 MB | 406 MB | 787 MB |

The WebContent process (the page, its DOM and decoded bitmaps) is the largest part everywhere (130 to 240 MB); the Rust
process grows from 33 to 107 MB in Develop (the cached 1600 px working image as f32, the GPU context, AI raster
caches). The photos are `make-sample-trip.py`'s synthetic JPEGs (flat colour fields, 2400×1600 and 6000×4000), so files
are small on disk; what the webview holds is fixed-size thumbnails (320 px) and proxies (1600 px), which cost the same
for real photos. The Rust side was a debug build; a release build is not expected to use more.

### Slider → paint, in detail

The bench drives Exposure through the slider's own store action on the folder's first photo, 20 single steps that
each wait for their paint, then 90 changes 16 ms apart, on each path. Three runs:

- **Run 1**, synthetic JPEG (`DSCF1000.jpg`, 4000×6000, flat colour fields; proxy 1067×1600): JPEG path only (the raw
  path had a StrictMode bug, since fixed): step 50 ms (p90 54), drag 25 ms (p90 29).
- **Run 2**, the same photo, both paths: the table below.
- **Run 3**, a real photo: `ON1 Sample 4.CR2` (22.1 MP Canon RAW, decoded to its 1600×1067 proxy, display look on),
  alone in a folder with the same 20-page book, load average about 8.

Synthetic photos favour the JPEG path: a flat image compresses to a small JPEG (about 60 KB at this size) that encodes
and decodes fast, so the raw path's saving on the synthetic run is a lower bound. Run 3 shows the real-photo cost.

| Stage (medians) | Run 2 JPEG | Run 2 raw | Run 3 JPEG (real RAW) | Run 3 raw (real RAW) |
| --- | --- | --- | --- | --- |
| Settings change → request sent (the `usePreview` coalescing timer, isolated change) | 16 ms | 16 ms | 16 ms | 16 ms |
| Rust render on the GPU (cached proxy) | 3 ms | 3 ms | 3 ms | 3 ms |
| Rust encode (turbojpeg q85) / RGB → RGBA pack (debug build) | 2 ms | 1 ms | 3 ms | 1 ms |
| Request → bytes in the webview (render, encode, transfer; webview clock), step / drag | 10 / 7 ms | 14 / 8 ms | 13 / 8 ms | 14 / 8 ms |
| WebKit decode (`HTMLImageElement.decode()`) / texture upload and draw, step / drag | 7 / 4 ms | 1 / 1 ms | 9 / 7 ms | 1 / 0 ms |
| React commit, `load`, the next animation frame | the rest | the rest | the rest | the rest |
| **Slider → paint, single step** | **49 ms** (p90 53) | **45 ms** (p90 49) | **54 ms** (p90 60) | **51 ms** (p90 58) |
| **Slider → paint, per frame in a 60 Hz drag** | **23 ms** (p90 31) | **22 ms** (p90 26) | **26 ms** (p90 33) | **22 ms** (p90 28) |
| Frames painted during the 90-change drag | 44 | 44 | 44 | 44 |

The 3 to 4 ms step delta is smaller than the spread between runs (49 to 54 ms medians for the same path) and than
each run's own median-to-p90 gap (4 to 7 ms), so one loaded run cannot rank the paths more finely than "about the
same".

The paint clock stops in the animation frame after the picture is on the page, so the screen shows it at most one
refresh later (7 ms at this display's 144 Hz). During a drag the preview runs at about 29 frames a second (a request
every 32 to 35 ms: the 16 ms coalescing timer re-armed by the next 16 ms change).

### Full render, in detail

`budget_full_render_24mp` (`crates/develop/tests/raw.rs`) under `/usr/bin/time -l`, release build. The ON1 sample set
has no 24 MP file; the 22.1 MP Canon CR2 is the nearest. Its first row is the median of three runs (peak footprint
1.22, 1.25 and 1.25 GB; times within 5 %); the other rows are one run each:

| File | Settings | Decode | Render | Encode | Total | Peak footprint | Max RSS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ON1 Sample 4.CR2, 5760×3840 (22.1 MP) | none, GPU | 367 ms | 85 ms | 78 ms | 533 ms | 1.25 GB | 0.96 GB |
| same | none, CPU (`PHOTOBOOK_FORCE_CPU=1`) | 363 ms | 93 ms | 77 ms | 537 ms | 0.75 GB | 0.95 GB |
| same | `everything.json` (every section, masks, crop), GPU | 359 ms | 739 ms | 56 ms | 1158 ms | 1.73 GB | 1.00 GB |
| same | `effects.json`, GPU | 363 ms | 94 ms | 81 ms | 544 ms | 1.24 GB | 0.96 GB |
| ON1 Sample 3.NEF, 5568×3712 (20.7 MP) | none, GPU | 334 ms | 77 ms | 123 ms | 538 ms | 1.16 GB | 0.87 GB |
| ON1 Sample 5.ARW, 7952×5304 (42.2 MP) | none, GPU | 402 ms | 136 ms | 138 ms | 681 ms | 1.92 GB | 1.53 GB |
| ON1 Sample 8.cr2, 8688×5792 (50.3 MP) | none, GPU | 809 ms | 183 ms | 200 ms | 1200 ms | 2.08 GB | 1.89 GB |

The peak is 56 bytes per pixel at 22 MP and 78 with masks and a crop. The full image probably exists several times at
once (not yet measured per stage; the first step of plan 37): the RAW decoder's buffers, the linear f32 RGB image
(12 B/px, 265 MB at 22 MP), the GPU's rgba16float source (8 B/px) and warp (16 B/px), the 8-bit output and the JPEG. The editor runs two full renders at a time (`MAX_RENDERS`) plus the
export lanes, so a publish or export of a RAW-heavy book can hold 2.5 to 4 GB on top of the editor's 0.4 GB.

## The experiment: raw RGBA frames into WebGL

A debug-only custom URI scheme, `pbraw` (`apps/editor/src-tauri/src/commands/raw_preview.rs`, registered in `lib.rs`
under `cfg(debug_assertions)`), answers a POST with the developed proxy as raw RGBA8 behind a 16-byte header, with the
same scope checks, job ordering and render permit as `render_develop_preview` (`raw_preview_frame` in
`commands/develop.rs`). `RawPreviewCanvas` uploads it into a WebGL2 texture and draws one quad. It is on only in a dev
build with `localStorage['photobook.rawPreview'] = '1'` (or the bench's override); the default path did not change.

It saves what it was meant to save: the WebKit decode (7 → 1 ms on the synthetic photo, 9 → 1 ms on the real RAW) and
the JPEG encode (2 to 3 → 1 ms). It loses most of it again in transfer: a 1067×1600 frame is 6.8 MB raw against tens
to hundreds of KB of JPEG, and the custom-scheme response takes longer to arrive than the IPC response (14 against 10
to 13 ms for a step). Net: −4 ms per step on the synthetic photo and −3 ms on the real RAW, −1 to −4 ms per drag frame,
with a slightly tighter p90 because there is no decode to queue behind; all within the run-to-run spread above, and a
lower bound on the synthetic photo. Not worth a second preview path; the scheme stays as a dev-only
probe for a later attempt (half-size frames while dragging, or an `ImageBitmap` from a shared buffer).

## Recommendation

**A native preview surface is not needed.** The develop maths take 3 ms on the GPU and the whole Rust side 5 ms; the
webview's own costs (transfer and JPEG decode) are about 10 to 15 ms of a 49 to 54 ms step, and a `CAMetalLayer` under the webview
could remove only those, at the price of objc2 plumbing, z-ordering against the DOM overlays (crop, masks, guides,
loupe) and a macOS-only path. The rest of the latency is the editor's own scheduling, which is cheap to fix inside
Tauri: the `usePreview` coalescing timer always adds 16 ms before the request of an isolated change (send at once when
nothing is in flight, coalesce only behind an in-flight request), and the swap goes through a React state update, the
image `load` and the next frame (setting the `<img>` source directly once decoded would save part of that). Neither fix
is implemented; the "near 30 ms" a step should reach with both is an estimate, not a measurement. Measure again with
this procedure before reconsidering a native surface.
Revisit it only if they do not, or when the proxy grows past 1600 px for 5K displays (the transfer and decode scale with
it, the scheduling does not).

Memory does not argue for a different shell either: the whole editor with 300 photos and a 20-page book sits at a
quarter of the 1.5 GB alarm, and most of it is the page itself. **The full render is the memory problem**, and it is
independent of the GUI toolkit: one 22 MP render peaks at 1.25 GB (1.73 GB with masks and a crop), two at once pass 2.5
GB. The tiling work in the Rust render path is the next plan: [37 · Tiled full render](plans/37-tiled-full-render.md).
