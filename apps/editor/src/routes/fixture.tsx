import { Page } from '@photobook/shared';
import { FIXTURE_PAGES, fixtureResolve } from '@photobook/shared/fixtures';
import '@photobook/shared/renderer.css';

const PAGE_WIDTH = 420;

/** Step 1.3 check: the shared renderer fixture, rendered the same way as the viewer's dev page. */
export function FixtureRoute() {
  return (
    <div className="h-full overflow-auto bg-stage p-8">
      <h1 className="mb-6 font-serif text-xl text-fg">Renderer fixture (editor, React)</h1>
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
