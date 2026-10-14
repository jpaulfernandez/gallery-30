import {
  BOOK_OUTPUT_ID,
  bleedBox,
  imposePages,
  MAX_BLEED_MM,
  MAX_PRINT_DPI,
  MIN_PRINT_DPI,
  PAPER_PRESETS,
  PAPER_SIZES,
  type PaperSize,
  PRINT_PRESETS,
  type PrintImposition,
  type PrintOrientation,
  type PrintOutput,
  type PrintPresetName,
  pagesOf,
  paperForTemplate,
  paperSize,
  presetSettings,
  printSourceId,
  printSummary,
  sameRatio,
  templateOf,
} from '@photobook/shared';
import { useEffect, useState } from 'react';
import { useBookStore } from '../../store/book';
import { Field, inputClass, Section } from '../editor/inspectorUi';
import { buttonClass as buttonLook } from '../ui/Button';

// Plan 45: the look of a `Button` (components/ui) on these plain buttons.
const buttonClass = `${buttonLook({ size: 'sm' })} w-full justify-between text-left`;

/** The dpi choices the panel offers (any value from 72 to 600 is valid in the file). */
const DPI_CHOICES = [150, 200, 300, 600];

/** A ratio as the panel says it: "4:5", "1:1.41". */
function ratioText(w: number, h: number): string {
  const r = w / h;
  if (Math.abs(r - 0.8) < 0.005) return '4:5';
  if (Math.abs(r - 1) < 0.005) return '1:1';
  return r < 1 ? `1:${(1 / r).toFixed(2)}` : `${r.toFixed(2)}:1`;
}

/**
 * The inspector with nothing selected on a print (workflow plan 15): what it prints (the book or a post), the paper and
 * its orientation, single pages or spreads, the bleed, crop marks and the photo resolution, with the Zine preset and a
 * note when the pages' ratio is not the paper's. Every change is one undo step. Export… (top bar) makes the PDF.
 */
export function PrintPanel({ print }: { print: PrintOutput }) {
  const setPrintSettings = useBookStore((s) => s.setPrintSettings);
  const book = useBookStore((s) => s.book);
  const [bleed, setBleed] = useState(String(print.bleedMm));
  useEffect(() => setBleed(String(print.bleedMm)), [print.bleedMm]);
  if (!book) return null;

  const set = (patch: Parameters<typeof setPrintSettings>[1]) => setPrintSettings(print.id, patch);
  const posts = book.outputs.filter((o) => o.kind === 'social');
  const source = printSourceId(book, print);
  // The post it printed was deleted: `printSourceId` falls back to the book, and the panel says so.
  const sourceGone = print.source !== BOOK_OUTPUT_ID && source === BOOK_OUTPUT_ID;
  const pageCount = pagesOf(book, print.id).length;
  const sheets = imposePages(pageCount, print).length;
  const template = templateOf(book, print.id);
  const paper = paperSize(print.paper, print.orientation);
  const fits = sameRatio(paper.w / paper.h, template.width / template.height);
  const suggestion = paperForTemplate(template);
  const suggested = suggestion.paper !== print.paper || suggestion.orientation !== print.orientation;
  const suggestionFits = sameRatio(
    paperSize(suggestion.paper, suggestion.orientation).w / paperSize(suggestion.paper, suggestion.orientation).h,
    template.width / template.height,
  );
  const sheet = bleedBox(print);

  const commitBleed = () => {
    const value = Number(bleed.replace(',', '.'));
    if (Number.isFinite(value)) set({ bleedMm: value });
    else setBleed(String(print.bleedMm));
  };

  // A preset keeps the source and the pages' orientation (`presetSettings`).
  const applyPreset = (name: PrintPresetName) => set(presetSettings(name, template));

  return (
    <>
      <Section title="Print">
        <div className="space-y-1 text-xs">
          <p className="text-fg">{printSummary(print)}</p>
          <p className="text-fg-muted tabular-nums">
            {pageCount === 1 ? '1 page' : `${pageCount} pages`} on {sheets === 1 ? '1 PDF page' : `${sheets} PDF pages`}
            {print.marks ? ' · crop marks' : ''}
          </p>
        </div>
        <Field label="Prints">
          <select
            aria-label="What the print prints"
            value={source}
            onChange={(e) => set({ source: e.target.value })}
            className={`${inputClass} w-40 min-w-0`}
          >
            <option value={BOOK_OUTPUT_ID}>The book</option>
            {posts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || 'Post'}
              </option>
            ))}
          </select>
        </Field>
        {sourceGone && (
          <p role="status" className="text-[11px] text-warn">
            Post deleted; printing the book.
          </p>
        )}
        <Field label="Paper">
          <select
            aria-label="Paper size"
            value={print.paper}
            onChange={(e) => set({ paper: e.target.value as PaperSize })}
            className={`${inputClass} w-40 min-w-0`}
          >
            {PAPER_SIZES.map((p) => (
              <option key={p} value={p}>
                {PAPER_PRESETS[p].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Orientation">
          <select
            aria-label="Paper orientation"
            value={print.orientation}
            onChange={(e) => set({ orientation: e.target.value as PrintOrientation })}
            className={`${inputClass} w-40 min-w-0`}
          >
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </Field>
        <Field label="Layout">
          <select
            aria-label="Imposition"
            value={print.imposition}
            onChange={(e) => set({ imposition: e.target.value as PrintImposition })}
            className={`${inputClass} w-40 min-w-0`}
          >
            <option value="pages">Single pages</option>
            <option value="spreads">Spreads</option>
          </select>
        </Field>
        <Field label="Bleed (mm)">
          <input
            type="number"
            min={0}
            max={MAX_BLEED_MM}
            step={0.5}
            aria-label="Bleed in millimetres"
            value={bleed}
            onChange={(e) => setBleed(e.target.value)}
            onBlur={commitBleed}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitBleed();
            }}
            className={`${inputClass} w-40 min-w-0 tabular-nums`}
          />
        </Field>
        <Field label="Photos">
          <select
            aria-label="Photo resolution"
            value={print.dpi}
            onChange={(e) => set({ dpi: Number(e.target.value) })}
            className={`${inputClass} w-40 min-w-0`}
          >
            {[...new Set([...DPI_CHOICES, print.dpi])]
              .filter((d) => d >= MIN_PRINT_DPI && d <= MAX_PRINT_DPI)
              .sort((a, b) => a - b)
              .map((d) => (
                <option key={d} value={d}>
                  {d} dpi
                </option>
              ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={print.marks} onChange={(e) => set({ marks: e.target.checked })} />
          Crop marks
        </label>
        {!fits && (
          <p role="note" className="text-[11px] text-warn leading-relaxed">
            The pages are {ratioText(template.width, template.height)} and {PAPER_PRESETS[print.paper].label}{' '}
            {print.orientation} is {ratioText(paper.w, paper.h)}: each page prints centred on its trim with bands of its
            background colour.
            {suggested && suggestionFits
              ? ` ${PAPER_PRESETS[suggestion.paper].label} ${suggestion.orientation} fits.`
              : ''}
          </p>
        )}
        <p className="text-[11px] text-fg-muted leading-relaxed">
          Each PDF page is {Math.round(sheet.w * 10) / 10} × {Math.round(sheet.h * 10) / 10} mm with bleed
          {print.marks ? ', plus a margin for the marks' : ''}. Photos come from the full-size edits; colours are sRGB.
        </p>
      </Section>
      <Section title="Presets">
        {(Object.keys(PRINT_PRESETS) as PrintPresetName[]).map((name) => (
          <button
            key={name}
            type="button"
            className={buttonClass}
            title={PRINT_PRESETS[name].description}
            onClick={() => applyPreset(name)}
          >
            <span>{PRINT_PRESETS[name].label}</span>
            <span className="text-fg-muted">{PRINT_PRESETS[name].description}</span>
          </button>
        ))}
      </Section>
    </>
  );
}
