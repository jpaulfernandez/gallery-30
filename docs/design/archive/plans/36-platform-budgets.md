# 36 · Platform budgets (optional)

Status: done 2026-10-13. Results in `docs/design/PLATFORM_BUDGETS.md`, procedure in `scripts/measure/README.md`
(+ `sample-memory.sh`, `make-bench-book.py`). Numbers (M3 Pro, dev build, load 3–10): resident memory with 300 photos
and a 20-page book 238 MB physical footprint summed over `photobook-editor` and its WebKit processes (237 MB in the Cull
grid, 406 MB in Develop; alarm 1.5 GB); slider → paint on the 1067×1600 proxy 49 ms median for one Exposure step (p90
53; acceptable, not good; 54 ms, p90 60, on a real 22 MP RAW's proxy), 23 to 26 ms per frame during a 60 Hz drag; full render of a 22.1 MP CR2 (no 24 MP file in the ON1
set) 0.53 s and 1.25 GB peak footprint (median of three runs) (1.16 s / 1.73 GB with `everything.json`). Experiment: debug-only `pbraw` custom
scheme returning raw RGBA8 (`src-tauri/src/commands/raw_preview.rs`, `raw_preview_frame` in `commands/develop.rs`,
registered in `lib.rs` under `cfg(debug_assertions)`) drawn by `RawPreviewCanvas` (WebGL2), behind
`localStorage['photobook.rawPreview'] = '1'` in dev builds only: −4 ms per step on the synthetic photo (45 against 49 ms), −3 ms on the real RAW (51 against 54),
−1 to −4 ms per drag frame, all within the run-to-run spread (a lower bound on the synthetic photo); decode saved,
transfer of 6.8 MB per frame ate most of it. Neither latency fix in the recommendation is implemented. Recommendation: no native preview surface; fix the 16 ms
coalescing delay and the React swap first. Full-render memory is the problem, so plan 37 (tiled full render) is written,
not started. How the slider was driven: the window cannot be seen or clicked, so a dev-only bench
(`src/lib/bench/budgets.ts`, started from `main.tsx` only with `VITE_PHOTOBOOK_BENCH=1`) calls the slider's own store
action (`setAssetDevelop` inside `beginDevelopDrag`/`endDevelopDrag`) and reads paint times from the new
`[photobook:develop] slider→paint` line (`components/develop/previewTiming.ts`: settings change → `<img>` `load` or the
WebGL draw → next animation frame); the React render after the store write is in the number, pointer-event handling is not. Deviations: the
plan's "16-bit PNG" alternative was not tried (raw RGBA8 only); memory is the editor's dev build (Rust debug profile);
photos are `make-sample-trip.py`'s synthetic JPEGs; the full render is measured in a release test binary
(`budget_full_render_24mp` in `crates/develop/tests/raw.rs`, ignored), not inside the editor process. Review fixes (same day):
the scheme allows only `http://localhost:1420`; the canvas and fetch (`rawPreviewFetch.ts`) are dev-only dynamic
imports, so the release bundle has none of the experiment (checked with a Vite build); the `slider→paint` line is
dev-only; tests `raw_preview::tests` (Rust: preflight, wrong method, bad JSON, origin) and `rawPreviewFetch.test.ts`,
`previewTiming.test.ts`; `make-bench-book.py` is deterministic and embeds the nine layouts.

WORKFLOW_PLAN [15](../WORKFLOW_PLAN.md#15-platform-stay-on-tauri-measure-then-go-hybrid-if-needed-oct-12-2026). Size: 1 day.
Depends on: nothing.

**Goal.** Numbers before opinions: measure the three budgets that would justify a hybrid shell, and try the one
in-Tauri fix that pays regardless (raw RGBA preview frames instead of JPEG round-trips).

## Budgets

| Measure | Target |
| --- | --- |
| Resident memory with 300 photos imported and 20 pages designed | record; alarm above 1.5 GB |
| Slider to paint latency on a 1600 px proxy | under 30 ms good, under 60 ms acceptable |
| Full render time and peak memory on a 24 MP RAW | record |

## Steps

1. A `scripts/measure/` note with the procedure (Activity Monitor or `footprint`, the `[photobook:` timing lines)
   and a results table dated in `docs/design/PLATFORM_BUDGETS.md`.
2. Experiment: a custom URI scheme protocol in Tauri that streams the preview as raw RGBA (or a 16-bit PNG without
   compression) into a WebGL canvas instead of JPEG → `<img>`; measure the latency delta on one slider.
3. If the full-render memory is the problem, note the tiling work in the Rust `render` path as the next plan;
   do not start it here.

## Check

- The results table exists with the three numbers and the experiment's delta; a recommendation paragraph says
  whether a native preview surface is needed.
