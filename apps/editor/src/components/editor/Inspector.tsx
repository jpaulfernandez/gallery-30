import { useDroppable } from '@dnd-kit/core';
import {
  type Book,
  DEFAULT_TEXT_COLOR,
  fontStack,
  type Page,
  type PhotoElement,
  resolveTheme,
  SLOT_RATIOS,
  TEXT_PRESETS,
  type TextElement,
} from '@photobook/shared';
import type { Draft } from 'immer';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cropFit, MAX_SCALE, MIN_SCALE, zoomCrop } from '../../lib/crop';
import { useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { layoutName } from '../layouts/layoutGroups';
import { BookSettings } from './BookSettings';
import { type DragData, type DropData, pageBgDndId } from './dnd';
import { GridOfFramesButton, SaveAsLayoutButton } from './FramePopovers';
import { FrameSection, SelectionSection } from './FrameSection';
import { useIdleGesture, usePointerGesture } from './gestures';
import { RotateIcon, TextIcon } from './icons';
import { Field, HEX, inputClass, Section, toHex6 } from './inspectorUi';
import { ShapeSection } from './ShapeSection';
import { addTextToCurrentPage } from './textActions';

/**
 * Right panel: book settings and page settings with nothing selected, slot and photo settings for
 * a photo, typography for text.
 */
export function Inspector() {
  const pageIndex = useUiStore((s) => s.pageIndex);
  const book = useBookStore((s) => s.book);
  const pageAtIndex = book?.pages[pageIndex];
  const selectedId = useUiStore((s) => s.selectedElementId);
  const selected = pageAtIndex?.elements.find((e) => e.id === selectedId);
  const selectedIds = useUiStore((s) => s.selectedElementIds);
  const many = pageAtIndex?.elements.filter((e) => selectedIds.includes(e.id)) ?? [];

  return (
    <aside aria-label="Inspector" className="flex min-h-0 flex-col border-line border-l bg-panel">
      <header className="label border-line border-b px-3 py-2">
        {many.length > 1
          ? `${many.length} selected`
          : selected
            ? selected.type === 'photo'
              ? 'Photo slot'
              : 'Text'
            : 'Book and page'}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {many.length > 1 ? (
          <SelectionSection count={many.length} frames={many.filter((e) => e.type === 'photo').length} />
        ) : selected?.type === 'photo' && pageAtIndex ? (
          <PhotoInspector pageId={pageAtIndex.id} element={selected} />
        ) : selected?.type === 'text' && pageAtIndex ? (
          <TextInspector key={selected.id} pageId={pageAtIndex.id} element={selected} />
        ) : book ? (
          <>
            <BookSettings book={book} />
            {pageAtIndex && <PageInspector key={pageAtIndex.id} page={pageAtIndex} book={book} />}
          </>
        ) : null}
      </div>
    </aside>
  );
}

function PageInspector({ page, book }: { page: Page; book: Book }) {
  const themeBackground = resolveTheme(book.theme).defaultPageBackground;
  const setBackground = useBookStore((s) => s.setPageBackground);
  const updatePage = useBookStore((s) => s.updatePage);
  const openLayoutPicker = useUiStore((s) => s.openLayoutPicker);
  const touchColor = useIdleGesture(500);
  const color = typeof page.background === 'string' ? page.background : themeBackground;
  const [hex, setHex] = useState(color);
  useEffect(() => setHex(color), [color]);

  const commitHex = () => {
    const value = hex.trim().startsWith('#') ? hex.trim() : `#${hex.trim()}`;
    if (HEX.test(value)) setBackground(page.id, value.toLowerCase());
    else setHex(color);
  };

  // Notes: local draft, committed 500 ms after typing stops, on blur, and when the page changes.
  const [notes, setNotes] = useState(page.notes ?? '');
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNotes = useRef<string | null>(null);
  const editingNotes = useRef(false);
  useEffect(() => {
    if (!editingNotes.current) setNotes(page.notes ?? '');
  }, [page.notes]);
  const pageId = page.id;
  const flushNotes = useCallback(() => {
    if (notesTimer.current) clearTimeout(notesTimer.current);
    notesTimer.current = null;
    const value = pendingNotes.current;
    pendingNotes.current = null;
    if (value === null) return;
    updatePage(pageId, (p) => {
      if ((p.notes ?? '') === value) return;
      if (value) p.notes = value;
      else delete p.notes;
    });
  }, [pageId, updatePage]);
  useEffect(() => flushNotes, [flushNotes]);

  return (
    <>
      <Section title="Page background">
        <Field label="Color">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={toHex6(color)}
              onChange={(e) => {
                touchColor();
                setBackground(page.id, e.target.value);
              }}
              aria-label="Page background color"
              className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent p-0"
            />
            <input
              type="text"
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              onBlur={commitHex}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitHex();
              }}
              spellCheck={false}
              aria-label="Page background hex"
              className={`${inputClass} w-24 font-mono`}
            />
          </div>
        </Field>
        <BackgroundPhoto page={page} color={color} />
      </Section>
      <Section title="Layout">
        <button
          type="button"
          onClick={() => openLayoutPicker(page.id)}
          className="flex w-full items-center justify-between rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-left text-xs hover:border-accent"
        >
          <span>{layoutName(page.layout, book)}</span>
          <span className="text-fg-muted">Change…</span>
        </button>
        <div className="grid grid-cols-2 gap-2">
          <GridOfFramesButton pageId={page.id} className={frameToolButton} />
          <SaveAsLayoutButton page={page} className={frameToolButton} />
        </div>
        <p className="text-[11px] text-fg-muted leading-relaxed">
          Press F to draw a frame. Saved layouts appear in the Layouts tab under Custom.
        </p>
      </Section>
      <Section title="Text">
        <button
          type="button"
          onClick={() => addTextToCurrentPage()}
          title="Add text (T)"
          className="flex w-full items-center gap-2 rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-left text-xs hover:border-accent"
        >
          <TextIcon />
          <span>Add text</span>
          <span className="ml-auto text-fg-muted">T</span>
        </button>
      </Section>
      <Section title="Notes">
        <textarea
          value={notes}
          onFocus={() => {
            editingNotes.current = true;
          }}
          onChange={(e) => {
            setNotes(e.target.value);
            pendingNotes.current = e.target.value;
            if (notesTimer.current) clearTimeout(notesTimer.current);
            notesTimer.current = setTimeout(flushNotes, 500);
          }}
          onBlur={() => {
            editingNotes.current = false;
            flushNotes();
          }}
          rows={5}
          placeholder="Private notes for this page (never published)"
          aria-label="Page notes"
          className={`${inputClass} w-full resize-y select-text`}
        />
      </Section>
    </>
  );
}

const frameToolButton =
  'w-full rounded-md border border-line bg-panel-2 px-2 py-1.5 text-left text-xs hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line';

const FILTERS: Array<{ value: PhotoElement['filter']; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'bw', label: 'Black and white' },
  { value: 'fade', label: 'Fade' },
];

function PhotoInspector({ pageId, element }: { pageId: string; element: PhotoElement }) {
  const setSlotRatio = useBookStore((s) => s.setSlotRatio);
  const setCrop = useBookStore((s) => s.setCrop);
  const rotate = useBookStore((s) => s.rotateElement);
  const setFilter = useBookStore((s) => s.setFilter);
  const onSliderPointerDown = usePointerGesture();
  const hasPhoto = element.asset !== null;

  return (
    <>
      <FrameSection pageId={pageId} element={element} />
      <Section title="Slot">
        <div role="radiogroup" aria-label="Slot ratio" className="grid grid-cols-6 rounded-md border border-line p-0.5">
          {SLOT_RATIOS.map((ratio) => {
            const active = element.ratio === ratio;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
              <button
                key={ratio}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setSlotRatio(pageId, element.id, ratio)}
                className={`rounded px-0 py-1 text-[11px] tabular-nums ${
                  active ? 'bg-line text-fg' : 'text-fg-muted hover:text-fg'
                }`}
              >
                {ratio}
              </button>
            );
          })}
        </div>
      </Section>
      <Section title="Photo">
        {hasPhoto ? (
          <>
            <Field label="Zoom">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={MIN_SCALE}
                  max={MAX_SCALE}
                  step={0.01}
                  value={element.crop.scale}
                  onPointerDown={onSliderPointerDown}
                  onChange={(e) => {
                    const fit = cropFit(useBookStore.getState().book, element);
                    setCrop(pageId, element.id, zoomCrop(element.crop, Number(e.target.value), undefined, fit));
                  }}
                  aria-label="Photo zoom"
                  className="w-32 accent-accent"
                />
                <span className="w-9 text-right text-fg-muted text-xs tabular-nums">
                  {Math.round(element.crop.scale * 100)}%
                </span>
              </div>
            </Field>
            <Field label="Rotate">
              <button
                type="button"
                onClick={() => rotate(pageId, element.id)}
                className="flex items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 py-1 text-xs hover:border-accent"
              >
                <RotateIcon />
                <span className="tabular-nums">{element.rotate}°</span>
              </button>
            </Field>
            <Field label="Filter">
              <select
                value={element.filter}
                onChange={(e) => setFilter(pageId, element.id, e.target.value as PhotoElement['filter'])}
                aria-label="Photo filter"
                className={inputClass}
              >
                {FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
            <p className="text-[11px] text-fg-muted leading-relaxed">
              Drag the photo to pan, pinch to zoom, double-click to open the original. Alt + drag (or the Move handle)
              swaps it with another slot.
            </p>
          </>
        ) : (
          <p className="text-fg-muted text-xs">Empty slot. Drag a photo from the left panel onto it.</p>
        )}
      </Section>
      <ShapeSection pageId={pageId} element={element} />
    </>
  );
}

// Text ------------------------------------------------------------------------------------------

const TEXT_PRESET_OPTIONS: Array<{ value: TextElement['style']; label: string }> = [
  { value: 'title', label: 'Title' },
  { value: 'caption', label: 'Caption' },
  { value: 'date', label: 'Date stamp' },
  { value: 'body', label: 'Body' },
];
const TEXT_FAMILIES = ['Inter', 'Fraunces', 'JetBrains Mono', 'Instrument Serif'] as const;
const TEXT_WEIGHTS = [300, 400, 500, 600, 700] as const;
const TEXT_ALIGNS: Array<{ value: TextElement['align']; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];
/** Size limits, percent of the page height (the slider covers the useful 1 to 12 %). */
const SIZE_MIN = 0.5;
const SIZE_MAX = 30;
const SLIDER_MIN = 1;
const SLIDER_MAX = 12;

/** Fraction of the page height -> percent with one decimal. */
const sizePercent = (size: number): number => Math.round(size * 1000) / 10;

function TextInspector({ pageId, element }: { pageId: string; element: TextElement }) {
  const updateElement = useBookStore((s) => s.updateElement);
  const editText = useUiStore((s) => s.editText);
  const onSliderPointerDown = usePointerGesture();
  const touchColor = useIdleGesture(500);
  const preset = TEXT_PRESETS[element.style];
  const family = element.family ?? preset.family;
  const size = element.size ?? preset.size;
  const weight = element.weight ?? preset.weight;
  const color = element.color ?? DEFAULT_TEXT_COLOR;
  const elementId = element.id;

  const update = useCallback(
    (fn: (el: Draft<TextElement>) => void) =>
      updateElement(pageId, elementId, (el) => {
        if (el.type === 'text') fn(el);
      }),
    [updateElement, pageId, elementId],
  );

  const setSize = (percent: number) => {
    const value = Math.round(Math.min(Math.max(percent, SIZE_MIN), SIZE_MAX) * 10) / 1000;
    update((el) => {
      if (el.size !== value) el.size = value;
    });
  };

  // Size field: local draft so partial input ("2.") is not overwritten while typing.
  const [sizeDraft, setSizeDraft] = useState(String(sizePercent(size)));
  const editingSize = useRef(false);
  useEffect(() => {
    if (!editingSize.current) setSizeDraft(String(sizePercent(size)));
  }, [size]);

  const setColor = (value: string) =>
    update((el) => {
      el.color = value;
    });
  const [hex, setHex] = useState(color);
  useEffect(() => setHex(color), [color]);
  const commitHex = () => {
    const value = hex.trim().startsWith('#') ? hex.trim() : `#${hex.trim()}`;
    if (HEX.test(value)) setColor(value.toLowerCase());
    else setHex(color);
  };

  const segment = (active: boolean) =>
    `rounded px-0 py-1 text-[11px] ${active ? 'bg-line text-fg' : 'text-fg-muted hover:text-fg'}`;

  return (
    <>
      <Section title="Text">
        <Field label="Preset">
          <select
            value={element.style}
            onChange={(e) => {
              const style = e.target.value as TextElement['style'];
              // A preset is a full typographic choice: drop the element-level overrides.
              update((el) => {
                el.style = style;
                delete el.family;
                delete el.size;
                delete el.weight;
              });
            }}
            aria-label="Text preset"
            className={`${inputClass} w-36`}
          >
            {TEXT_PRESET_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Family">
          <select
            value={family}
            onChange={(e) => {
              const value = e.target.value;
              update((el) => {
                if (value === TEXT_PRESETS[el.style].family) delete el.family;
                else el.family = value;
              });
            }}
            aria-label="Font family"
            className={`${inputClass} w-36`}
            style={{ fontFamily: fontStack(family) }}
          >
            {TEXT_FAMILIES.map((f) => (
              <option key={f} value={f} style={{ fontFamily: fontStack(f) }}>
                {f}
              </option>
            ))}
            {!(TEXT_FAMILIES as readonly string[]).includes(family) && <option value={family}>{family}</option>}
          </select>
        </Field>
        <div className="space-y-1.5">
          <Field label="Size">
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={SIZE_MIN}
                max={SIZE_MAX}
                step={0.1}
                value={sizeDraft}
                onFocus={() => {
                  editingSize.current = true;
                }}
                onChange={(e) => {
                  setSizeDraft(e.target.value);
                  const v = Number(e.target.value);
                  if (e.target.value !== '' && Number.isFinite(v) && v >= SIZE_MIN && v <= SIZE_MAX) setSize(v);
                }}
                onBlur={() => {
                  editingSize.current = false;
                  setSizeDraft(String(sizePercent(size)));
                }}
                aria-label="Font size, percent of page height"
                className={`${inputClass} w-16 tabular-nums`}
              />
              <span className="text-[11px] text-fg-muted">% of page height</span>
            </div>
          </Field>
          <input
            type="range"
            min={SLIDER_MIN}
            max={SLIDER_MAX}
            step={0.1}
            value={Math.min(Math.max(sizePercent(size), SLIDER_MIN), SLIDER_MAX)}
            onPointerDown={onSliderPointerDown}
            onChange={(e) => setSize(Number(e.target.value))}
            aria-label="Font size slider"
            className="w-full accent-accent"
          />
        </div>
        <Field label="Weight">
          <select
            value={weight}
            onChange={(e) => {
              const value = Number(e.target.value);
              update((el) => {
                if (value === TEXT_PRESETS[el.style].weight) delete el.weight;
                else el.weight = value;
              });
            }}
            aria-label="Font weight"
            className={`${inputClass} w-36`}
          >
            {TEXT_WEIGHTS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
            {!(TEXT_WEIGHTS as readonly number[]).includes(weight) && <option value={weight}>{weight}</option>}
          </select>
        </Field>
        <Field label="Align">
          <div
            role="radiogroup"
            aria-label="Text alignment"
            className="grid w-36 grid-cols-3 rounded-md border border-line p-0.5"
          >
            {TEXT_ALIGNS.map((a) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
              <button
                key={a.value}
                type="button"
                role="radio"
                aria-checked={element.align === a.value}
                onClick={() =>
                  update((el) => {
                    el.align = a.value;
                  })
                }
                className={segment(element.align === a.value)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Color">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={toHex6(color)}
              onChange={(e) => {
                touchColor();
                setColor(e.target.value);
              }}
              aria-label="Text color"
              className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent p-0"
            />
            <input
              type="text"
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              onBlur={commitHex}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitHex();
              }}
              spellCheck={false}
              aria-label="Text color hex"
              className={`${inputClass} w-24 font-mono`}
            />
          </div>
        </Field>
        <Field label="Pill background">
          <button
            type="button"
            role="switch"
            aria-checked={element.pill === true}
            aria-label="Pill background"
            onClick={() =>
              update((el) => {
                if (el.pill) delete el.pill;
                else el.pill = true;
              })
            }
            className={`relative h-4 w-7 rounded-full transition-colors ${element.pill ? 'bg-accent' : 'bg-line'}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 size-3 rounded-full bg-white transition-transform ${
                element.pill ? 'translate-x-3' : ''
              }`}
            />
          </button>
        </Field>
      </Section>
      <Section title="Content">
        <button
          type="button"
          onClick={() => editText(element.id)}
          className="w-full rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-left text-xs hover:border-accent"
        >
          Edit text
        </button>
        <p className="text-[11px] text-fg-muted leading-relaxed">
          Double-click the text or press Enter to edit (Escape reverts, Cmd+Enter or clicking away commits). Drag to
          move; it snaps to the 8 pt grid. Delete removes it.
        </p>
      </Section>
    </>
  );
}

// Page background photo --------------------------------------------------------------------------

/**
 * Drop target for a full-bleed background photo (dnd-kit droppable `page-bg:<pageId>`, handled
 * in EditorDnd). Shows the photo when set, with Remove reverting to a color.
 */
function BackgroundPhoto({ page, color }: { page: Page; color: string }) {
  const setBackground = useBookStore((s) => s.setPageBackground);
  const assetId = typeof page.background === 'object' ? page.background.asset : null;
  const relPath = useBookStore((s) => (assetId ? (s.book?.assets[assetId]?.path ?? null) : null));
  const file = useAssetsStore((s) => (relPath ? s.files[relPath] : undefined));
  const src = file?.thumbUrl ?? file?.proxyUrl;
  const drop: DropData = { kind: 'page-bg', pageId: page.id };
  const { setNodeRef, isOver, active } = useDroppable({ id: pageBgDndId(page.id), data: drop });
  const accepts = (active?.data.current as DragData | undefined)?.kind === 'asset';

  return (
    <div className="space-y-1.5">
      <span className="text-fg-muted text-xs">Background photo</span>
      <div
        ref={setNodeRef}
        className={`relative flex h-20 items-center justify-center overflow-hidden rounded-md border text-[11px] ${
          isOver && accepts
            ? 'border-accent bg-accent/15 text-fg'
            : accepts
              ? 'border-accent/60 border-dashed text-fg-muted'
              : 'border-line border-dashed text-fg-muted'
        }`}
      >
        {assetId ? (
          src ? (
            <img src={src} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <span>{relPath ?? 'Photo'}</span>
          )
        ) : (
          <span>Drop a photo here</span>
        )}
        {assetId && isOver && accepts && <span className="absolute inset-0 bg-accent/30" />}
      </div>
      {assetId && (
        <button
          type="button"
          onClick={() => setBackground(page.id, color)}
          className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs hover:border-accent"
        >
          Remove photo
        </button>
      )}
    </div>
  );
}
