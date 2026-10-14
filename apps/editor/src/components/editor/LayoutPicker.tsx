import { LAYOUT_BLANK } from '@photobook/shared';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useBookStore } from '../../store/book';
import { useDesignBook } from '../../store/design';
import { useUiStore } from '../../store/ui';
import { BlankLayoutCard, CardGrid, LayoutCard } from '../layouts/LayoutCard';
import { customLayouts, groupLayouts, LAYOUT_COUNTS, type LayoutCountFilter } from '../layouts/layoutGroups';
import { IconButton } from '../ui/Button';
import { CloseIcon } from './icons';

/**
 * Modal layout picker for one page: the same cards and grouping as the Layouts tab (photo count,
 * then "Photos only" / "With captions", then the book's custom layouts), with a "Blank" card first.
 */
export function LayoutPicker() {
  const target = useUiStore((s) => s.layoutPicker);
  const close = useUiStore((s) => s.closeLayoutPicker);
  const book = useDesignBook();
  const applyLayout = useBookStore((s) => s.applyLayout);
  const panelRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<LayoutCountFilter>('all');
  const groups = useMemo(() => groupLayouts(filter), [filter]);
  const page = book?.pages.find((p) => p.id === target?.pageId);

  useEffect(() => {
    if (page) panelRef.current?.focus();
  }, [page]);

  if (!book || !page) return null;

  const choose = (layoutId: string) => {
    applyLayout(page.id, layoutId);
    close();
  };
  const card = (layout: (typeof book.customLayouts)[number]) => (
    <LayoutCard
      key={layout.id}
      layout={layout}
      template={book.template}
      theme={book.theme}
      current={layout.id === page.layout}
      onChoose={choose}
    />
  );
  const custom = customLayouts(book, filter);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes through the shell shortcuts
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the modal
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stage/60 p-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Choose a layout"
        tabIndex={-1}
        className="flex max-h-full w-[min(960px,100%)] flex-col rounded-xl border border-line bg-panel shadow-2xl outline-none"
      >
        <header className="flex items-center gap-4 border-line border-b px-5 py-3">
          <h2 className="font-medium text-sm">Choose a layout</h2>
          <div role="radiogroup" aria-label="Photos per page" className="flex gap-1">
            {(['all', ...LAYOUT_COUNTS] as const).map((value) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={filter === value}
                onClick={() => setFilter(value)}
                className={`h-6 min-w-7 rounded px-2 text-[11px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  filter === value ? 'bg-line text-fg' : 'text-fg-muted hover:bg-fg/5 hover:text-fg'
                }`}
              >
                {value === 'all' ? 'All' : value}
              </button>
            ))}
          </div>
          <IconButton label="Close" shortcut="Esc" icon={<CloseIcon />} onClick={close} className="ml-auto" />
        </header>
        <div className="min-h-0 scrollbar overflow-x-hidden overflow-y-auto px-5 pt-2 pb-5">
          <Group title="Blank">
            <BlankLayoutCard
              template={book.template}
              current={page.layout === LAYOUT_BLANK}
              onChoose={() => choose(LAYOUT_BLANK)}
            />
          </Group>
          {groups.map((group) => (
            <section key={group.photos} className="mt-5">
              <h3 className="font-medium text-fg text-xs">
                {group.photos} {group.photos === 1 ? 'photo' : 'photos'}
              </h3>
              {group.photosOnly.length > 0 && (
                <Group title="Photos only" count={group.photosOnly.length}>
                  {group.photosOnly.map(card)}
                </Group>
              )}
              {group.captioned.length > 0 && (
                <Group title="With captions" count={group.captioned.length}>
                  {group.captioned.map(card)}
                </Group>
              )}
            </section>
          ))}
          <section className="mt-5">
            <h3 className="font-medium text-fg text-xs">Custom</h3>
            {custom.length > 0 ? (
              <div className="mt-2">
                <CardGrid min={120}>{custom.map(card)}</CardGrid>
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-fg-muted">
                {book.customLayouts.length > 0
                  ? 'No custom layouts with this many photos.'
                  : 'Draw frames on a page and save them as a layout.'}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Group({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <div className="mt-3">
      <h4 className="section-title mb-1.5 flex items-baseline gap-1.5">
        {title}
        {count !== undefined && <span className="normal-case tracking-normal">{count}</span>}
      </h4>
      <CardGrid min={120}>{children}</CardGrid>
    </div>
  );
}
