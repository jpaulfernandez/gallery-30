import { OVERLAY_MARGIN, overlayPadding, type PageSize, type TextElement, textStyle } from '@photobook/shared';
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { focusCanvas } from './textActions';

const pct = (n: number) => `${n * 100}%`;

/** The text of a plaintext contenteditable, without the trailing <br> some engines keep. */
function readText(node: HTMLElement): string {
  const text = node.innerText;
  return node.lastChild instanceof HTMLBRElement ? text.replace(/\n$/, '') : text;
}

/**
 * Inline editor for a text element: a plaintext `contenteditable` box at the element's frame with
 * the renderer's own typography and decoration (`textStyle`, `.pb-text`, `.pb-text-overlay` with the
 * theme-margin padding variables, `.pb-text-box`), so what you type is what the page shows.
 * The canvas hides the rendered element while this is mounted.
 *
 * Commits on blur, Cmd+Enter, or when editing ends any other way (selection change, page change).
 * Escape reverts. Enter inserts a line break.
 */
export function TextEditor({
  pageId,
  element,
  template,
}: {
  pageId: string;
  element: TextElement;
  template: PageSize;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLElement | null>(null);
  const done = useRef(false);
  /** What has been typed so far; null until the first input. */
  const draft = useRef<string | null>(null);
  const [pageHeightPx, setPageHeightPx] = useState(0);
  const margin = useBookStore((s) => s.book?.theme.margin) ?? OVERLAY_MARGIN;
  const elementId = element.id;
  const initialText = useRef(element.text);

  // Font-size fallback for engines without container units; cqw on the wrapper does the real work.
  useLayoutEffect(() => {
    const node = wrapRef.current;
    if (node) setPageHeightPx((node.clientWidth * template.height) / template.width);
  }, [template.width, template.height]);

  // Uncontrolled: fill once, focus, caret at the end.
  useLayoutEffect(() => {
    const node = editRef.current;
    if (!node) return;
    node.textContent = initialText.current;
    node.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, []);

  const commitDraft = () => {
    const text = draft.current;
    if (text === null) return;
    useBookStore.getState().updateElement(pageId, elementId, (el) => {
      if (el.type === 'text' && el.text !== text) el.text = text;
    });
  };

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) commitDraft();
    const ui = useUiStore.getState();
    if (ui.editingTextId === elementId) ui.editText(null);
  };

  // Editing can end from outside (another selection, page change, delete): commit what was typed.
  // Only the text: the ui already moved on. Safe under StrictMode's mount, unmount, mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount and unmount only, with the latest commitDraft
  useEffect(() => {
    done.current = false;
    return () => {
      if (done.current) return;
      done.current = true;
      commitDraft();
    };
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
      focusCanvas();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
      focusCanvas();
    }
  }

  const aspect = template.height / template.width;
  const f = element.frame;
  const box = {
    position: 'absolute',
    left: pct(f.x),
    top: pct(f.y),
    width: pct(f.w),
    minHeight: pct(f.h),
    ...textStyle(element, { pageAspect: aspect, pageHeightPx: pageHeightPx || 1000 * aspect }),
    // Same padding variables as the renderer (overlay text keeps the safe margin from the trim).
    ...(element.overlay ? overlayPadding(margin, (pageHeightPx || 1000 * aspect) / aspect) : undefined),
  } as CSSProperties;
  // The renderer always decorates editable text (gradient, tint), even while empty.
  const decoration = `${element.overlay ? ' pb-text-overlay' : ''}${element.box ? ' pb-text-box' : ''}`;

  const editable = {
    ref: (node: HTMLElement | null) => {
      editRef.current = node;
    },
    contentEditable: 'plaintext-only' as const,
    suppressContentEditableWarning: true,
    role: 'textbox',
    'aria-multiline': true,
    'aria-label': 'Text',
    spellCheck: true,
    onKeyDown,
    onInput: (e: FormEvent<HTMLElement>) => {
      draft.current = readText(e.currentTarget);
    },
    onBlur: () => finish(true),
    className: 'outline-none select-text cursor-text',
  };

  return (
    <div ref={wrapRef} className="pointer-events-none absolute inset-0" style={{ containerType: 'inline-size' }}>
      <div data-canvas-ui className={`pb-text pb-text-${element.style}${decoration} pointer-events-auto`} style={box}>
        {element.pill ? (
          <span {...editable} className={`pb-pill min-w-[1ch] ${editable.className}`} />
        ) : (
          // Overlay text sits at the bottom of its frame (flex end), so it must not fill the box.
          <div {...editable} style={element.overlay ? undefined : { minHeight: '100%' }} />
        )}
      </div>
    </div>
  );
}
