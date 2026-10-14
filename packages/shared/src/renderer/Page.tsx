import type { CSSProperties } from 'react';
import type { Page as PageData, PhotoElement as PhotoElementData, Theme } from '../schema.js';
import type { EditableProps } from './interactive.js';
import { PhotoElement } from './PhotoElement.js';
import { TextElement } from './TextElement.js';
import { DEFAULT_PAGE_WIDTH_PX, type PageSize, type ResolveImage } from './types.js';
import { cx } from './util.js';

/** Same as the schema type; declared here so `Page` is both the component and the data type. */
export type Page = PageData;

export interface PageProps extends Omit<EditableProps, 'selected'> {
  /** The page to draw (guides and notes are editor-only, so a published manifest page without them is fine). */
  page: Omit<PageData, 'guides' | 'notes'>;
  template: PageSize;
  theme: Theme;
  resolve: ResolveImage;
  /** Element id that gets the `pb-selected` class. */
  selectedId?: string | null;
  /**
   * Rendered page width in px. Only used to pick image sizes (`targetWidthPx`) and the font-size
   * fallback; layout itself is fluid. Defaults to 1080.
   */
  pageWidthPx?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * One book page. Fills its parent's width at the template's aspect ratio; every element is
 * absolutely positioned from its fraction-based frame, so the page renders the same at any size.
 */
export function Page(props: PageProps) {
  const { page, template, theme, resolve, selectedId, pageWidthPx = DEFAULT_PAGE_WIDTH_PX } = props;
  const editable = props.editable ?? false;
  const pageHeightPx = (pageWidthPx * template.height) / template.width;
  const bg = page.background;

  const bgElement: PhotoElementData | null =
    typeof bg === 'object'
      ? {
          type: 'photo',
          id: `${page.id}:background`,
          asset: bg.asset,
          frame: { x: 0, y: 0, w: 1, h: 1 },
          crop: { x: 0, y: 0, scale: 1 },
          rotate: 0,
          filter: 'none',
        }
      : null;

  const style = {
    position: 'relative',
    width: '100%',
    aspectRatio: `${template.width} / ${template.height}`,
    background: typeof bg === 'string' ? bg : theme.background,
    overflow: 'hidden',
    containerType: 'inline-size',
    ...props.style,
  } as CSSProperties;

  return (
    <div className={cx('pb-page', props.className)} style={style} data-page-id={page.id}>
      {bgElement && (
        <PhotoElement
          element={bgElement}
          resolve={resolve}
          template={template}
          pageWidthPx={pageWidthPx}
          className="pb-page-bg"
        />
      )}
      {page.elements.map((el) =>
        el.type === 'photo' ? (
          <PhotoElement
            key={el.id}
            element={el}
            resolve={resolve}
            template={template}
            pageWidthPx={pageWidthPx}
            editable={editable}
            selected={selectedId === el.id}
            onElementPointerDown={props.onElementPointerDown}
          />
        ) : (
          <TextElement
            key={el.id}
            element={el}
            theme={theme}
            template={template}
            pageHeightPx={pageHeightPx}
            editable={editable}
            selected={selectedId === el.id}
            onElementPointerDown={props.onElementPointerDown}
          />
        ),
      )}
    </div>
  );
}
