import { CountUp } from '../ui/CountUp';

/**
 * Plan 45: a Library sidebar row (ODDHALLS_UI_PLAN 3): 26 px, `sm` radius; the current row has a `panel-3` fill and a
 * 2 px `accent` bar at its left; hover is a 6 % white wash. Shared by `Sidebar` and the kitchen sink's Shell page.
 */
export const sidebarRowClass = (active: boolean) =>
  `relative flex h-[26px] min-w-0 shrink-0 items-center gap-2 rounded-sm px-2 text-xs outline-none transition-colors duration-fast focus-visible:ring-2 focus-visible:ring-accent ${
    active
      ? 'bg-panel-3 text-fg before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-pill before:bg-accent'
      : 'text-fg-2 hover:bg-fg/6 hover:text-fg'
  }`;

/**
 * A row's count: mono, `fg-muted`, counting up the first time the sidebar shows it and as a scan finds photos.
 * `id` names the row, so the sidebar of another route (library, a project's Cull) starts from the same number.
 */
export function RowCount({ value, id }: { value: number; id?: string }) {
  return <CountUp value={value} memoryKey={id} className="text-[11px] text-fg-muted" />;
}
