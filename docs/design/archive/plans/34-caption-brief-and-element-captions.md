# 34 · Caption brief and element captions

Status: done 2026-10-13. Landed: `packages/shared/src/ai/style.ts` (the fixed role, Editorial style sheet, voice notes,
alt and output rules; `buildSystem(brief, index, { existing })`, deterministic, snapshot-tested) and `ai/brief.ts`
(`BriefInputSchema` / `validateBrief`, `parsePeople`, `emptyBrief`, `existingCaptions`, `captureSummary`);
`apps/editor/src/store/captions.ts` (book store slice: `setBrief`, one undo step, no step when unchanged;
`writeCaption(pageId, elementId, text, alt?)`, text plus the photo's `asset.alt` in one `set`, one undo step, works on
output frames); `lib/jobs/aiCaption.ts` (`captionSubject`, `planElementCaption`, `requestElementCaptions` as an `ai`
job, cancel through `ai_cancel`); `components/ai/BriefDialog.tsx` (mounted in `main.tsx`), `WritePopover.tsx` (✦ Write in
the text inspector's Content section) and `writeState.ts` (the popover's pure state machine); a Rust command
`photo_capture_info(folder, paths)` in `commands/ai.rs` (Exif `DateTimeOriginal`/`DateTime` and GPS through
`kamadak-exif`, registered in `lib.rs`, wrapper `photoCaptureInfo` in `lib/tauri.ts`) for the "Where and when?"
pre-fill; Project ▾ → *Caption brief…*. Decisions: (1) No schema change or version bump: the stored `BriefSchema` of
plan 03 already has every field with a default, so it stays lenient (an empty brief in a file still opens) and the
dialog saves through the stricter `validateBrief` (`about` required, texts trimmed and capped, at most 3 examples and
30 names, blanks and repeats dropped). (2) The three variants are the targets `what`, `where`, `detail` (one per
angle; repeats tolerated, up to three shown); each carries the subject photo's alt text, and Use records that alt on
the asset with the text, only when the photo has no alt yet (an author's alt is never overwritten; the cards then say
"the photo keeps its own"); alt text is capped at 125 characters at a word. Undo restores the text; the newest `alt`
is kept, like every asset field but develop (see `applyHistory`). Plan 35 still owns publishing `alt`. (3) Element input: the photo the text box belongs to (the
nearest photo frame within 0.08 of the page width with the others at least twice as far, or the only photo), else the
page's photos (at most 6, always including the nearest, in page order) with the nearest named in the prompt; each sent by hash with the developHash on screen
(`currentDeveloped`, else the source proxy) and labelled with its book-wide index number. (4) The index is
`indexText(book, libraries, { scope: 'placed', include: page photos })` and is left out of the system block while no
photo of the book is described; Write never runs Describe photos by itself (no spend without asking). The system
block is byte-identical across a book's text boxes (tested); it changes only when the brief, the descriptions, or (with
`useExisting`) the first three captions of the book change, or for photos placed only on an output frame. (5) The
brief's existing-caption examples are the first three caption/body/quote texts of four words or more in book order,
added at request time, not copied into the brief, and never the box being written (so Use and the chips leave that
box's system block unchanged; a box among the first three gets a block of its own). A brief without a non-blank
`about` (`briefReady`) counts as no brief: Write opens the dialog. (6) Place and time pre-fill is a date range plus the median GPS
position as coordinates ("June 3–9, 2026; near 38.71° N, 9.14° W"): no reverse geocoding (nothing to look up offline),
and the hint asks the author to replace the coordinates with a place name; saved untouched, only the dates are kept. (7) The "⋯ menu" entry is the popover's
*Brief…* link and Project ▾ → *Caption brief…* (the Book ⋯ menu belongs to plan 35). (8) The cost shown is after the
answer (`attemptsCost`), not an estimate before: one element request is a few cents. (9) The popover takes the focus
when it opens and gives it to the first Use when captions arrive, keeps Tab inside, and returns it to the Write button
on close; a wrapped caption loses its outer quotes only when no quote of the same kind is inside; a "No preview yet"
error names the file, not the asset id. Tests: shared Vitest for brief
validation, the v8 round trip without a bump, existing captions, the capture summary and the system block snapshot;
editor Vitest for the subject rule, the request plan (labels, refs, byte-identical system), variants, the job (ok,
refusal, cancel via `ai_cancel`, error), the state machine, the store actions, and the popover with the Tauri wrapper
mocked (first Write opens the brief and the second does not, the brief only in the project file, three variants
with alt text, Use is one undo step, a chip re-asks with the previous captions, a refusal shows the reason and keeps
the text with no undo step, closing cancels, no key); Rust tests for the Exif reader (date, signed GPS, missing or
half data). No real API call was made. Not done: a run against the real API (no key here, and tests must not call
it). At the time of writing, `pnpm --filter editor test` had 13 failures in `frameMove`, `Canvas` and `customPages`
tests (`rowSpread is not a function`, another plan's in-progress canvas work) and `tsc` errors in
`components/export/ExportDialog.tsx` (`EXPORT_FORMATS`), neither in files this plan touched.

WORKFLOW_PLAN [12.1](../WORKFLOW_PLAN.md#121-what-it-does), [12.2](../WORKFLOW_PLAN.md#122-first-use-the-brief),
[12.5](../WORKFLOW_PLAN.md#125-ui) (W8). Size: 2 days. Depends on: 33.

**Goal.** The first-use interview that makes captions specific, saved on the project, and the Element scope: a
Write button on a text element that offers three variants.

## Decisions

- `book.captions.brief` (schema v8, plan 03): `{ about, photographer, placeTime, people: string[], voice: 'editorial' | 'diary' | 'minimal' | 'playful', avoid, examples: string[], useExisting: boolean }`.
  Only `about` is required; place and time pre-filled from EXIF dates and GPS when present.
- The Editorial style sheet is a fixed system block in `packages/shared/src/ai/style.ts`: present tense, concrete
  nouns, one or two sentences of 12 to 30 words, place and time when known, no exclamation marks, hashtags, emoji,
  superlatives, no restating the obvious, no names outside the brief. Variants differ in angle, not tone.
- Element scope input: the one photo (or the page it is on) plus the brief and the index of the project's photos;
  output three variants plus alt text; chips Shorter, More specific, Different angle re-request with a short
  instruction; Use replaces the text in one undo step; "Keep mine" closes.
- The privacy line appears in the brief dialog and the popover footer.

## Steps

1. Shared: `BriefSchema` filled in (03 declared it), `style.ts`, `buildSystem(brief, index)`.
2. `components/ai/BriefDialog.tsx`: five fields, examples list, "Use my existing captions as examples" when the book
   has text elements; opened on first use and from the ⋯ menu afterwards; store action `setBrief`.
3. `components/ai/WritePopover.tsx` on the text element inspector (✦ Write): variant cards, chips, Use, Keep mine;
   loading and error states; `lib/jobs/aiCaption.ts` for the request (queue, cancel on close).
4. Tests: brief validation, system block snapshot, popover state machine with a mocked command.

## Check

- First Write opens the brief; second does not; the brief is in the project file and nowhere else.
- Three variants arrive with alt text; Use is one undo step; a refusal shows the reason and keeps the text.

## Docs

- `README.md` features (AI captions, bring your own key); `docs/ACCOUNTS.md`.
