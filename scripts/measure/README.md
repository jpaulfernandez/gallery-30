# Platform budgets: how to measure

Workflow plan 36 (`docs/design/archive/plans/36-platform-budgets.md`, WORKFLOW_PLAN section 15). The numbers and their dates
live in `docs/design/PLATFORM_BUDGETS.md`; this note is how to take them again. Everything runs on the dev build and
the develop crate's tests, on one Mac, with nothing else heavy running (the load average changes every number here).

| Budget | Target | How |
| --- | --- | --- |
| Resident memory, 300 photos imported, 20 pages designed | record; alarm above 1.5 GB | Bench run below, `sample-memory.sh` |
| Slider → paint on a 1600 px proxy | under 30 ms good, under 60 ms acceptable | Bench run below, `slider→paint` log lines |
| Full render time and peak memory, 24 MP RAW | record | `budget_full_render_24mp` under `/usr/bin/time -l` |

## 1. Test folder and project

Generate 300 photos with the repository's own generator into a scratch folder (not `fixtures/`, which is gitignored
but shared), then a legacy 20-page book over them, which the editor turns into a project at startup:

```sh
python3 scripts/make-sample-trip.py "$SCRATCH/trip300" 300
python3 scripts/measure/make-bench-book.py "$SCRATCH/trip300"
```

`make-sample-trip.py` writes JPEGs and a few PNGs at 2400×1600 and, every eighth file, 6000×4000 (portrait or
landscape), a third of them in a `day-two/` subfolder. `make-bench-book.py` writes
`book.photobook.json` version 3: every file as an asset (SHA-256, size, mtime, size and orientation from the file) and
20 pages that cycle nine layouts (the lisbon-demo book's, embedded in the script, so it needs no gitignored fixture),
34 photos placed. Ids come from a fixed timestamp and a seeded generator, so the same files give the same book and
project id. Files Pillow cannot open (camera RAW) are sized with `sips`, so a folder with one real RAW works too (that
is how the real-photo latency run was made).

## 2. Seed app data, run the dev build with the bench

Back up `~/Library/Application Support/com.photobook.editor/recent.json` and `folders.json`, and list the cache, first
(the cleanup in this section needs that listing):

```sh
ls "$HOME/Library/Application Support/com.photobook.editor/cache" | sort > "$SCRATCH/cache-before.txt"
```

Then make the scratch folder the only imported folder and the recent project:

```sh
APP="$HOME/Library/Application Support/com.photobook.editor"
echo '[{ "id": "01K7BENCH36PRATF0RMBDGETS0", "path": "'"$SCRATCH/trip300"'", "name": "trip300",
  "addedAt": 0, "lastSeen": 0 }]' > "$APP/folders.json"
echo '{ "folder": "'"$SCRATCH/trip300"'" }' > "$APP/recent.json"
```

Start the editor with the bench (`apps/editor/src/lib/bench/budgets.ts`, loaded by `main.tsx` only when
`VITE_PHOTOBOOK_BENCH=1` on a dev server) and the memory sampler next to it:

```sh
pgrep -f XPCServices/com.apple.WebKit > "$SCRATCH/webkit-before.txt"
source ~/.cargo/env && VITE_PHOTOBOOK_BENCH=1 pnpm dev > "$SCRATCH/dev.log" 2>&1 &
scripts/measure/sample-memory.sh "$SCRATCH/dev.log" "$SCRATCH/webkit-before.txt" > "$SCRATCH/memory.log"
```

The bench needs no clicks (the agents that run it cannot see the window):

1. It waits for the reopened project and for the folder to finish scanning, hashing and preparing its thumbnails and
   proxies (`useLibraryStore`: `scanned`, not `busy`, `prepared == total`), then holds the Design view of the 20-page
   book for 30 s (`[photobook:bench] checkpoint design`; `VITE_PHOTOBOOK_BENCH_HOLD_MS` changes the hold).
2. It opens the folder's Cull grid (300 thumbnails, virtualised) and holds it (`checkpoint cull`).
3. It opens Develop on the first photo and moves Exposure through the slider's own store action
   (`setAssetDevelop` inside `beginDevelopDrag` / `endDevelopDrag`): one warm-up change, 20 single steps that each
   wait for their paint and 150 ms more (`step`), then 90 changes 16 ms apart, a fast 60 Hz drag (`drag`). It does
   this on the JPEG path and again on the raw RGBA path (section 4), logs `slider jpeg`, `slider raw` and
   `slider summary` (median, p90, min, max of `slider→paint`, plus the median request and decode stages), and resets
   the photo's develop.
4. It holds Develop for a last sample (`checkpoint develop`) and logs `done`.

`sample-memory.sh` reads each checkpoint 15 s into its hold: `footprint` (physical footprint, what Activity Monitor
shows as Memory) and RSS of `photobook-editor` and of every `com.apple.WebKit.*` process that was not running before
the launch. WKWebView runs the page in its own WebContent process (and shares GPU and Networking processes), so the
editor's memory is the sum, not the `photobook-editor` line alone. Keep Safari, Mail and other WebKit apps from
starting new processes during the run, or the sum picks them up.

Stop with `pkill -f "tauri dev"; pkill -f photobook-editor` (never `pkill -f vite.js`). Then restore `recent.json` and
`folders.json`, delete the project the legacy import made (`<appdata>/projects/<id>/`, the id is in the
`[photobook:projects] imported legacy book` line), and delete only the cache entries the run created for the scratch
photos: hashes that are in the scratch folder and were not in the listing taken before the run. A photo identical to one
you already had (`make-sample-trip.py` is deterministic, so its first files match `fixtures/sample-trip`) keeps its
entry; remove only the `develop-*`, `proxy-*`, `thumb-*` and `looks/` files the run added to it.

```sh
ls "$APP/cache" | sort > "$SCRATCH/cache-after.txt"
find "$SCRATCH/trip300" -type f ! -path '*/.photobook*' ! -name '*.json*' -exec shasum -a 256 {} + | cut -d' ' -f1 \
  | sort > "$SCRATCH/hashes.txt"
comm -13 "$SCRATCH/cache-before.txt" "$SCRATCH/cache-after.txt" | comm -12 - "$SCRATCH/hashes.txt" \
  | while read -r h; do rm -rf "$APP/cache/$h"; done
```

## 3. Slider → paint

`[photobook:develop] slider→paint <ms>ms {path, job, request, decode}` is logged for every painted live preview
(`apps/editor/src/components/develop/previewTiming.ts`). The clock starts at the settings change the render carries
(the bench marks its store write with `markInput`; a real drag starts it when `usePreview` sees the new settings) and
stops in the animation frame after the picture is on the page: the `<img>`'s `load` on the JPEG path, the WebGL draw on
the raw path. That frame composites the picture, so the screen shows it at most one refresh later (8 ms at 120 Hz).
The 16 ms request coalescing in `usePreview` is inside the number. `request` is invoke → bytes in the webview (render,
encode, transfer), `decode` is `HTMLImageElement.decode()` (JPEG) or texture upload and draw (raw). The Rust side logs
`[photobook:develop] preview job=… decode=…ms render=…ms encode=…ms` (and `raw preview job=… render=… pack=…`).

Without the bench, a real drag in the dev window logs the same lines. The GPU render alone on the proxy is the ignored
`timing_effects_proxy` test (`cargo test -p photobook-develop --release --test gpu -- --ignored --nocapture
timing_effects`), recorded in plan 19's status line.

## 4. The raw RGBA experiment

`localStorage.setItem('photobook.rawPreview', '1')` in the dev window (or the bench's override) switches the Develop
live preview to the `pbraw` custom scheme (`apps/editor/src-tauri/src/commands/raw_preview.rs`, registered in debug
builds only): a POST with the render request returns the developed proxy as raw RGBA8 (16-byte header, no JPEG
encode), which `RawPreviewCanvas` uploads into a WebGL2 texture and draws. Release builds neither register the scheme
nor read the flag (the canvas and the fetch are dynamic imports behind `import.meta.env.DEV`, so the release bundle
leaves them out), responses allow only the dev server's origin (`http://localhost:1420`), and the CSP is unchanged
(the dev page is not under it).

## 5. Full render of a 24 MP RAW

```sh
source ~/.cargo/env
cargo test -p photobook-develop --release --test raw --no-run
cd crates/develop
/usr/bin/time -l ../../target/release/deps/raw-<hash> --ignored --nocapture --exact budget_full_render_24mp
```

The test (`crates/develop/tests/raw.rs`) decodes the RAW at full size, develops it with `render_full_with_options`
(the display look on, GPU when available) and encodes JPEG q95, the same steps as the editor's `render_full_file`, and
prints `[budget] … decode … render … encode`. `/usr/bin/time -l` prints `maximum resident set size` and
`peak memory footprint` for the whole process (the test binary alone is about 2 MB). It takes the first 22–26 MP RAW
in `PHOTOBOOK_RAW_DIR` or `~/Pictures/ON1 Samples`; `PHOTOBOOK_BUDGET_RAW=<file>` picks one,
`PHOTOBOOK_BUDGET_SETTINGS=everything.json` renders a fixture's settings (every section, masks, a crop), and
`PHOTOBOOK_FORCE_CPU=1` takes the CPU path. Run it three times and keep the median.
