# Publishing setup

One-time setup for putting books on the web. You only need this when you want to share a book; designing
books locally needs none of it. See [ACCOUNTS.md](ACCOUNTS.md) for which accounts are involved and what they
cost (nothing, for a few books).

Three pieces, set up once:

1. **Cloudflare R2** holds every image, page image, manifest and the site file (`site.json`).
2. **The viewer** (`apps/viewer`), a static web app on Vercel (or any static host), serves every book by
   path (`https://<viewer>/<slug>`). Publishing a book never redeploys the viewer.
3. **Optional: a Cloudflare Worker with D1** records likes and downloads, so you can see who saved what.

All commands below run from the repository root unless a `cd` says otherwise. They assume
[INSTALLATION.md](INSTALLATION.md) is done (`pnpm install` has run).

## 1. Log in to Cloudflare

```bash
pnpm --filter @photobook/worker exec wrangler login
```

This uses the `wrangler` CLI that ships as a dev dependency of `worker/`. If you want the slower
`wrangler` upload transport (section 3), also install it globally so the publish CLI can find it:
`npm install -g wrangler`.

## 2. Create the R2 bucket

Enable R2 once in the Cloudflare dashboard (**R2 Object Storage**, **Get started**; it asks for a payment
method even on the free tier). Then:

```bash
pnpm --filter @photobook/worker exec wrangler r2 bucket create photobook
pnpm --filter @photobook/worker exec wrangler r2 bucket cors set photobook --file "$PWD/docs/r2-cors.json" --force
```

[`docs/r2-cors.json`](r2-cors.json) allows `GET` and `HEAD` from any origin, which the viewer needs.

Give the bucket a public URL, one of:

- **Custom domain (recommended).** If you have a domain on Cloudflare, connect a subdomain to the bucket
  (dashboard: the bucket, **Settings**, **Custom Domains**, or
  `wrangler r2 bucket domain add photobook --domain cdn.example.com --zone-id <zone-id>`).
- **r2.dev URL.** `wrangler r2 bucket dev-url enable photobook`. Good for trying things out: it is rate
  limited, and some networks cannot reach `*.r2.dev` at all.

Images and manifests are public, but their keys carry a random per-book prefix, so they cannot be guessed
or listed.

## 3. R2 API token

The publish CLI uploads through R2's S3-compatible API with a token that wrangler cannot create:

1. Cloudflare dashboard, **R2**, **Manage R2 API Tokens** (or **API Tokens** under R2), **Create API token**.
2. Permissions: **Object Read & Write**, scoped to the `photobook` bucket.
3. Copy the **Access Key ID** and **Secret Access Key** (the secret is shown once). Your **Account ID** is
   on the R2 overview page.

Without a token you can choose the **wrangler** transport in the editor's Settings: it runs one
`wrangler r2 object put` per object through your wrangler login. It is much slower and cannot prune or
unpublish, so use it only to get started.

## 4. Deploy the viewer

The viewer needs one build-time setting, the bucket's public URL:

```bash
cp apps/viewer/.env.example apps/viewer/.env.production.local
# then edit VITE_R2_PUBLIC_URL in that file (no trailing slash)
```

### On Vercel

Install the Vercel CLI once (`npm install -g vercel`), then:

```bash
cd apps/viewer
vercel link        # first time only: creates a project (any name) under your account
cd ../..
pnpm --filter viewer run deploy
```

The build runs locally and the output is uploaded prebuilt, so Vercel never installs the monorepo.
`pnpm --filter viewer run deploy:preview` gives a preview URL instead of production. Note the
production URL Vercel prints; it is your **Viewer URL**.

### On another static host

`pnpm --filter viewer build` writes a static site to `apps/viewer/dist/`. Any host works as long as every
unknown path serves `index.html` (single-page app fallback), for example Cloudflare Pages or Netlify.
`/assets/*` files are content-hashed and can be cached forever.

Redeploy the viewer only when the viewer code changes. New and updated books appear without a deploy.

## 5. Settings in the editor

Open **Settings** in the editor's top bar and fill in:

| Key | Meaning |
| --- | --- |
| `R2_BUCKET`, `R2_PUBLIC_URL` | The bucket (`photobook`) and its public base URL |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | S3 credentials from section 3 (transport `s3`) |
| `R2_TRANSPORT` | `s3` (default) or `wrangler` |
| `VIEWER_URL` | Where the viewer is deployed, for the links the editor shows |
| `DOWNLOAD_MAX_EDGE`, `DOWNLOAD_QUALITY` | The full-quality download version (default 4096 px, JPEG quality 88) |
| `PUBLISH_CONCURRENCY` | Image workers (default: CPU cores minus one) |
| `SOCIAL_API_URL` | The likes and download-log Worker (section 8); written into `site.json` as `api` |
| `SOCIAL_ADMIN_TOKEN` | The Worker's `ADMIN_TOKEN`; lets the editor's Downloads tab read the log |

**Test connection** runs `photobook doctor`. Passwords are set per book (section 7), not here. If an
earlier version set a site-wide `SITE_PASSWORD`, it still guards the book list and any book not republished
since; **Remove site-wide password** (`photobook password clear`) drops it from `site.json`.

The values are saved to a `publish.env` file in the editor's app data folder, with owner-only
permissions, and never go into the project file:

| OS | Settings file |
| --- | --- |
| macOS | `~/Library/Application Support/com.photobook.editor/publish.env` |
| Linux | `~/.local/share/com.photobook.editor/publish.env` |
| Windows | `%APPDATA%\com.photobook.editor\publish.env` |

The CLI reads the same file. You can also set the keys in the environment, or point at another file with
`--env <file>` or `PHOTOBOOK_ENV`.

A book's soft password is checked in the browser. It keeps casual visitors out and nothing more: anyone with the
link and the word gets in, and image URLs are reachable directly. Do not publish anything that needs real
access control.

## 6. Page images for sharing (optional)

Publish renders every page with a headless Chromium to `feed.png` (1080 x 1350), `story.png` (1080 x 1920)
and a small thumbnail, for the viewer's **Share page** and jump grid. Install the browser once:

```bash
pnpm --filter @photobook/publish exec playwright install chromium
```

Without it the `pages` step warns and the publish continues without page images (`--skip-pages` does the
same on purpose).

## 7. Publish

In the editor, set the book's slug and visibility (listed books appear on the viewer's home page; unlisted
ones are reachable by link only) and press **Publish**. To protect a book, turn on **Password** in the same
Publish section and set a word: viewers type it once per device, a new word asks every device again, and
**Ask again after** optionally sets a date when devices are asked anew. Only a salted hash is kept, in the
project file and the published manifest; the word itself is stored nowhere. Password changes apply on the
next publish. With the switch off, anyone with the link opens the book. Or from a terminal:

```bash
pnpm --filter @photobook/publish photobook publish /path/to/project.photobook.json --dry-run
pnpm --filter @photobook/publish photobook publish /path/to/project.photobook.json
pnpm --filter @photobook/publish photobook publish /path/to/project.photobook.json --prune
pnpm --filter @photobook/publish photobook unpublish /path/to/project.photobook.json
pnpm --filter @photobook/publish photobook password clear
pnpm --filter @photobook/publish photobook doctor
```

**Where the project file is.** A project lives in the editor's app data folder, in
`~/Library/Application Support/com.photobook.editor/projects/<id>/project.photobook.json` on macOS
(`%APPDATA%\com.photobook.editor\projects\…` on Windows, `~/.local/share/com.photobook.editor/projects/…` on Linux);
**Reveal** on the home screen shows it in the Finder. After **Save as…** it is wherever you saved it. The command takes that path, the same way it took
`book.photobook.json` before; an older `book.photobook.json` still publishes as is.

Outputs are cached in `.photobook-publish/` next to the project file (inside the project's folder in app data), so a
rerun processes and uploads only what changed. `--prune` deletes images the book no longer uses.

**Folders and edits in the project file.** The project file lists the photo folders it draws from under `folders`
(the folder the project was started on, plus any imported folder a moved photo was found in), and each photo names its
folder and its path inside it. The CLI finds a photo at that folder
joined with the photo's path: an absolute folder path is used as is (or, when it does not exist on this machine, the
folder the project file is in, so a moved or copied folder still publishes), and a relative one is relative to the
project file. Ratings, flags and develop settings are not in the project file but in each folder's
`.photobook/library.json` (see [Where edits are stored](DEVELOP.md#where-edits-are-stored)); the CLI reads it once per
folder and publishes every photo with its edit from there. A photo frozen with *Snapshot edits* uses the settings in
the project file instead. Books saved by an older Photobook (version 7 or earlier) still publish: their edits are in
the project file, and the editor moves them into the library the next time it opens the book. A `library.json` that does not
parse falls back to `library.json.bak` (with a warning), the same rule the editor uses; one written by a newer
Photobook, or one with no usable backup, stops the run before anything is uploaded, because its edits would be lost.
`--ignore-library` publishes anyway, without that folder's ratings and edits. A folder with no `library.json` at all
publishes its photos unedited, and the run warns when the book has photos there.

The book is then at `https://<viewer>/<slug>`. Share the link, and the password if the book has one.

**Developed photos.** A photo edited in the [Develop module](DEVELOP.md) publishes with the edit baked in. The
editor does this in two steps before it starts the CLI. **Denoising** runs the AI denoise on every used photo whose
denoise is on but not applied yet (it needs that model installed under **Settings → Models**, and stops with a message
naming it when it is not). **Render edited photos** then renders each edited photo at full resolution to
`<photo folder>/.photobook-cache/develop/<hash>-<developHash>.jpg` (`...-<developHash>-p3.jpg` for a Display P3 book,
see Colour), and the CLI publishes that file in place of the original (the original is never touched). Camera RAW
photos always publish through such a render. Re-editing a photo gives it a new render and new image URLs, and `--prune`
removes the old ones. If you run the CLI yourself and a render is missing, a real publish stops before uploading
anything with `N developed photo(s) have no rendered file yet: ... Open the book in the editor and let it render the
edited photos before publishing.`; `--dry-run` only warns and lists each developed photo as `render present (current)`
or `render missing`. The cache lives inside the photo folder, so on a synced drive (iCloud, Dropbox) the renders
sync along with the photos; they are safe to delete, the editor recreates them.

**Colour.** Published images are colour-managed: a photo with a wide-gamut profile (Display P3 from an
iPhone, Adobe RGB, ...) is published in Display P3 with its profile embedded in every size (AVIF, WebP and JPEG),
so P3 screens show its full colour and browsers on sRGB screens convert it; sRGB and untagged photos are
published as plain sRGB, as before. The download copy keeps the original profile. Edited photos are rendered
in the book's **Output colour** (Book settings in the inspector): sRGB, the web standard, or Display P3 for
Apple displays. The render is tagged with that profile, and the CLI publishes the matching file, so switching the
setting renders every edited photo (and camera RAW) once more, publishes new image URLs, and `--prune` removes the
old ones; a render made in the other space is never published for the book. The Develop view's **Proof** button (`S`)
only previews an edit in either space before you choose; the renders the editor keeps always use the book's setting.
HEIC photos are decoded by macOS (ImageIO) with their own colour (Display P3 on an iPhone) and bit depth, and an
edited HEIC keeps its Exif. The viewer needs nothing: browsers read the embedded profile.

**Alt text.** A photo's alt text (written by the AI captions or typed in the photo inspector's **Alt text** field,
see [ACCOUNTS.md](ACCOUNTS.md#anthropic-optional-for-ai-captions)) is published with the book: each entry of the
manifest's `images` map carries it as `alt`, and the viewer sets it as the `alt` attribute of the photo's `<img>` on
the page and in the lightbox, so screen readers can describe the book. A photo without alt text has no `alt` field
and renders with `alt=""`, as before; manifests published before alt text existed keep working. Changing alt text
counts as an unpublished change (the editor's publish badge shows it) and a republish uploads only the new manifest:
page images do not depend on it, so none is rendered again.

**Smoke check (optional).** Publishes a six-photo fixture to the slug `smoke-fixture-six`, checks it over
the public URL, republishes and unpublishes it. Needs the S3 transport:

```bash
pnpm --filter @photobook/publish smoke
```

## 8. Likes and the download log (optional)

A small Cloudflare Worker (`worker/`) with a D1 database records likes and logs downloads, zips and page
shares. The editor's **Downloads** tab reads it so you can see who saved what. Without it the viewer hides
likes and logs nothing; downloads still work.

```bash
cd worker
cp wrangler.toml wrangler.local.toml                      # git-ignored; your deployment's config
pnpm exec wrangler d1 create photobook-social             # put the printed database_id in wrangler.local.toml
pnpm run db:migrate                                       # applies migrations/ to the remote database
pnpm run deploy                                           # prints the Worker URL
openssl rand -hex 32 | tr -d '\n' | tee ~/.photobook-admin-token | pnpm exec wrangler secret put ADMIN_TOKEN --config wrangler.local.toml
```

The last line generates a random admin token, saves a copy to `~/.photobook-admin-token` and sets it as the
Worker's `ADMIN_TOKEN` secret.

To serve the Worker on your own domain instead of `*.workers.dev`, uncomment `routes` in
`wrangler.local.toml` and redeploy.

Then in the editor's Settings set **Worker URL** (`SOCIAL_API_URL`) and **Admin token**
(`SOCIAL_ADMIN_TOKEN`, the contents of `~/.photobook-admin-token`), and publish once (or run
`photobook password sync`) so `site.json` carries the Worker URL. Routes and the API are described in [worker/README.md](../worker/README.md).

## Social posts

A project can hold social posts next to its book (the document drop-down beside the stage tabs, **New… → Social
post**). A post is made for one network, which fixes its page size, how many frames it holds, the safe area drawn on
the canvas and the caption limit. The templates live in `packages/shared/src/social/templates.ts`; the numbers were
checked on 13 October 2026 and each template carries that date.

| Network | Size (px) | Ratio | Frames | Caption | Safe area |
| --- | --- | --- | --- | --- | --- |
| Instagram carousel | 1080 x 1350 | 4:5 | 20 | 2,200 | 3:4 profile grid crop (first frame) |
| Instagram square | 1080 x 1080 | 1:1 | 20 | 2,200 | 3:4 profile grid crop (first frame) |
| Instagram / Facebook story | 1080 x 1920 | 9:16 | 20 | 2,200 | profile bar and reply field |
| TikTok photo slideshow | 1080 x 1920 | 9:16 | 35 | 4,000 | tabs, action column, caption |
| Threads | 1080 x 1350 | 4:5 | 20 | 500 | none |
| Bluesky | 1080 x 1350 | 4:5 | 4 | 300 | none |
| X | 1080 x 1080 | 1:1 | 4 | 280 | none |
| Pinterest pin | 1000 x 1500 | 2:3 | 5 | 500 | bottom buttons |

Frames are pages: the same layouts, frames, text and inspector as the book. **Send to post…** (the page strip's menu,
or **Send page to post…** in the inspector) copies a book page, or another post's frame, to the end of a post or into a
new one: the photos and elements keep their ids, a layout page is re-fitted to the post's size and every crop is kept
inside its slot. One undo step removes it again. A post stops at its network's frame limit and says so.

With nothing selected on a post, the inspector shows the network, **Add frame** and the **Caption**, counted against
the network's limit. The count is in characters as a person sees them (grapheme clusters, so an emoji with a skin tone
is one), which is close to every network's rule but not exact: X, for one, counts a link as 23 characters and a CJK
character as 2, so leave some room there.

**Export…** in the top bar (in place of Publish) writes the post to a folder:

```text
<destination>/<post name as a slug>/01.jpg … NN.jpg
<destination>/<post name as a slug>/caption.txt
```

Two posts whose names give the same slug ("Trip A", "Trip-A") get their own folders (`trip-a`, `trip-a-2`). Exporting a
post again replaces its files and removes frames the earlier export wrote that this one does not (a post that lost
frames, or switched between JPEG and PNG); other files in the folder are left alone.

The destination defaults to `Exports/Posts` in the project's first folder; **Choose…** picks any folder (one outside
your imported folders must be picked again after a restart, as for photo exports). JPEG (quality 92, sRGB, 4:4:4) is
the default; PNG is lossless. Where a network has a small file limit (Bluesky about 1 MB, X 5 MB) a JPEG frame over it
is saved at a lower quality, down to 60, and the jobs list warns when even that is too large. **Open folder when done** shows the folder in the Finder. Nothing is posted: the files
are ready for the phone (AirDrop) or a scheduler, and no network account or API is involved.

The frames are rendered exactly as the book's page images are: the publish CLI's headless Chromium draws the shared
renderer at the network's pixel size with the developed renders of edited photos, so it needs Chromium installed
(section 6). A photo that would be enlarged from the 2048 px web copy (a landscape photo filling a story frame needs
2880 px) is drawn from the larger download copy instead. Each export is one job in the jobs list: edited photos are
rendered and denoised first, as for a publish (jobs of their own), then one CLI process writes the caption and every
frame, counting frames as it goes. Cancel stops it at once; frames already written stay. The same render runs from
the command line:

```bash
pnpm --filter @photobook/publish photobook render-frames <project.photobook.json> --output <post id> --out <dir> \
  [--frames 1,3] [--format jpeg|png] [--quality 92] [--caption] [--clean]
```

## Print

A project can also hold prints (**New… → Print** in the document drop-down). A print holds settings only: it prints
the book's pages, or a post's frames when **Prints** names that post, so editing a page changes the book and every
print of it. **Export PDF…** in the top bar writes a print-ready PDF.

With nothing selected on a print, the inspector shows its settings:

| Setting | Choices | Default |
| --- | --- | --- |
| Prints | The book, or one of the project's posts | The book |
| Paper | A5 (148 x 210 mm), A4 (210 x 297 mm), US Letter (8.5 x 11 in), 8 x 10 in, 8 x 8 in square | The paper whose shape is the pages' (4:5 books: 8 x 10 in; square: 8 x 8 in; A4 books: A4), else A5 |
| Orientation | Portrait or landscape | The pages' orientation |
| Layout | Single pages, or spreads | Single pages |
| Bleed | 0 to 10 mm on every outside edge | 3 mm |
| Photos | 150, 200, 300 or 600 dpi | 300 dpi |
| Crop marks | On or off | On (with the default bleed the sheet is larger than the page, and the marks show where to cut) |

**Zine** (under *Presets*) sets A5 spreads, 3 mm bleed and crop marks in one click, in the pages' orientation (a
landscape book makes a landscape zine). When the post a print printed is deleted, the panel says "Post deleted;
printing the book" and the print falls back to the book.

What the PDF holds:

- **Pages.** One page per PDF page, or with *Spreads* two facing pages side by side, as a book opens: the first page
  alone on the right half, then 2 and 3, 4 and 5, and an even last page alone on the left half. The other half of a
  lone page's sheet stays blank.
- **Size.** Each PDF page is the trim (the paper, or two papers side by side for spreads) plus the bleed on every side;
  an A5 page with 3 mm bleed is 154 x 216 mm. With crop marks on, a 7 mm margin is added around the bleed for them.
  Chromium rounds the page size to a fraction of a point (well under 0.1 mm). The PDF has no TrimBox or BleedBox
  entries: give the print shop the trim size, or use the crop marks.
- **Bleed.** The bleed is a copy of the page stretched over the bleed box and drawn under the page, so whatever touches
  the edge of a page (a full-bleed photo, a page colour) continues past the cut and a slightly off cut shows no white
  sliver. It is a stretched copy of the page's edge, not more of the photo: the strip of the photo just inside the trim
  repeats, slightly enlarged, in the bleed. Inside the trim the page is exactly what the web book shows. The spine side
  of a spread page does not bleed.
- **Pages of another shape.** A page whose shape is not the paper's (a 4:5 book on A5) is printed centred on its
  trim, with bands of its own background colour; the inspector says so and names the paper that fits.
- **Marks.** Crop marks at the four corners of the trim, outside the bleed, and on spreads a fold mark above and below
  the spine. Hairlines, plain black.
- **Photos.** From the full-size sources: the developed render of an edited photo or a RAW (edited photos are rendered
  and denoised first, as for a publish), resized to what the largest use of each photo needs at the chosen dpi and
  never enlarged, embedded as sRGB JPEGs (quality 92). A photo smaller than that prints at its own size. Colours are
  sRGB; CMYK conversion is left to the print shop. Photos with the **B&W** or **Fade** filter are the exception:
  Chromium draws a filtered photo as a bitmap of its slot at 300 dpi whatever the dpi setting (and stores it
  losslessly, so those pages make larger PDFs).

The PDF is rendered by the publish CLI's headless Chromium with the shared page renderer (`page.pdf`), like the page
images and post frames, so it needs Chromium installed (section 6). **Export PDF…** asks for the destination (default
`Exports/Print` in the project's first folder; **Choose…** picks any folder, as for posts) and writes
`<print name as a slug>.pdf`. When that file exists the sheet shows *Replace the existing zine.pdf*, and **Export
PDF** stays off until it is ticked. The job shows in the jobs list, and the toast's **Reveal in Finder** (or *Show in Finder
when done*) shows the file. The same PDF from the command line:

```bash
pnpm --filter @photobook/publish photobook print <project.photobook.json> --output <print id> --out <file.pdf>
```

`--png` writes one proof PNG per sheet (`01.png`, …) into the `--out` folder instead, at the print's dpi; `--dpi N`
overrides the dpi. The print-size photos are cached in `.photobook-publish/print/` next to the project file, the three
most recently used files per photo (older edits and sizes are removed on the next print). A run that is cancelled
leaves no PDF: it writes a temp file next to the PDF and renames it, and the next run removes temp files of killed
runs. Like
`publish`, the command stops when an edited photo has no full-size render yet; the editor's export renders them first.

## Slideshow

A project can also hold slideshows (**New… → Slideshow** in the document drop-down): an MP4 video of the book's pages,
a post's frames or the project's picks, one slide each, for YouTube, Reels, TikTok or a screen. A slideshow holds
settings only; the canvas shows its source's pages (the book's for the picks), and editing a page changes the book or
the post. **Export video…** in the top bar writes the video.

With nothing selected on a slideshow, the inspector shows its settings, a looping sketch of the transition and motion,
and the slide count and length:

| Setting | Choices | Default |
| --- | --- | --- |
| Slides | The book's pages, the picks (every photo of the project flagged as a pick in Cull, shown whole on black), or one of the project's posts | The book's pages |
| Order | As listed, reversed, or shuffled (the same shuffle every time) | As listed |
| Seconds per slide | 1 to 30, in half seconds | 4 |
| Transition | Cut, crossfade, or dip to black (0.8 s, at most half a slide) | Crossfade |
| Motion | Still, or Ken Burns (a slow zoom or pan, a different one on each slide) | Ken Burns |
| Size | 1080p landscape (1920 x 1080), 4K landscape (3840 x 2160), 1080p vertical (1080 x 1920), 4K vertical (2160 x 3840), square (1080 x 1080) | 1080p landscape |
| Audio | One audio file (MP3, M4A, AAC, WAV, AIFF, FLAC, Ogg, Opus), copied into the app's data folder when chosen | None |

The video runs at 30 fps and lasts exactly slides x seconds per slide: a transition happens inside a slide's time and
never lengthens it. A longer audio track is cut at the end of the video with a 1.5 s fade-out; a shorter one ends in
silence (and, when it ends more than 1.5 s before the video does, without a fade: the fade is timed on the video's
end). Pages of another shape than the video (a 4:5 page in a 16:9 video) are centred on their own background
colour.

How it is made: the publish CLI renders every video frame as a still JPEG with the shared page renderer in headless
Chromium (so it needs Chromium, section 6), Ken Burns as a zoom of the page itself (text stays sharp) and transitions
as blended frames; then FFmpeg encodes them to H.264 (VideoToolbox on macOS, High profile, yuv420p, BT.709) with AAC
audio and `faststart`, through a temp file renamed when complete, so a cancelled export leaves no partial video. Each
export's frames go to its own folder, `.photobook-publish/slideshow/<id>/frames-<run>/` next to the project file (about
0.3 MB a frame at 1080p, four times that at 4K), and are deleted after the encode; folders left by a crash are swept
after six hours. Before any frame is rendered the export checks FFmpeg and its H.264 encoder, the audio file, the
destination, and the free disk space (it asks for about 1.5 MB a frame at 1080p, 6 MB at 4K), and asks before
replacing an existing video; one export per slideshow runs at a time. Rendering takes roughly 0.1 s a frame at 1080p
on an M-series Mac, so a 20-slide, 4-second slideshow (2,400 frames) takes about five minutes; held frames without
motion are written once. Transition frames cost more: both slides are captured and blended in JavaScript, which at 4K
(25 MB of pixels a layer) adds roughly a tenth of a second per transition frame. Photos come from the download JPEG
instead of the 2048 px browse image whenever the slide is shown larger than that (4K, or Ken Burns' zoom).

FFmpeg is not bundled. **Settings → Tools** downloads an LGPL build (about 10 MB, checked against a pinned SHA-256;
see [INSTALLATION.md](INSTALLATION.md#ffmpeg-for-slideshows)), or uses an `ffmpeg` already installed (Homebrew).
**Export video…** asks for the destination (default `Exports/Videos` in the project's first folder; **Choose…** picks
any folder) and writes `<slideshow name as a slug>.mp4`; the export shows as one job in the jobs list, and the
toast's **Reveal in Finder** shows the file. The frames alone from the command line:

```bash
pnpm --filter @photobook/publish photobook render-slideshow <project.photobook.json> --output <slideshow id> [--out <dir>]
```

It writes `000001.jpg …` and `frames.json`. An `--out` folder must be empty or hold only an earlier run's frames (it
clears those and nothing else). Encode them with any FFmpeg, e.g.
`ffmpeg -framerate 30 -i <dir>/%06d.jpg -c:v h264_videotoolbox -b:v 12M -pix_fmt yuv420p video.mp4`.

## Troubleshooting

- **`Missing publish settings`**: fill in the keys listed in the message in the editor's Settings, or in
  the settings file.
- **`*.r2.dev` or `*.workers.dev` does not load**: some networks block these. Use a custom domain.
- **Viewer says `VITE_R2_PUBLIC_URL is not set`**: create `apps/viewer/.env.production.local` (section 4)
  and redeploy.
- **Images fail with CORS errors**: rerun the `cors set` command from section 2.
- **`Listing objects needs the S3 transport`**: prune and unpublish need the R2 API token (section 3).
