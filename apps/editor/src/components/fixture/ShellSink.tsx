import { useState } from 'react';
import { useUiStore } from '../../store/ui';
import { RedoIcon, UndoIcon } from '../editor/icons';
import { JobsPillLabel, jobsPillClass } from '../shell/JobsBar';
import { LibraryFilters } from '../shell/LibraryFilterBar';
import { useCullPaneKeys } from '../shell/Panes';
import { SaveIndicator } from '../shell/SaveIndicator';
import { RowCount, sidebarRowClass } from '../shell/SidebarRow';
import { Button, buttonClass, IconButton } from '../ui/Button';
import { Input } from '../ui/Field';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui/Menu';
import { SegmentedTrack, segmentClass } from '../ui/Segmented';

/**
 * Plan 45: the shell of ODDHALLS_UI_PLAN 3 drawn from the real pieces (the row class and count of the sidebar, the
 * save indicator, the jobs pill, the stage tabs' track) on sample data, so the direction can be checked in a browser
 * without Tauri: the top bar with the traffic-light inset, the sliding stage tabs, Project ▾ and View ▾, the Library
 * sidebar with counts counting up and the current row's accent bar, the borderless filter bar and the jobs pill.
 * Plan 51: the sidebar's Filters section (the real `LibraryFilters`) and the Cull panes: Tab (or the button) hides the
 * sidebar, as `ui.panes.cull` says.
 */

const STAGES = ['cull', 'develop', 'design'] as const;
type SinkStage = (typeof STAGES)[number];

const FOLDERS = [
  { name: 'Lisbon 2026', count: 1284 },
  { name: 'Porto weekend', count: 312 },
  { name: 'Film scans', count: 58 },
];
const COLLECTIONS = [
  { name: 'Kept', count: 214 },
  { name: 'Edited', count: 96 },
  { name: 'Needs denoise', count: 17 },
];
const PROJECTS = ['Lisbon zine', 'Porto postcards'];

export function ShellSink() {
  const [stage, setStage] = useState<SinkStage>('cull');
  const [current, setCurrent] = useState('Lisbon 2026');
  const [grid, setGrid] = useState(true);
  const left = useUiStore((s) => s.panes.cull.left);
  useCullPaneKeys();
  const [replay, setReplay] = useState(0);
  const [progress, setProgress] = useState(0.4);

  const save = () => {
    useUiStore.getState().setSaveStatus('saving');
    setTimeout(() => useUiStore.getState().setSaveStatus('saved'), 120);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="shell-sink">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={save}>
          Simulate a save
        </Button>
        <Button
          size="sm"
          onClick={() => useUiStore.getState().setSaveStatus('error', 'Disk full: project not written')}
        >
          Simulate a failed save
        </Button>
        <Button size="sm" onClick={() => setReplay((r) => r + 1)}>
          Replay the counts
        </Button>
        <Button size="sm" onClick={() => setProgress((p) => (p >= 1 ? 0 : Math.min(1, p + 0.2)))}>
          Step the jobs ring
        </Button>
        <Button size="sm" onClick={() => useUiStore.getState().togglePanes('cull', 'panes')}>
          Toggle the panes (Tab)
        </Button>
      </div>

      <div className="relative flex h-[34rem] flex-col overflow-hidden rounded-md border border-hairline bg-stage">
        {/* The top bar: panel-2, a hairline under it, the 78 px inset where the traffic lights sit. */}
        <header className="relative grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-hairline border-b bg-panel-2 pr-3 pl-[78px]">
          <span aria-hidden="true" className="absolute top-1/2 left-4 flex -translate-y-1/2 gap-2">
            <span className="size-3 rounded-pill bg-fg/20" />
            <span className="size-3 rounded-pill bg-fg/20" />
            <span className="size-3 rounded-pill bg-fg/20" />
          </span>
          <div className="flex min-w-0 items-center gap-1">
            <Menu
              label={
                <>
                  Project <span aria-hidden="true">▾</span>
                </>
              }
              menuLabel="Project (shell)"
            >
              <MenuLabel>Lisbon zine</MenuLabel>
              <MenuItem>Rename…</MenuItem>
              <MenuItem>Save as…</MenuItem>
              <MenuItem>Caption brief…</MenuItem>
              <MenuItem>Cull its photos</MenuItem>
              <MenuItem>Close project</MenuItem>
              <MenuSeparator />
              <MenuLabel>Open</MenuLabel>
              <MenuItem>Porto postcards</MenuItem>
              <MenuItem>All projects · New project…</MenuItem>
            </Menu>
            <span className="truncate text-fg-muted text-xs">Lisbon zine</span>
          </div>
          <SegmentedTrack as="nav" aria-label="Stages (shell)" activeKey={stage}>
            {STAGES.map((s) => (
              <button
                key={s}
                type="button"
                data-segment-active={s === stage || undefined}
                aria-current={s === stage ? 'page' : undefined}
                onClick={() => setStage(s)}
                className={segmentClass(s === stage)}
              >
                {s[0]?.toUpperCase() + s.slice(1)}
              </button>
            ))}
          </SegmentedTrack>
          <div className="flex items-center justify-end gap-1">
            {stage === 'design' && (
              <Menu
                label={
                  <>
                    View <span aria-hidden="true">▾</span>
                  </>
                }
                menuLabel="View (shell)"
                alignEnd
                width={240}
              >
                <MenuItem checked={grid} onSelect={() => setGrid((g) => !g)}>
                  Show grid
                </MenuItem>
                <MenuItem checked={false}>Show rulers and guides</MenuItem>
              </Menu>
            )}
            <IconButton icon={<UndoIcon />} label="Undo" shortcut="⌘Z" />
            <IconButton icon={<RedoIcon />} label="Redo" shortcut="⇧⌘Z" disabled />
            <SaveIndicator className="ml-2 w-16" />
            <span className={`${buttonClass({ variant: 'ghost', size: 'sm' })} ml-1`}>Settings</span>
            {stage === 'design' && (
              <Button variant="primary" className="ml-3">
                Publish
              </Button>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* The Library sidebar: panel, no right border; rows 26 px, counts in mono counting up. */}
          {left && (
            <nav
              aria-label="Library (shell)"
              className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto bg-panel p-2"
              key={replay}
            >
              {[
                { title: 'Folders', rows: FOLDERS },
                { title: 'Collections', rows: COLLECTIONS },
                { title: 'Projects', rows: PROJECTS.map((name) => ({ name, count: null })) },
              ].map((section) => (
                <section key={section.title} className="flex flex-col gap-0.5">
                  <div className="flex h-6 items-center justify-between pr-0.5 pl-2">
                    <h2 className="section-title m-0">{section.title}</h2>
                    {section.title === 'Folders' && (
                      <Button variant="ghost" size="sm">
                        Import…
                      </Button>
                    )}
                  </div>
                  {section.rows.map((row) => (
                    <button
                      key={row.name}
                      type="button"
                      aria-current={row.name === current ? 'page' : undefined}
                      onClick={() => setCurrent(row.name)}
                      className={sidebarRowClass(row.name === current)}
                    >
                      <span className="min-w-0 flex-1 truncate text-left">{row.name}</span>
                      {row.count !== null && <RowCount value={row.count} />}
                    </button>
                  ))}
                </section>
              ))}
              <section className="flex flex-col gap-0.5">
                <div className="flex h-6 items-center pl-2">
                  <h2 className="section-title m-0">Filters</h2>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 px-2 text-xs">
                  <LibraryFilters projectOpen={false} isoKnown pane />
                </div>
              </section>
            </nav>
          )}

          <main className="flex min-w-0 flex-1 flex-col bg-stage">
            {/* The filter bar: docked, no border. */}
            <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-xs">
              <Input type="search" placeholder="Search photos" aria-label="Search photos (shell)" className="w-40" />
              <span className="font-mono text-[11px] text-fg-muted">142/600 decided</span>
              <Button variant="toggle" size="sm">
                Decide
              </Button>
              <span className="ml-auto font-mono text-[11px] text-fg-muted tabular-nums">1 284 photos</span>
            </div>
            <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(96px,1fr))] content-start gap-2 p-3">
              {Array.from({ length: 18 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells
                <div key={i} className="aspect-[3/2] rounded-xs bg-panel" />
              ))}
            </div>
          </main>
        </div>

        {/* The jobs pill, bottom-right: the progress ring and the count. */}
        <div className="absolute right-3 bottom-3">
          <span className={jobsPillClass}>
            <JobsPillLabel active={2} failed={0} progress={progress} running="DSCF1001.jpg" />
          </span>
        </div>
      </div>
    </div>
  );
}
