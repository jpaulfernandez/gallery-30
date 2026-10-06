# Photobook

Turn a folder of photos into a designed, zine-style photobook that friends read on their phones.

You design on your computer, against the original files, with page layouts or free-drawn photo boxes and
text. When the book is ready, one command optimizes the images and publishes it to your own cloud storage,
and the book appears at its own link. Friends open the link, type a shared password once, swipe through
the pages, and save full-quality copies of the photos they like.

Everything is self-hosted: no Photobook account and no central server. You run the editor locally, and
published books live in your own Cloudflare bucket on free tiers.

![Design locally, publish to R2, read on a phone](docs/design/architecture.png)

## Features

**Editor (desktop app)**

- Opens any photo folder in place. Nothing is copied or uploaded until you publish, so it stays fast with
  hundreds of large camera JPEGs.
- Book sizes: phone portrait 4:5 (fits a phone screen and Instagram), story 9:16, square, A4 portrait and
  landscape.
- A library of layouts for one to six photos per page, plus custom pages with snapping photo boxes.
- Drag photos from the filmstrip into slots; pan, zoom and rotate inside each slot.
- Text boxes with a curated set of fonts and preset styles (title, caption, date stamp, body).
- Page reordering, duplicate, undo and redo, autosave, and a phone preview frame.
- Moved photos are relinked automatically by size and content hash.
- A **Downloads** tab that shows who saved which photos and pages.

**Publishing**

- One command or one button: generates AVIF, WebP and JPEG sizes, a full-quality download copy of each
  photo, and Instagram-ready page images, then uploads them to Cloudflare R2.
- Republishing uploads only what changed.
- Listed books appear on the site's home page; unlisted books are reachable by link only.
- One soft site password, typed once per device.

**Viewer (mobile web)**

- One page per screen, swipe to turn, thumbnail grid to jump, works in iOS Safari without an install.
- A drawer with the photos on the current page: view, download in full quality, like.
- Collect favorites across pages and download them as one zip.
- Share a page as a 4:5 feed or 9:16 story image.

## Quick start

You need Node 22+, pnpm 11, Rust and CMake. Full instructions: [docs/INSTALLATION.md](docs/INSTALLATION.md).

```bash
git clone https://github.com/jpaulfernandez/gallery-30.git
```

```bash
cd gallery-30 && pnpm install
```

```bash
pnpm dev
```

The first run compiles the native side and takes a few minutes. Then click **Open folder…** and choose a
folder of photos.

## Sharing books on the web

Designing books needs no accounts. To publish them, you set up once:

1. A **Cloudflare** account with an R2 bucket for images (free tier).
2. The **viewer** on Vercel (free Hobby plan) or any static host.
3. Optionally, a small Cloudflare **Worker** for likes and the download log.

What each account is for and what it costs: [docs/ACCOUNTS.md](docs/ACCOUNTS.md).
Step-by-step setup: [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Documentation

| Document | What's in it |
| --- | --- |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Prerequisites, running the editor, building the app |
| [docs/ACCOUNTS.md](docs/ACCOUNTS.md) | Which accounts you need, what they cost, where secrets live |
| [docs/PUBLISHING.md](docs/PUBLISHING.md) | R2, viewer, settings, publishing, likes and downloads |
| [worker/README.md](worker/README.md) | The likes and download-log API |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development workflow and code conventions |
| [docs/design/](docs/design/) | The original product requirements, implementation plan and UI notes |

## Repository layout

| Path | What |
| --- | --- |
| `apps/editor` | The desktop editor: Tauri 2, React 19, Vite, Tailwind, TanStack Router, Zustand |
| `apps/viewer` | The web reader: Vite and Preact, about 60 KB gzipped |
| `packages/shared` | Book schema (Zod), migrations, layouts, page renderer and fonts, shared by all apps |
| `packages/publish` | The `photobook` CLI: image processing (sharp), page rendering (Playwright), upload to R2 |
| `worker` | Cloudflare Worker and D1 database for likes and the download log |
| `scripts` | Developer utilities, such as a sample photo generator |

## Status

Photobook started as a personal tool and is shared as is. It works end to end on macOS. Known gaps:

- No prebuilt downloads; you build the editor from source.
- Linux and Windows builds are untested.
- A standalone app build does not bundle the publish CLI yet; publish from `pnpm dev` or see
  [INSTALLATION.md](docs/INSTALLATION.md#4-build-a-standalone-app-optional).
- The custom book size is not available in the editor yet.
- The site password is a soft gate, not real security.

Issues and pull requests are welcome.

## License

[MIT](LICENSE). The bundled fonts (Inter, Fraunces, Instrument Serif, JetBrains Mono) are licensed under
the SIL Open Font License 1.1; see `packages/shared/fonts/licenses/`.
