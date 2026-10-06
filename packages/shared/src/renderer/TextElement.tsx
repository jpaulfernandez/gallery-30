import type { CSSProperties } from 'react';
import type { TextElement as TextElementData, Theme } from '../schema.js';
import { type EditableProps, editableAttrs } from './interactive.js';
import { textStyle } from './text.js';
import { DEFAULT_PAGE_WIDTH_PX, type PageSize } from './types.js';
import { cx, frameStyle, num } from './util.js';

/** Same as the schema type; declared here so `TextElement` is both the component and the data type. */
export type TextElement = TextElementData;

export interface TextElementProps extends EditableProps {
  element: TextElementData;
  /** Overlay text is inset by `theme.margin` (default 0.08). */
  theme?: Theme;
  /** Page size, for converting the height-relative font size. Defaults to square. */
  template?: PageSize;
  /** Rendered page height in px for the font-size fallback. Defaults to 1080 * height / width. */
  pageHeightPx?: number;
  className?: string;
  style?: CSSProperties;
}

/** Inset for overlay text when no theme is passed (the guide's safe margin, fraction of the width). */
export const OVERLAY_MARGIN = 0.08;

/**
 * Overlay frames span the photo edge to edge (the gradient runs into the bleed); the text itself
 * keeps the safe margin from the trim, as width-relative padding. The `--pb-pad` variables read by
 * `.pb-text-overlay`; the editor's inline text editor uses them too, so editing matches the page.
 */
export function overlayPadding(margin: number, pageWidthPx: number): CSSProperties {
  return {
    '--pb-pad': `${num(margin * 100)}cqw`,
    '--pb-pad-px': `${num(margin * pageWidthPx, 2)}px`,
  } as CSSProperties;
}

/**
 * A text box at the element's frame. Text wraps inside the frame and sits at the top. An empty box
 * shows a "Type…" placeholder when editable and nothing otherwise. `overlay` text sits at the
 * bottom of its frame over a soft dark gradient, inset by the theme margin; `box` text gets a
 * light tint and padding.
 */
export function TextElement(props: TextElementProps) {
  const { element, template, editable, selected, className } = props;
  const pageAspect = template ? template.height / template.width : 1;
  const pageHeightPx = props.pageHeightPx ?? DEFAULT_PAGE_WIDTH_PX * pageAspect;
  const empty = element.text.trim() === '';
  // The gradient / tint only shows with text, or while editing so the box is findable.
  const decorated = !empty || editable;
  const pageWidthPx = pageHeightPx / pageAspect;

  return (
    <div
      className={cx(
        'pb-text',
        `pb-text-${element.style}`,
        empty && 'pb-text-empty',
        element.overlay && decorated && 'pb-text-overlay',
        element.box && decorated && 'pb-text-box',
        editable && 'pb-editable',
        selected && 'pb-selected',
        className,
      )}
      style={{
        ...frameStyle(element.frame),
        ...textStyle(element, { pageAspect, pageHeightPx }),
        ...(element.overlay ? overlayPadding(props.theme?.margin ?? OVERLAY_MARGIN, pageWidthPx) : undefined),
        ...props.style,
      }}
      {...editableAttrs(element.id, 'text', props)}
    >
      {empty && editable ? (
        <span className="pb-text-placeholder">Type…</span>
      ) : element.pill ? (
        <span className="pb-pill">{element.text}</span>
      ) : (
        element.text
      )}
    </div>
  );
}
