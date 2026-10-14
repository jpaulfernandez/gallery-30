import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useBookStore } from '../../store/book';
import { useDesignBook } from '../../store/design';
import { useUiStore } from '../../store/ui';
import { CustomLayoutMenu, GridOfFramesButton } from '../editor/FramePopovers';
import { CardGrid, DraggableLayoutCard } from './LayoutCard';
import { customLayouts, groupLayouts, LAYOUT_COUNTS, type LayoutCountFilter } from './layoutGroups';

/**
 * The Layouts tab of the left panel: a photo-count filter (All, 1 to 6), the library grouped by
 * count into "Photos only" and "With captions", then the book's custom layouts. Click a card to
 * apply it to the current page, or drag it onto the canvas page or a page strip tile. The Custom
 * group's header starts a grid of frames on the current page; its cards have a "…" menu (rename,
 * delete).
 */
export function LayoutsPanel() {
  const book = useDesignBook();
  const applyLayout = useBookStore((s) => s.applyLayout);
  const pageIndex = useUiStore((s) => s.pageIndex);
  const [filter, setFilter] = useState<LayoutCountFilter>('all');
  const groups = useMemo(() => groupLayouts(filter), [filter]);
  const page = book?.pages[pageIndex];
  const pageId = page?.id;
  const choose = useCallback(
    (layoutId: string) => {
      if (pageId) applyLayout(pageId, layoutId);
    },
    [applyLayout, pageId],
  );

  if (!book) return null;
  const custom = customLayouts(book, filter);
  const card = (layout: (typeof custom)[number]) => (
    <DraggableLayoutCard
      key={layout.id}
      layout={layout}
      template={book.template}
      theme={book.theme}
      current={layout.id === page?.layout}
      onChoose={choose}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="radiogroup" aria-label="Photos per page" className="flex gap-1 border-line border-b p-2">
        {(['all', ...LAYOUT_COUNTS] as const).map((value) => (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={filter === value}
            onClick={() => setFilter(value)}
            className={`h-6 min-w-6 flex-1 rounded px-1.5 text-[11px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              filter === value ? 'bg-line text-fg' : 'text-fg-muted hover:bg-fg/5 hover:text-fg'
            }`}
          >
            {value === 'all' ? 'All' : value}
          </button>
        ))}
      </div>
      <div
        className="min-h-0 flex-1 scrollbar overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] px-2 pb-4"
        data-testid="layouts-panel"
      >
        {groups.map((group) => (
          <section key={group.photos} aria-label={`${group.photos} ${group.photos === 1 ? 'photo' : 'photos'}`}>
            {filter === 'all' && (
              <h3 className="mt-4 mb-1 px-1 font-medium text-fg text-xs">
                {group.photos} {group.photos === 1 ? 'photo' : 'photos'}
              </h3>
            )}
            {group.photosOnly.length > 0 && (
              <Subgroup title="Photos only" count={group.photosOnly.length}>
                {group.photosOnly.map(card)}
              </Subgroup>
            )}
            {group.captioned.length > 0 && (
              <Subgroup title="With captions" count={group.captioned.length}>
                {group.captioned.map(card)}
              </Subgroup>
            )}
          </section>
        ))}
        <section aria-label="Custom layouts">
          <div className="mt-4 mb-1 flex items-center justify-between gap-2 px-1">
            <h3 className="font-medium text-fg text-xs">Custom</h3>
            {pageId && (
              <GridOfFramesButton
                pageId={pageId}
                className="rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted outline-none hover:bg-fg/5 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
              />
            )}
          </div>
          {custom.length > 0 ? (
            <CardGrid>
              {custom.map((layout) => (
                <div key={layout.id} className="group/card relative min-w-0">
                  {card(layout)}
                  <div className="absolute top-2 right-2">
                    <CustomLayoutMenu layout={layout} />
                  </div>
                </div>
              ))}
            </CardGrid>
          ) : (
            <p className="px-1 py-2 text-[11px] text-fg-muted leading-relaxed">
              {book.customLayouts.length > 0
                ? 'No custom layouts with this many photos.'
                : 'Draw frames on a page (F) or start from a grid, then use Save as layout in the page inspector.'}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function Subgroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="mt-2">
      <h4 className="section-title mb-1 flex items-baseline gap-1.5 px-1">
        {title}
        <span className="normal-case tracking-normal">{count}</span>
      </h4>
      <CardGrid>{children}</CardGrid>
    </div>
  );
}
