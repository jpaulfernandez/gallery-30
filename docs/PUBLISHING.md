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
| `SITE_PASSWORD` | The one soft password viewers type once per device; changing it asks every device again |
| `SITE_PASSWORD_EXPIRES_AT` | Optional ISO date after which devices are asked again |
| `DOWNLOAD_MAX_EDGE`, `DOWNLOAD_QUALITY` | The full-quality download version (default 4096 px, JPEG quality 88) |
| `PUBLISH_CONCURRENCY` | Image workers (default: CPU cores minus one) |
| `SOCIAL_API_URL` | The likes and download-log Worker (section 8); written into `site.json` as `api` |
| `SOCIAL_ADMIN_TOKEN` | The Worker's `ADMIN_TOKEN`; lets the editor's Downloads tab read the log |

**Test connection** runs `photobook doctor`. **Apply password to the site now** rewrites `site.json` alone.

The values are saved to a `publish.env` file in the editor's app data folder, with owner-only
permissions, and never go into the project file:

| OS | Settings file |
| --- | --- |
| macOS | `~/Library/Application Support/com.photobook.editor/publish.env` |
| Linux | `~/.local/share/com.photobook.editor/publish.env` |
| Windows | `%APPDATA%\com.photobook.editor\publish.env` |

The CLI reads the same file. You can also set the keys in the environment, or point at another file with
`--env <file>` or `PHOTOBOOK_ENV`.

The soft password is checked in the browser. It keeps casual visitors out and nothing more: anyone with the
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
ones are reachable by link only) and press **Publish**. Or from a terminal:

```bash
pnpm --filter @photobook/publish photobook publish /path/to/book.photobook.json --dry-run
pnpm --filter @photobook/publish photobook publish /path/to/book.photobook.json
pnpm --filter @photobook/publish photobook publish /path/to/book.photobook.json --prune
pnpm --filter @photobook/publish photobook unpublish /path/to/book.photobook.json
pnpm --filter @photobook/publish photobook password sync
pnpm --filter @photobook/publish photobook doctor
```

Outputs are cached in `.photobook-publish/` next to the project file, so a rerun processes and uploads only
what changed. `--prune` deletes images the book no longer uses.

The book is then at `https://<viewer>/<slug>`. Share the link and the password.

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

## Troubleshooting

- **`Missing publish settings`**: fill in the keys listed in the message in the editor's Settings, or in
  the settings file.
- **`*.r2.dev` or `*.workers.dev` does not load**: some networks block these. Use a custom domain.
- **Viewer says `VITE_R2_PUBLIC_URL is not set`**: create `apps/viewer/.env.production.local` (section 4)
  and redeploy.
- **Images fail with CORS errors**: rerun the `cors set` command from section 2.
- **`Listing objects needs the S3 transport`**: prune and unpublish need the R2 API token (section 3).
