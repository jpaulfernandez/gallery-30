import { type Frame, type PhotoElement, resolveTheme, type TextElement, tokenOnAxis } from '@photobook/shared';
import { frameWithField, inchesPerUnit, minFrameSize } from '../../lib/frames';
import { useBookStore } from '../../store/book';
import { useDesignBook } from '../../store/design';
import { isRatioLocked, useUiStore } from '../../store/ui';
import { buttonClass as buttonLook } from '../ui/Button';
import { NumberField } from './BookSettings';
import { deleteSelection, mergeSelection, splitSelection } from './frameActions';
import { LockIcon, MergeIcon, SplitColumnsIcon, SplitRowsIcon, TrashIcon } from './icons';
import { Section } from './inspectorUi';

const FIELDS = [
  { key: 'x', label: 'X', name: 'Left edge' },
  { key: 'y', label: 'Y', name: 'Top edge' },
  { key: 'w', label: 'W', name: 'Width' },
  { key: 'h', label: 'H', name: 'Height' },
] as const;

// Plan 45: the look of a `Button` (components/ui) on these plain buttons.
const actionButton = `${buttonLook({ size: 'sm' })} gap-1.5 text-left`;

/**
 * Frame position and size in inches on the 8 in wide reference page (X, Y from the top-left trim),
 * the ratio lock used by the resize handles and by W / H here, and (photos) Split.
 */
export function FrameSection({ pageId, element }: { pageId: string; element: PhotoElement | TextElement }) {
  const book = useDesignBook();
  const setFrames = useBookStore((s) => s.setFrames);
  const locked = useUiStore((s) => isRatioLocked(s, element));
  const setRatioLock = useUiStore((s) => s.setRatioLock);
  if (!book) return null;
  const per = inchesPerUnit(book.template);
  const theme = resolveTheme(book.theme);
  const bleed =
    element.type === 'photo' ? { x: theme.bleed, y: tokenOnAxis(theme.bleed, book.template, 'y') } : { x: 0, y: 0 };
  const f = element.frame;
  const shown: Record<keyof Frame, number> = { x: f.x * per.x, y: f.y * per.y, w: f.w * per.x, h: f.h * per.y };
  const commit = (field: keyof Frame, inches: number) => {
    const next = frameWithField(f, field, inches, {
      template: book.template,
      lock: locked,
      min: minFrameSize(book.template, element.type),
      bleed,
    });
    setFrames(pageId, { [element.id]: next });
  };

  return (
    <Section title="Frame">
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        {FIELDS.map(({ key, label, name }) => (
          <div key={key} className="flex items-center gap-1.5">
            <span className="w-3 text-fg-muted text-xs">{label}</span>
            <NumberField
              value={shown[key]}
              min={key === 'x' || key === 'y' ? -1 : 0.01}
              max={key === 'x' || key === 'w' ? per.x : per.y}
              step={0.01}
              unit="in"
              label={`${name}, inches`}
              onCommit={(v) => commit(key, v)}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-fg-muted text-xs">Aspect ratio</span>
        <button
          type="button"
          aria-pressed={locked}
          onClick={() => setRatioLock(element.id, !locked)}
          title={
            locked
              ? 'Locked: resizing keeps the shape (hold Shift while dragging to resize freely)'
              : 'Free: resizing changes the shape (hold Shift while dragging to keep it)'
          }
          className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
            locked ? 'border-accent/60 text-fg' : 'border-line text-fg-muted hover:text-fg'
          }`}
        >
          <LockIcon open={!locked} />
          {locked ? 'Locked' : 'Free'}
        </button>
      </div>
      {element.type === 'photo' && (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => splitSelection('horizontal')}
            title="Split top / bottom with a gutter (Cmd+Shift+H)"
            className={actionButton}
          >
            <SplitRowsIcon />
            Split rows
          </button>
          <button
            type="button"
            onClick={() => splitSelection('vertical')}
            title="Split left / right with a gutter (Cmd+Shift+V)"
            className={actionButton}
          >
            <SplitColumnsIcon />
            Split columns
          </button>
        </div>
      )}
      <p className="text-[11px] text-fg-muted leading-relaxed">
        Drag a handle to resize (Shift: the other ratio mode, {locked ? 'free' : 'keep the shape'}; Alt: from the
        centre; Cmd: no snapping). Arrow keys nudge one grid step, Shift ten.
      </p>
    </Section>
  );
}

/** The inspector for a multi-selection (Shift+click): count, Merge and Delete. */
export function SelectionSection({ count, frames }: { count: number; frames: number }) {
  return (
    <Section title="Selection">
      <p className="text-fg text-xs">
        {count} elements selected
        {frames !== count && <span className="text-fg-muted"> ({frames} photo frames)</span>}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={frames < 2}
          onClick={() => mergeSelection()}
          title={
            frames < 2 ? 'Select two or more photo frames' : 'Merge into one frame at their bounding box (Cmd+Shift+M)'
          }
          className={actionButton}
        >
          <MergeIcon />
          Merge
        </button>
        <button type="button" onClick={() => deleteSelection()} title="Delete (Backspace)" className={actionButton}>
          <TrashIcon />
          Delete
        </button>
      </div>
      <p className="text-[11px] text-fg-muted leading-relaxed">
        Merge keeps the first filled photo. Shift+click adds or removes frames; arrow keys nudge them all.
      </p>
    </Section>
  );
}
