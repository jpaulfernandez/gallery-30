# 33 · Photo index

Status: done 2026-10-13. Landed: `LibraryPhotoAiSchema` and the optional `ai` field on `LibraryPhotoSchema`
(`packages/shared/src/library.ts`, library stays version 1; `AI_TIMES_OF_DAY`); `packages/shared/src/ai/photoIndex.ts`
(`indexEntries`, `indexLine`, `indexText(book, library, { scope, include })` where `library` is one `Library` or
`(asset) => Library`; scope `placed` (the default, what plan 35 uses) lists the photos on `book.pages` plus the
`include` ids not on a page (e.g. the target photo), scope `all` every asset with the unplaced ones by path; photos are
`Photo N` numbered book-wide in book order, the first page they appear on as a photo or background, with their page
numbers (these are the index's own numbers: `ai_describe` labels each request's images 1 to 8 afresh); a photo without an entry reads "not described yet"; about 50 to 60 tokens a described
photo; byte-identical for the same inputs); `apps/editor/src/lib/jobs/aiIndex.ts` (`planIndex`, `estimateIndex`,
`runIndex`, `indexPhotos` for plan 35, `toLibraryAi`, `INDEX_BATCH` 8, `INDEX_CONFIRM_ABOVE` 20);
`apps/editor/src/components/ai/DescribePhotos.tsx` (`describePhotosAction`, the dialog mounted in `main.tsx`, the
batch bar slot `describe` at order 70); a new job kind `ai` with its own lane of one (`store/jobs.ts`); `isEmptyPhoto`
keeps an entry that holds only `ai`. Decisions: one job per run with batch progress (progress counts photos, detail
`batch i/n`), not one job per batch, so the jobs list shows one row and one cancel; cancel calls `ai_cancel` on the
request in flight and keeps the batches already written. Refs are the source proxy by hash (no `developHash`): the
entry is keyed by the file's hash, so it describes the photo, not one edit of it. Photos are deduplicated by hash
(one ref, written to every folder library that holds those bytes), and a description another folder's library
already has for the same bytes is copied without a request. Entries are written through the book store's
`patchPhoto` inside `withoutHistory` (a description is not an undo step; undo keeps the newest `ai` because
`mergeLibrariesForHistory` keeps the newest entry), into the library of the photo's own folder (a library that is
not loaded, or was closed meanwhile, is read first; one that cannot be written is skipped and counted as not ready).
The entry's `model` is the requested model and `servedBy` (optional) the one that answered after a fallback;
`description` is capped at 600 characters (`AI_DESCRIPTION_MAX`, longer answers are cut) and a bad `ai` value drops
only that field when the library is parsed (`.catch(undefined)`), never the library. Refresh (`upToDate`) redoes
entries asked of a cheaper offered model, or of an unknown one, than the index model (Settings → AI `indexModel`);
an entry asked of the same or a pricier model counts as up to date (Refresh never downgrades). The action runs at
once when the key is set and at most 20 photos would be sent; above 20, when nothing is new, when Refresh would redo
some entries, on Shift-click, without a key, or when the settings cannot be read (showing that error) it opens the
dialog, which shows the count, the requests and the estimate (`describeEstimate`). Overlapping runs never bill a
photo twice: the action and the Cull item do nothing while an index job is queued or running, `runIndex` passes a
`dedupe` key (model, Refresh, hashes and folders) so an equal run joins the first, and batches are formed as the run
goes from the photos still not up to date in the current libraries (one another run described meanwhile is skipped,
or copied to a folder that lacks it). Each run ends in a toast (`indexResultText`: described, declined, without a
preview, not described, cost). Entries the answer leaves out, with unknown ids or that do not fit the schema are
counted as `failed` and named in the job log. Before re-reading a library that was closed, `writeAi` awaits the
autosave flush so the read is what is on disk. The Cull batch bar does not exist
(plan 11), so the Cull entry point is an item of the Cull grid's right-click menu. A declined batch is skipped with
the message in the job log and the run goes on; a batch none of whose photos has a cached preview (the command's
error) is counted as missing and the run goes on; other errors fail the job. Estimate model: 400 uncached text tokens
and 1,500 output tokens per request of 8 (`INDEX_TEXT_TOKENS_PER_REQUEST`, `INDEX_OUTPUT_TOKENS_PER_REQUEST`).
Checked by Vitest with the Tauri wrapper mocked (no API calls): the 16 photos of the lisbon fixture index in two
requests on Haiku at `low` effort and a second run makes zero requests, entries parse from the serialized
`library.json` under their hashes and reach the file through the library autosave's write, no undo step is recorded,
and undo and redo of a Develop edit keep `ai` (`store/library.test.ts`); overlapping runs (an equal run joins, an
overlapping one sends only the new photos); Refresh against a cheaper, the same and a pricier model and a fallback
answer; failed entries; on 45 photos (6 requests) the estimate shown before the
run is within 20 % of the mocked `usage` priced after it, in dollars and tokens; Refresh, dedupe and copy across
folders, a project photo in another folder written to that folder's library, refusal and missing previews, cancel
through `ai_cancel`, and the dialog (runs at once at 12 photos, cost first at 30, everything described, no key);
plus shared tests for the schema and `indexText`. Not done: the run against the real API on the lisbon fixture (no
key here and the tests must not call the API), so the 20 % check is on mocked usage only and the real output-token
figure is unmeasured; the Batch API path is not built (as planned). No Rust change was needed.

WORKFLOW_PLAN [12.3](../WORKFLOW_PLAN.md#123-cost-and-why-scan-the-whole-book-is-fine), [14.5](../WORKFLOW_PLAN.md#145-ai-context-per-project) (W8).
Size: 1 day. Depends on: 32, 02, 09.

**Goal.** A two-line description per photo, computed once and cached by hash in the library, so caption requests
carry text instead of pixels and the whole book's context costs under a dollar.

## Decisions

- Library entry `photos[hash].ai = { model, at, description, people, setting, timeOfDay, mood }` (schema v1 of the
  library gains the optional field; no version bump needed since it is optional).
- Batches of 8 photos at 768 px per request, Haiku by default, `low` effort, structured output; results written to
  the library of each photo's folder. Re-indexing only touches photos without an entry (or with an older model when
  "Refresh" is chosen).
- Runs in the job queue; the Batch API is a later option when the user is not waiting (noted, not built here).

## Steps

1. Shared: `LibraryPhotoAiSchema`; `indexText(book, library)` formats the index as the system block text (about 60
   tokens per photo).
2. Rust: `ai_describe` (32) takes refs and returns entries; the TS side writes them through `patchPhoto`.
3. `lib/jobs/aiIndex.ts`: builds batches from the refs that lack an entry, enqueues, shows the cost estimate first
   when more than 20 photos.
4. A *Describe photos* action in the Cull batch bar and in the Book captions dialog (35) as the first step.

## Check

- On the lisbon fixture the index runs once; a second run makes zero requests (log line counts); entries appear in
  `library.json` under the hash.
- Cost shown before the run matches the `usage` sum after it within 20 %.

## Docs

- `docs/ACCOUNTS.md` AI (what is sent); `CLAUDE.md` library field.
