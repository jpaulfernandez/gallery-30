import { useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { type UiPrefs, useUiStore } from '../../store/ui';
import { Filmstrip } from '../filmstrip/Filmstrip';
import { LayoutsPanel } from '../layouts/LayoutsPanel';

const TABS: Array<{ id: UiPrefs['leftTab']; label: string }> = [
  { id: 'photos', label: 'Photos' },
  { id: 'layouts', label: 'Layouts' },
];

/** Left panel: Photos (the filmstrip) and Layouts tabs. The tab is a UI pref (localStorage). */
export function LeftPanel() {
  const tab = useUiStore((s) => s.leftTab);
  const setPref = useUiStore((s) => s.setPref);
  const folder = useBookStore((s) => s.folder);
  const scanning = useAssetsStore((s) => s.busy);

  return (
    <section aria-label="Photos and layouts" className="flex min-h-0 flex-col border-line border-r bg-panel">
      <header className="flex items-center justify-between border-line border-b px-2 py-1.5">
        <div role="tablist" aria-label="Left panel" className="flex gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`left-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`left-panel-${t.id}`}
              onClick={() => setPref('leftTab', t.id)}
              className={`label rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                tab === t.id ? 'bg-line text-fg!' : 'hover:text-fg!'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'photos' && (
          <button
            type="button"
            onClick={() => folder && void useAssetsStore.getState().scan(folder, { force: true })}
            disabled={!folder || scanning}
            title="Scan the folder again for added, changed or removed photos"
            className="rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            Rescan
          </button>
        )}
      </header>
      <div
        role="tabpanel"
        id={`left-panel-${tab}`}
        aria-labelledby={`left-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === 'photos' ? <Filmstrip /> : <LayoutsPanel />}
      </div>
    </section>
  );
}
