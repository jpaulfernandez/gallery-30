import { DEVELOP_DEFAULTS, type DevelopSettings, isDefaultDevelop } from '@photobook/shared';
import { deepEqual } from '../../lib/develop/merge';
import { PRESET_SECTION_LABELS } from '../../lib/develop/presets';
import { assetDevelop, type LibraryView, photoEntryPlace } from '../../store/library';

/** One undo state of the book store (what zundo keeps: the book and the libraries). */
export type HistorySnapshot = Pick<LibraryView, 'book' | 'libraries'>;

/** A row of Develop's History (plan 51): an undo step that changed this photo's settings. */
export interface HistoryRow {
  /** The step's index in `[...pastStates, current]`: undoing back to it shows the photo as this row left it. */
  step: number;
  label: string;
  /** Undo can go back to this row without undoing a later step of another photo or of the document. */
  reachable: boolean;
}

const SECTION_LABELS: Record<string, string> = {
  ...PRESET_SECTION_LABELS,
  look: 'Look',
  geometry: 'Transform',
  masks: 'Masks',
};

/** `camelCase` → "camel case". */
const words = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The paths (`['light', 'exposure']`) whose values differ; arrays and nulls compare whole. */
function changedPaths(a: unknown, b: unknown, path: string[] = []): string[][] {
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => changedPaths(a[k], b[k], [...path, k]));
  }
  return deepEqual(a, b) ? [] : [path];
}

function valueAt(settings: DevelopSettings, path: string[]): unknown {
  let v: unknown = settings;
  for (const key of path) v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
  return v;
}

function signed(n: number, exposure: boolean): string {
  const text = exposure || !Number.isInteger(n) ? Math.abs(n).toFixed(2) : String(Math.abs(n));
  return n > 0 ? `+${text}` : n < 0 ? `−${text}` : text;
}

/**
 * What one step did to a photo's settings, in the words of the panel: "Exposure +0.30", "Look: Wren", "Crop", "Reset
 * all", a section's name when several of its values changed, else the sections' names.
 */
export function describeDevelopChange(
  prev: DevelopSettings | undefined,
  next: DevelopSettings | undefined,
  lookName: (presetId: string) => string | null,
): string {
  const a = prev ?? DEVELOP_DEFAULTS;
  const b = next ?? DEVELOP_DEFAULTS;
  if (isDefaultDevelop(b) && !isDefaultDevelop(a)) return 'Reset all';
  const applied = b.look.applied;
  if ((a.look.applied?.presetId ?? null) !== (applied?.presetId ?? null)) {
    return applied ? `Look: ${lookName(applied.presetId) ?? 'a look'}` : 'Look: None';
  }
  const paths = changedPaths(a, b);
  const sections = [...new Set(paths.map((p) => p[0] ?? ''))];
  if (sections.length === 1 && sections[0] === 'geometry') {
    return paths.some((p) => p[1] === 'crop') ? 'Crop' : 'Transform';
  }
  const [only] = paths;
  if (paths.length === 1 && only) {
    const value = valueAt(b, only);
    const label = sentence(
      only
        .slice(1)
        .filter((k) => k !== 'mix')
        .map(words)
        .join(' ') || words(only[0] ?? ''),
    );
    if (typeof value === 'number') return `${label} ${signed(value, only.at(-1) === 'exposure')}`;
    return label;
  }
  const names = sections.map((s) => SECTION_LABELS[s] ?? sentence(words(s)));
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')}…`;
}

/** Every key of `a` and `b` holds the same reference, except the keys `skip` allows. */
function sameExcept(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  skip: (key: string, x: unknown, y: unknown) => boolean,
): boolean {
  if (a === b) return true;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] !== b[key] && !skip(key, a[key], b[key])) return false;
  }
  return true;
}

const record = (v: unknown) => (v ?? {}) as Record<string, unknown>;

/**
 * Nothing differs between two undo states but this photo: its book asset's `develop` and its library entry (where its
 * develop and versions live). A step that also wrote another photo (Sync…, Reset edits on a selection, a paste) or the
 * document is not. Unchanged parts keep their references (the store's updates are structural), so this compares
 * references only; a write outside undo between the two states (a rating) makes it false, which only greys more rows.
 */
function onlyThisPhoto(
  a: HistorySnapshot,
  b: HistorySnapshot,
  assetId: string,
  place: { folder: string; hash: string } | null,
): boolean {
  if ((a.book === null) !== (b.book === null)) return false;
  const books = sameExcept(record(a.book), record(b.book), (key, x, y) =>
    key !== 'assets'
      ? false
      : sameExcept(record(x), record(y), (id, p, q) =>
          id === assetId ? sameExcept(record(p), record(q), (field) => field === 'develop') : false,
        ),
  );
  if (!books) return false;
  return sameExcept(a.libraries, b.libraries, (folder, x, y) =>
    folder !== place?.folder
      ? false
      : sameExcept(record(x), record(y), (key, p, q) =>
          key === 'photos' ? sameExcept(record(p), record(q), (hash) => hash === place.hash) : false,
        ),
  );
}

/**
 * Develop's History for one photo (plan 51, ODDHALLS_LAYOUT_PLAN 4.3): the steps of `states` (the book store's undo
 * states, oldest first, then the current one) that changed `assetId`'s settings, newest first. No storage of its own.
 * A row is reachable when every later step changed this photo and nothing else (`onlyThisPhoto`), so jumping back to
 * it with undo touches no other photo and not the document.
 */
export function historyRows(
  states: readonly HistorySnapshot[],
  view: Pick<LibraryView, 'folder' | 'developVersion'>,
  assetId: string,
  lookName: (presetId: string) => string | null,
): HistoryRow[] {
  const develops = states.map((s) => assetDevelop({ ...s, ...view }, assetId));
  const last = states.at(-1);
  const place = last ? photoEntryPlace({ ...last, ...view }, assetId) : null;
  const rows: HistoryRow[] = [];
  let reachable = true;
  for (let step = states.length - 1; step >= 1; step -= 1) {
    const before = develops[step - 1];
    const after = develops[step];
    const prev = states[step - 1];
    const next = states[step];
    if (!deepEqual(before ?? DEVELOP_DEFAULTS, after ?? DEVELOP_DEFAULTS)) {
      rows.push({ step, label: describeDevelopChange(before, after, lookName), reachable });
    }
    // Undoing back past this step must touch nothing but this photo.
    if (!prev || !next || !onlyThisPhoto(prev, next, assetId, place)) reachable = false;
  }
  return rows;
}
