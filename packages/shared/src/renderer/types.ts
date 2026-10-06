/** What a host returns for an asset: the renderer never knows where images live. */
export interface ResolvedImage {
  src: string;
  srcSet?: string;
  sizes?: string;
  /**
   * Alternative encodings rendered as `<source>` elements of a `<picture>` ahead of the img
   * (AVIF and WebP ladders in the viewer). `src` stays the fallback.
   */
  sources?: ImageSource[];
  /** Tiny image (usually a data: URL) shown behind the photo while it loads. */
  placeholder?: string;
  /** Intrinsic size of `src`, used as the img's width/height attributes. */
  width?: number;
  height?: number;
  /** The img's `loading` attribute; the viewer lazy-loads pages beyond the neighbours. */
  loading?: 'eager' | 'lazy';
}

export interface ImageSource {
  /** MIME type, e.g. `image/avif`. */
  type: string;
  srcSet: string;
  sizes?: string;
}

/**
 * Injected by the host. The editor returns proxy file URLs; the viewer returns R2 URLs with srcset.
 * `targetWidthPx` is the slot's width at `pageWidthPx` (default 1080). Return null when the asset
 * cannot be shown (missing file, not cached yet).
 */
export type ResolveImage = (assetId: string, targetWidthPx: number) => ResolvedImage | null;

/**
 * The subset of a pointer event the renderer hands to `onElementPointerDown`. Both React's
 * synthetic event and Preact's native event satisfy it, so the renderer stays framework neutral.
 */
export interface ElementPointerEvent {
  clientX: number;
  clientY: number;
  button: number;
  pointerId: number;
  pointerType: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  currentTarget: EventTarget & HTMLElement;
  preventDefault(): void;
  stopPropagation(): void;
}

export type ElementPointerDownHandler = (elementId: string, event: ElementPointerEvent) => void;

/** Page size in template pixels; only the ratio matters to the renderer. */
export interface PageSize {
  width: number;
  height: number;
}

/** Default page width used to compute `targetWidthPx` and the px font-size fallback. */
export const DEFAULT_PAGE_WIDTH_PX = 1080;
