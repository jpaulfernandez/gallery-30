import { useEffect, useLayoutEffect } from 'react';
import { useCullStageMark } from '../../store/cull';
import { useUiStore } from '../../store/ui';
import { ReviewMode } from '../review/ReviewMode';
import { CompareView } from './CompareView';
import { CullGrid } from './CullGrid';
import { DecideView } from './DecideView';
import { RejectPileView } from './RejectPileView';
import { closeRejectPile, openRejectPile, useRejectPileStore } from './rejectPile';
import { SurveyView } from './SurveyView';

/**
 * The Cull stage's main area over the `review` session: the grid, one photo in `ReviewMode` (Space on the
 * grid; Escape comes back to the grid where it was), two side by side (`CompareView`, C) or a survey of several
 * (`SurveyView`, N; plan 07) or the Decide pass (`DecideView`, Enter; plan 40). `ui.cull.view` says which. The reject
 * pile (`RejectPileView`, plan 42: *Review rejects…*) shows over whichever it is, and Esc comes back to it.
 */
export function CullView({ onDevelop }: { onDevelop?: (id: string) => void }) {
  const view = useUiStore((s) => s.cull.view);
  const pile = useRejectPileStore((s) => s.open);
  if (pile) return <RejectPileView />;
  if (view === 'review') {
    return <ReviewMode inline onDevelop={onDevelop} onClose={() => useUiStore.getState().setCull({ view: 'grid' })} />;
  }
  if (view === 'compare') return <CompareView onDevelop={onDevelop} />;
  if (view === 'survey') return <SurveyView onDevelop={onDevelop} />;
  if (view === 'decide') return <DecideView onDevelop={onDevelop} onReviewRejects={openRejectPile} />;
  return <CullGrid onDevelop={onDevelop} />;
}

/**
 * `CullView` for one source (`sourceKey`: a folder, a collection, the project): another source remounts it, so the grid
 * never keeps the previous source's scroll, and opens on the grid at the top (`useCullSource`), with no Decide pass.
 */
export function CullStage({ sourceKey, onDevelop }: { sourceKey: string; onDevelop?: (id: string) => void }) {
  useCullSource(sourceKey);
  useCullStageMark();
  // Leaving the Cull stage closes the reject pile.
  useEffect(() => closeRejectPile, []);
  return <CullView key={sourceKey} onDevelop={onDevelop} />;
}

/**
 * Keep the selection within `ids` (the list on screen): photos a filter or a new source hides leave it, and an anchor
 * that left it is dropped, so Cmd+A, a range or a batch never reaches a photo that is not shown.
 */
export function keepSelectionWithin(ids: readonly string[]): void {
  const { selection, setSelection } = useUiStore.getState();
  if (selection.keys.length === 0 && selection.anchor === null) return;
  const shown = new Set(ids);
  const keys = selection.keys.filter((k) => shown.has(k));
  const anchor = selection.anchor !== null && shown.has(selection.anchor) ? selection.anchor : null;
  if (keys.length !== selection.keys.length || anchor !== selection.anchor) setSelection(keys, anchor);
}

/** The source the grid showed last (`useCullSource`). */
let lastSource: string | null = null;

/**
 * Another source (a folder, a collection, the project) opens on the grid at the top; coming back to the same one keeps
 * the view and the scroll. A layout effect: it runs in the grid's first commit, before the grid (which has no width
 * until its own first layout effect) restores `ui.cull.scrollTop`.
 */
export function useCullSource(sourceKey: string): void {
  useLayoutEffect(() => {
    if (lastSource !== sourceKey) {
      useUiStore
        .getState()
        .setCull({ view: 'grid', scrollTop: 0, compare: undefined, survey: undefined, decide: undefined });
      closeRejectPile();
    }
    lastSource = sourceKey;
  }, [sourceKey]);
}
