import type { PhotoLookup } from '../../store/assets';
import { type CullCompare, useUiStore } from '../../store/ui';

/** A collapsed group cell the grid has the focus on (plan 39): the frames it holds, the one shown, the suggested best. */
export interface FocusedGroup {
  /** The group's photos in the list, in capture order. */
  frames: readonly string[];
  shown: string;
  best: string;
}

/**
 * C on the grid: Compare opens on the first two selected photos (the first is the candidate), else, on a collapsed
 * group (`group`), on the shown frame against the group's suggested best (the next frame when the shown one is the
 * best), else on the focused photo and the next one (the previous when it is the last). False, and nothing changes,
 * with fewer than two photos. `options.groupFirst` (plan 52's *Compare with best*) takes the group even with a
 * selection; `options.back` is where Esc returns (Decide).
 */
export function openCompare(
  group?: FocusedGroup,
  options: { groupFirst?: boolean; back?: CullCompare['back'] } = {},
): boolean {
  const { review, selection, setCull, setReviewIndex } = useUiStore.getState();
  if (!review) return false;
  const picked = selection.keys.filter((id) => review.ids.includes(id));
  const focused = review.ids[review.index];
  const inGroup = (picked.length < 2 || options.groupFirst === true) && group !== undefined;
  const candidate = inGroup ? group.shown : picked.length >= 2 ? picked[0] : focused;
  const select = inGroup
    ? group.best !== group.shown && group.frames.includes(group.best)
      ? group.best
      : group.frames[(group.frames.indexOf(group.shown) + 1) % group.frames.length]
    : picked.length >= 2
      ? picked[1]
      : (review.ids[review.index + 1] ?? review.ids[review.index - 1]);
  if (!candidate || !select || candidate === select) return false;
  setReviewIndex(review.ids.indexOf(candidate));
  setCull({ view: 'compare', compare: { candidate, select, ...(options.back ? { back: options.back } : {}) } });
  return true;
}

/**
 * N on the grid: Survey opens on the selection, else on the frames of the focused group (`groupFrames`, plan 39), else
 * on the picks of the list shown, in the grid's order. False, and nothing changes, when that is fewer than two photos
 * (there is nothing to choose between).
 */
export function openSurvey(lookup: PhotoLookup, groupFrames?: readonly string[]): boolean {
  const { review, selection, setCull } = useUiStore.getState();
  if (!review) return false;
  const chosen = new Set(selection.keys);
  const ids =
    chosen.size > 0
      ? review.ids.filter((id) => chosen.has(id))
      : groupFrames
        ? groupFrames.filter((id) => review.ids.includes(id))
        : review.ids.filter((id) => lookup.fields(id)?.flag === 'pick');
  if (ids.length < 2) return false;
  setCull({ view: 'survey', survey: { ids } });
  return true;
}
