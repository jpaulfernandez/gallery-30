import { type LayoutData, type Page, resolveTheme } from '@photobook/shared';
import { useMemo, useState } from 'react';
import {
  type FrameGridOptions,
  GRID_MAX,
  gridFrames,
  inchesPerUnit,
  pageToLayoutData,
  saveLayoutBlocker,
} from '../../lib/frames';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { LayoutThumb } from '../layouts/LayoutThumb';
import { MoreIcon } from './icons';
import { inputClass } from './inspectorUi';
import { PopoverButton } from './Popover';

/** The last grid the user added, offered again next time (this session). */
let lastGrid: Required<FrameGridOptions> = { cols: 2, rows: 2, wide: false, bleed: false };

const primaryButton =
  'rounded-md bg-accent px-3 py-1 font-medium text-white text-xs hover:bg-accent/90 disabled:opacity-50 disabled:hover:bg-accent';
const segment = (active: boolean) =>
  `rounded px-2 py-1 text-[11px] ${active ? 'bg-line text-fg' : 'text-fg-muted hover:text-fg'}`;

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const button =
    'flex size-6 items-center justify-center rounded-md border border-line text-fg hover:border-accent disabled:opacity-40 disabled:hover:border-line';
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-fg-muted">{label}</span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={`Fewer ${label.toLowerCase()}`}
          disabled={value <= 1}
          onClick={() => onChange(value - 1)}
          className={button}
        >
          −
        </button>
        <output aria-label={label} className="w-5 text-center text-fg tabular-nums">
          {value}
        </output>
        <button
          type="button"
          aria-label={`More ${label.toLowerCase()}`}
          disabled={value >= GRID_MAX}
          onClick={() => onChange(value + 1)}
          className={button}
        >
          +
        </button>
      </div>
    </div>
  );
}

function GridForm({ pageId, close }: { pageId: string; close: () => void }) {
  const book = useBookStore((s) => s.book);
  const addFrameGrid = useBookStore((s) => s.addFrameGrid);
  const [opts, setOpts] = useState(lastGrid);
  const theme = useMemo(() => resolveTheme(book?.theme), [book?.theme]);
  const template = book?.template ?? { width: 1080, height: 1350 };
  const items = useMemo(
    () => gridFrames(opts, theme, template).map((f) => ({ kind: 'photo' as const, ...f })),
    [opts, theme, template],
  );
  const filled =
    book?.pages.find((p) => p.id === pageId)?.elements.filter((e) => e.type === 'photo' && e.asset !== null).length ??
    0;
  const cells = opts.cols * opts.rows;
  const per = inchesPerUnit(template);
  const set = (patch: Partial<FrameGridOptions>) => setOpts((o) => ({ ...o, ...patch }));

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <div className="w-16 shrink-0">
          <LayoutThumb items={items} template={template} className="rounded-[2px]" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <Stepper label="Columns" value={opts.cols} onChange={(cols) => set({ cols })} />
          <Stepper label="Rows" value={opts.rows} onChange={(rows) => set({ rows })} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-fg-muted">Gutter</span>
        <div role="radiogroup" aria-label="Gutter" className="flex rounded-md border border-line p-0.5">
          {([false, true] as const).map((wide) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
            <button
              key={String(wide)}
              type="button"
              role="radio"
              aria-checked={opts.wide === wide}
              onClick={() => set({ wide })}
              className={segment(opts.wide === wide)}
            >
              {wide ? 'Wide' : 'Standard'} {((wide ? theme.wideGutter : theme.gutter) * per.x).toFixed(2)} in
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-fg-muted">Edges</span>
        <div role="radiogroup" aria-label="Grid edges" className="flex rounded-md border border-line p-0.5">
          {([false, true] as const).map((bleed) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
            <button
              key={String(bleed)}
              type="button"
              role="radio"
              aria-checked={opts.bleed === bleed}
              onClick={() => set({ bleed })}
              className={segment(opts.bleed === bleed)}
            >
              {bleed ? 'Bleed' : 'Inside safe margins'}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-fg-muted leading-relaxed">
        Replaces the page's empty frames.
        {filled > 0 &&
          ` Its ${filled} ${filled === 1 ? 'photo is' : 'photos are'} poured into the frames in order${
            filled > cells ? `; ${filled - cells} will not fit` : ''
          }.`}
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={close} className="rounded-md px-2 py-1 text-fg-muted hover:text-fg">
          Cancel
        </button>
        <button
          type="button"
          className={primaryButton}
          onClick={() => {
            lastGrid = opts;
            addFrameGrid(pageId, opts);
            useUiStore.getState().select(null);
            close();
          }}
        >
          Add {cells} {cells === 1 ? 'frame' : 'frames'}
        </button>
      </div>
    </div>
  );
}

/** "Grid of frames…": fill the page with cols x rows empty frames (see `addFrameGrid`). */
export function GridOfFramesButton({ pageId, className }: { pageId: string; className?: string }) {
  return (
    <PopoverButton
      label="Grid of frames…"
      title="Fill the page with a grid of empty photo frames"
      panelLabel="Grid of frames"
      width={260}
      className={className}
    >
      {(close) => <GridForm pageId={pageId} close={close} />}
    </PopoverButton>
  );
}

function NameForm({
  initial,
  action,
  onSubmit,
  close,
}: {
  initial: string;
  action: string;
  onSubmit: (name: string) => void;
  close: () => void;
}) {
  const [name, setName] = useState(initial);
  const ok = name.trim().length > 0;
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        onSubmit(name.trim());
        close();
      }}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: the popover opens to type a name
        autoFocus
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        maxLength={60}
        spellCheck={false}
        aria-label="Layout name"
        className={`${inputClass} w-full`}
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={close} className="rounded-md px-2 py-1 text-fg-muted hover:text-fg">
          Cancel
        </button>
        <button type="submit" disabled={!ok} className={primaryButton}>
          {action}
        </button>
      </div>
    </form>
  );
}

/**
 * "Save as layout…": name the page's frames and add them to the book's custom layouts (Layouts
 * tab, Custom group). Disabled with the reason as tooltip unless the page has 1 to 6 photo frames.
 */
export function SaveAsLayoutButton({ page, className }: { page: Page; className?: string }) {
  const count = useBookStore((s) => s.book?.customLayouts.length ?? 0);
  const blocker = saveLayoutBlocker(page);
  return (
    // A disabled button shows no tooltip in WebKit, so the reason sits on a wrapper.
    <span className="block" title={blocker ?? undefined}>
      <PopoverButton
        label="Save as layout…"
        title={blocker ? undefined : 'Save this page’s frames as a custom layout'}
        disabled={blocker !== null}
        panelLabel="Save as layout"
        className={className}
      >
        {(close) => (
          <NameForm
            initial={`Custom ${count + 1}`}
            action="Save layout"
            close={close}
            onSubmit={(name) => {
              const current = useBookStore.getState().book?.pages.find((p) => p.id === page.id);
              const data = current ? pageToLayoutData(current, name) : null;
              if (data) useBookStore.getState().addCustomLayout(data, page.id);
            }}
          />
        )}
      </PopoverButton>
    </span>
  );
}

/** The "…" menu on a custom layout card: rename (inline) and delete. */
export function CustomLayoutMenu({ layout }: { layout: LayoutData }) {
  return (
    <PopoverButton
      label={<MoreIcon />}
      ariaLabel={`More actions for ${layout.name}`}
      title="Rename or delete"
      panelLabel={`Layout ${layout.name}`}
      width={220}
      alignEnd
      className="flex size-6 items-center justify-center rounded-md border border-line bg-panel-2/95 text-fg opacity-0 shadow-black/30 shadow-sm transition-opacity hover:border-accent focus-visible:opacity-100 group-hover/card:opacity-100 aria-expanded:opacity-100"
    >
      {(close) => (
        <div className="space-y-3">
          <NameForm
            initial={layout.name}
            action="Rename"
            close={close}
            onSubmit={(name) => useBookStore.getState().renameCustomLayout(layout.id, name)}
          />
          <div className="border-line border-t pt-2">
            <button
              type="button"
              onClick={() => {
                useBookStore.getState().removeCustomLayout(layout.id);
                close();
              }}
              className="w-full rounded-md px-2 py-1 text-left text-red-400 hover:bg-red-500/10"
            >
              Delete layout
            </button>
          </div>
        </div>
      )}
    </PopoverButton>
  );
}
