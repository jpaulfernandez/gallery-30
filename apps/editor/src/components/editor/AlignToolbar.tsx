import type { Frame } from '@photobook/shared';
import type { ReactNode } from 'react';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { alignSelection, distributeSelection, matchSelection, tidySelection } from './frameActions';
import {
  AlignBottomIcon,
  AlignCenterIcon,
  AlignLeftIcon,
  AlignMiddleIcon,
  AlignRightIcon,
  AlignTopIcon,
  DistributeHorizontalIcon,
  DistributeVerticalIcon,
  MatchHeightIcon,
  MatchWidthIcon,
  TidyIcon,
} from './icons';

const pct = (n: number) => `${n * 100}%`;

/**
 * Plan 48: the canvas's floating pills (the selection and alignment toolbars, the tool group, the zoom HUD, the Adjust
 * hint): `panel-3`, a hairline, the float shadow. The toolbars are `lg` (12 px), the HUD and the hint full pills.
 */
export const canvasPill = 'border border-hairline bg-panel-3 shadow-float';

/** Above the selection when there is room on the page, else under it (page-height fraction). */
const ROOM_ABOVE = 0.08;

interface Action {
  label: string;
  icon: ReactNode;
  run: () => boolean;
  /** Elements the action needs. */
  min: number;
}

/** Groups of the toolbar, separated by a thin rule. */
const GROUPS: Action[][] = [
  [
    { label: 'Align left', icon: <AlignLeftIcon />, run: () => alignSelection('left'), min: 2 },
    { label: 'Align centre', icon: <AlignCenterIcon />, run: () => alignSelection('center'), min: 2 },
    { label: 'Align right', icon: <AlignRightIcon />, run: () => alignSelection('right'), min: 2 },
    { label: 'Align top', icon: <AlignTopIcon />, run: () => alignSelection('top'), min: 2 },
    { label: 'Align middle', icon: <AlignMiddleIcon />, run: () => alignSelection('middle'), min: 2 },
    { label: 'Align bottom', icon: <AlignBottomIcon />, run: () => alignSelection('bottom'), min: 2 },
  ],
  [
    {
      label: 'Distribute horizontally',
      icon: <DistributeHorizontalIcon />,
      run: () => distributeSelection('x'),
      min: 3,
    },
    { label: 'Distribute vertically', icon: <DistributeVerticalIcon />, run: () => distributeSelection('y'), min: 3 },
  ],
  [
    {
      label: 'Match width (of the last selected)',
      icon: <MatchWidthIcon />,
      run: () => matchSelection('width'),
      min: 2,
    },
    {
      label: 'Match height (of the last selected)',
      icon: <MatchHeightIcon />,
      run: () => matchSelection('height'),
      min: 2,
    },
  ],
  [{ label: 'Tidy: equal gaps on each row, on the gutter', icon: <TidyIcon />, run: () => tidySelection(), min: 2 }],
];

/**
 * Alignment toolbar over a multi-selection (workflow plan 30): align left / centre / right / top /
 * middle / bottom to the selection's bounding box, distribute horizontally / vertically (three or
 * more), match width / height to the last selected element, and Tidy (equal gaps on the current
 * rows, on the page's gutter rhythm). Each button is one undo step (frameActions.ts).
 */
export function AlignToolbar({ box, count }: { box: Frame; count: number }) {
  const above = box.y >= ROOM_ABOVE;
  return (
    <div
      data-canvas-ui
      role="toolbar"
      aria-label="Align"
      className={`pointer-events-auto absolute z-10 flex items-center gap-0.5 whitespace-nowrap rounded-lg p-0.5 ${canvasPill}`}
      style={{
        left: pct(box.x),
        top: above ? `calc(${pct(box.y)} - 44px)` : `calc(${pct(box.y + box.h)} + 10px)`,
      }}
    >
      {GROUPS.map((group, i) => (
        <div key={group[0]?.label} className={`flex gap-0.5 ${i > 0 ? 'border-hairline border-l pl-0.5' : ''}`}>
          {group.map((a) => {
            const disabled = count < a.min;
            const title = disabled ? `${a.label} (select ${a.min} or more)` : a.label;
            return (
              <Tooltip key={a.label} label={title}>
                <Button
                  variant="ghost"
                  aria-label={a.label}
                  disabled={disabled}
                  onClick={() => a.run()}
                  size="lg"
                  icon={a.icon}
                />
              </Tooltip>
            );
          })}
        </div>
      ))}
    </div>
  );
}
