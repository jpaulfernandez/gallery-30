# Installation

Photobook runs from source. You build the editor once on your machine; there are no prebuilt downloads yet.
Designing books needs no accounts. Publishing them is a separate, optional setup ([PUBLISHING.md](PUBLISHING.md)).

**Platforms.** The editor is built and tested on macOS (Apple Silicon). It is a Tauri app, so Linux and
Windows should work, but nobody has tested them yet. Reports and fixes are welcome.

## 1. Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| [Node.js](https://nodejs.org) | 22 or newer | Editor UI, viewer, publish CLI |
| [pnpm](https://pnpm.io) | 11 (the repo pins 11.20.0) | Workspace package manager |
| [Rust](https://rustup.rs) | latest stable | The editor's native side (Tauri) |
| [CMake](https://cmake.org) | any recent | Builds libjpeg-turbo for fast thumbnails |
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

This starts the editor's UI on port 1420 and opens the Photobook window. The first run compiles the Rust
side and takes several minutes; later runs start in seconds.

Click **Open folder…**, pick a folder of photos, and start building pages. Photos stay where they are: the
editor references them in place and writes one project file, `book.photobook.json`, into that folder
(with the previous version kept as `book.photobook.json.bak`). Thumbnails and previews are cached in the
app's data folder.

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

On macOS this produces `Photobook.app` and a `.dmg` under `apps/editor/src-tauri/target/release/bundle/`.
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
PHOTOBOOK_CLI="$HOME/bin/photobook-cli" /Applications/Photobook.app/Contents/MacOS/Photobook
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
