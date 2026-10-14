# Installation

Photobook runs from source. You build the editor (the **oddhalls** app) once on your machine; there are no prebuilt
downloads yet.
Designing books needs no accounts. Publishing them is a separate, optional setup ([PUBLISHING.md](PUBLISHING.md)).

**Platforms.** The editor is built and tested on macOS (Apple Silicon). It is a Tauri app, so Linux and
Windows should work, but nobody has tested them yet. Reports and fixes are welcome.

## 1. Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| [Node.js](https://nodejs.org) | 22 or newer | Editor UI, viewer, publish CLI |
| [pnpm](https://pnpm.io) | 11 (the repo pins 11.20.0) | Workspace package manager |
| [Rust](https://rustup.rs) | 1.89 or newer (latest stable is fine) | The editor's native side (Tauri) and the develop crate |
| [CMake](https://cmake.org) | any recent | Builds libjpeg-turbo for fast thumbnails and Develop renders |
| NASM | any recent, **x86_64 only** | libjpeg-turbo's SIMD code on Intel/AMD CPUs (not needed on Apple Silicon) |
| Git | any | To clone the repo |

### macOS

```bash
xcode-select --install
```

```bash
brew install node cmake
```

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

On an Intel Mac, also run `brew install nasm`.

### Linux (untested)

Install Node 22+, then Tauri's system libraries, CMake and NASM. On Debian or Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev cmake nasm
```

Then install Rust with rustup as above. Other distributions: see
[Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

### Windows (untested)

Install the Microsoft C++ Build Tools and WebView2 as described in
[Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/), then Node 22+, Rust (rustup), CMake
and NASM, each added to `PATH`.

### pnpm

Corepack, which ships with Node 22 and 24, installs the pinned pnpm version for you:

```bash
corepack enable
```

If your Node has no corepack, use `npm install -g pnpm@11` instead.

## 2. Get the code and install

```bash
git clone https://github.com/jpaulfernandez/gallery-30.git
```

```bash
cd gallery-30 && pnpm install
```

## 3. Run the editor

```bash
pnpm dev
```

This starts the editor's UI on port 1420 and opens the editor window (titled **oddhalls**, the editor's name). The first run compiles the Rust
side and takes several minutes (it also downloads ONNX Runtime once, see [AI models](#ai-models)); later runs start
in seconds.

Click **Import folder…**, pick a folder of photos, then **New project…**: give the book a title, choose the folder
and a page size, and start building pages. Photos stay where they are: the editor references them in place, and
ratings and edits go into the folder's `.photobook/library.json`, shared by every project on that folder.

Each project is one file, `project.photobook.json`, in the app's data folder under `projects/<id>/` (with the
previous version kept as `project.photobook.json.bak`). The home screen lists the projects, last opened first, with
**Rename**, **Reveal** (show the file in the Finder) and **Delete**, which moves the project to the Trash (photos,
edits and the published book are not touched). **Save as…** in the editor's top bar moves a project's file anywhere
you like, and **Open project file…** on the home screen opens one from anywhere; both are remembered in
`projects.json` in the app's data folder. The editor reopens the last project on launch (`recent.json`).

Every imported folder is remembered in the *Folders* list on the home screen (`folders.json` in the app's data folder)
and stays readable without the folder picker; clicking one opens its most recent project, or starts one. The editor
only reads and writes inside these folders and its data folder, so a project whose folder you removed from the list
opens again once the folder is imported again. **Remove** takes a folder off the list; its `.photobook/` and
`.photobook-cache/` files stay on disk, and importing it again picks them up. Thumbnails and previews are cached in
the app's data folder.

**Books from an older Photobook.** A `book.photobook.json` inside a folder (where projects lived before) becomes a
project the first time the folder is imported or, for folders already in the list, at startup. Its ratings and edits
move into the folder's library when it is first opened, and the old file stays next to the photos, renamed
`book.photobook.json.imported`, so it is never imported twice. Delete it once you are happy with the project.

**Moved photos.** A photo whose file is gone from its place is looked for by size and content hash, first in its own
folder and then in every imported folder; the project then points at the file where it was found and keeps its edits
and its place on the pages. One that is found nowhere shows as *Missing* in the filmstrip with **Locate**.

### Supported photos

JPEG, PNG and HEIC (HEIC needs macOS: thumbnails go through `sips`, Develop decodes the full photo through ImageIO at its own bit depth, and exporting to HEIC also goes through ImageIO, so the Export dialog offers HEIC on macOS only), and camera RAW files: `.dng .cr2 .cr3 .crw .arw .srf .sr2 .nef .nrw .raf .orf .rw2 .rwl
.pef .srw .erf .3fr .fff .iiq .mos .mef .mrw .kdc .dcr .x3f` through the bundled [`rawler`](https://github.com/dnglab/dnglab) decoder (about 870
camera models, Fujifilm X-Trans included; tested on Canon, Nikon and Sony files). The filmstrip shows a RAW from the
camera's embedded JPEG at once, then switches to Photobook's own rendering of it, which is what the canvas, the
Develop view and the published book use; RAW photos always publish as JPEG renders. Not supported: 4-colour and
monochrome sensors, lens corrections and camera profiles; a file `rawler` cannot read shows an error in the
filmstrip. How to edit them is in [DEVELOP.md](DEVELOP.md). RAW decoding reads the whole sensor (about 0.2 to 1.3 s per photo), so the first open of a large RAW folder
keeps rendering in the background for a while; the renders are cached.

### AI models

AI masks and denoise run locally through ONNX Runtime (CoreML on Apple silicon). No model ships with the app:
**Settings → Models** lists each one with its task, download size and licence, and downloads it on demand into
the app's data folder (`~/Library/Application Support/com.photobook.editor/models/` on macOS), resuming an
interrupted download and checking it against a pinned SHA-256. Delete removes the model and its compiled CoreML
cache. Every listed model has a permissive licence (MIT or Apache-2.0); the pinned list is
`crates/develop/models.toml`.

The first Rust build downloads a prebuilt, statically linked ONNX Runtime through the `ort` crate's build script
(about 9 MB compressed, 77 MB unpacked in `~/Library/Caches/ort.pyke.io`), so it needs network access once. To build offline, point `ORT_LIB_LOCATION` at a local
ONNX Runtime build. (The develop crate alone also builds without AI, RAW and HEIC support with
`cargo build -p photobook-develop --no-default-features`; the editor itself always includes them.) Using the models:
[DEVELOP.md](DEVELOP.md#ai-models).

### FFmpeg for slideshows

Slideshow videos are encoded with FFmpeg, which is not bundled either. **Settings → Tools** downloads a static FFmpeg
6.0 build on demand into `~/Library/Application Support/com.photobook.editor/tools/` (about 10 MB), checks the download
and the program in it against pinned SHA-256s (`apps/editor/src-tauri/tools.toml`), and **Check** runs it once to
confirm it has the `h264_videotoolbox` encoder. The build is Auto-Editor's `ae-ffmpeg` 1.2.0 from PyPI, licensed
LGPL v3: it has no GPL parts (no x264 or x265) and encodes H.264 with Apple's VideoToolbox, so it is Apple silicon
and Intel Macs only. FFmpeg's source is at <https://ffmpeg.org/releases/ffmpeg-6.0.tar.xz>.

An FFmpeg you installed yourself works too (`brew install ffmpeg`, found on `PATH`, `/opt/homebrew/bin` or
`/usr/local/bin`); the downloaded one is used first when both exist. On Linux there is no download: install FFmpeg
with libx264 yourself (it is found on `PATH` and encodes with `libx264`). Slideshow export does not work on Windows
yet (the program lookup does not handle `;`-separated paths or `ffmpeg.exe`).

### No photos handy?

`scripts/make-sample-trip.py` generates a folder of fake trip photos in mixed sizes and orientations. It
needs Python 3 with Pillow:

```bash
pip3 install pillow
```

```bash
python3 scripts/make-sample-trip.py
```

The photos land in `fixtures/sample-trip/` (git-ignored). Open that folder in the editor.

## 4. Build a standalone app (optional)

```bash
pnpm --filter editor tauri build
```

On macOS this produces `oddhalls.app` and a `.dmg` under `target/release/bundle/` (the Cargo workspace target at the repo root).
The app is not code-signed, so the first time you open it, right-click it and choose **Open**.

**Limitation:** a standalone build does not include the publish CLI yet, so its **Publish** button only
works when the `PHOTOBOOK_CLI` environment variable points at a `photobook` executable. Until the CLI is
bundled, publish from `pnpm dev`, or use a small wrapper script:

```sh
#!/bin/sh
# Save as ~/bin/photobook-cli and chmod +x it. Adjust the path to your clone.
cd "$HOME/gallery-30/packages/publish" && exec ./node_modules/.bin/tsx --conditions=source bin/photobook.ts "$@"
```

and start the app from a terminal so it inherits the variable:

```bash
PHOTOBOOK_CLI="$HOME/bin/photobook-cli" /Applications/oddhalls.app/Contents/MacOS/oddhalls
```

(Check the executable's name under `Contents/MacOS/` if it differs.)

## 5. Check your setup (optional)

```bash
pnpm typecheck && pnpm test && pnpm lint
```

## Troubleshooting

- **`cargo: command not found` during `pnpm dev`**: open a new terminal after installing Rust, or run
  `source ~/.cargo/env`.
- **`turbojpeg-sys` fails to build**: CMake is missing, or on x86_64, NASM is missing.
- **pnpm refuses to run build scripts**: the allowed packages (esbuild, workerd, sharp) are listed in
  `pnpm-workspace.yaml`. Make sure you run pnpm 11 from the repository root.
- **`sharp` fails to install**: it downloads a prebuilt binary for your platform. Check your network, then
  run `pnpm install` again.
- **Photos show as Missing after moving the folder**: the editor relinks moved files by size and content
  hash when you reopen the book. For files it cannot find, use **Locate** in the filmstrip.
