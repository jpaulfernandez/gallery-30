import { Page } from '@photobook/shared';
import { FIXTURE_PAGES, fixtureResolve } from '@photobook/shared/fixtures';
import '@photobook/shared/renderer.css';
import { useState } from 'react';
import { KitchenSink } from '../components/fixture/KitchenSink';
import { LooksFixture } from '../components/fixture/LooksFixture';

const PAGE_WIDTH = 420;

type Tab = 'renderer' | 'looks' | 'sink';

const TAB_STORE = 'photobook:fixture-tab';

function readTab(): string | null {
  try {
    return localStorage.getItem(TAB_STORE);
  } catch {
    return null;
  }
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'renderer', label: 'Renderer' },
  { id: 'looks', label: 'Looks' },
  { id: 'sink', label: 'Kitchen sink' },
];

const TITLES: Record<Tab, string> = {
  renderer: 'Renderer fixture (editor, React)',
  looks: 'Built-in looks',
  sink: 'Kitchen sink',
};

const isTab = (v: string | null): v is Tab => TABS.some((t) => t.id === v);

/**
 * Step 1.3 check: the shared renderer fixture, rendered the same way as the viewer's dev page. The Looks tab (workflow
 * plan 21) shows every built-in look on three photos through the develop render; the Kitchen sink tab (plan 44) shows
 * every token and needs no Tauri. The tab is remembered per browser; `#/fixture?tab=sink` opens one directly.
 */
export function FixtureRoute() {
  const [tab, setTab] = useState<Tab>(() => {
    // Hash history: the query sits in the hash (`#/fixture?tab=sink`).
    const hash = globalThis.location?.hash ?? '';
    const asked = new URLSearchParams(hash.slice(hash.indexOf('?') + 1)).get('tab');
    if (isTab(asked)) return asked;
    const stored = readTab();
    return isTab(stored) ? stored : 'renderer';
  });
  const choose = (next: Tab) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_STORE, next);
    } catch {
      // Remembering the tab is a convenience.
    }
  };
  return (
    <div className="scrollbar h-full overflow-auto bg-stage p-8">
      <div className="mb-6 flex items-baseline gap-6">
        <h1 className="font-serif text-xl text-fg">{TITLES[tab]}</h1>
        <div className="flex gap-1 text-xs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tab === t.id}
              onClick={() => choose(t.id)}
              className={`rounded-md px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                tab === t.id ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:text-fg'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'looks' ? <LooksFixture /> : tab === 'sink' ? <KitchenSink /> : <RendererFixture />}
    </div>
  );
}

function RendererFixture() {
  return (
    <div>
      <div className="flex flex-wrap gap-8">
        {FIXTURE_PAGES.map(({ book, page, label }) => (
          <figure key={`${book.id}/${page.id}`} className="m-0" style={{ width: PAGE_WIDTH }}>
            <Page
              page={page}
              template={book.template}
              theme={book.theme}
              resolve={fixtureResolve}
              pageWidthPx={PAGE_WIDTH}
            />
            <figcaption className="mt-2 font-mono text-[11px] text-fg-muted">{label}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
