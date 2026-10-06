# Accounts you need

Short answer: **none to design books**, and two free accounts to share them on the web.

| What you want to do | Accounts needed |
| --- | --- |
| Design books on your computer, preview them on a phone frame | None |
| Publish books to the web for friends to read and download | Cloudflare (R2) and Vercel, or Cloudflare alone with another static host |
| See likes and who downloaded what | The same Cloudflare account (Workers and D1) |
| Use a nice domain instead of `*.r2.dev` and `*.workers.dev` | A domain whose DNS is on Cloudflare (optional) |

Photobook has no central server and no Photobook account. Each person runs their own copy and their own
cloud storage. Your photos, your bucket, your bill (which should be zero).

## Cloudflare

Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up). The free plan is enough.

What Photobook uses:

- **R2 object storage** holds your published images, page images, book manifests and the site file. R2
  charges nothing for bandwidth, which matters because friends download full-quality photos. Enabling R2
  asks for a payment method even on the free tier.
- **Workers and D1** (optional) run the small API for likes and the download log.

Credentials Photobook asks for:

| Credential | Where to find it | Stored in |
| --- | --- | --- |
| Account ID | R2 overview page | Editor settings file |
| R2 API token (Access Key ID + Secret Access Key), Object Read & Write on your bucket | R2, Manage R2 API Tokens | Editor settings file |
| Your wrangler login | `wrangler login` (browser sign-in) | wrangler's own config, used only for setup commands |
| Worker admin token | You generate it (`openssl rand -hex 32`) | Worker secret, and the editor settings file |

## Vercel (or any static host)

The viewer is a static web app. The repo includes a one-command deploy to Vercel: sign up at
[vercel.com](https://vercel.com/signup) on the free Hobby plan, which is meant for personal,
non-commercial use. Vercel needs no credentials from you inside Photobook; the `vercel` CLI handles its own
login.

Prefer to stay on Cloudflare only? Build the viewer (`pnpm --filter viewer build`) and host
`apps/viewer/dist/` on Cloudflare Pages, Netlify, GitHub Pages with an SPA fallback, or your own server.
See [PUBLISHING.md](PUBLISHING.md), section 4.

## A domain (optional)

Not required, but recommended once you share books for real:

- `*.r2.dev` URLs are rate limited and meant for development, and some networks block `*.r2.dev` and
  `*.workers.dev` entirely.
- A custom domain needs its DNS managed by Cloudflare (free). Domains cost around 10 USD a year from any
  registrar, including Cloudflare's.

## What it costs

For a handful of books shared with friends and family, typically nothing. Free allowances at the time of
writing (check the providers' pricing pages, they change):

| Service | Free allowance | Typical Photobook use |
| --- | --- | --- |
| Cloudflare R2 | 10 GB stored per month, 1 million writes and 10 million reads per month, free egress | Each photo is stored as a few web sizes plus a roughly 3 MB download copy, so a book of 150 photos is several hundred MB |
| Cloudflare Workers | 100,000 requests per day | One request per like or download |
| Cloudflare D1 | 5 GB storage, 100,000 row writes per day | One row per like or download |
| Vercel Hobby | Generous bandwidth for a static site | The viewer shell is about 60 KB gzipped; images come from R2, not Vercel |

## Where your secrets live

- Publish credentials and the site password are saved in a `publish.env` file in the editor's app data
  folder with owner-only permissions (paths in [PUBLISHING.md](PUBLISHING.md), section 5).
- Nothing secret goes into the project file (`book.photobook.json`) or into this repository. The
  `.gitignore` excludes `.env*.local`, `wrangler.local.toml`, `.dev.vars` and `.vercel/`.
- The site password is a soft gate checked in the browser. It keeps casual visitors out, not determined
  ones. Do not publish anything that needs real access control.
