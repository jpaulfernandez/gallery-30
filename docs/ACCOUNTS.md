# Accounts you need

Short answer: **none to design books**, and two free accounts to share them on the web.

| What you want to do | Accounts needed |
| --- | --- |
| Design books on your computer, preview them on a phone frame | None |
| Publish books to the web for friends to read and download | Cloudflare (R2) and Vercel, or Cloudflare alone with another static host |
| See likes and who downloaded what | The same Cloudflare account (Workers and D1) |
| Use a nice domain instead of `*.r2.dev` and `*.workers.dev` | A domain whose DNS is on Cloudflare (optional) |
| Write captions and alt text with AI | An Anthropic API key (optional, pay as you go) |

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

## Anthropic (optional, for AI captions)

The AI caption features (describing photos, writing captions and alt text) use your own Anthropic API key. Nothing
else in Photobook needs it, and nothing is sent anywhere until you press a Generate button.

1. Create an account at [console.anthropic.com](https://console.anthropic.com), add a payment method or credit, and
   create an API key under **API keys**.
2. In the editor, open **Settings → AI**, paste the key and press **Test**. Test counts a few tokens with the
   key and the selected caption model (free) and says whether the key works; a wrong key gives Anthropic's reason.
3. Pick the models. **Claude Opus 5.5** is the default for captions; **Claude Haiku 5.5** is the default for
   describing photos (the index each caption request reads), which it does well at a fraction of the price.
   **Claude Sonnet 5.5** sits in between.

**What it costs.** You pay Anthropic per token. Prices per million tokens on October 13, 2026 (check
[anthropic.com/pricing](https://www.anthropic.com/pricing), they change):

| Model | Input | Output | Read from cache |
| --- | --- | --- | --- |
| Claude Opus 5.5 | $4 | $20 | $0.20 |
| Claude Sonnet 5.5 | $2 | $10 | $0.20 |
| Claude Haiku 5.5 | $0.10 (prompts up to 100K tokens) | $0.50 | $0.01 |

A photo is sent at 768 pixels on its long edge, about 600 to 800 tokens, so describing 90 photos costs about a cent
on Haiku, and captioning a 30-page book on Opus costs well under a dollar. The shared part of a book's requests (the
style, your brief and the photo descriptions) is cached for an hour, so later pages read it at the cache price. The
settings show the tokens and the estimated spend this month, added up on your computer from what each answer
reports; Anthropic's console has the exact bill. Estimates shown before a run are a rough guide: the models think
before they answer, and how much varies from request to request.

**What is sent, and where the key lives.** The editor sends the photos a request is about (downscaled copies, never
the originals, and no file names) and the text you wrote for it (the brief, earlier captions as examples) to
Anthropic, and to nobody else. The key is saved in an `ai.env` file in the editor's app data folder with owner-only
permissions, next to `publish.env`. It is read from that file for each request by the editor's Rust side; it never
goes into a project file, a photo folder's library, the web view or a published book. Remove it with **Remove key**.

**Describe photos (the photo index).** *Describe photos* in the Develop batch bar (the selected photos, or the one
shown) and in the Cull grid's right-click menu sends each photo's cached preview, downscaled to 768 pixels, in
requests of eight photos, to the index model (Haiku unless you chose another in Settings → AI). The photos are
labelled "Photo 1", "Photo 2" and so on: no file names, paths or folder names are sent, and no text of yours. What
comes back is a two-line description, the number of people, the setting, the time of day and a mood word for each
photo. It is saved in the photo folder's library (`.photobook/library.json`, next to the ratings and edits, under
the photo's content hash), so every project on that folder shares it and a photo is never described twice; running
it again only sends photos without a description. When more than 20 photos would be sent, the editor shows how
many requests it will make and the estimated cost first, and nothing is sent until you press Describe. The run is a
job in the jobs list and can be cancelled; descriptions already received are kept. *Refresh* in that dialog
(Shift-click Describe photos to open it) describes again the photos a cheaper model described; it never replaces a
description by a pricier model's with a cheaper one's. Caption requests later send these descriptions as text instead
of the photos themselves.

**Write a caption (the brief and ✦ Write).** Select a text box on a page and press **✦ Write** in the inspector.
The first time in a project, the **Caption brief** opens: what the book is about (the only question you must
answer), who the photographer is and how to refer to them, where and when (pre-filled from the photos' Exif dates
and GPS positions as a date range and coordinates, read on your Mac; replace the coordinates with a place name),
who is in the photos (only these names are ever used; anyone else stays unnamed), the voice (Editorial, Diary,
Minimal or Playful), a line of things to avoid and up to three example captions in your own words. When the book
already has captions, *Use my existing captions as examples* adds the first three. The brief is saved in the
project file and nowhere else (not in the photo folder, not in the app's settings); change it any time from
**Project ▾ → Caption brief…** or the **Brief…** link in the Write popover. After you save it, the request is sent:
the brief, the fixed Editorial style sheet and the photo index of the book's placed photos (the descriptions above,
as text; left out while no photo is described) as the cached part, plus the photo the text box belongs to, or the
page's photos (up to six) when the box sits between several, each as its cached 768-pixel preview of the edit you
see, labelled with its number in the index. Three captions come back, each from a different angle (what is
happening, where we are, a detail) with the photo's alt text. **Use** puts one in the text box and saves the alt text
on the photo (unless it already has one) in one undo step; **Keep mine** closes; **Shorter**, **More specific** and
**Different angle** ask again with the previous captions. One request on Opus 5.5 costs a few cents (the popover
shows the estimated cost after the answer); it is a job in the jobs list, waits while Describe photos runs, and
closing the popover cancels it. A decline shows "The model declined this page" with the reason and leaves your text
as it was.

**Caption a page.** **Caption this page…** in a page's menu in the page strip (and in the page inspector, with nothing
selected) writes the page's captions in one request: one caption for each photo, or one caption for the whole page
(the sheet picks the one that suits the layout: one per photo when the layout has a caption box for each photo; you
can switch), plus the alt text of every photo either way. The request carries the same cached part as ✦ Write (the
style sheet, the brief and the photo index) and the previews of the page's photos, labelled with their numbers in the
index; the more photos a page has, the smaller each preview (768 pixels for one photo, 640 for two, 512 for three or
more), so a page costs about what one 1080-pixel picture of it would. Page requests ask for little thinking (effort
low, with an output limit of 4,096 tokens), since the brief and the index already carry the context. Nothing is sent
until you press **Generate**.
The captions come back for review, editable, each with the place it will go: the caption box under its photo, the
first empty caption box, or, on a page without caption boxes, a new caption at the bottom margin. **Apply** places them
in one undo step and saves each photo's alt text unless the photo already has one. A decline shows the reason and
changes nothing.

**Caption the book.** In the Design stage, the document menu next to the stage tabs has **Caption book…** while the
book is on screen. The dialog shows the brief, the pages to caption (*pages without captions*, the default, or *all
pages with photos*), how to caption them (fit each layout, one caption per photo, or one per page) and the cost before
anything is sent, for example "about 60,000 tokens, roughly $0.25 on Claude Opus 5.5", plus the cost of describing
the photos the index lacks. The estimate is a rough guide: it assumes about 400 output tokens a page plus 60 a photo,
which has not been measured against Anthropic yet, so check the spend the dialog adds up from the real answers. When
*all pages* includes pages that already have captions, the dialog says so before you start. **Caption** first describes those photos (the photo index above; nothing is sent again for
photos already described, so a second run starts straight with the pages, but it pays for every page request again), then sends one request per page, one at a
time in the jobs list, all with the same cached part so every page after the first reads it at the cache price. Each
page becomes a row as its answer arrives: **Accept** places its captions (one undo step per page), **Edit** lets you
change the texts and alt texts first, **Skip** drops them, and **Accept all** takes every page that is ready. Nothing
reaches the book until you accept it. A page the model declines shows the reason in its row and does not stop the
others. A page deleted or already reading the same captions says so in its row instead of counting as accepted.
**Stop** cancels the requests that have no answer yet and keeps the rows already answered; closing the dialog (Escape,
Cancel or Close) asks first when pages are still waiting for review, since their captions are paid for. The dialog adds up what the run actually spent from Anthropic's answers.

**Alt text.** Every caption run also writes alt text: one plain sentence per photo for screen readers, at most 125
characters. It is saved on the photo in the project when the photo has none (your own alt text is never replaced), and
you can read and change it in the photo inspector (**Alt text**, below the Develop entries); alt edits are not in the
undo history. Publishing puts it in the book's manifest and the
viewer sets it on the photo (see [PUBLISHING.md](PUBLISHING.md#7-publish)).

If Anthropic's safety checks decline a request on Opus, Anthropic retries it within the same request on the model
it recommends for that case (an earlier Opus); on Sonnet this happens only for some kinds of decline, and Haiku has
no such fallback. An answer from a fallback model is billed at that model's price and marked as such. When the
request is still declined, the editor shows "The model declined this page" with the reason and writes nothing.

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

- Publish credentials are saved in a `publish.env` file in the editor's app data
  folder with owner-only permissions (paths in [PUBLISHING.md](PUBLISHING.md), section 5).
- The Anthropic API key for AI captions is saved in `ai.env` in the same folder, also owner-only.
- Nothing secret goes into the project file (`project.photobook.json`) or into this repository. The
  `.gitignore` excludes `.env*.local`, `wrangler.local.toml`, `.dev.vars` and `.vercel/`.
- A book's password is stored only as a salted hash (in the project file and the published manifest),
  never as the word. It is a soft gate checked in the browser. It keeps casual visitors out, not determined
  ones. Do not publish anything that needs real access control.
