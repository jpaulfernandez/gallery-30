import { useDraggable } from '@dnd-kit/core';
import type { BookTemplate, LayoutData, Theme } from '@photobook/shared';
import { type ButtonHTMLAttributes, forwardRef, memo, type ReactNode } from 'react';
import { type DragData, layoutDndId } from '../editor/dnd';
import { LayoutThumb, useLayoutItems } from './LayoutThumb';

export interface LayoutCardProps {
  layout: LayoutData;
  template: BookTemplate;
  theme: Theme;
  /** The target page already uses this layout. */
  current?: boolean;
  /** Click: apply the layout. */
  onChoose: (layoutId: string) => void;
}

interface CardBodyProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  name: string;
  best?: string;
  current?: boolean;
  dragging?: boolean;
  thumb: ReactNode;
}

/** The card chrome shared by every layout card: the page drawing, name and "best for" line. */
const CardBody = forwardRef<HTMLButtonElement, CardBodyProps>(function CardBody(
  { name, best, current, dragging, thumb, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      type="button"
      aria-pressed={current ?? false}
      title={best ? `${name}: ${best}` : name}
      className={`group flex w-full min-w-0 flex-col gap-1.5 rounded-md p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        dragging ? 'opacity-40' : ''
      } ${className ?? ''}`}
    >
      <div
        className={`w-full rounded-[2px] shadow-black/40 shadow-sm transition duration-150 group-hover:-translate-y-0.5 group-hover:shadow-black/60 group-hover:shadow-lg ${
          current ? 'ring-2 ring-accent ring-offset-2 ring-offset-panel' : ''
        }`}
      >
        {thumb}
      </div>
      <span className="min-w-0 px-0.5">
        <span
          className={`block truncate font-medium text-[11px] leading-tight ${current ? 'text-accent' : 'text-fg group-hover:text-fg'}`}
        >
          {name}
        </span>
        {best && <span className="mt-0.5 line-clamp-2 block text-[10.5px] text-fg-muted leading-snug">{best}</span>}
      </span>
    </button>
  );
});

/** A layout card that applies on click (the layout picker). */
export const LayoutCard = memo(function LayoutCard({ layout, template, theme, current, onChoose }: LayoutCardProps) {
  const items = useLayoutItems(layout, template, theme);
  return (
    <CardBody
      name={layout.name}
      best={layout.best}
      current={current}
      onClick={() => onChoose(layout.id)}
      thumb={<LayoutThumb items={items} template={template} />}
    />
  );
});

/**
 * A layout card that also drags (the Layouts tab): dnd-kit draggable `layout:<id>` with data
 * `{ kind: 'layout', layoutId }`, dropped on the canvas page or a page strip tile (EditorDnd).
 */
export const DraggableLayoutCard = memo(function DraggableLayoutCard({
  layout,
  template,
  theme,
  current,
  onChoose,
}: LayoutCardProps) {
  const items = useLayoutItems(layout, template, theme);
  const data: DragData = { kind: 'layout', layoutId: layout.id };
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: layoutDndId(layout.id), data });
  return (
    <CardBody
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      name={layout.name}
      best={layout.best}
      current={current}
      dragging={isDragging}
      onClick={() => onChoose(layout.id)}
      className="cursor-grab"
      thumb={<LayoutThumb items={items} template={template} />}
    />
  );
});

/** The "Blank" card: an empty page, first in the picker. */
export function BlankLayoutCard({
  template,
  current,
  onChoose,
}: {
  template: BookTemplate;
  current?: boolean;
  onChoose: () => void;
}) {
  return (
    <CardBody
      name="Blank"
      best="An empty page; draw frames or drop photos"
      current={current}
      onClick={onChoose}
      thumb={
        <LayoutThumb items={[]} template={template}>
          <div className="absolute inset-[8%] rounded-[1px] border border-[#c9d0cc] border-dashed" />
        </LayoutThumb>
      }
    />
  );
}

/** Card grid: two columns in the 280 px left panel, more in the picker. */
export function CardGrid({ children, min = 104 }: { children: ReactNode; min?: number }) {
  return (
    <div className="grid gap-x-2 gap-y-3" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}>
      {children}
    </div>
  );
}
