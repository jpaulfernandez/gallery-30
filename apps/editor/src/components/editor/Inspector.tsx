import { useDroppable } from '@dnd-kit/core';
import {
  BOOK_OUTPUT_ID,
  type Book,
  DEFAULT_TEXT_COLOR,
  findOutput,
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
import { fileOfAsset, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { currentDesignBook, useDesignBook } from '../../store/design';
import { assetDevelop } from '../../store/library';
import { useUiStore } from '../../store/ui';
// Workflow plan 35: Caption this page, and a photo's alt text.
import { AltTextField } from '../ai/AltTextField';
import { openCaptionPage } from '../ai/CaptionPageSheet';
import { WriteButton } from '../ai/WritePopover';
import { PostPanel, SendToPostSection } from '../design/PostPanel';
import { PrintPanel } from '../design/PrintPanel';
import { SlideshowPanel } from '../design/SlideshowPanel';
import { openDevelop } from '../filmstrip/visible';
import { layoutName } from '../layouts/layoutGroups';
import { Button, buttonClass, focusRing } from '../ui/Button';
import { Input, Select, Switch } from '../ui/Field';
import { SegmentedTrack } from '../ui/Segmented';
import { Tag } from '../ui/Tag';
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
 * a photo, typography for text. Plan 48: each section is a card (`inspectorUi` `Section`), the controls come from
 * `components/ui`.
 */
export function Inspector() {
  const pageIndex = useUiStore((s) => s.pageIndex);
  const book = useDesignBook();
  // Book settings (size, theme, publish) belong to the book: shown with the book open, never on a post.
  const realBook = useBookStore((s) => s.book);
  const onBook = useUiStore((s) => s.design.outputId === BOOK_OUTPUT_ID);
  // A social post (plan 14): its network, frame limit and caption with nothing selected.
  const outputId = useUiStore((s) => s.design.outputId);
  const post = useBookStore((s) => {
    const output = s.book ? findOutput(s.book, outputId) : undefined;
    return output?.kind === 'social' ? output : undefined;
  });
  // A print (plan 15): its paper, imposition, bleed, marks and dpi with nothing selected.
  const print = useBookStore((s) => {
    const output = s.book ? findOutput(s.book, outputId) : undefined;
    return output?.kind === 'print' ? output : undefined;
  });
  // A slideshow (plan 16): its slides, timing, transition, motion, size and audio with nothing selected.
  const slideshow = useBookStore((s) => {
    const output = s.book ? findOutput(s.book, outputId) : undefined;
    return output?.kind === 'slideshow' ? output : undefined;
  });
  const pageAtIndex = book?.pages[pageIndex];
  const selectedId = useUiStore((s) => s.selectedElementId);
  const selected = pageAtIndex?.elements.find((e) => e.id === selectedId);
  const selectedIds = useUiStore((s) => s.selectedElementIds);
  const many = pageAtIndex?.elements.filter((e) => selectedIds.includes(e.id)) ?? [];

  return (
    <aside aria-label="Inspector" className="flex min-h-0 flex-col border-line border-l bg-panel">
      <header className="section-title border-line border-b px-3 py-2">
        {many.length > 1
          ? `${many.length} selected`
          : selected
            ? selected.type === 'photo'
              ? 'Photo slot'
              : 'Text'
            : onBook
              ? 'Book and page'
              : post
                ? 'Post and frame'
                : print
                  ? 'Print and page'
                  : slideshow
                    ? 'Slideshow and page'
                    : 'Page'}
      </header>
      <div className="min-h-0 flex-1 scrollbar overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
        {many.length > 1 ? (
          <SelectionSection count={many.length} frames={many.filter((e) => e.type === 'photo').length} />
        ) : selected?.type === 'photo' && pageAtIndex ? (
          <PhotoInspector pageId={pageAtIndex.id} element={selected} />
        ) : selected?.type === 'text' && pageAtIndex ? (
          <TextInspector key={selected.id} pageId={pageAtIndex.id} element={selected} />
        ) : book ? (
          <>
            {onBook && realBook && <BookSettings book={realBook} />}
            {post && <PostPanel post={post} />}
            {print && <PrintPanel print={print} />}
            {slideshow && <SlideshowPanel slideshow={slideshow} />}
            {pageAtIndex && <PageInspector key={pageAtIndex.id} page={pageAtIndex} book={book} />}
            {pageAtIndex && <SendToPostSection pageId={pageAtIndex.id} />}
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
              className="h-6 w-8 cursor-pointer rounded-xs border border-line bg-transparent p-0"
            />
            <Input
              type="text"
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              onBlur={commitHex}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitHex();
              }}
              spellCheck={false}
              aria-label="Page background hex"
              className="w-24 font-mono"
            />
          </div>
        </Field>
        <BackgroundPhoto page={page} color={color} />
      </Section>
      <Section title="Layout">
        <Button size="sm" onClick={() => openLayoutPicker(page.id)} className="w-full justify-between">
          <span>{layoutName(page.layout, book)}</span>
          <span className="text-fg-muted">Change…</span>
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <GridOfFramesButton pageId={page.id} className={frameToolButton} />
          <SaveAsLayoutButton page={page} className={frameToolButton} />
        </div>
        <p className="text-[11px] text-fg-muted leading-relaxed">
          Press F to draw a frame. Saved layouts appear in the Layouts tab under Custom.
        </p>
      </Section>
      <Section title="Text">
        <Button size="sm" onClick={() => addTextToCurrentPage()} title="Add text (T)" className="w-full gap-2">
          <TextIcon />
          <span>Add text</span>
          <span className="ml-auto font-mono text-fg-muted">T</span>
        </Button>
        <Button
          size="sm"
          onClick={() => openCaptionPage(page.id)}
          title="Write this page's captions with AI, with the alt text of its photos; you review them before they are placed"
          className="w-full gap-2"
        >
          <span aria-hidden="true">✦</span>
          <span>Caption this page…</span>
        </Button>
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

const frameToolButton = `${buttonClass({ size: 'sm' })} w-full`;

/** An item of the inspector's segmented tracks (`ui/Segmented`'s look), sharing the track's width equally. */
const segment = (active: boolean) =>
  `relative z-10 flex-1 rounded-sm py-1 font-medium text-[11px] transition-colors duration-base ease-out ${focusRing} ${
    active ? 'text-fg' : 'text-fg-2 hover:text-fg'
  }`;

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
        <SegmentedTrack role="radiogroup" aria-label="Slot ratio" activeKey={element.ratio ?? null} className="w-full">
          {SLOT_RATIOS.map((ratio) => {
            const active = element.ratio === ratio;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
              <button
                key={ratio}
                type="button"
                role="radio"
                aria-checked={active}
                data-segment-active={active || undefined}
                onClick={() => setSlotRatio(pageId, element.id, ratio)}
                className={`${segment(active)} font-mono tabular-nums`}
              >
                {ratio}
              </button>
            );
          })}
        </SegmentedTrack>
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
                    const fit = cropFit(currentDesignBook(), element);
                    setCrop(pageId, element.id, zoomCrop(element.crop, Number(e.target.value), undefined, fit));
                  }}
                  aria-label="Photo zoom"
                  className="w-32 accent-accent"
                />
                <span className="w-10 text-right font-mono text-fg-2 text-xs tabular-nums">
                  {Math.round(element.crop.scale * 100)}%
                </span>
              </div>
            </Field>
            <Field label="Rotate">
              <Button size="sm" onClick={() => rotate(pageId, element.id)}>
                <RotateIcon />
                <span className="font-mono tabular-nums">{element.rotate}°</span>
              </Button>
            </Field>
            <Field label="Filter">
              <Select
                value={element.filter}
                onChange={(e) => setFilter(pageId, element.id, e.target.value as PhotoElement['filter'])}
                aria-label="Photo filter"
                className="w-36"
              >
                {FILTERS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
            <DevelopField assetId={element.asset} />
            {element.asset && <AltTextField assetId={element.asset} />}
            <p className="text-[11px] text-fg-muted leading-relaxed">
              Drag to move the frame. Double-click (or Adjust in the toolbar) to pan and zoom the photo inside; Esc
              finishes. Alt + drag (or the Move handle) swaps it with another slot.
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

/**
 * Develop entries in the photo section: open the Develop view, flag edited photos and reset their edits, and import
 * the photo's Lightroom (.xmp) settings.
 */
function DevelopField({ assetId }: { assetId: string | null }) {
  const edited = useBookStore((s) => (assetId ? assetDevelop(s, assetId) !== undefined : false));
  const reset = useBookStore((s) => s.resetAssetDevelop);
  if (!assetId) return null;
  return (
    <>
      <Field label="Develop">
        <div className="flex items-center gap-1.5">
          {edited && (
            <>
              <Tag tone="accent">Edited</Tag>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => reset(assetId)}
                title="Remove every Develop adjustment from this photo"
              >
                Reset
              </Button>
            </>
          )}
          <Button size="sm" onClick={() => openDevelop(assetId)} title="Open the Develop view (D)">
            Develop…
          </Button>
        </div>
      </Field>
      <Button
        size="sm"
        onClick={() => useUiStore.getState().openXmpImport([assetId])}
        title="Read this photo’s Lightroom (.xmp) settings and apply them (Cmd+Shift+I in the Develop view)"
        className="w-full justify-center"
      >
        Import Lightroom settings…
      </Button>
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

  return (
    <>
      <Section title="Text">
        <Field label="Preset">
          <Select
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
            className="w-36"
          >
            {TEXT_PRESET_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Family">
          <Select
            value={family}
            onChange={(e) => {
              const value = e.target.value;
              update((el) => {
                if (value === TEXT_PRESETS[el.style].family) delete el.family;
                else el.family = value;
              });
            }}
            aria-label="Font family"
            className="w-36"
            style={{ fontFamily: fontStack(family) }}
          >
            {TEXT_FAMILIES.map((f) => (
              <option key={f} value={f} style={{ fontFamily: fontStack(f) }}>
                {f}
              </option>
            ))}
            {!(TEXT_FAMILIES as readonly string[]).includes(family) && <option value={family}>{family}</option>}
          </Select>
        </Field>
        <div className="space-y-1.5">
          <Field label="Size">
            <div className="flex items-center gap-1.5">
              {/* Plan 48 keeps the live preview per keystroke; whether it commits on blur instead is plan 54's. */}
              <Input
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
                className="w-16 font-mono tabular-nums"
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
          <Select
            value={weight}
            onChange={(e) => {
              const value = Number(e.target.value);
              update((el) => {
                if (value === TEXT_PRESETS[el.style].weight) delete el.weight;
                else el.weight = value;
              });
            }}
            aria-label="Font weight"
            className="w-36"
          >
            {TEXT_WEIGHTS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
            {!(TEXT_WEIGHTS as readonly number[]).includes(weight) && <option value={weight}>{weight}</option>}
          </Select>
        </Field>
        <Field label="Align">
          <SegmentedTrack role="radiogroup" aria-label="Text alignment" activeKey={element.align} className="w-36">
            {TEXT_ALIGNS.map((a) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled as buttons
              <button
                key={a.value}
                type="button"
                role="radio"
                aria-checked={element.align === a.value}
                data-segment-active={element.align === a.value || undefined}
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
          </SegmentedTrack>
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
              className="h-6 w-8 cursor-pointer rounded-xs border border-line bg-transparent p-0"
            />
            <Input
              type="text"
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              onBlur={commitHex}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitHex();
              }}
              spellCheck={false}
              aria-label="Text color hex"
              className="w-24 font-mono"
            />
          </div>
        </Field>
        <Field label="Pill background">
          <Switch
            checked={element.pill === true}
            label="Pill background"
            hideLabel
            onChange={() =>
              update((el) => {
                if (el.pill) delete el.pill;
                else el.pill = true;
              })
            }
          />
        </Field>
      </Section>
      <Section title="Content">
        <Button size="sm" onClick={() => editText(element.id)} className="w-full">
          Edit text
        </Button>
        {/* Workflow plan 34: ✦ Write, three AI captions for this text box. */}
        <WriteButton pageId={pageId} element={element} />
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
  const file = useAssetsStore((s) => fileOfAsset(s.files, assetId));
  const src = file?.thumbUrl ?? file?.proxyUrl;
  const drop: DropData = { kind: 'page-bg', pageId: page.id };
  const { setNodeRef, isOver, active } = useDroppable({ id: pageBgDndId(page.id), data: drop });
  const accepts = (active?.data.current as DragData | undefined)?.kind === 'asset';

  return (
    <div className="space-y-1.5">
      <span className="text-fg-2 text-xs">Background photo</span>
      <div
        ref={setNodeRef}
        className={`relative flex h-20 items-center justify-center overflow-hidden rounded-md border text-[11px] ${
          isOver && accepts
            ? 'border-fg bg-fg/10 text-fg'
            : accepts
              ? 'border-fg/60 border-dashed text-fg-muted'
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
        {assetId && isOver && accepts && <span className="absolute inset-0 bg-fg/20" />}
      </div>
      {assetId && (
        <Button size="sm" onClick={() => setBackground(page.id, color)}>
          Remove photo
        </Button>
      )}
    </div>
  );
}
