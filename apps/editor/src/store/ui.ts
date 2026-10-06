import { create } from 'zustand';
import { useBookStore } from './book';

/**
 * Editor UI state: never part of the project file, never undone.
 *
 * Zoom: a number is a zoom factor where 1 (100%) draws the page at PAGE_PX_PER_UNIT CSS px per
 * template px, i.e. 540 px wide for the 1080 px templates; 'fit' fits the canvas with 48 px padding.
 */

export type SaveStatus = 'saved' | 'saving' | 'dirty' | 'error';
export type Zoom = number | 'fit';
/** Canvas tool: Select (V) picks, moves and resizes; Frame (F) draws new empty photo frames. */
export type CanvasTool = 'select' | 'frame';

/** CSS px per template px at 100%: 1080 px templates are 540 px wide. */
export const PAGE_PX_PER_UNIT = 0.5;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
/** Cmd+= / Cmd+- stops. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/**
 * Editor view preferences: per machine, persisted in `localStorage` (never in the book, never
 * undone, kept across books and `reset()`).
 */
export interface UiPrefs {
  /** Grid lines every `theme.grid` of the page width. */
  showGrid: boolean;
  /** Safe-margin and hard-margin rectangles. */
  showMargins: boolean;
  /** Snap moved and resized frames to guides (hold Cmd while dragging to bypass). */
  snapEnabled: boolean;
  /** Left panel tab. */
  leftTab: 'photos' | 'layouts';
}

/** localStorage keys of the prefs. */
export const UI_PREF_KEYS: { [K in keyof UiPrefs]: string } = {
  showGrid: 'photobook.ui.showGrid',
  showMargins: 'photobook.ui.showMargins',
  snapEnabled: 'photobook.ui.snapEnabled',
  leftTab: 'photobook.ui.leftTab',
};

export const DEFAULT_UI_PREFS: UiPrefs = { showGrid: false, showMargins: true, snapEnabled: true, leftTab: 'photos' };

function readPref<K extends keyof UiPrefs>(key: K): UiPrefs[K] {
  const fallback = DEFAULT_UI_PREFS[key];
  try {
    const raw = globalThis.localStorage?.getItem(UI_PREF_KEYS[key]);
    if (raw === null || raw === undefined) return fallback;
    if (typeof fallback === 'boolean') return (raw === 'true') as UiPrefs[K];
    return (raw === 'photos' || raw === 'layouts' ? raw : fallback) as UiPrefs[K];
  } catch {
    return fallback;
  }
}

/** Prefs as stored on this machine (defaults where unset or unreadable). */
export function loadUiPrefs(): UiPrefs {
  return {
    showGrid: readPref('showGrid'),
    showMargins: readPref('showMargins'),
    snapEnabled: readPref('snapEnabled'),
    leftTab: readPref('leftTab'),
  };
}

function writePref<K extends keyof UiPrefs>(key: K, value: UiPrefs[K]): void {
  try {
    globalThis.localStorage?.setItem(UI_PREF_KEYS[key], String(value));
  } catch {
    // Storage blocked: the pref still applies for this session.
  }
}

export interface UiState extends UiPrefs {
  /** Index of the page on the canvas; kept within `book.pages`. */
  pageIndex: number;
  /** Primary selected element on the current page (the last one clicked); what single-element UI uses. */
  selectedElementId: string | null;
  /**
   * Every selected element on the current page, in selection order; the primary is the last one.
   * Shift+click adds or removes; a plain click selects one.
   */
  selectedElementIds: string[];
  /** Canvas tool. */
  tool: CanvasTool;
  /**
   * Ratio-lock choices made in the inspector, by element id. Elements without an entry use the
   * default: photos locked, text free (see `isRatioLocked`). Per book, never saved.
   */
  ratioLocks: Readonly<Record<string, boolean>>;
  /** Text element being edited inline (always the selected element). */
  editingTextId: string | null;
  zoom: Zoom;
  /** The zoom factor 'fit' resolves to, reported by the canvas. */
  fitZoom: number;
  /** Layout picker open for this page. */
  layoutPicker: { pageId: string } | null;
  /** Full-resolution original being inspected. */
  originalModal: { assetId: string } | null;
  saveStatus: SaveStatus;
  saveError: string | null;

  setPageIndex: (index: number) => void;
  /** Select one element (or none); selecting anything else ends inline text editing. */
  select: (elementId: string | null) => void;
  /** Shift+click: add an element to the selection (it becomes the primary) or remove it. */
  toggleSelection: (elementId: string) => void;
  /** Select several elements; the last one is the primary. */
  selectMany: (elementIds: string[]) => void;
  setTool: (tool: CanvasTool) => void;
  /** Lock or free an element's aspect ratio for resizing. */
  setRatioLock: (elementId: string, locked: boolean) => void;
  /** Start inline editing of a text element (selects it), or end editing with null. */
  editText: (elementId: string | null) => void;
  setZoom: (zoom: Zoom) => void;
  setFitZoom: (zoom: number) => void;
  /** Step to the next (1) or previous (-1) stop in ZOOM_STEPS from the effective zoom. */
  stepZoom: (direction: 1 | -1) => void;
  openLayoutPicker: (pageId: string) => void;
  closeLayoutPicker: () => void;
  openOriginal: (assetId: string) => void;
  closeOriginal: () => void;
  setSaveStatus: (status: SaveStatus, error?: string | null) => void;
  /** Set a view pref and persist it in localStorage. */
  setPref: <K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) => void;
  /** Reset the per-book UI state (prefs are kept). */
  reset: () => void;
}

const INITIAL = {
  pageIndex: 0,
  selectedElementId: null,
  selectedElementIds: [] as string[],
  editingTextId: null,
  tool: 'select' as CanvasTool,
  ratioLocks: {} as Readonly<Record<string, boolean>>,
  zoom: 'fit' as Zoom,
  fitZoom: 1,
  layoutPicker: null,
  originalModal: null,
  saveStatus: 'saved' as SaveStatus,
  saveError: null,
};

/** Whether resizing keeps an element's aspect ratio: the inspector choice, else photos yes, text no. */
export function isRatioLocked(
  s: Pick<UiState, 'ratioLocks'>,
  element: { id: string; type: 'photo' | 'text' },
): boolean {
  return s.ratioLocks[element.id] ?? element.type === 'photo';
}

export const effectiveZoom = (s: Pick<UiState, 'zoom' | 'fitZoom'>): number => (s.zoom === 'fit' ? s.fitZoom : s.zoom);

export const useUiStore = create<UiState>()((set, get) => ({
  ...INITIAL,
  ...loadUiPrefs(),
  setPageIndex: (index) => {
    const count = useBookStore.getState().book?.pages.length ?? 0;
    const next = Math.min(Math.max(index, 0), Math.max(count - 1, 0));
    if (next !== get().pageIndex)
      set({ pageIndex: next, selectedElementId: null, selectedElementIds: [], editingTextId: null });
  },
  select: (elementId) =>
    set((s) => ({
      selectedElementId: elementId,
      selectedElementIds: elementId === null ? [] : [elementId],
      editingTextId: s.editingTextId === elementId ? s.editingTextId : null,
    })),
  toggleSelection: (elementId) =>
    set((s) => {
      const ids = s.selectedElementIds.includes(elementId)
        ? s.selectedElementIds.filter((id) => id !== elementId)
        : [...s.selectedElementIds, elementId];
      return { selectedElementIds: ids, selectedElementId: ids.at(-1) ?? null, editingTextId: null };
    }),
  selectMany: (elementIds) => {
    const ids = [...new Set(elementIds)];
    set({ selectedElementIds: ids, selectedElementId: ids.at(-1) ?? null, editingTextId: null });
  },
  setTool: (tool) => set({ tool }),
  setRatioLock: (elementId, locked) => set((s) => ({ ratioLocks: { ...s.ratioLocks, [elementId]: locked } })),
  editText: (elementId) =>
    set(
      elementId === null
        ? { editingTextId: null }
        : { selectedElementId: elementId, selectedElementIds: [elementId], editingTextId: elementId },
    ),
  setZoom: (zoom) => set({ zoom: zoom === 'fit' ? 'fit' : clampZoom(zoom) }),
  setFitZoom: (fitZoom) => set({ fitZoom }),
  stepZoom: (direction) => {
    const z = effectiveZoom(get());
    const eps = 0.001;
    const next =
      direction > 0 ? ZOOM_STEPS.find((s) => s > z + eps) : [...ZOOM_STEPS].reverse().find((s) => s < z - eps);
    set({ zoom: next ?? (direction > 0 ? ZOOM_MAX : ZOOM_MIN) });
  },
  openLayoutPicker: (pageId) => set({ layoutPicker: { pageId } }),
  closeLayoutPicker: () => set({ layoutPicker: null }),
  openOriginal: (assetId) => set({ originalModal: { assetId } }),
  closeOriginal: () => set({ originalModal: null }),
  setSaveStatus: (saveStatus, saveError = null) => set({ saveStatus, saveError }),
  setPref: (key, value) => {
    writePref(key, value);
    set({ [key]: value } as Pick<UiPrefs, typeof key>);
  },
  reset: () => set(INITIAL),
}));

// Keep the UI consistent with the document: a new book resets, edits (and undo) keep the page
// index in range and drop a selection or picker whose target is gone.
useBookStore.subscribe((state, prev) => {
  if (state.folder !== prev.folder) {
    useUiStore.getState().reset();
    return;
  }
  if (state.book === prev.book) return;
  const pages = state.book?.pages ?? [];
  const ui = useUiStore.getState();
  const patch: Partial<UiState> = {};
  const pageIndex = Math.min(ui.pageIndex, Math.max(pages.length - 1, 0));
  if (pageIndex !== ui.pageIndex) patch.pageIndex = pageIndex;
  const page = pages[pageIndex];
  const exists = (id: string) => page?.elements.some((e) => e.id === id) ?? false;
  if (ui.selectedElementIds.some((id) => !exists(id))) {
    patch.selectedElementIds = ui.selectedElementIds.filter(exists);
  }
  if (ui.selectedElementId && !exists(ui.selectedElementId)) {
    patch.selectedElementId = (patch.selectedElementIds ?? ui.selectedElementIds).at(-1) ?? null;
  }
  if (ui.editingTextId && !page?.elements.some((e) => e.id === ui.editingTextId)) patch.editingTextId = null;
  if (ui.layoutPicker && !pages.some((p) => p.id === ui.layoutPicker?.pageId)) patch.layoutPicker = null;
  if (Object.keys(patch).length > 0) useUiStore.setState(patch);
});
