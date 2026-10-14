import { type ReactNode, useEffect } from 'react';
import { type PaneStage, useUiStore } from '../../store/ui';
import { paneKeyAction } from '../cull/keys';
import { dialogOpen } from '../ui/DialogShell';

/**
 * The shell of a stage (plan 51, ODDHALLS_LAYOUT_PLAN 2): the top bar, then the left pane, the centre and the right
 * pane, then the strip. Each pane shows when the stage has one and `ui.panes[stage]` has it on (Tab, Shift+Tab; per
 * stage and per machine). The Cull, Design and the library's Develop routes lay out through it; the Develop view lays
 * out its own panes from the same state. Plan 52's Photo pane is Cull's `right`.
 */
export function PaneShell({
  stage,
  top,
  left,
  leftWidth = 220,
  right,
  rightWidth = 300,
  strip,
  children,
}: {
  stage: PaneStage;
  /** The top bar (44 px). */
  top: ReactNode;
  left?: ReactNode;
  /** px (Layout 2: 220). */
  leftWidth?: number;
  right?: ReactNode;
  /** px (Layout 2: 300). */
  rightWidth?: number;
  strip?: ReactNode;
  /** The centre. */
  children: ReactNode;
}) {
  const panes = useUiStore((s) => s.panes[stage]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-stage={stage}>
      {/* The bars keep their old grid spans (`col-span-*`), which mean nothing in this flex column. */}
      <div className="flex h-11 shrink-0 flex-col *:flex-1">{top}</div>
      <div className="flex min-h-0 flex-1">
        {left !== undefined && panes.left && (
          <div
            data-pane="left"
            style={{ width: leftWidth }}
            className="grid min-h-0 shrink-0 grid-rows-[minmax(0,1fr)]"
          >
            {left}
          </div>
        )}
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">{children}</div>
        {right !== undefined && panes.right && (
          <div
            data-pane="right"
            style={{ width: rightWidth }}
            className="grid min-h-0 shrink-0 grid-rows-[minmax(0,1fr)]"
          >
            {right}
          </div>
        )}
      </div>
      {strip !== undefined && panes.strip && (
        <div data-pane="strip" className="shrink-0">
          {strip}
        </div>
      )}
    </div>
  );
}

/**
 * Cull's Tab and Shift+Tab (`paneKeyAction`): the side panes, and with Shift the strip too. Not while Develop is open
 * over Cull (it has its own), in Compare (Tab picks the pane the keys act on there) or while a dialog is open. Off
 * unless `enabled` (the library route mounts it on Develop too, where Tab is the Develop view's).
 */
export function useCullPaneKeys(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const ui = useUiStore.getState();
      if (e.defaultPrevented || ui.develop || ui.cull.view === 'compare' || dialogOpen()) return;
      const pane = paneKeyAction(e);
      if (!pane) return;
      e.preventDefault();
      ui.togglePanes('cull', pane);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
