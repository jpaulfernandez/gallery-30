/** Gap between Survey tiles, px. */
export const SURVEY_GAP = 8;

/**
 * Columns for `count` tiles in a `width` by `height` area that give the largest picture of the given `aspect` (width
 * over height) in each tile: few photos get large tiles, many get a near-square grid.
 */
export function surveyColumns(count: number, width: number, height: number, aspect = 1.5): number {
  if (count <= 1 || width <= 0 || height <= 0) return 1;
  let best = 1;
  let bestSize = -1;
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const cellW = (width - SURVEY_GAP * (columns - 1)) / columns;
    const cellH = (height - SURVEY_GAP * (rows - 1)) / rows;
    const picture = Math.min(cellW, cellH * aspect);
    if (picture > bestSize + 0.5) {
      best = columns;
      bestSize = picture;
    }
  }
  return best;
}
