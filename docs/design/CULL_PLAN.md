# Cull workflow: research and plan

Oct 13, 2026. The Cull stage today (workflow plans [06](archive/plans/06-cull-grid-and-selection.md) and
[07](archive/plans/07-cull-compare-and-survey.md)) is a Lightroom-shaped grid: stars, pick / reject / unflag, Compare and
Survey. It works, but it reproduces the part of Lightroom that makes culling tiring: a five-star scale nobody can apply
consistently, a "maybe" state (unflagged) that lets every hard decision be deferred, bursts shown as twenty equal
cells, and no way to finish. This document researches why culling is tiring, looks at what the current tools do, and
plans a workflow built on one idea: **culling is a sequence of yes-or-no decisions, taken one group at a time, with a
visible end.**

The plan adds five session-sized pieces (plans 38 to 42, laid out at the end in the format of
[plans/README.md](plans/README.md)): capture time and technical stats in the folder index; burst groups; the Decide
pass with a target and progress; technical lenses (soft, blown, dark) that rank and never reject; and a staged path
from the reject pile to the Trash.

Status: plans 38–42 done Oct 13, 2026 and archived in [archive/plans/](archive/plans/) (38, 39, 40, 41, 42; each has
its Status line); the human checks of 39, 40 and 42 (a real folder grouped, a Decide pass, a move to the Trash and back)
are the owner's, collected in [plan 49's Status](archive/plans/49-delight-and-polish.md).

## 1. What is wrong today

- **Two scales, one of them useless.** Stars and flags both exist. The user's own experience (and Lightroom's
  folklore) is that stars add a second decision ("is this a 3 or a 4?") on top of the first ("does this stay?"), and the
  answer changes with mood and fatigue. Section 2 says why: there is no stable absolute scale in the head to rate against.
- **"Unflagged" is a maybe.** Every photo starts there, and nothing pushes it out. A folder of 600 photos with 40
  picks and 30 rejects has 530 undecided photos that will be looked at again next time.
- **Bursts cost N decisions.** Twenty frames of the same moment are twenty cells, each rated alone. The right question
  is "which one of these" (a comparison, easy), not "is this one good" twenty times (an absolute judgment, hard).
- **No end.** Nothing says how far along the cull is or when it is done, and "done" is the only thing that stops the
  cull from being re-opened.
- **Rejects never leave.** The app never deletes, so rejects stay in the folder at 35 % opacity forever, and the disk
  fills with frames the user has already decided against.

## 2. Research: why culling is tiring

Full memo with sources in [section 8](#8-sources). What matters, with the parts that replicate separated from the parts
that do not.

**Decision fatigue is real as an experience, not as a battery.** The "ego depletion" model (Baumeister 1998; Vohs 2008)
and the hungry-judges study (Danziger 2011) are the usual citations, and both failed to replicate or were explained by
case ordering (Hagger 2016, 23 labs, d = 0.04; Glöckner 2016). What does hold: long runs of similar choices are
aversive, and people accept the default more and more as a session goes on (Levav 2010, car configurators). Design
consequence: do not build a "you are tired" mechanic; do make the session short, make the default the safe side, and
give it an end.

**Choice overload is worst exactly in a burst.** The jam study (Iyengar & Lepper 2000) is conditional: the 2010
meta-analysis (Scheibehenne) finds overload when the options are *similar* and preferences are *unclear*. Twenty
near-identical frames is the textbook case. Grouping them is the single biggest lever.

**Binary is faster, and "maybe" invites deferral.** Reaction time grows with the log of the number of alternatives
(Hick 1952); the slow part of a five-star rating is not the keypress but deciding what a star means. Forced-choice
pairwise comparison had the lowest variance and the best time-efficiency of four methods for judging *image quality*
specifically (Mantiuk 2012). A no-choice option is taken more when the options are close (Dhar 1997; the broad effect
is contested, Evangelidis 2023, but the specific case of near-equal options is where it holds). Consequence: one pass,
two keys, no maybe; stars only later, on survivors, if ever.

**Comparison beats rating.** Decision by sampling (Stewart, Chater & Brown 2006): people judge by ordinal comparison
against what is in front of them, not against an internal scale. Thurstone's law of comparative judgment (1927)
rests on the same fact. Consequence: inside a group, ask "which of these two is sharper", carry the winner, never ask
for a number.

**Rejecting your own frame feels like a loss.** Endowment (Kahneman, Knetsch & Thaler 1990: owned things are valued
about twice as high) and sunk cost (Arkes & Blumer 1985: effort already spent raises persistence). Consequence: the
verb is *keep*, the pass is framed as "pick the ones that stay", and the reject pile is a place, not a deletion.

**A visible goal accelerates the end.** Goal gradient (Hull 1934; Kivetz 2006: users of a rating site rated faster and
quit less near a threshold) and the preference for percent-done indicators (Myers 1985). The Zeigarnik "unfinished
tasks are remembered better" claim failed a 2025 meta-analysis; only the urge to resume holds. Consequence: a target
("keep about 60"), a progress bar of decided photos, and a clear "this folder is culled" state.

**Thumbnails lie about sharpness.** Scene content survives at 32 px (Torralba 2009) and faces at very low resolution
(Sinha 2006), but downsampling makes blur disappear (Trentacoste 2011; Park 2014). Consequence: content and exposure
can be judged in the grid; focus needs a 100 % view of the subject, one key away.

**Reversible forever is worse than reversible once.** Students who could swap a print later liked it less than those
who could not (Gilbert & Ebert 2002), yet most wanted the option. Consequence: rejects stay reversible until one explicit
review of the pile, and the Trash step is a bounded "last look", not a perpetual bin inside the app.

**Practitioners already cull in passes.** The near-universal advice (Narrative, PetaPixel, Imagen, Photo Mechanic
users): a fast technical pass, then a comparative pass inside bursts, then ratings if a client needs them. Reported
unassisted throughput is roughly 900 to 1,500 photos an hour for the first pass; a wedding shooter stacking bursts
describes 3,000 to 700 in twenty minutes.

### Design principles

1. One pass, two keys: Keep or Reject. No maybe. Stars are hidden in the pass and optional afterwards.
2. A burst is one decision: show the group, suggest the sharpest, let the user swap, then one key keeps the one shown
   and rejects the rest.
3. Compare, never rate: inside a group the question is "this or that", at 100 % when it is about focus.
4. The verb is keep. The pass counts kept photos against a target; rejects are a pile, not a deletion.
5. Show the end: decided / total, kept / target, and a "culled" state the folder reaches.
6. Technical signals rank and explain; they never move a photo. Intent (deliberate blur, a silhouette) is the user's.
7. Groups never hide: a collapsed group still counts and matches filters (the Lightroom stacks lesson).
8. Destructive is staged: reject (reversible) → review the pile once (bounded) → Trash (OS-recoverable, confirmed with
   the real count, independent of the active filter).
9. Never lose the place: after any decision or deletion the cursor is on the next undecided photo.
10. Short sessions: a soft nudge to pause after about 45 minutes or a few hundred decisions, dismissable.

## 3. What the other tools do

Details and links in the competitive memo ([section 8](#8-sources)). The short version:

| Tool | Decision vocabulary | Grouping | Signals | Target / progress | Delete |
| --- | --- | --- | --- | --- | --- |
| Narrative Select | stars, colours, tag, reject, plus a 5-level AI rank *relative to the scene* | "Scenes" (visual similarity), best on top | per-face focus 0–10 and eye state as "dashboard lights", hover explains why; Ruthless / Balanced / Cautious dial | counts per category | none, ships to Lightroom |
| Aftershoot | Selected / Rejected plus stars and colours | visual duplicates, Few↔More slider, cannot be turned off | blur (Lenient / Moderate / Strict), closed eyes; *does* auto-sort, with a warning icon when a whole set is bad | "Cull to Target" 10–60 % slider | per image with a confirm, Z rejects a whole set |
| FilterPixel | P / X / U (duplicate), stars | series with a "+N" badge, one best per series | closed eyes, focus, no face; cloud | none | none |
| Photo Mechanic | tag, 8 colour classes, stars (a preference decides what digits do) | none | none | per-class counts | manual |
| Lightroom Classic | P / X / U, stars, colours | auto-stack by capture time (default 1 s or 1 min, sources differ) and, since 2025, by visual similarity | Assisted Culling (2025): subject / eye focus sliders, eyes open, auto-reject exposure and misfires; a 2026 fix for intentional background blur | "43 Selects and 2 Rejects" | *Delete Rejected Photos* filters to rejects then asks Disk / Remove / Cancel; respects the active filter ("No photos to delete") |
| Capture One | stars, colours, no reject flag | Cull view groups by similarity with a slider | Face Focus zoom, explicitly not an assessment | filter counts | none inside Cull |
| Apple Photos bursts | favourites inside the stack | camera burst | suggested frames as dots | | "Keep Everything / Keep Only N Favorites", losers to Recently Deleted |
| Slidebox, Swipewipe | swipe keep / trash | | | | nothing happens until a "last look" and apply |

**Worth taking.** Relative, explained, never-acting assessments (Narrative). Group-aware keys: one axis moves between
groups, another inside one, one chord selects the whole group. A warning when a whole group is bad instead of a silent
"best" (Aftershoot). Delete as a staged last look (Slidebox, Apple's "Keep only N"). Auto-advance with an off switch.
Counts on every filter.

**To avoid.** Auto-rejecting intent (every AI tool has the complaint: dark frames, panning blur, closed eyes on a laughing
bride). An AI verdict separate from the user's flag (Adobe forum: "would work better tied into the normal pick/reject").
Three parallel scales (Photo Mechanic). Stacks that drop out of filters and search (an eight-year-old Lightroom thread).
A destructive command whose scope depends on the active filter. Losing the grid position after a confirm dialog.

## 4. The workflow

### 4.1 Vocabulary

Two words, two keys, the Lightroom keys so nothing has to be relearned:

| State | Key | Shown as |
| --- | --- | --- |
| **Keep** | P | the flag badge as today (`flag: 'pick'`) |
| **Reject** | X | 35 % opacity as today (`flag: 'reject'`) |
| undecided | U clears | no badge; this is the queue, not a state to aim for |

The schema does not change: `flag` stays `'pick' | 'reject' | undefined`. The UI stops saying *pick* and *unflag* and
says *Keep*, *Reject* and *Undecided*. Stars stay in the schema and in Review and Develop, but the Cull grid hides them
behind a *Stars* toggle (`ui.cull.showStars`, off by default) and the Decide pass never shows them. The flag filter
gains *Undecided*.

### 4.2 Groups

A **group** is a burst or a re-shot subject: frames from the same camera and lens, seconds apart, that look alike.
Groups are computed from the folder index (plan 38 stores what they need), never from the originals, and are
recomputed on the fly; the user can split, merge and detach, and those overrides are library data by hash.

In the grid a group is **one cell** when *Group* is on (the filter bar toggle, on by default once a source has groups):
the shown frame (the kept one if exactly one is kept, else the suggested best), a `+N` badge, a stacked edge, and the
group's keep / reject counts in the badge colour (all decided, some kept, nothing decided). `G` expands the focused group
in place into its frames (and collapses it again); `,` and `.` step the shown frame inside a collapsed group; `Cmd+G`
selects the whole group. Filters, search, Cmd+A and the counts always work on the photos inside the groups, and a group
that is only partly in the filter shows only its matching frames. Nothing is ever hidden by being grouped.

### 4.3 The Decide pass

`Enter` on the grid (or the *Decide* button in the filter bar) opens **Decide**, a view of the Cull stage like Compare
and Survey (`ui.cull.view: 'decide'`). It walks the **undecided** photos of the current list, one *unit* at a time: a
single photo, or a group.

```
┌ Decide ───────────────────────────── 142 / 600 decided · 38 kept of ~60 ─── [Target ▾] [Done Esc] ┐
│                                                                                                    │
│                               [ the shown frame, proxy, fit ]                                      │
│                                                                                                    │
│  group 7 of 9 frames    ▣ ▣ ▣ ▢ ▢ ▢ ▢ ▢ ▢      sharpest ●  ·  highlights 4 %                      │
│  P keep this one (rejects the rest of the group)  X reject  , . other frame  Space 100 %  C compare │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Key | Single photo | Group |
| --- | --- | --- |
| P | keep, advance | keep the shown frame, reject the group's other undecided frames, advance to the next unit |
| Shift+P | keep, stay | keep the shown frame only, step to the group's next undecided frame (for two keepers from one burst) |
| X | reject, advance | reject the shown frame, step inside the group; the last undecided frame rejected advances |
| Shift+X | | reject every undecided frame of the group, advance |
| U | undo the last decision of this pass (a decision log, independent of app undo) | same |
| , . | | previous / next frame of the group (the strip under the picture) |
| ← → | previous / next unit without deciding (skipping is allowed, never rewarded: the counter does not move) | same |
| Space | toggle 100 % at the sharpest region (the max tile of plan 38), a second press fits | same |
| C | | Compare the shown frame with the group's suggested best (linked zoom, Cmd+Enter promotes, Esc back) |
| D | Develop this photo | same |
| Esc | back to the grid, focus on the unit left | same |

Auto-advance is always on in Decide (it is the point of the view); Shift therefore means "stay" here, not "invert
auto-advance" as in the grid. The grid's own keys are unchanged.

The header is the progress: *decided / total* of the current list and *kept / target*. The target is the user's
("Keep about…", a number or a share, stored per folder); without one the header shows kept only. When the undecided
count reaches zero the view says **Culled: 58 kept, 542 rejected**, offers *Review rejects…* (section 4.5) and
*Rate the keepers* (Survey over the picks), and the folder's sidebar row gets a small check. After 45 minutes in the
view, or 300 decisions, a one-line "Good place to stop?" appears above the key hint, dismissable, never modal.

### 4.4 Technical lenses

Three computed signals, surfaced as **lenses** in the filter bar (*Soft*, *Blown*, *Dark*) and as dim badges, with one
rule: **they rank and explain; they never flag.** Each is a view the user can select all of and press X on. The copy
says so ("Softest 10 % of the folder by local sharpness; intentional blur looks the same to this test").

- **Soft**: a sharpness score per photo (noise-corrected Laplacian variance per tile; `sharpnessMax` is the sharpest
  tile, so a portrait with sharp eyes and a creamy background is not soft) plus a motion flag (structure-tensor
  anisotropy). Absolute thresholds fail across scenes (a sky scores lower than a sharp forest), so the lens shows the
  folder's bottom decile by `sharpnessMax` and, inside a group, the rank against the group's best. The within-group
  rank is the useful one and is what the Decide strip shows.
- **Blown**: `clipHigh` (share of pixels with any channel ≥ 250 on the display-referred proxy) above 2 % ("worth a
  look") and 5 % ("likely blown"), suppressed when the photo is high-key (`medianLum` > 0.75) and marked *RAW headroom*
  when the source is RAW (a blown preview often recovers).
- **Dark**: `medianLum` < 0.1, suppressed when `clipHigh` is also high (a silhouette).

As built (Oct 13, 2026, plan 41): the high-key suppression of Blown holds only while `clipHigh` is at most 25 % (a
high-key frame clipped over a quarter is still blown); a silhouette is `medianLum` < 0.1 with `clipHigh` > 2 % and is
in neither Dark nor Blown; Soft is the decile by rank (`Math.round` of 10 % of the folder's photos with stats, ties at
the cut taken in folder order), so a folder under five photos has no Soft.

Why not AI here: the user's own point holds. Every AI culling tool carries the same complaint (dark frames rejected,
panning blur rejected, a laughing face called a blink), and Adobe needed a 2026 fix for intentional background blur. A
local metric that *ranks within a burst* is right nearly always, because the content is held constant; an absolute
verdict needs the intent, which only the user has. Faces and eyes (a permissive face model, eye aspect ratio) are a
later plan and follow the same rule.

### 4.5 Rejects to the Trash

Rejects stay in the folder, reversible, until the user asks. *Review rejects…* (Project ▾, the Cull menu, and the end
of a Decide pass) opens the **reject pile** of the source as a Survey-like grid: every reject of the folder, not the
filtered view (the Lightroom lesson). U rescues one (it becomes undecided and leaves the pile), Cmd+A then U rescues
all. The button at the bottom reads **Move 542 to the Trash…** and opens one dialog:

> Move 542 photos (3.1 GB) to the macOS Trash? Photobook cannot undo this. They stay in the Trash until you empty it.
> 4 of them are placed in *Lisbon book*: [keep those 4 in the folder] (checked by default).
> [Cancel] [Move 538 to the Trash]

The Rust command moves files with the `trash` crate (the same path project delete uses), along with a sidecar `.xmp`
of the same stem, never touches a file outside the imported root, and returns per-file results; the index and library
entries of moved files are dropped, projects placing them keep their asset ids and show Missing (as a relink would), the
cache under the hash is left for the cache cleaner. There is no "delete rejects" key; the only path is the pile.

## 5. Data

Everything new is optional, so the library and the index stay at version 1 and no book migration is needed.

**Folder index entry** (`index.json`, Rust `IndexEntry`, TS `IndexEntry` / `PhotoFile`), new optional fields written by
the prepare pass and the scan:

| Field | Type | Source |
| --- | --- | --- |
| `taken` | epoch ms, subsecond when the camera writes it | EXIF `DateTimeOriginal` + `SubSecTimeOriginal` (a string: "05" is 50 ms), else `DateTime`, else absent (mtime stays the fallback for sorting) |
| `make`, `model`, `lens`, `focal` | strings, mm | EXIF (`camera_exif` already reads make and model) |
| `phash` | 16 hex chars | DCT perceptual hash of the proxy |
| `stats` | `{ sharpness, sharpnessMax, motion, clipHigh, clipLow, medianLum }` | one pass over the proxy in `prepare` |

**Library** (`library.json`): `photos[hash].cull?: { group?: 'solo' | ULID }` (a manual detach or merge id) and a
top-level optional `cull?: { target?: number | { share: number }; culledAt?: string }`. Groups themselves are not
stored: `groupPhotos(entries, overrides, settings)` is a pure function in `packages/shared`.

**UI**: `ui.cull` gains `grouped: boolean`, `showStars: boolean`, `expanded: string | null` (the group open in place),
`view: 'decide'`, `decide?: { ids: string[]; index: number; frame: number; log: Decision[] }`. The flag filter gains
`'undecided'`. The lens is a filter-bar field `lens: 'none' | 'soft' | 'blown' | 'dark'` on `FilmstripView`, so a saved
collection can be "Soft in Lisbon".

## 6. Grouping algorithm

Pure TS, runs per source over index entries (milliseconds for ten thousand photos), tuned on real bursts in plan 39.

1. Sort by `taken` (then file name with the numeric collator; photos without `taken` are never grouped).
2. Walk in order. A frame joins the open group when: same `make`, `model` and `lens`, `focal` within 5 %, the gap to the
   group's last frame ≤ 2 s (`burstGap`), and `hamming(phash, last.phash)` ≤ 16. Otherwise it opens a new group.
   *As built (Oct 13, 2026, plan 39):* each camera and lens keeps its own open group (and step 3 merges per camera and
   lens), so a second camera firing mid-burst neither joins nor breaks it; read literally, this step split the burst
   fixture in two.
3. Merge adjacent groups when the gap between them is ≤ 30 s (`reshootGap`), the rig matches, and the smallest pairwise
   hash distance between them is ≤ 4 (the same subject shot again after a pause).
4. Apply overrides: `'solo'` removes a frame; frames sharing a merge ULID form one group whatever the maths said.
5. Groups of one are not groups. Inside a group, frames keep capture order; the **suggested best** is the highest
   `score`, ties to the earliest:

```
sharp  = min(1, sharpnessMax / best(sharpnessMax in group))
motion = (motion > 0.6 && sharpness < 0.7 * best(sharpness)) ? 0.5 : 1
clip   = 1 - 0.5 * clamp((clipHigh - 0.02) / 0.08) - 0.25 * clamp((clipLow - 0.05) / 0.2)
score  = sharp * motion * clip
```

Only the stats are persisted; thresholds live in code, so tuning never needs a rescan. The grouping settings
(`burstGap`, `reshootGap`, the hash distances) are one object with defaults and a *Grouping: tighter / looser* control
in the filter bar's Group menu that scales the two gaps.

Known limits, named in the UI copy: a camera that writes no subsecond time can split a burst across a second boundary
(the hash test catches most); a body without `SubSecTime` at all groups on whole seconds; two cameras in one folder
never share a group (by design).

## 7. Implementation plans

Five plans in the format of `plans/README.md`, one session each, to be split into `plans/38-…` to `plans/42-…` when
started. 38 and 39 are the foundation; 40, 41 and 42 can run in parallel after 39.

### 38 · Capture time and photo stats in the index

Size: 1.5 days. Depends on: nothing new (plans 02, 05, 23).

**Goal.** Every prepared photo records when it was taken, with what, a perceptual hash and six technical numbers, in
the folder index, so grouping and lenses are pure functions over the index.

**Decisions.** Stats are computed in `prepare` on the 8-bit proxy already in memory (RAW through `prepare_raw`'s
proxy too), about 10 to 15 ms a photo, in the same pass that encodes the thumbnail; nothing is decoded twice. A cache
hit (`cached()`) without stats in `meta.json` recomputes them from the cached `proxy.jpg`. `taken` uses `kamadak-exif`
(already a dependency); the hash uses the `image_hasher` crate (MIT / Apache-2.0), DCT 8×8. Sorting by *time* uses
`taken` when present, else mtime, in both `libraryKeys` and the Design filmstrip.

**Steps.**
1. Rust `crates/develop/src/stats.rs` (no Tauri): `photo_stats(gray: &[u8], rgb: &[u8], w, h, sigma: Option<f32>) ->
   PhotoStats` (tile Laplacian variance with noise correction, structure-tensor anisotropy, histogram clip shares and
   median) and `phash(gray, w, h) -> u64`; `camera_meta.rs` gains `taken`, `lens`, `focal`, `serial`.
2. `commands/assets.rs`: `Meta` and `AssetInfo` carry `taken`, `lens`, `focal`, `phash`, `stats`; `prepare` fills them;
   `cached()` backfills from `proxy.jpg` when `meta.json` predates the field.
3. `IndexEntry` (Rust and `lib/tauri.ts`), `PhotoFile`, the prepare patch in `store/library.ts` and `indexOf` carry the
   new fields; `scan_folder`'s `apply_index` keeps them on an unchanged file.
4. `libraryKeys` and the filmstrip sort by `taken ?? mtime`.
5. A `photobook stats <folder>` CLI subcommand (debug) prints the fields for a folder.

**Check.** Fixture photos under `crates/develop/tests/fixtures/` (a sharp, a defocused, a motion-blurred, a bokeh
portrait, a blown and a dark frame): the sharp ranks above the others on `sharpnessMax`, the portrait is not below the
defocused one, motion > 0.6 only on the panned frame, clip shares within 1 % of a Python reference; a JPEG with
`SubSecTimeOriginal "05"` yields `taken` ending in 050 ms; `cargo check --no-default-features` builds; a folder scanned
by the previous version gains the fields on the next prepare without a rescan (Vitest on the patch path).

**Docs.** `CLAUDE.md` index fields; `crates/develop/README.md` stats module.

### 39 · Groups in the grid

Size: 2 days. Depends on: 38, 06.

**Goal.** Bursts and re-shots are one cell each, expandable in place, with a suggested best, and nothing grouped is ever
hidden from filters, search or counts.

**Decisions.** The algorithm of section 6, in `packages/shared/src/cull/groups.ts` (`groupPhotos`, `suggestedBest`,
`GroupSettings` defaults). Overrides are library data (`photos[hash].cull.group`), written through `patchPhoto` outside
undo like `ai`. The grid's row model is a list of units (a photo or a group), built with the virtualiser from the
filtered ids; a group whose frames are only partly in the filter shows the matching ones. Keys: `G` expand / collapse,
`,` `.` step the shown frame, `Cmd+G` select the group; the group's badge click expands too.

**Steps.**
1. Shared `groups.ts` with tests on synthetic entries (gaps, rig change, hash jump, re-shoot merge, overrides, no
   `taken`).
2. `store/cull.ts` (new): `useGroups(sourceKey)` memoised over the folder's index entries and overrides; `setGrouped`,
   `expandGroup`, `splitGroup`, `mergeSelected`, `detach`.
3. `CullGrid`: unit rows, the group cell (stacked edge, `+N`, decided counts), expansion in place (the frames take the
   group's row(s), with a left accent bar), the keys, Cmd+A over photos; selection stays photo-keyed.
4. Filter bar: *Group* toggle with a menu (tighter / looser, *Merge selected*, *Split group*, *Ungroup*); counts stay
   photo counts.
5. Compare (C) on a collapsed group opens the shown frame against the suggested best; Survey (N) on a group surveys
   its frames.
6. Right-click menu items: Merge into one group, Split, Detach.

**Check.** Vitest: a filter that matches two of five frames shows a group cell of two; Cmd+A under a filter selects
photos, not groups; expanding keeps the scroll and the focus; `,` `.` wrap inside the group; overrides survive a
restart (library round trip); the Lightroom case (search matches a frame inside a collapsed group) finds it. A grouped
real folder (the lisbon fixture plus a burst fixture) is looked at by a person before the plan is marked done.

**Docs.** `README.md` Cull keys; `DESIGN_NOTES.md` group cell spec.

### 40 · The Decide pass, target and progress

Size: 2 days. Depends on: 39, 07.

**Goal.** One view that walks the undecided photos one unit at a time with two keys, shows how far along the cull is
and against what target, and ends.

**Decisions.** `DecideView.tsx` in `components/cull/`, a sibling of Compare and Survey (same header height, same key
hint line), reusing `urlsOf` and `viewport.ts`; `ReviewMode` is untouched. The decision log (`ui.cull.decide.log`) is
the pass's own undo (U), separate from app undo, since flags are not undo steps. The target and `culledAt` are
library top-level fields; the flag filter gains *Undecided*; the UI words become Keep / Reject / Undecided everywhere
in Cull (Review and Develop keep their key hints but say Keep for P). Stars hidden behind `ui.cull.showStars`.

**Steps.**
1. Shared: `FlagFilterSchema` gains `'undecided'`; `matchesFilter` and `viewFilter`; `LibrarySchema` optional `cull`.
2. `DecideView`: units from the grid's list, the frame strip for a group, the key table of 4.3, Space to the sharpest
   tile (`stats` gives the tile index; fall back to centre), C into Compare and back, progress header, the *Target*
   popover (number or share, per folder), the "culled" end state with its two buttons, the pause nudge (a timer and a
   decision counter, dismiss remembered for the session).
3. Grid: Enter opens Decide on the focused unit (Space keeps opening Review); a *Decide* button and the progress
   fraction in the filter bar; the sidebar's folder row shows a check when `culledAt` is set and no undecided photo
   remains (cleared when a new photo arrives).
4. Rename labels: *Pick* → *Keep*, *Unflag* → *Undecided* in the filter bar, menus, key hints and README.

**Check.** Vitest: P on a group of five writes one library update (one kept, four rejected) and advances to the next
unit; Shift+P keeps and steps; X on the last undecided frame advances; U reverts exactly the last decision including a
group decision; ← → skip without changing the counter; the end state appears when undecided reaches zero and
disappears when U brings one back; target as a share computes against the list; the pause nudge fires at 300
decisions in a test clock; keyboard parity table extended with Decide. Verified by a person on a real folder of a few
hundred photos: the pass should feel like it moves.

**Docs.** `README.md` (feature bullet, Decide keys table); `DESIGN_NOTES.md` Decide view spec.

### 41 · Technical lenses

Size: 1 day. Depends on: 38, 39.

**Goal.** Soft, Blown and Dark as lenses in the filter bar and as explanations in Decide and on hover, with the rule in
the copy: they rank, the user decides.

**Decisions.** A lens is a filter-bar field (`lens`) on `FilmstripView`, saved in collections; thresholds in one
`packages/shared/src/cull/lenses.ts` object (decile for Soft, 2 % / 5 % for Blown, 0.1 for Dark, the high-key and
silhouette suppressions). Badges are dim glyphs in the cell's top-right row next to the edited dot, with a tooltip
that gives the number and the caveat. No lens ever writes a flag; the way to reject a lens is Cmd+A, X, like any
selection.

**Steps.**
1. Shared `lenses.ts`: `lensOf(entry, folderStats)` and `folderStats(entries)` (the decile cut), with tests on the
   fixture stats.
2. Filter bar: a *Lens* select (None, Soft, Blown, Dark) with the count, the one-line caveat under the grid while a
   lens is on, and *RAW headroom* shown on Blown for RAW sources.
3. Cell badges and tooltips; the Decide strip's "sharpest ●" and the per-frame bar under each thumbnail (relative to
   the group's best); a *Worth a look* built-in collection (any lens) listed only when stats exist.
4. Right-click: *Select the group's softer frames* (everything but the suggested best).

**Check.** Vitest: the bokeh portrait fixture is not in Soft; the silhouette fixture is in neither Dark nor Blown; a
high-key fixture is not in Blown; a lens plus a flag filter composes; a collection saved with a lens reopens with it.

**Docs.** `README.md` lenses paragraph (with the caveat verbatim); `DESIGN_NOTES.md` badges.

### 42 · The reject pile and the Trash

Size: 1.5 days. Depends on: 40, 01 (scope), the `trash` crate path in `commands/projects.rs`.

**Goal.** One staged, bounded path from rejects to the macOS Trash: review the whole pile, rescue, confirm with the
real count, keep the place.

**Decisions.** Rust `trash_photos(folder, relPaths) -> Vec<{ path, ok, error? }>`: `ensure_imported_root`,
`resolve_rel` per file, `move_to_trash` (NsFileManager, recoverable), a sibling `.xmp` with the same stem goes along,
`.photobook-cache` renders are not touched. The command is not a job (it is seconds) but is cancel-safe per file. The
pile is always the source's full reject set, never the filtered view. Photos placed in any project are listed and
excluded by default; moving them anyway leaves Missing assets (the relink path already handles it). After the move the
index and library entries are dropped (the library entry only when no other file in the folder has the hash), the
grid focus goes to the next unit, and a toast says how many moved and names the failures. Capability: nothing new
(`trash` is native); `README.md` states the files go to the Trash and can be put back from there.

**Steps.**
1. Rust `commands/photos.rs` (new): `trash_photos`; register in `lib.rs`; tests on a temp root (out-of-root path
   refused, sidecar moved, result per file).
2. `lib/tauri.ts` wrapper; `store/library.ts` `dropPhotos(folder, relPaths)` (index, library, in-memory `folders[id]`).
3. `RejectPileView.tsx`: the Survey layout over the full reject set, U rescues, Cmd+A, the bottom bar with the size
   sum and the button; the dialog with the count, size, the projects line and the checkbox; the toast.
4. Entry points: Project ▾ → *Review rejects…*, the Cull menu, the Decide end state; disabled with zero rejects.
5. Docs: a *Deleting photos* paragraph in `README.md` and the DESIGN_NOTES dialog spec.

**Check.** Rust: a path with `..` or outside the root is refused; a RAW with its `.xmp` moves both; a failure on one
file does not stop the rest. Vitest (wrapper mocked): the pile ignores the active filter; rescue removes from the pile
and sets undecided; the placed-in-project count and exclusion; after a move the index and library lose the entries and
the focus lands on the next unit; the project keeps its asset id and shows Missing. A person moves rejects on a copy
of a real folder and puts one back from the Trash.

**Docs.** `README.md`, `DESIGN_NOTES.md`, `CLAUDE.md` (the command and the rule that the Trash is the only delete).

### Later, not planned here

- **Faces and eyes** (a permissive face detector such as BlazeFace, Apache-2.0, with eye aspect ratio for blinks),
  surfaced as a *Close-ups* strip in Decide and as an *Eyes* lens, under the same never-flag rule.
- **Second visual signal** (normalised cross-correlation on the 32 px thumbnail) if real bursts show false splits that
  the hash alone misses.
- **Rate the keepers**: a Survey over the picks with stars, for users who deliver by rating.
- **AI explanation** through the existing Messages command (plan 32) for a group ("what differs between these"), opt-in
  and per group, never in the pass.

## 8. Sources

Psychology and human factors:

- Baumeister, Bratslavsky, Muraven & Tice (1998), *Ego depletion: Is the active self a limited resource?*, JPSP 74.
  Vohs et al. (2008), *Making choices impairs subsequent self-control*, JPSP 94. Contested: Hagger et al. (2016), *A
  multilab preregistered replication of the ego-depletion effect*, PPS 11; Carter et al. (2015), JEP:General 144.
- Danziger, Levav & Avnaim-Pesso (2011), *Extraneous factors in judicial decisions*, PNAS. Contested: Weinshall-Margel &
  Shapard (2011) PNAS letter; Glöckner (2016), *The irrational hungry judge effect revisited*, JDM 11.
- Levav, Heitmann, Herrmann & Iyengar (2010), *Order in product customization decisions*, JPE 118.
- Iyengar & Lepper (2000), *When choice is demotivating*, JPSP 79. Scheibehenne, Greifeneder & Todd (2010), *Can there
  ever be too many options?*, JCR 37.
- Hick (1952), *On the rate of gain of information*, QJEP 4; Hyman (1953).
- Preston & Colman (2000), *Optimal number of response categories in rating scales*, Acta Psychologica 104.
- Mantiuk, Tomaszewska & Mantiuk (2012), *Comparison of four subjective methods for image quality assessment*, CGF 31.
- Dhar (1997), *Consumer preference for a no-choice option*, JCR 24; Tversky & Shafir (1992), *Choice under conflict*.
  Contested: Evangelidis, Levav & Simonson (2023), Management Science 69.
- Schwartz et al. (2002), *Maximizing versus satisficing*, JPSP 83.
- Kahneman, Knetsch & Thaler (1990), *Experimental tests of the endowment effect and the Coase theorem*, JPE 98.
  Arkes & Blumer (1985), *The psychology of sunk cost*, OBHDP 35.
- Stewart, Chater & Brown (2006), *Decision by sampling*, Cognitive Psychology 53. Thurstone (1927), *A law of
  comparative judgment*. Verhavert et al. (2019) on comparative-judgment reliability.
- Hull (1934), goal gradient; Kivetz, Urminsky & Zheng (2006), *The goal-gradient hypothesis resurrected*, JMR 43.
  Myers (1985), *The importance of percent-done progress indicators*, CHI '85. Ghibellini & Meier (2025), Zeigarnik
  meta-analysis, Humanities and Social Sciences Communications 12.
- Ariga & Lleras (2011), *Brief and rare mental breaks keep you focused*, Cognition 118 (contested: Helton & Russell
  2012). Csikszentmihalyi (1990), *Flow*.
- Torralba (2009), *How many pixels make an image?*, Visual Neuroscience 26. Sinha et al. (2006), *Face recognition by
  humans: Nineteen results*, Proc. IEEE 94. Trentacoste et al. (2011), *Blur-aware image downsizing*, Eurographics.
  Park, Triantaphillidou et al. (2014), *Evaluation of perceived image sharpness with changes in the displayed image
  size*, SPIE.
- Johnson & Goldstein (2003), *Do defaults save lives?*, Science 302. Gilbert & Ebert (2002), *Decisions and
  revisions*, JPSP 82.
- Practitioners: Narrative blog (McPherson interview; shot-to-delivered 3:1 to 4:1), PetaPixel *How to cull and edit
  wedding photos quickly*, Imagen *How long to cull 3,000 photos*, glass.photo on culling.

Tools (help centres and reviews, 2025–2026): Narrative Select (keyboard shortcuts, AI First Pass, face and focus
assessments, Scenes; Fstoppers and Shotkit reviews), Aftershoot (shortcuts, culling preferences, blur settings, Cull to
Target, the "best of a bad set" warning; G2 and Photofocus reviews), FilterPixel (shortcuts, Auto-Select, benchmark
page), Photo Mechanic (colour classes, preferences), Lightroom Classic (stacks help page, Assisted Culling learn page
and the Early Access forum thread, Delete Rejected Photos and the "No photos to delete" thread, the collapsed-stack
filter thread), Capture One (Cull view, Group Overview, Face Focus, the AI Culling thread), Apple Photos burst help,
Google Pixel Top Shot, Slidebox, Swipewipe, Gemini Photos.

Technical:

- Platt, Czerwinski & Field (2003), *PhotoTOC*, MSR-TR-2002-17. Cooper, Foote, Girgensohn & Wilcox (2005), *Temporal
  event clustering for digital photo collections*, ACM TOMCCAP 1(3). PhotoCluster (VISAPP 2014). Columbia DVMM
  near-duplicate detection (about 19 % of consumer frames are non-identical duplicates).
- Krawetz, *Looks like it* (aHash, pHash, dHash and the 0 / ≤ 5 / ≥ 10 Hamming bands); Yang, Gu & Niu, blockhash;
  the `image_hasher` crate (MIT / Apache-2.0).
- Pech-Pacheco et al. (2000), variance of Laplacian; Pertuz, Puig & García (2013), *Analysis of focus measure
  operators in shape-from-focus*, Pattern Recognition 46; Narvekar & Karam (2011), CPBD, IEEE TIP 20 (academic
  licence, not ported); Liu, Li & Jia (2008), blur classification, CVPR; US 8,068,668 (structure-tensor motion vs
  defocus).
- Lightroom clipping indicators (255 / 0 per channel), darktable clipping module defaults; Kasson and LibRaw on RAW
  highlight headroom.
- ExifTool forum and the Adobe fractional-seconds bug on `SubSecTimeOriginal`.
- Soukupová & Čech (2016), *Real-time eye blink detection using facial landmarks*, CVWW; BlazeFace (Apache-2.0);
  `rustface` (BSD-2).
