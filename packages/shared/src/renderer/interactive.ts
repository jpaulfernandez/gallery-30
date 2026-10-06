import type { ElementPointerDownHandler } from './types.js';

/** Props shared by every element when the page is editable. */
export interface EditableProps {
  /** Adds data attributes and pointer handlers so the editor can wrap elements with its own chrome. */
  editable?: boolean;
  /** Adds the `pb-selected` class. The renderer draws no selection chrome itself. */
  selected?: boolean;
  onElementPointerDown?: ElementPointerDownHandler;
}

export function editableAttrs(
  id: string,
  type: 'photo' | 'text',
  { editable, onElementPointerDown }: EditableProps,
): Record<string, unknown> {
  if (!editable) return {};
  return {
    'data-element-id': id,
    'data-element-type': type,
    onPointerDown: onElementPointerDown
      ? (event: Parameters<ElementPointerDownHandler>[1]) => onElementPointerDown(id, event)
      : undefined,
  };
}
