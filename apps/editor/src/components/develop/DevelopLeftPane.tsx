import type { DevelopSettings } from '@photobook/shared';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { undo, useBookStore } from '../../store/book';
import { photoEntryPlace } from '../../store/library';
import { findLook } from '../../store/looks';
import { sidebarRowClass } from '../shell/SidebarRow';
import { type HistorySnapshot, historyRows } from './developHistory';
import { LooksSection } from './LooksSection';
import { PanelCard } from './PanelCard';
import { PresetsMenu } from './PresetsMenu';
import { VersionStrip } from './VersionStrip';

/**
 * The Develop view's left pane (plan 51, ODDHALLS_LAYOUT_PLAN 4.3): the "pick a starting point" side. Looks with
 * Amount and the LUT picker (`LooksSection`, moved from the right panel), Presets (`PresetsMenu`: apply, Save current
 * as preset…), History (this photo's undo steps) and Versions (`VersionStrip`, moved from over the picture). Tab hides
 * it with the right pane (`ui.panes.develop`); the keys (`[` `]`, Cmd+Shift+C / V) live in `DevelopMode` and work
 * without it.
 */
export function DevelopLeftPane({ assetId, settings }: { assetId: string; settings: DevelopSettings }) {
  const canHoldVersions = useBookStore((s) => photoEntryPlace(s, assetId) !== null);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 scrollbar overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] p-2">
      <LooksSection assetId={assetId} settings={settings} />
      <section
        aria-label="Presets"
        className="flex h-9 shrink-0 items-center justify-between rounded-md bg-panel-2 pr-1.5 pl-3 shadow-raised"
      >
        <h3 className="section-title m-0 text-fg">Presets</h3>
        <PresetsMenu assetId={assetId} settings={settings} />
      </section>
      <DevelopHistory assetId={assetId} />
      {canHoldVersions && <VersionsCard assetId={assetId} />}
    </div>
  );
}

/**
 * History: the book store's undo states (no storage of its own) filtered to the steps that changed this photo, newest
 * first. A row undoes back to it when every later step changed this photo and nothing else (`historyRows`); otherwise
 * it is listed only (`aria-disabled`, with a note under the list), since undo is one stack for the whole project and
 * jumping would undo another photo's edit.
 */
function DevelopHistory({ assetId }: { assetId: string }) {
  const [open, setOpen] = useState(true);
  const past = useStore(useBookStore.temporal, (s) => s.pastStates);
  const book = useBookStore((s) => s.book);
  const libraries = useBookStore((s) => s.libraries);
  const folder = useBookStore((s) => s.folder);
  const developVersion = useBookStore((s) => s.developVersion);
  const rows = useMemo(() => {
    const states = [...(past as HistorySnapshot[]), { book, libraries }];
    return historyRows(states, { folder, developVersion }, assetId, (id) => findLook(id)?.name ?? null);
  }, [past, book, libraries, folder, developVersion, assetId]);
  const current = past.length;
  const jump = (step: number) => {
    for (let i = current; i > step; i -= 1) if (!undo()) break;
  };
  return (
    <PanelCard
      title="History"
      open={open}
      onToggle={() => setOpen((o) => !o)}
      meta={rows.length > 0 && <span className="font-mono text-[11px] text-fg-muted">{rows.length}</span>}
      bodyClassName="px-1.5 pb-1.5"
    >
      {rows.length === 0 ? (
        <p className="px-1.5 pb-1 text-[11px] text-fg-muted">No edits to this photo yet.</p>
      ) : (
        <>
          <ol aria-label="History of this photo" className="flex flex-col">
            {rows.map((row) => (
              <li key={row.step} className="flex">
                <button
                  type="button"
                  // Focusable and read out as unavailable; the note under the list says why.
                  aria-disabled={!row.reachable || undefined}
                  aria-current={row.step === current ? 'step' : undefined}
                  // Prefixed so a row never takes the name of a card or tool ("Crop", "Transform").
                  aria-label={`History: ${row.label}`}
                  onClick={() => {
                    if (row.reachable) jump(row.step);
                  }}
                  title={
                    row.step === current ? 'The settings shown' : row.reachable ? 'Undo back to this step' : undefined
                  }
                  className={`${sidebarRowClass(row.step === current)} flex-1 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent`}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{row.label}</span>
                </button>
              </li>
            ))}
          </ol>
          {rows.some((row) => !row.reachable) && (
            <p className="px-1.5 pt-1 text-[11px] text-fg-muted">Older steps also changed other photos; use Undo.</p>
          )}
        </>
      )}
    </PanelCard>
  );
}

/** Versions as chips under History (plan 08's row, a pill over the picture before plan 51; a card since plan 49). */
function VersionsCard({ assetId }: { assetId: string }) {
  return <VersionStrip assetId={assetId} />;
}
