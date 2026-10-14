# 07 · Cull compare and survey

Status: done 2026-10-13, with these deviations. `ReviewMode` has no zoom or pan, so there was nothing to reuse there:
the viewport is new (`components/cull/viewport.ts`, `useLinkedViewport`); `ReviewMode` only exports `urlsOf` (the proxy
and thumbnail of a photo, developed render when one matches), which both views use. The plan's zoom keys 1, 2, 4 are the
rating keys, so zoom is K / J (and Cmd+= / Cmd+−) through Fit, 1×, 2×, 4×, F for fit, and the header's buttons; 1× is
one pixel of the 1600 px proxy per device pixel (so it divides by `devicePixelRatio`), not the original's, and zoom is
offered only when both photos have their proxy (a pane on its thumbnail alone holds both at fit, "Preparing preview…").
The loupe point is clamped per axis so the picture always fills the pane (centred where it is smaller). Tab on a
button, link or select (the filter bar) keeps its browser meaning and does not switch panes. The loupe point is the shared centre of the viewport (click a
detail: both panes zoom to 1× there; drag pans both). Compare: the candidate is the first selected photo (or the
focused one), the select the second (or the next one, the previous on the last photo); arrows step the candidate and
skip the select; Cmd+Enter makes the candidate the select and the next photo that is neither it nor the old select the candidate (with none ahead it steps back to the nearest one before, and with no third photo it does nothing); Tab or a click moves the
rating and flag keys between the panes, and rating the candidate auto-advances it like Review. Survey: N needs two or
more photos (the selection, else the picks), the last tile refuses X ("until one remains"), Shift+click marks tiles
that X and the rating keys then act on together, and Esc selects the survivors and puts the grid's focus on the tile
the survey ended on. `ui.cull` gained optional `compare` and `survey` (the photos each view shows); a source change
clears them. C and N are grid keys only (Review does not open them). As in plan 06, ratings and flags are not undo
steps, so "one undo step" is one batched store write (the tests count it: one library update, no new undo state).
Verified by Vitest (viewport clamp, dpr and survey-layout maths, Compare open, step, promote from the opening state and at
the end, linked zoom, edge clicks and long drags, proxy missing, Tab outside the panes, pane focus, auto-advance, stale
list or select leaving; Survey open from the selection and the picks, X remove in one write, marks including the
focused tile and every tile, real auto-advance, Esc survivors; keyboard parity with C and N); the UI was not looked at.

WORKFLOW_PLAN [1.1](../WORKFLOW_PLAN.md#11-three-stages-one-top-bar) (W2.2). Size: 1 day. Depends on: 06.

**Goal.** Two ways to choose between near-duplicates: Compare (C) puts two photos side by side with linked zoom and
pan; Survey (N) tiles the selection and lets you reject from it until one remains.

## Decisions

- Compare: left is the *candidate*, right the *select*; arrows swap the candidate through the filtered list; Cmd+Enter
  makes the candidate the select. Linked zoom (1, 2, 4×, fit) and pan on both; a loupe point shared between them.
- Survey: the selection (or picks when nothing is selected), grid sized to fit, X removes a photo from the view and
  sets reject, rating keys act on the focused tile; Esc leaves with the survivors selected.
- Both are views inside `/cull`, state in `ui.cull.view: 'grid' | 'review' | 'compare' | 'survey'`; no new routes.

## Steps

1. `components/cull/CompareView.tsx`: two `ReviewMode`-style panes sharing a `ViewportState` (zoom, pan) through a small
   `useLinkedViewport` hook; the proxy image on each side; rating and flag keys target the focused pane.
2. `components/cull/SurveyView.tsx`: CSS grid of proxies, `X` rejects and removes, stars rate, click focuses,
   Shift+click selects; survivors become the selection on exit.
3. Keys in the Cull key handler: C opens Compare on the focused photo plus the next one (or the first two selected),
   N opens Survey, Esc returns to the grid. Keys listed in the Cull help overlay.
4. Both reuse the proxy loading of `ReviewMode` (`fileUrl` of `proxy.jpg`), never decode originals.

## Check

- Component tests: Compare swap and linked zoom, Survey reject removes the tile and writes the flag in one undo step,
  Esc restores the grid selection to the survivors.
- Keyboard parity test extended with C and N.

## Docs

- `README.md` keys; `docs/design/DESIGN_NOTES.md` Cull section.
