import {
  type AssetFlag,
  BOOK_OUTPUT_ID,
  type FlagFilter,
  GROUP_BY_KEYS,
  type GroupByKey,
  type Lens,
  type PhotoSort,
  pagesOf,
  type StoryGroupBy,
} from '@photobook/shared';
import { create } from 'zustand';
import type { ComponentMode, MaskToolName } from '../lib/develop/masks';
import { COPY_SECTIONS, DEFAULT_COPY_SECTIONS, type DevelopCopySection } from '../lib/develop/sync';
import type { StructureLine } from '../lib/tauri';
import { useBookStore } from './book';
import { assetDevelop } from './library';
import { setOutputContext } from './outputs';

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

/**
 * Filmstrip order: capture time (the Exif `taken`, else the file mtime) or file name, and (plan 56) the storytelling
 * sorts of `@photobook/shared` (rating, sharpness, colour, luminance, aspect, warmth). View state only.
 */
export type FilmstripSort = PhotoSort;
/** Filmstrip flag filter: everything, everything but rejects, only picks, only rejects (shared with collections). */
export type { FlagFilter };

/**
 * What the Photos tab shows. Lives here (not in the filmstrip) so switching to Layouts, preview or
 * review and back keeps the search, filters and scroll position. Per book, not persisted.
 */
export interface FilmstripView {
  query: string;
  sort: FilmstripSort;
  /** Hide photos some page already uses. */
  hideUsed: boolean;
  flag: FlagFilter;
  /** Only photos rated at least this many stars; 0 shows every rating, unrated included. */
  minRating: number;
  /** Only photos with develop edits (the Cull filter bar's *Edited*). */
  edited: boolean;
  /** Only photos whose ISO is at least this; 0 keeps every photo (offered once the index knows ISO). */
  minIso: number;
  /** The Cull filter bar's technical lens (plan 41, `inLens`): `'none'` keeps every photo. Never writes a flag. */
  lens: Lens;
  /** Plan 56: the Design tabs' *Group by* dividers (day, place, camera, colour family, aspect); absent is none. */
  groupBy?: StoryGroupBy;
  /** Grid scroll offset, px. */
  scrollTop: number;
  /** Asset id the grid should scroll into view once (set when review closes), then cleared. */
  reveal: string | null;
}

export const DEFAULT_FILMSTRIP: FilmstripView = {
  query: '',
  sort: 'time',
  hideUsed: false,
  flag: 'all',
  minRating: 0,
  edited: false,
  minIso: 0,
  lens: 'none',
  scrollTop: 0,
  reveal: null,
};

/**
 * The Develop strip's filter (workflow plan 08): the Cull filter, except that *All flags* hides rejects there, so by
 * default Develop steps through the picks and the unflagged photos.
 */
export function developFilter<V extends Pick<FilmstripView, 'flag'>>(view: V): V {
  return view.flag === 'all' ? { ...view, flag: 'no-rejects' } : view;
}

/**
 * The photos selected in Cull (workflow plan 06), shared by Cull, Develop's strip and batch bar (plan 08), paste (10),
 * looks (20), denoise (27) and export (11). `keys` are photo ids of the list on screen, in selection order: library keys
 * `${folderId}/${path}` in the library stages, project asset ids in the project's Cull. `anchor` is where a Shift range
 * starts (the last plain or Cmd click). Empty means batch actions take the focused photo.
 */
export interface PhotoSelection {
  keys: string[];
  anchor: string | null;
}

export const EMPTY_SELECTION: PhotoSelection = { keys: [], anchor: null };

/**
 * What the Cull stage shows: the grid, one photo (`ReviewMode`), two side by side (compare), a survey of several, or
 * the Decide pass (plan 40).
 */
export type CullViewMode = 'grid' | 'review' | 'compare' | 'survey' | 'decide';

/** The two photos of the Compare view (workflow plan 07): the one being judged (left) and the one to beat (right). */
export interface CullCompare {
  candidate: string;
  select: string;
  /** The view Esc goes back to: Decide when Decide opened Compare (C, plan 40), else the grid. */
  back?: 'decide';
}

/** One decision of the Decide pass (plan 40): each photo it flagged with the flag it had before, and the photo shown. */
export interface CullDecision {
  at: string;
  /** Photo id to its flag before the decision (null: undecided). */
  before: Record<string, AssetFlag | null>;
}

/**
 * The Decide pass (plan 40, `components/cull/DecideView.tsx`): the photo it shows is the `review` session's current
 * one; this holds the pass's own decision log (U undoes the last one; never app undo) and the pause nudge's clock.
 * Kept across a stage switch and a trip to the grid; dropped when the Cull stage opens another source.
 */
export interface CullDecide {
  log: CullDecision[];
  /** When the pass started (or restarted after a break, `openDecide`), epoch ms. */
  startedAt: number;
  /** When the last decision was taken, epoch ms; absent before the first. */
  lastAt?: number;
  /** Decisions taken in the pass (U does not take one back). */
  decisions: number;
  /** The "Good place to stop?" line was dismissed for this pass. */
  pauseDismissed: boolean;
}

/** The photos Survey still shows, in grid order; X removes one (and rejects it). */
export interface CullSurvey {
  ids: string[];
}

/** Cull grid state, kept across sources and projects. */
export interface CullState {
  /** Grid columns, `CULL_COLUMNS_MIN` to `CULL_COLUMNS_MAX` (J / K, Cmd+- / Cmd+=); per machine, persisted. */
  columns: number;
  view: CullViewMode;
  /** Grid scroll offset, px: Review and back (Esc) returns to it. */
  scrollTop: number;
  /** The photos of the Compare view; set with `view: 'compare'`. */
  compare?: CullCompare;
  /** The photos of the Survey view; set with `view: 'survey'`. */
  survey?: CullSurvey;
  /** Bursts and re-shots show as one cell each (plan 39, the filter bar's *Group*); on by default. */
  grouped: boolean;
  /** The grid shows star ratings (plan 39 adds the field; plan 40 hides the stars behind it). Off by default. */
  showStars: boolean;
  /** The group (`PhotoGroup.id`) open in place in the grid (G), or null. */
  expanded: string | null;
  /** The Decide pass (plan 40); set when it first opens on a source. */
  decide?: CullDecide;
  /**
   * The one zoom of One and Two (plan 52, ODDHALLS_LAYOUT_PLAN 3): Fit, or 1× / 2× / 4× the proxy's pixels, the stop of
   * their linked viewport (Grid's zoom is `columns`). Per machine, persisted like the columns.
   */
  zoom: CullZoom;
  /**
   * Plan 53: the *Assist* overlays of One, Two and Decide (all off by default; per machine, persisted). Optional so a
   * state written before 53 reads as `DEFAULT_CULL_ASSIST`.
   */
  assist?: CullAssist;
  /** Plan 53: the grid's *Group by* dividers (`'none'` by default; per machine, persisted). */
  groupBy?: CullGroupBy;
  /** Plan 53: the grid's collapsed *Group by* sections, by key and section key (per machine, persisted). */
  collapsed?: CullCollapsed;
}

/** Plan 53: the composition guides O cycles through (null: none). */
export const COMPOSITION_GUIDES = ['thirds', 'golden', 'spiral', 'centre', 'diagonals'] as const;
export type CompositionGuide = (typeof COMPOSITION_GUIDES)[number];

/** Plan 53: Cull's view-only assist overlays. They never write a flag or a setting. */
export interface CullAssist {
  /** F: in-focus edges in the accent (a preview mode of `render_develop_preview`). */
  focusPeak: boolean;
  /** Z: stripes over clipped highlights and, dimmer, crushed shadows (a preview mode). */
  zebra: boolean;
  /** O: the composition guide drawn over the picture, or null. */
  composition: CompositionGuide | null;
}

export const DEFAULT_CULL_ASSIST: Readonly<CullAssist> = { focusPeak: false, zebra: false, composition: null };
export const CULL_ASSIST_KEY = 'photobook.ui.cullAssist';

function loadCullAssist(): CullAssist {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(CULL_ASSIST_KEY) ?? 'null') as Partial<CullAssist> | null;
    const composition = COMPOSITION_GUIDES.find((g) => g === raw?.composition) ?? null;
    return { focusPeak: raw?.focusPeak === true, zebra: raw?.zebra === true, composition };
  } catch {
    return { ...DEFAULT_CULL_ASSIST };
  }
}

/** Plan 53: the grid's dividers by capture hour, day, camera, lens or place (`groupBy` in shared), or none. */
export type CullGroupBy = 'none' | GroupByKey;
export const CULL_GROUP_BY_KEY = 'photobook.ui.cullGroupBy';

/** Plan 53: collapsed section keys per *Group by* key. */
export type CullCollapsed = Partial<Record<GroupByKey, string[]>>;
export const CULL_COLLAPSED_KEY = 'photobook.ui.cullCollapsed';

function loadCullCollapsed(): CullCollapsed {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(CULL_COLLAPSED_KEY) ?? '{}') as Record<string, unknown>;
    const out: CullCollapsed = {};
    for (const key of GROUP_BY_KEYS) {
      const keys = raw?.[key];
      if (Array.isArray(keys)) out[key] = keys.filter((k): k is string => typeof k === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

function loadCullGroupBy(): CullGroupBy {
  try {
    const raw = globalThis.localStorage?.getItem(CULL_GROUP_BY_KEY);
    return GROUP_BY_KEYS.find((k) => k === raw) ?? 'none';
  } catch {
    return 'none';
  }
}

/** One and Two's zoom stops (`ZoomStop` in `components/cull/viewport.ts`). */
export type CullZoom = 'fit' | 1 | 2 | 4;
export const CULL_ZOOM_KEY = 'photobook.ui.cullZoom';

function loadCullZoom(): CullZoom {
  try {
    const raw = globalThis.localStorage?.getItem(CULL_ZOOM_KEY);
    const n = Number(raw);
    return raw === '1' || raw === '2' || raw === '4' ? (n as CullZoom) : 'fit';
  } catch {
    return 'fit';
  }
}

export const CULL_COLUMNS_MIN = 3;
export const CULL_COLUMNS_MAX = 8;
export const CULL_COLUMNS_KEY = 'photobook.ui.cullColumns';
const DEFAULT_CULL_COLUMNS = 5;

const clampColumns = (n: number): number =>
  Math.min(CULL_COLUMNS_MAX, Math.max(CULL_COLUMNS_MIN, Math.round(Number.isFinite(n) ? n : DEFAULT_CULL_COLUMNS)));

function loadCullColumns(): number {
  try {
    const raw = globalThis.localStorage?.getItem(CULL_COLUMNS_KEY);
    return raw ? clampColumns(Number(raw)) : DEFAULT_CULL_COLUMNS;
  } catch {
    return DEFAULT_CULL_COLUMNS;
  }
}

/** The stages that lay out the shell's panes (ODDHALLS_LAYOUT_PLAN 2): left, right and the strip. */
export type PaneStage = 'cull' | 'develop' | 'design';
export const PANE_STAGES: readonly PaneStage[] = ['cull', 'develop', 'design'];

/** Which of a stage's panes show (plan 51). `strip` is the bottom strip (Develop's filmstrip, Design's page strip). */
export interface StagePanes {
  left: boolean;
  right: boolean;
  strip: boolean;
}

export type Panes = Record<PaneStage, StagePanes>;

/** What Tab (`'panes'`: both side panes) and Shift+Tab (`'all'`: the panes and the strip) toggle. */
export type PaneToggle = 'panes' | 'all';

export const PANES_KEY = 'photobook.ui.panes';
const ALL_SHOWN: StagePanes = { left: true, right: true, strip: true };

/** The panes stored on this machine (every pane shown where unset or unreadable); never in the project file. */
export function loadPanes(): Panes {
  const out = { cull: { ...ALL_SHOWN }, develop: { ...ALL_SHOWN }, design: { ...ALL_SHOWN } };
  try {
    const raw = globalThis.localStorage?.getItem(PANES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      for (const stage of PANE_STAGES) {
        const saved = (parsed as Record<string, unknown>)[stage];
        if (!saved || typeof saved !== 'object') continue;
        for (const pane of ['left', 'right', 'strip'] as const) {
          const v = (saved as Record<string, unknown>)[pane];
          if (typeof v === 'boolean') out[stage][pane] = v;
        }
      }
    }
  } catch {
    // Unreadable: every pane shows.
  }
  return out;
}

/**
 * The panes after Tab or Shift+Tab: Tab hides both side panes when either shows, else shows both; Shift+Tab hides
 * the panes and the strip when any shows, else shows all three.
 */
export function togglePanes(panes: StagePanes, which: PaneToggle): StagePanes {
  if (which === 'panes') {
    const show = !(panes.left || panes.right);
    return { ...panes, left: show, right: show };
  }
  const show = !(panes.left || panes.right || panes.strip);
  return { left: show, right: show, strip: show };
}

/**
 * The ids from `anchor` to `to` (both included) in `order`, in that order's direction; just `to` when the anchor is
 * not in the list (filtered out, or none) and nothing when `to` is not.
 */
export function rangeOf(order: readonly string[], anchor: string | null, to: string): string[] {
  const end = order.indexOf(to);
  if (end < 0) return [];
  const start = anchor === null ? -1 : order.indexOf(anchor);
  if (start < 0) return [to];
  return start <= end ? order.slice(start, end + 1) : order.slice(end, start + 1).reverse();
}

/**
 * Photo review (loupe) session: the photo ids it steps through, fixed when it opens, and the current one. A photo id
 * is a project asset id (Review inside a project) or a library key `${folderId}/${path}` (Cull, no project needed).
 */
export interface ReviewSession {
  ids: string[];
  index: number;
}

/** A line under the Upright buttons, for one photo. */
export interface UprightMessage {
  assetId: string;
  text: string;
  /** An error (invalid guides, unstable solve) rather than a note. */
  error: boolean;
}

/**
 * The lines the last automatic Upright analysis found for one photo, in fractions of its oriented frame, with the
 * orientation they belong to (`orientationKey`): the "show structure" overlay draws them while it still matches.
 */
export interface UprightLines {
  assetId: string;
  orientation: string;
  lines: StructureLine[];
}

/** Key of a photo's orientation (rotate and flips) for `UprightLines`. */
export const orientationKey = (g: { rotate: number; flipH: boolean; flipV: boolean }): string =>
  `${g.rotate}|${g.flipH ? 'h' : ''}${g.flipV ? 'v' : ''}`;

/** Develop view session: the photo ids (see `ReviewSession`) it steps through, fixed when it opens, and the current one. */
export interface DevelopSession {
  ids: string[];
  index: number;
}

/** Brush settings for new mask strokes (per machine, a pref). Same units as `BrushStroke`. */
export interface BrushParams {
  /** Diameter, % of the frame's short side (0.5..100). */
  size: number;
  /** Soft edge, % of the radius. */
  feather: number;
  /** Dab opacity, %. */
  flow: number;
  /** Paint erase strokes (Alt inverts it per stroke). */
  erase: boolean;
}

export const DEFAULT_BRUSH: BrushParams = { size: 10, feather: 50, flow: 100, erase: false };
export const BRUSH_SIZE_MIN = 0.5;

/** A brush size one `[` (-1) or `]` (+1) step away: about 15 % per step, on a 0.5 grid. */
export function stepBrushSize(size: number, dir: 1 | -1): number {
  const next = dir > 0 ? Math.max(size * 1.15, size + 0.5) : Math.min(size / 1.15, size - 0.5);
  return Math.min(100, Math.max(BRUSH_SIZE_MIN, Math.round(next * 2) / 2));
}

/**
 * The selected mask and the tool drawing over the picture (Develop Masks section). `tool` null: the mask is only
 * selected. `create`: the next shape the tool draws creates the mask itself (`'new'`, with `maskId` as its id) or a
 * new component of `maskId` with that mode; after that, `componentId` names the component the tool edits (brush
 * strokes go into it, gradient handles move it; `refine` adds click / box prompts to the selected AI component).
 */
export interface DevelopMaskTool {
  maskId: string;
  componentId?: string;
  tool: MaskToolName | null;
  create?: 'new' | ComponentMode;
}

/** The last finished Apply of a photo: which intermediate it made and how long the model took. */
export interface DenoiseRun {
  key: string;
  elapsedMs: number;
  engine: string;
}

/** A model download started from the Denoise group, by manifest name (progress from `models:progress`). */
export interface DenoiseDownload {
  job: number;
  received: number;
  total: number;
}

/**
 * Denoise group state (step D5.2) that must outlive the section being collapsed or the view stepping to another photo:
 * last results and errors by asset id, model downloads by model name, the 100 % crop preview, and `epoch`, bumped
 * whenever an intermediate changed so the live preview renders again with the same settings. Apply runs are jobs in
 * `store/jobs.ts` (plan 09).
 */
export interface DenoiseUi {
  runs: Readonly<Record<string, DenoiseRun>>;
  errors: Readonly<Record<string, string>>;
  downloads: Readonly<Record<string, DenoiseDownload>>;
  epoch: number;
  /** The crop preview is open; clicking the picture moves `center` (fractions of the picture shown). */
  previewOpen: boolean;
  center: readonly [number, number];
}

export const DENOISE_UI_INITIAL: DenoiseUi = {
  runs: {},
  errors: {},
  downloads: {},
  epoch: 0,
  previewOpen: false,
  center: [0.5, 0.5],
};

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
  /** Rulers along the page and its ruler guides (`page.guides`, workflow plan 31); hidden guides do not snap. */
  showRulers: boolean;
  /** Draw the snap guides and distance badges while a frame is dragged (snapping itself follows `snapEnabled`). */
  showGuidesWhileDragging: boolean;
  /** Left panel tab in Design: the project's photos, the library (to add photos), or layouts. */
  leftTab: 'photos' | 'library' | 'layouts';
  /** Review: move to the next photo after rating or flagging one (Shift inverts it per key). */
  reviewAutoAdvance: boolean;
  /** Develop: draw the lines automatic Upright found over the photo (used and rejected in two colours). */
  showStructure: boolean;
  /** Develop Masks: tint the selected mask red over the picture (`O`). */
  maskOverlay: boolean;
  /** Plan 44: the achromatic surround of the photo wells (`--color-surround`, set by `lib/surround.ts`). */
  surround: Surround;
  /** Plan 46: haptic ticks on a Force Touch trackpad (Settings → Appearance; `lib/haptic.ts`). */
  haptics: boolean;
  /** Plan 54: the Develop panel's Basic ⇄ Advanced switch (true: every card's advanced controls show inline). */
  developAdvanced: boolean;
}

/** Plan 44: Settings → Appearance → Surround. Black is the screen-viewing one, mid grey the print-matching one. */
export const SURROUNDS = ['black', 'charcoal', 'mid'] as const;
export type Surround = (typeof SURROUNDS)[number];

/** localStorage keys of the prefs. */
export const UI_PREF_KEYS: { [K in keyof UiPrefs]: string } = {
  showGrid: 'photobook.ui.showGrid',
  showMargins: 'photobook.ui.showMargins',
  snapEnabled: 'photobook.ui.snapEnabled',
  showRulers: 'photobook.ui.showRulers',
  showGuidesWhileDragging: 'photobook.ui.showGuidesWhileDragging',
  leftTab: 'photobook.ui.leftTab',
  reviewAutoAdvance: 'photobook.ui.reviewAutoAdvance',
  showStructure: 'photobook.ui.showStructure',
  maskOverlay: 'photobook.ui.maskOverlay',
  surround: 'photobook.ui.surround',
  haptics: 'photobook.ui.haptics',
  developAdvanced: 'photobook.ui.developAdvanced',
};

/** localStorage key of the brush settings (an object, so kept apart from the boolean / string prefs). */
export const MASK_BRUSH_KEY = 'photobook.ui.maskBrush';
/** localStorage key of the sections Cmd+Shift+C copies (the Copy Settings dialog's remembered choice). */
export const COPY_SECTIONS_KEY = 'photobook.ui.copySections';

export const DEFAULT_UI_PREFS: UiPrefs = {
  showGrid: false,
  showMargins: true,
  snapEnabled: true,
  showRulers: true,
  showGuidesWhileDragging: true,
  leftTab: 'photos',
  reviewAutoAdvance: false,
  showStructure: false,
  maskOverlay: true,
  surround: 'black',
  haptics: true,
  developAdvanced: false,
};

const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** A stored brush pref, each field checked (bad or missing ones take the default). */
function parseBrush(raw: string): BrushParams {
  let v: Partial<Record<keyof BrushParams, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') v = parsed as typeof v;
  } catch {
    // Keep the defaults.
  }
  return {
    size: clampNum(v.size, BRUSH_SIZE_MIN, 100, DEFAULT_BRUSH.size),
    feather: clampNum(v.feather, 0, 100, DEFAULT_BRUSH.feather),
    flow: clampNum(v.flow, 0, 100, DEFAULT_BRUSH.flow),
    erase: typeof v.erase === 'boolean' ? v.erase : DEFAULT_BRUSH.erase,
  };
}

function readPref<K extends keyof UiPrefs>(key: K): UiPrefs[K] {
  const fallback = DEFAULT_UI_PREFS[key];
  try {
    const raw = globalThis.localStorage?.getItem(UI_PREF_KEYS[key]);
    if (raw === null || raw === undefined) return fallback;
    if (typeof fallback === 'boolean') return (raw === 'true') as UiPrefs[K];
    if (key === 'surround') return (SURROUNDS.includes(raw as Surround) ? raw : fallback) as UiPrefs[K];
    return (raw === 'photos' || raw === 'library' || raw === 'layouts' ? raw : fallback) as UiPrefs[K];
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
    showRulers: readPref('showRulers'),
    showGuidesWhileDragging: readPref('showGuidesWhileDragging'),
    leftTab: readPref('leftTab'),
    reviewAutoAdvance: readPref('reviewAutoAdvance'),
    showStructure: readPref('showStructure'),
    maskOverlay: readPref('maskOverlay'),
    surround: readPref('surround'),
    haptics: readPref('haptics'),
    developAdvanced: readPref('developAdvanced'),
  };
}

/** The copy sections stored on this machine: the known names of a JSON array, else the defaults. */
export function loadCopySections(): DevelopCopySection[] {
  try {
    const raw = globalThis.localStorage?.getItem(COPY_SECTIONS_KEY);
    const list: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(list)) {
      const known = COPY_SECTIONS.filter((s) => list.includes(s));
      if (known.length > 0) return known;
    }
  } catch {
    // Unreadable: the defaults.
  }
  return [...DEFAULT_COPY_SECTIONS];
}

/** The brush settings stored on this machine (defaults where unset or unreadable). */
export function loadMaskBrush(): BrushParams {
  try {
    const raw = globalThis.localStorage?.getItem(MASK_BRUSH_KEY);
    return raw ? parseBrush(raw) : { ...DEFAULT_BRUSH };
  } catch {
    return { ...DEFAULT_BRUSH };
  }
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
  /** Photos tab search, sort, filters and scroll. */
  filmstrip: FilmstripView;
  /**
   * The library's filters (Cull and Develop over a folder or collection, and the Design stage's Library tab): search,
   * sort, flag and rating; `hideUsed` hides photos already in the open project. Kept across projects.
   */
  libraryView: FilmstripView;
  /** The library folder the Design stage's Library tab shows (registry id); null: the project's primary folder. */
  libraryTabFolder: string | null;
  /** The photo (library key) Cull or Develop showed last, so switching stages keeps it. */
  libraryPhoto: string | null;
  /** The folder (registry id) Cull or Develop showed last: where the stage tabs go back to. */
  libraryFolder: string | null;
  /** Photos selected in Cull (`PhotoSelection`); per book (a project open or close clears it). */
  selection: PhotoSelection;
  /** Cull grid columns, view and scroll. */
  cull: CullState;
  /** Photo review open over the editor. */
  review: ReviewSession | null;
  /** Develop view open over the editor. */
  develop: DevelopSession | null;
  /** Develop view shows the original instead of the edit (the backslash key). Reset whenever the view opens or closes. */
  developBeforeAfter: boolean;
  /** Guided Upright drawing is on in the Develop view (the guides overlay). Reset whenever the view opens or closes. */
  developGuides: boolean;
  /** The Transform section's Upright message (an invalid guide combination, or what the solve corrected). */
  uprightMessage: UprightMessage | null;
  /** Lines of the last automatic Upright analysis (not saved: the stored transform is what renders). */
  uprightLines: UprightLines | null;
  /** Denoise group results, downloads and crop preview (step D5.2). */
  denoise: DenoiseUi;
  /** The Develop panel's Masks section is open (`M`): mask tools and the overlay only work while it is. */
  developMasks: boolean;
  /** Selected mask and active mask tool; cleared when stepping to another photo or closing the view. */
  developMaskTool: DevelopMaskTool | null;
  /** Brush size, feather, flow and erase for new strokes (per machine, persisted under `MASK_BRUSH_KEY`). */
  maskBrush: BrushParams;
  /**
   * The Sync dialog (Develop panel header, or the batch bar with the selection as `targets`, checked when it opens): copy
   * sections of `sourceId` onto other photos. Per book, not saved.
   */
  syncDialog: { sourceId: string; targets?: string[] } | null;
  /** The Copy Settings dialog (Shift+Cmd+Alt+C, the panel's Copy…, the Cull menu) for `sourceId`'s settings. */
  copyDialog: { sourceId: string } | null;
  /**
   * The sections Cmd+Shift+C (and Paste from previous) copies: the Copy Settings dialog's choice when it was remembered
   * (workflow plan 10). Per machine, persisted under `COPY_SECTIONS_KEY`, kept by `reset()`.
   */
  copySections: DevelopCopySection[];
  /**
   * Which panes each stage shows (plan 51, ODDHALLS_LAYOUT_PLAN 2): Tab and Shift+Tab toggle them. Per machine,
   * persisted under `PANES_KEY`, kept by `reset()`.
   */
  panes: Panes;
  /** The Lightroom import dialog over these photos (one: the Inspector button or Cmd+Shift+I; several: the filmstrip). */
  xmpImportDialog: { assetIds: string[] } | null;
  saveStatus: SaveStatus;
  saveError: string | null;
  /**
   * The Design stage (workflow plan 13): `outputId` is the document on the canvas, `BOOK_OUTPUT_ID` for the book's
   * pages or an id of `book.outputs`. The route `/project/$id/design/$outputId` sets it; `pageIndex` and the selection
   * are within its pages.
   */
  design: DesignState;
  /** Show another document on the canvas (the route calls it): the page it was left on (else its first), nothing selected. */
  setDesignOutput: (outputId: string) => void;
  /** Canvas gesture modes (workflow plan 29). */
  canvas: CanvasState;
  /**
   * Enter Adjust photo mode on a filled photo frame (it becomes the only selection) or leave it with null. The mode
   * ends by itself when the selection, the page, the tool or the frame's photo changes (see `adjustingHolds`).
   */
  setAdjusting: (elementId: string | null) => void;

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
  setFilmstrip: (patch: Partial<FilmstripView>) => void;
  setLibraryView: (patch: Partial<FilmstripView>) => void;
  setLibraryTabFolder: (folderId: string | null) => void;
  /** Remember where Cull or Develop is (the folder, and the photo shown when known). */
  setLibraryPlace: (folderId: string | null, photo?: string | null) => void;
  /** Replace the selection (deduplicated); `anchor` defaults to the last key. */
  setSelection: (keys: readonly string[], anchor?: string | null) => void;
  /** Cmd+click: add or remove one photo; it becomes the anchor. */
  toggleSelected: (key: string) => void;
  /** Shift+click / Shift+arrow: select the range from the anchor to `to` in `order` (the list as sorted now). */
  selectRange: (order: readonly string[], to: string) => void;
  clearSelection: () => void;
  /** Change the Cull view or scroll; `columns` is clamped and persisted, `zoom` persisted. */
  setCull: (patch: Partial<CullState>) => void;
  /** Open review over photo ids `ids` (in that order) at `index`; does nothing for an empty list. */
  openReview: (ids: string[], index?: number) => void;
  /** Step to another photo of the review, clamped to the list. */
  setReviewIndex: (index: number) => void;
  /**
   * Swap the photo list of an open review or Develop session (the library stages, as a folder scan adds photos) and
   * show `index`, keeping everything else of the session (tools, before/after). No-op with no session.
   */
  updateSessionIds: (kind: 'review' | 'develop', ids: string[], index: number) => void;
  /** Close review and have the filmstrip reveal the photo it ended on. */
  closeReview: () => void;
  /**
   * Open the Develop view over photo ids `ids` (in that order) at `index`, closing review if it is open; does
   * nothing for an empty list.
   */
  openDevelop: (ids: string[], index?: number) => void;
  /** Step to another photo of the Develop session, clamped to the list. */
  setDevelopIndex: (index: number) => void;
  /** Close the Develop view and have the filmstrip reveal the photo it ended on. */
  closeDevelop: () => void;
  /** Show the original (true) or the edit (false) in the Develop view. */
  setDevelopBeforeAfter: (before: boolean) => void;
  /** Turn guided Upright drawing on or off. */
  setDevelopGuides: (on: boolean) => void;
  setUprightMessage: (message: UprightMessage | null) => void;
  setUprightLines: (lines: UprightLines | null) => void;
  /** Open or close the Masks section; closing ends the mask tool and the selection. */
  setDevelopMasks: (open: boolean) => void;
  /** Select a mask / start a tool (opens the Masks section), or clear both with null. */
  setDevelopMaskTool: (tool: DevelopMaskTool | null) => void;
  /** Update the Denoise group state: `patch` maps the current state to the fields that change. */
  updateDenoise: (patch: (prev: DenoiseUi) => Partial<DenoiseUi>) => void;
  /** Change the brush settings (persisted). */
  setMaskBrush: (patch: Partial<BrushParams>) => void;
  openSyncDialog: (sourceId: string, targets?: readonly string[]) => void;
  closeSyncDialog: () => void;
  openCopyDialog: (sourceId: string) => void;
  closeCopyDialog: () => void;
  /** Remember the sections to copy (persisted); an empty list is ignored. */
  setCopySections: (sections: readonly DevelopCopySection[]) => void;
  /** Show or hide some of a stage's panes; persisted. */
  setPanes: (stage: PaneStage, patch: Partial<StagePanes>) => void;
  /** Tab (`'panes'`) or Shift+Tab (`'all'`) on a stage (`togglePanes`); persisted. */
  togglePanes: (stage: PaneStage, which: PaneToggle) => void;
  /** Open the Lightroom import dialog over `assetIds`; does nothing for an empty list. */
  openXmpImport: (assetIds: string[]) => void;
  closeXmpImport: () => void;
  setSaveStatus: (status: SaveStatus, error?: string | null) => void;
  /** Set a view pref and persist it in localStorage. */
  setPref: <K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) => void;
  /** Reset the per-book UI state (prefs are kept). */
  reset: () => void;
}

/** The Design stage's open document and the page each document was left on (see `UiState.design`). */
/** Canvas gesture modes (workflow plan 29). */
export interface CanvasState {
  /** The photo frame in *Adjust photo* mode (drag pans the photo, wheel zooms it), or null: drags move frames. */
  adjusting: string | null;
}

export interface DesignState {
  outputId: string;
  /** Page index each document showed when another one was opened, by output id. Per project, never saved. */
  pageIndexes: Readonly<Record<string, number>>;
}

/** What a Develop session change keeps of the Denoise state: results and downloads go on; the crop preview resets. */
function keepDenoise(d: DenoiseUi): Partial<DenoiseUi> {
  return { runs: d.runs, errors: d.errors, downloads: d.downloads, epoch: d.epoch };
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
  filmstrip: DEFAULT_FILMSTRIP,
  libraryTabFolder: null as string | null,
  review: null as ReviewSession | null,
  develop: null as DevelopSession | null,
  developBeforeAfter: false,
  developGuides: false,
  uprightMessage: null as UprightMessage | null,
  uprightLines: null as UprightLines | null,
  denoise: DENOISE_UI_INITIAL,
  developMasks: false,
  developMaskTool: null as DevelopMaskTool | null,
  syncDialog: null as { sourceId: string; targets?: string[] } | null,
  copyDialog: null as { sourceId: string } | null,
  xmpImportDialog: null as { assetIds: string[] } | null,
  saveStatus: 'saved' as SaveStatus,
  saveError: null,
  selection: EMPTY_SELECTION,
  design: { outputId: BOOK_OUTPUT_ID, pageIndexes: {} } as DesignState,
  canvas: { adjusting: null } as CanvasState,
};

/** Whether resizing keeps an element's aspect ratio: the inspector choice, else photos yes, text no. */
export function isRatioLocked(
  s: Pick<UiState, 'ratioLocks'>,
  element: { id: string; type: 'photo' | 'text' },
): boolean {
  return s.ratioLocks[element.id] ?? element.type === 'photo';
}

export const effectiveZoom = (s: Pick<UiState, 'zoom' | 'fitZoom'>): number => (s.zoom === 'fit' ? s.fitZoom : s.zoom);

/** Plan 46: true while `setZoom` or `stepZoom` (a person zooming) writes, so `lib/haptic.ts` skips resets. */
let userZoom = false;
export const zoomedByUser = (): boolean => userZoom;
function asUserZoom(write: () => void): void {
  userZoom = true;
  try {
    write();
  } finally {
    userZoom = false;
  }
}

export const useUiStore = create<UiState>()((set, get) => ({
  ...INITIAL,
  // Not in INITIAL: the library's place and filters outlive a project (`reset` keeps them).
  libraryView: DEFAULT_FILMSTRIP,
  libraryPhoto: null,
  libraryFolder: null,
  cull: {
    columns: loadCullColumns(),
    view: 'grid',
    scrollTop: 0,
    grouped: true,
    showStars: false,
    expanded: null,
    zoom: loadCullZoom(),
    assist: loadCullAssist(),
    groupBy: loadCullGroupBy(),
    collapsed: loadCullCollapsed(),
  },
  ...loadUiPrefs(),
  maskBrush: loadMaskBrush(),
  copySections: loadCopySections(),
  panes: loadPanes(),
  setDesignOutput: (outputId) => {
    const { design, pageIndex } = get();
    if (design.outputId === outputId) return;
    // Each document reopens on the page it was left on (this session only), kept within its pages.
    const pageIndexes = { ...design.pageIndexes, [design.outputId]: pageIndex };
    const book = useBookStore.getState().book;
    const count = book ? pagesOf(book, outputId).length : 0;
    const back = Math.min(pageIndexes[outputId] ?? 0, Math.max(count - 1, 0));
    set({
      design: { outputId, pageIndexes },
      pageIndex: back,
      selectedElementId: null,
      selectedElementIds: [],
      editingTextId: null,
      layoutPicker: null,
    });
  },
  setAdjusting: (elementId) =>
    set(
      elementId === null
        ? { canvas: { adjusting: null } }
        : {
            canvas: { adjusting: elementId },
            tool: 'select',
            selectedElementId: elementId,
            selectedElementIds: [elementId],
            editingTextId: null,
          },
    ),
  setPageIndex: (index) => {
    const book = useBookStore.getState().book;
    const count = book ? pagesOf(book, get().design.outputId).length : 0;
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
  setZoom: (zoom) => asUserZoom(() => set({ zoom: zoom === 'fit' ? 'fit' : clampZoom(zoom) })),
  setFitZoom: (fitZoom) => set({ fitZoom }),
  stepZoom: (direction) => {
    const z = effectiveZoom(get());
    const eps = 0.001;
    const next =
      direction > 0 ? ZOOM_STEPS.find((s) => s > z + eps) : [...ZOOM_STEPS].reverse().find((s) => s < z - eps);
    asUserZoom(() => set({ zoom: next ?? (direction > 0 ? ZOOM_MAX : ZOOM_MIN) }));
  },
  openLayoutPicker: (pageId) => set({ layoutPicker: { pageId } }),
  closeLayoutPicker: () => set({ layoutPicker: null }),
  openOriginal: (assetId) => set({ originalModal: { assetId } }),
  closeOriginal: () => set({ originalModal: null }),
  setFilmstrip: (patch) => set((s) => ({ filmstrip: { ...s.filmstrip, ...patch } })),
  setLibraryView: (patch) => set((s) => ({ libraryView: { ...s.libraryView, ...patch } })),
  setLibraryTabFolder: (libraryTabFolder) => set({ libraryTabFolder }),
  setLibraryPlace: (folderId, photo) =>
    set((s) => ({
      libraryFolder: folderId ?? s.libraryFolder,
      libraryPhoto: photo === undefined ? s.libraryPhoto : photo,
    })),
  setSelection: (keys, anchor) => {
    const unique = [...new Set(keys)];
    set({ selection: { keys: unique, anchor: anchor === undefined ? (unique.at(-1) ?? null) : anchor } });
  },
  toggleSelected: (key) =>
    set((s) => {
      const has = s.selection.keys.includes(key);
      return {
        selection: { keys: has ? s.selection.keys.filter((k) => k !== key) : [...s.selection.keys, key], anchor: key },
      };
    }),
  selectRange: (order, to) =>
    set((s) => {
      const anchor = s.selection.anchor !== null && order.includes(s.selection.anchor) ? s.selection.anchor : to;
      return { selection: { keys: rangeOf(order, anchor, to), anchor } };
    }),
  clearSelection: () =>
    set((s) => (s.selection.keys.length === 0 && s.selection.anchor === null ? {} : { selection: EMPTY_SELECTION })),
  setCull: (patch) =>
    set((s) => {
      const next = { ...s.cull, ...patch };
      // Plan 49: *Group by* is one control; dividers always keep the bursts stacked (no "dividers, bursts unstacked").
      if ((next.groupBy ?? 'none') !== 'none') next.grouped = true;
      if (patch.columns !== undefined) {
        next.columns = clampColumns(patch.columns);
        try {
          globalThis.localStorage?.setItem(CULL_COLUMNS_KEY, String(next.columns));
        } catch {
          // Storage blocked: the columns still apply for this session.
        }
      }
      if (patch.zoom !== undefined && patch.zoom !== s.cull.zoom) {
        try {
          globalThis.localStorage?.setItem(CULL_ZOOM_KEY, String(patch.zoom));
        } catch {
          // Storage blocked: the zoom still applies for this session.
        }
      }
      try {
        if (patch.assist !== undefined) globalThis.localStorage?.setItem(CULL_ASSIST_KEY, JSON.stringify(patch.assist));
        if (patch.groupBy !== undefined) globalThis.localStorage?.setItem(CULL_GROUP_BY_KEY, patch.groupBy);
        if (patch.collapsed !== undefined) {
          globalThis.localStorage?.setItem(CULL_COLLAPSED_KEY, JSON.stringify(patch.collapsed));
        }
      } catch {
        // Storage blocked: the overlays and dividers still apply for this session.
      }
      return { cull: next };
    }),
  openReview: (ids, index = 0) => {
    if (ids.length === 0) return;
    set({ review: { ids, index: Math.min(Math.max(index, 0), ids.length - 1) } });
  },
  setReviewIndex: (index) =>
    set((s) => {
      if (!s.review) return {};
      const next = Math.min(Math.max(index, 0), s.review.ids.length - 1);
      return next === s.review.index ? {} : { review: { ...s.review, index: next } };
    }),
  updateSessionIds: (kind, ids, index) =>
    set((s) => {
      const session = kind === 'review' ? s.review : s.develop;
      if (!session || ids.length === 0) return {};
      const next = { ids, index: Math.min(Math.max(index, 0), ids.length - 1) };
      return kind === 'review' ? { review: next } : { develop: next };
    }),
  closeReview: () =>
    set((s) => ({
      review: null,
      filmstrip: s.review ? { ...s.filmstrip, reveal: s.review.ids[s.review.index] ?? null } : s.filmstrip,
    })),
  openDevelop: (ids, index = 0) => {
    if (ids.length === 0) return;
    set({
      develop: { ids, index: Math.min(Math.max(index, 0), ids.length - 1) },
      developBeforeAfter: false,
      developGuides: false,
      uprightMessage: null,
      uprightLines: null,
      developMasks: false,
      developMaskTool: null,
      denoise: { ...DENOISE_UI_INITIAL, ...keepDenoise(get().denoise) },
      review: null,
    });
  },
  setDevelopIndex: (index) =>
    set((s) => {
      if (!s.develop) return {};
      const next = Math.min(Math.max(index, 0), s.develop.ids.length - 1);
      return next === s.develop.index
        ? {}
        : {
            develop: { ...s.develop, index: next },
            developMaskTool: null,
            denoise: { ...s.denoise, center: DENOISE_UI_INITIAL.center },
          };
    }),
  closeDevelop: () =>
    set((s) => ({
      develop: null,
      developBeforeAfter: false,
      developGuides: false,
      uprightMessage: null,
      uprightLines: null,
      developMasks: false,
      developMaskTool: null,
      denoise: { ...DENOISE_UI_INITIAL, ...keepDenoise(s.denoise) },
      filmstrip: s.develop ? { ...s.filmstrip, reveal: s.develop.ids[s.develop.index] ?? null } : s.filmstrip,
    })),
  setDevelopBeforeAfter: (developBeforeAfter) => set({ developBeforeAfter }),
  setDevelopGuides: (developGuides) => set({ developGuides }),
  setUprightMessage: (uprightMessage) => set({ uprightMessage }),
  setUprightLines: (uprightLines) => set({ uprightLines }),
  setDevelopMasks: (developMasks) => set(developMasks ? { developMasks } : { developMasks, developMaskTool: null }),
  setDevelopMaskTool: (developMaskTool) =>
    set(developMaskTool ? { developMaskTool, developMasks: true } : { developMaskTool: null }),
  updateDenoise: (patch) => set((s) => ({ denoise: { ...s.denoise, ...patch(s.denoise) } })),
  setMaskBrush: (patch) => {
    const next = parseBrush(JSON.stringify({ ...get().maskBrush, ...patch }));
    try {
      globalThis.localStorage?.setItem(MASK_BRUSH_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: the brush still applies for this session.
    }
    set({ maskBrush: next });
  },
  openSyncDialog: (sourceId, targets) =>
    set({ syncDialog: targets ? { sourceId, targets: [...targets] } : { sourceId } }),
  closeSyncDialog: () => set({ syncDialog: null }),
  openCopyDialog: (sourceId) => set({ copyDialog: { sourceId } }),
  closeCopyDialog: () => set({ copyDialog: null }),
  setPanes: (stage, patch) => {
    const panes = { ...get().panes, [stage]: { ...get().panes[stage], ...patch } };
    try {
      globalThis.localStorage?.setItem(PANES_KEY, JSON.stringify(panes));
    } catch {
      // Storage blocked: the panes still apply for this session.
    }
    set({ panes });
  },
  togglePanes: (stage, which) => get().setPanes(stage, togglePanes(get().panes[stage], which)),
  setCopySections: (sections) => {
    const next = COPY_SECTIONS.filter((s) => sections.includes(s));
    if (next.length === 0) return;
    try {
      globalThis.localStorage?.setItem(COPY_SECTIONS_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked: the choice still applies for this session.
    }
    set({ copySections: next });
  },
  openXmpImport: (assetIds) => {
    if (assetIds.length > 0) set({ xmpImportDialog: { assetIds } });
  },
  closeXmpImport: () => set({ xmpImportDialog: null }),
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
  const ui = useUiStore.getState();
  const pages = state.book ? pagesOf(state.book, ui.design.outputId) : [];
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
  // A selected mask (or the component its tool edits) that undo or a delete removed is deselected.
  const tool = ui.developMaskTool;
  if (tool && !tool.create && ui.develop) {
    const masks = assetDevelop(state, ui.develop.ids[ui.develop.index] ?? '')?.masks ?? [];
    const mask = masks.find((m) => m.id === tool.maskId);
    if (!mask) patch.developMaskTool = null;
    else if (tool.componentId && !mask.components.some((c) => c.id === tool.componentId)) {
      patch.developMaskTool = { maskId: tool.maskId, tool: null };
    }
  }
  if (Object.keys(patch).length > 0) useUiStore.setState(patch);
});

// Page actions given no output work on the document on the Design stage.
setOutputContext(() => useUiStore.getState().design.outputId);

/**
 * Whether Adjust photo mode on `adjusting` still holds (workflow plan 29): the element must be the only selection, a
 * filled photo frame on the current page, with the Select tool on.
 */
export function adjustingHolds(
  adjusting: string | null,
  state: { selectedElementIds: readonly string[]; tool: string; filled: boolean },
): boolean {
  if (adjusting === null) return false;
  return (
    state.tool === 'select' &&
    state.filled &&
    state.selectedElementIds.length === 1 &&
    state.selectedElementIds[0] === adjusting
  );
}

/** The frame Adjust photo mode was entered on and the photo it held then. */
let adjusted: { id: string; asset: string | null } | null = null;

// Adjust photo mode ends when its frame stops being the only selection, the page or tool changes, or the photo goes
// or is replaced (a different photo dropped on the frame starts from its own crop).
function keepAdjusting(): void {
  const ui = useUiStore.getState();
  const adjusting = ui.canvas.adjusting;
  if (adjusting === null) {
    adjusted = null;
    return;
  }
  const book = useBookStore.getState().book;
  const page = book ? pagesOf(book, ui.design.outputId)[ui.pageIndex] : undefined;
  const el = page?.elements.find((e) => e.id === adjusting);
  const asset = el?.type === 'photo' ? el.asset : null;
  if (adjusted?.id !== adjusting) adjusted = { id: adjusting, asset };
  const holds = adjustingHolds(adjusting, {
    selectedElementIds: ui.selectedElementIds,
    tool: ui.tool,
    filled: asset !== null,
  });
  if (!holds || adjusted.asset !== asset) {
    adjusted = null;
    useUiStore.setState({ canvas: { adjusting: null } });
  }
}
useUiStore.subscribe(keepAdjusting);
useBookStore.subscribe(keepAdjusting);
