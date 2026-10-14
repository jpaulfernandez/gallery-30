# 35 · Page and book captions, alt text

Status: done 2026-10-13 (review fixes applied the same day). Landed: `apps/editor/src/lib/ai/placeCaptions.ts` (pure
placement: caption slots are the page's text elements in the caption style, which every captioned layout creates; a
photo's caption takes the slot nearest that photo, the page caption and photos without a slot of their own take the
free slots (empty ones first), and when every slot is taken a caption joins the slot nearest its photo, so a shared
caption strip holds every photo's caption, joined as sentences by `joinCaptions` (a full stop is added when a caption
does not end one); a page with no caption slot gets one new caption element at `captionFrame`); `store/captions.ts`
gained `applyCaptions(pageId, captions)` (one undo step, false and no step when nothing changes; a new element makes the
page `custom` like Add text; alt text written only where the photo has none, as plan 34 does) and `setAssetAlt` (blank
removes it; recorded without history, because undo keeps the newest asset fields but develop, see `applyHistory`, so a
step would undo nothing; the Alt text field's tooltip says so); `lib/jobs/aiPageCaption.ts` (`planPageCaption`,
`captionSystem`, `toPageCaptions`, `requestPageCaption` as an `ai` job with `ai_cancel`, `estimatePageCaptions`,
`pageOutputTokens`, `defaultCaptionMode`, `sendEdge`); `lib/jobs/aiBookCaption.ts` (the run store `useBookCaptions`:
index step, one system block, a job per page, rows Accept / Edit / Skip / Accept all, Stop, usage sums; a row is
`accepted` only when `applyCaptions` changed the page, else "No change" or "Page changed"); `components/ai/CaptionReview.tsx`,
`CaptionPageSheet.tsx`, `CaptionBookDialog.tsx` (both mounted in `main.tsx`; the dialog closes with its run when the
project closes or another opens), `AltTextField.tsx` (photo inspector, under the Develop entries). Alt text: one shared
`normalizeAlt` (`packages/shared/src/publish/alt.ts`: one line, trimmed, at most `ALT_MAX` 125 characters cut at a word)
used by `setAssetAlt`, `applyCaptions`, the model output (`capAlt`), the manifest and the fingerprint. Publish:
`ImageRecordSchema.alt` (optional, manifest stays version 1), `buildManifest` writes the normalised alt on each image
record, `ResolvedImage.alt`, `resolveImageRecord` passes it, the shared `PhotoElement` and the viewer's lightbox set
`<img alt>` (`alt=""` without one); `pages.ts` unchanged. Fingerprint decision: alt text joins `publishableContent` per
used asset (`{ hash, develop?, alt? }`, only when non-blank, so every existing fingerprint is unchanged), because it
changes the manifest and must show as unpublished; it stays out of `pageHash`, so page renders are not redone and image
keys do not change. Rust: `AiRequestOptions.maxTokens` (1,024 to 16,000; `CaptionOptions.max_tokens`, sent as the
request's `max_tokens`, 16,000 when absent) so page captions can ask for less. Decisions and deviations: (1) **Page
input is the photos' proxies**, not a page render: plan 14 renders with the CLI's Chromium only and has no in-app
renderer. To keep a page near the cost of one 1080 px render, previews are sent at 768 px for one photo, 640 px for two
and 512 px for three or more, at most 20; photos not sent (not hashed yet, or beyond 20) are named in the review ("N
photos of this page not sent"). (2) Page requests run at effort `low` with `maxTokens` 4,096 (plan 32's default for
captions is `medium` and 16,000): the brief and index carry the context. (3) Output: targets are the photos' index
labels (`Photo N`) and `page`; in page mode the model writes the page caption plus one alt-only entry per photo, so alt
text is produced on every run. Mode default (`fit`): one caption per photo when the page has two or more photos and a
caption slot for each, else one for the page; the sheet has a radio, the book dialog a select. (4) **No page toolbar
exists** (as plan 14 found): *Caption this page…* is in the page strip's page menu and in the page inspector's Text
section; *Caption book…* is in the Design stage's document menu (OutputMenu) when the book is on screen (TopBar
untouched). (5) The book dialog's estimate uses `planIndex` + `estimateIndex` for the photos the index lacks and
`estimatePageCaptions` for the pages: images at their sent size, 200 uncached text tokens a page, the system block at
4 characters a token plus 60 tokens per photo still to describe (cached once, read by every later page), and
**400 + 60 per photo output tokens a page, an unmeasured rough guide** (the dialog says so). It does not call
`count_tokens`, which would send the brief and index before the author pressed Caption. With "all pages" the dialog warns
when pages already have captions. (6) The index step calls `planIndex` and `runIndex` (the pieces of `indexPhotos`) so
Stop can cancel the index job; a failed index stops the run. The system block is built once after the index, so it is
byte-identical for every page request (tested). (7) Each accepted page is its own undo step (Accept all is several).
Closing the dialog (Escape, Cancel or Close) while rows are ready asks "Drop N pages you have not accepted?" first.
(8) The suggested page title of WORKFLOW_PLAN 12.1 is not done (not in this plan's steps). Tests (Vitest, Tauri wrapper
mocked, no API call): placement into caption slots, a shared strip joined as sentences, a new element at the bottom
margin, one undo step, alt only where missing and capped at 125, `setAssetAlt` without a step
(`lib/ai/placeCaptions.test.ts`); request plan (effort `low`, `maxTokens` 4,096, photos not sent beyond 20), answer
parsing, preview sizes, the estimate (output 400 + 60 a photo; 20 one-photo pages on Opus 5.5 under $0.30), index
before captions with one system block, accept / edit / skip / accept all, "No change" and "Page changed" rows, **a
mocked refusal on page 3 leaves pages 1–2 and 4–5 accepted**, a re-run makes no describe request, cancel keeps answered
rows (`lib/jobs/aiBookCaption.test.ts`); the dialog shows the estimate ("about … tokens, roughly $… on Claude Opus 5.5")
before any request, lands nothing until accepted, asks before dropping ready rows on Esc and Close, warns before an
all-pages run over captions, and closes for good with the project; the sheet sends nothing before Generate, applies in
one step and shows a refusal (`components/ai/captionUi.test.tsx`); shared: alt in the record, resolver and rendered
`<img alt>` (`publish/alt.test.tsx`; the viewer has no test setup and renders through `resolveFromManifest` and the
shared `<Page>`), fingerprint with alt and `normalizeAlt`; publish: `buildManifest` writes normalised alt
(`manifest.test.ts`); Rust: the caption body's `max_tokens` and effort, and `maxTokens` deserialising. Check list: the
refusal check passes (mocked); the viewer check passes through the shared renderer test, not in a browser. **The cost
checks are not met as verified**: the lisbon-fixture run needs an API key (none here, and tests must not call the
API), so the real cost of a book is unknown. By the estimator, 20 one-photo pages on Opus 5.5 come to about $0.28 (of
which about $0.18 is output), only just under the $0.30 target and resting on the unmeasured output guess. "Re-run under
$0.05" is not met as written: a re-run skips the index requests (cached in the libraries) but repeats every page request,
so it costs about as much as the first run's page requests (the system block is cached for an hour, which only lowers
the input part). Not tried in the running Tauri app (jsdom only). At the time of the review fixes, other plans' work in
progress failed elsewhere: `pnpm typecheck` in `packages/shared/src/outputs.test.ts`, `publish/fingerprint.test.ts`
line 74, `apps/editor/src/store/outputs.ts`, `packages/publish/src/slideshow.ts` and
`apps/editor/src/lib/jobs/slideshowExport.ts`; Vitest in `shared/src/develop/parity.test.ts`,
`editor/src/store/denoise.test.ts` and `publish/src/publish.test.ts` (`locked` in `site.json`). None are lines this
plan touched.

WORKFLOW_PLAN [12.1](../WORKFLOW_PLAN.md#121-what-it-does), [12.3](../WORKFLOW_PLAN.md#123-cost-and-why-scan-the-whole-book-is-fine),
[12.5](../WORKFLOW_PLAN.md#125-ui) (W8). Size: 2 days. Depends on: 34.

**Goal.** Caption a page or the whole book with review before anything lands, show the cost first, and publish alt
text for accessibility.

## Decisions

- Page scope sends the rendered page (one image at 1080 px long edge from the in-app renderer of plan 14, or the
  page's photos' proxies if the renderer is not available yet) plus the brief and the index; output one caption per
  photo on the page or one page caption, placed in the layout's caption slots (captioned layouts exist) or as a new
  caption element at the bottom margin per `captionFrame`.
- Book scope: a dialog with the brief summary, cost estimate ("about 60,000 tokens, roughly $0.25 on Claude Opus
  5.5"), scope (pages without captions / all pages), then one request per page in the queue with a progress list;
  rows Accept / Edit / Skip and Accept all. Nothing lands until accepted; a refusal on one page leaves the others.
- `asset.alt` (schema field added in 03 if missed; otherwise add here as optional, no version bump needed) is
  written on every run and published: the manifest gains `alt` per photo and the viewer sets it on `<img>`.

## Steps

1. Store: `applyCaptions(pageId, captions[])` one undo step; `setAssetAlt`.
2. `components/ai/CaptionPageSheet.tsx` from the page toolbar (*Caption this page*).
3. `components/ai/CaptionBookDialog.tsx` from Design → Book ⋯ menu (*Caption book…*): estimate from
   `lib/ai/cost.ts`, index step (33) first, then the per-page jobs.
4. Publish: `packages/publish` manifest `alt`; viewer `<img alt>`; `pages.ts` unchanged.
5. Tests: placement into caption slots vs new element, accept/skip flow, manifest contains alt.

## Check

- On the lisbon fixture the Book scope captions 20 pages for under $0.30 on Opus 5.5 with the index cached;
  re-running costs under $0.05 (usage sums in the status line).
- A mocked refusal on page 3 leaves pages 1–2 and 4+ accepted.
- The published viewer shows alt text in the DOM.

## Docs

- `docs/PUBLISHING.md` (alt text in the manifest), `docs/ACCOUNTS.md`, `README.md`.
