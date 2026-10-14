import {
  type Asset,
  type Book,
  type CollectionFilter,
  type FlagFilter,
  type FolderLensStats,
  folderStats,
  inLens,
  type Lens,
  type LensEntry,
  type Library,
  type LibraryPhoto,
  lensOf,
  newId,
  parseSavedCollections,
  type SavedCollection,
  storyComparator,
} from '@photobook/shared';
import { create } from 'zustand';
import { suggestedAmount } from '../lib/denoise';
import { devLog } from '../lib/log';
import { basename } from '../lib/path';
import { readCollections, writeCollections } from '../lib/tauri';
import { denoiseThresholds } from './denoisePrefs';
import { assetFolderPath, captureTime, type LibraryFolder, type PhotoFile, photoKey } from './library';
import type { FilmstripView } from './ui';

/**
 * The library's built-in collections (workflow plan 05): saved filters over every imported folder, never copies.
 * Kept (flagged pick; plan 40's word, the id stays `picks`), Edited (a master edit in the library) and Needs denoise (`needsDenoise`: the measured noise
 * when the photo has a profile, its ISO otherwise; plan 23). Needs denoise is offered once some known photo has an
 * ISO or a measured noise. Worth a look (plan 41) holds the photos in any technical lens (Soft, Blown or Dark,
 * `inLens('any', …)`), offered once some known photo has stats. Saved collections (plan 06, `useCollectionsStore`) are
 * listed after them.
 */
export const COLLECTIONS = [
  { id: 'picks', name: 'Kept' },
  { id: 'edited', name: 'Edited' },
  { id: 'needs-denoise', name: 'Needs denoise' },
  { id: 'worth-a-look', name: 'Worth a look' },
] as const;

export type CollectionId = (typeof COLLECTIONS)[number]['id'];

/** ISO from which a photo without a measured noise profile needs denoise. */
export const NEEDS_DENOISE_ISO = 3200;
/** Suggested denoise amount (`suggestedAmount` of the measured σ) from which a photo needs denoise. */
export const NEEDS_DENOISE_AMOUNT = 40;

/**
 * Whether a photo needs denoise: its measured noise suggests `thresholds.amount` or more, else its ISO is
 * `thresholds.iso` or more. The thresholds are Settings → Models' (plan 27; `NEEDS_DENOISE_AMOUNT` and
 * `NEEDS_DENOISE_ISO` by default).
 */
export function needsDenoise(
  photo: Pick<PhotoFile, 'iso' | 'noise'> & Partial<Pick<PhotoFile, 'kind'>>,
  thresholds: { iso: number; amount: number } = denoiseThresholds(),
): boolean {
  if (photo.noise !== undefined && photo.noise !== null) {
    const source = photo.kind === 'raw' ? 'raw' : 'processed';
    return (suggestedAmount({ sigma: photo.noise, source }) ?? 0) >= thresholds.amount;
  }
  return (photo.iso ?? 0) >= thresholds.iso;
}

export const isCollectionId = (id: string): id is CollectionId => COLLECTIONS.some((c) => c.id === id);

/** True when some known photo has an ISO or a measured noise (from its folder's index or `prepare_asset`). */
export function isoKnown(folders: Record<string, LibraryFolder>): boolean {
  for (const folder of Object.values(folders)) {
    for (const photo of Object.values(folder.photos)) {
      if (photo.iso !== undefined || photo.noise !== undefined) return true;
    }
  }
  return false;
}

/** True when some known photo has stats (plan 38), so the lenses can see something. */
export function statsKnown(folders: Record<string, LibraryFolder>): boolean {
  for (const folder of Object.values(folders)) {
    for (const photo of Object.values(folder.photos)) if (photo.stats) return true;
  }
  return false;
}

/**
 * The collections to list: Needs denoise only while an ISO or a noise measurement is known, Worth a look only while
 * some photo has stats.
 */
export function availableCollections(folders: Record<string, LibraryFolder>): (typeof COLLECTIONS)[number][] {
  const iso = isoKnown(folders);
  const stats = statsKnown(folders);
  return COLLECTIONS.filter((c) => (c.id !== 'needs-denoise' || iso) && (c.id !== 'worth-a-look' || stats));
}

const byPhotos = new WeakMap<object, FolderLensStats>();

/**
 * Plan 41: `folderStats` (the Soft decile, ranked by `lensKey`) of a folder's photos, or of the open project's files,
 * cached on the record (a scan or a prepare makes a new one).
 */
export function folderLensStats(
  photos: Record<string, Pick<PhotoFile, 'relPath' | 'stats'> & { assetId?: string }>,
): FolderLensStats {
  let stats = byPhotos.get(photos);
  if (!stats) {
    stats = folderStats(Object.values(photos).map((photo) => ({ key: lensKey(photo), stats: photo.stats })));
    byPhotos.set(photos, stats);
  }
  return stats;
}

/** What `lensOf` reads of a photo: its stats and whether it is a RAW (*RAW headroom*). */
export const lensEntry = (photo: Pick<PhotoFile, 'relPath' | 'stats' | 'kind'>): LensEntry => ({
  key: lensKey(photo),
  stats: photo.stats,
  raw: photo.kind === 'raw',
});

/** A photo's key in its folder's Soft ranking: a project file's asset id (its files span folders), else its path. */
const lensKey = (photo: Pick<PhotoFile, 'relPath'> & { assetId?: string }): string => photo.assetId ?? photo.relPath;

/** Whether a photo passes a lens (plan 41), with its folder's lens stats (`folderLensStats`). Absent lens: yes. */
export function matchesLens(lens: Lens | undefined, photo: PhotoFile, folder: FolderLensStats): boolean {
  if (lens === undefined || lens === 'none') return true;
  return inLens(lens, lensOf(lensEntry(photo), folder));
}

/**
 * Whether a photo (with its folder library entry) belongs to a built-in collection. `folder` is its folder's lens
 * stats (Worth a look's Soft cut); without it the photo is read as its folder's only one, so it is never Soft.
 */
export function inCollection(
  id: CollectionId,
  photo: PhotoFile,
  entry: LibraryPhoto | undefined,
  folder: FolderLensStats = NO_FOLDER_STATS,
): boolean {
  switch (id) {
    case 'picks':
      return entry?.flag === 'pick';
    case 'edited':
      return entry?.develop !== undefined;
    case 'needs-denoise':
      // A photo whose (master) denoise is on is taken care of: it leaves the collection, as its badge goes (plan 27).
      return !entry?.develop?.detail.denoise && needsDenoise(photo);
    case 'worth-a-look':
      return matchesLens('any', photo, folder);
  }
}

const NO_FOLDER_STATS: FolderLensStats = { photos: 0, softCut: null, soft: new Set() };

/**
 * Where the Cull and Develop stages take their photos from: one folder, a built-in collection, or a saved collection
 * (its filter over its folders, every imported folder when it names none).
 */
export type LibrarySource =
  | { kind: 'folder'; id: string }
  | { kind: 'collection'; id: CollectionId }
  | { kind: 'saved'; id: string; filter: CollectionFilter };

/** What a photo must match: the filters of a saved collection, or the library view's (`viewFilter`). */
export type PhotoFilter = Pick<
  CollectionFilter,
  'query' | 'flag' | 'minRating' | 'edited' | 'iso' | 'dateRange' | 'lens'
>;

/** The words of a search, lower-cased: a name matches when it contains every one. */
export const queryTerms = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

/** Whether a file name (or path: its base name counts) matches a search: it contains every word of it. */
export function nameMatches(path: string, query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const name = basename(path).toLowerCase();
  return terms.every((term) => name.includes(term));
}

/**
 * Whether a photo (with its folder library entry) passes a filter. A lens (plan 41) needs the photo's folder's lens
 * stats (`folderLensStats`); without them no photo is Soft.
 */
export function matchesFilter(
  filter: PhotoFilter,
  photo: PhotoFile,
  entry: LibraryPhoto | undefined,
  folder: FolderLensStats = NO_FOLDER_STATS,
): boolean {
  if (!nameMatches(photo.relPath, filter.query)) return false;
  if (!matchesLens(filter.lens, photo, folder)) return false;
  if ((entry?.rating ?? 0) < filter.minRating) return false;
  if (filter.edited && entry?.develop === undefined) return false;
  if (filter.iso !== undefined && (photo.iso ?? 0) < filter.iso) return false;
  if (filter.dateRange && (photo.mtime < filter.dateRange[0] || photo.mtime > filter.dateRange[1])) return false;
  switch (filter.flag) {
    case 'no-rejects':
      return entry?.flag !== 'reject';
    case 'picks':
      return entry?.flag === 'pick';
    case 'rejects':
      return entry?.flag === 'reject';
    case 'undecided':
      return entry?.flag === undefined;
    default:
      return true;
  }
}

/** The library view's filters (search, flag, stars, Edited, ISO, lens) as a `PhotoFilter`. */
export function viewFilter(view: Filters): PhotoFilter {
  return {
    query: view.query,
    flag: view.flag,
    minRating: view.minRating,
    edited: view.edited || undefined,
    iso: view.minIso ? view.minIso : undefined,
    lens: view.lens && view.lens !== 'none' ? view.lens : undefined,
  };
}

/** A photo the library stages can show: hashed (so it can be rated and edited), not unreadable. */
function isUsable(photo: PhotoFile): boolean {
  return photo.hash !== undefined && photo.status !== 'error';
}

/** The library folders a source draws from. */
export function sourceFolders(source: LibrarySource, folders: Record<string, LibraryFolder>): LibraryFolder[] {
  if (source.kind === 'folder') {
    const folder = folders[source.id];
    return folder ? [folder] : [];
  }
  if (source.kind === 'saved' && source.filter.folders) {
    return source.filter.folders.flatMap((id) => (folders[id] ? [folders[id]] : []));
  }
  return Object.values(folders);
}

/**
 * `folderId:usable` for each folder: changes when a scan adds, hashes or loses a photo, not when a thumbnail or an edit
 * lands. Views key their photo lists on it instead of the folders' objects.
 */
export function usableSignature(folders: readonly LibraryFolder[]): string {
  return folders
    .map((f) => {
      let usable = 0;
      for (const photo of Object.values(f.photos)) if (isUsable(photo)) usable += 1;
      return `${f.id}:${usable}`;
    })
    .join(',');
}

/**
 * Per folder, which photos need denoise by their ISO and σ (`needsDenoise` with `thresholds`), as a count and a
 * checksum of their paths: it changes when a measurement or a threshold moves a photo across, not on every new σ
 * (plan 27: the Needs denoise count and list follow it).
 */
export function noiseSignature(
  folders: readonly LibraryFolder[],
  thresholds: { iso: number; amount: number } = denoiseThresholds(),
): string {
  return folders
    .map((f) => {
      let count = 0;
      let sum = 0;
      for (const photo of Object.values(f.photos)) {
        if (!needsDenoise(photo, thresholds)) continue;
        count += 1;
        for (let i = 0; i < photo.relPath.length; i++) sum = (sum * 31 + photo.relPath.charCodeAt(i)) >>> 0;
      }
      return `${f.id}:${count}:${sum}`;
    })
    .join(',');
}

/** One candidate of a library view: its key, file and library entry. */
export interface LibraryItem {
  key: string;
  folderId: string;
  photo: PhotoFile;
  entry: LibraryPhoto | undefined;
  /** Its folder's lens stats (plan 41: the Soft cut). */
  lensStats: FolderLensStats;
}

/** Every usable photo of a source with its library entry (a collection keeps only its members). */
export function sourceItems(
  source: LibrarySource,
  folders: Record<string, LibraryFolder>,
  libraries: Record<string, Library>,
): LibraryItem[] {
  const items: LibraryItem[] = [];
  for (const folder of sourceFolders(source, folders)) {
    const photos = libraries[folder.path]?.photos;
    const lensStats = folderLensStats(folder.photos);
    for (const photo of Object.values(folder.photos)) {
      if (!isUsable(photo) || !photo.hash) continue;
      const entry = photos && Object.hasOwn(photos, photo.hash) ? photos[photo.hash] : undefined;
      if (source.kind === 'collection' && !inCollection(source.id, photo, entry, lensStats)) continue;
      if (source.kind === 'saved' && !matchesFilter(source.filter, photo, entry, lensStats)) continue;
      const key = photoKey({ folder: folder.id, path: photo.relPath });
      items.push({ key, folderId: folder.id, photo, entry, lensStats });
    }
  }
  return items;
}

/** How many photos a collection holds now (its folders' known photos). */
export function collectionCount(
  id: CollectionId,
  folders: Record<string, LibraryFolder>,
  libraries: Record<string, Library>,
): number {
  return sourceItems({ kind: 'collection', id }, folders, libraries).length;
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

type Filters = Pick<FilmstripView, 'query' | 'sort' | 'hideUsed' | 'flag' | 'minRating'> &
  Partial<Pick<FilmstripView, 'edited' | 'minIso' | 'lens'>>;

/**
 * The keys a library view shows, in order: the source's photos narrowed by the search, the flag, rating, Edited and
 * ISO filters, and (`hideUsed`) without the photos already in `project`, sorted by `view.sort` (capture time is the
 * Exif `taken`, else the file mtime: `captureTime`).
 */
export function libraryKeys(
  source: LibrarySource,
  folders: Record<string, LibraryFolder>,
  libraries: Record<string, Library>,
  view: Filters,
  project?: { book: Pick<Book, 'assets' | 'folders'> | null; primary: string | null },
): string[] {
  const filter = viewFilter(view);
  const inProject = view.hideUsed && project?.book ? projectPaths(project.book, project.primary) : null;
  const items = sourceItems(source, folders, libraries).filter(({ photo, entry, folderId, lensStats }) => {
    if (inProject?.has(`${folders[folderId]?.path}\n${photo.relPath}`)) return false;
    return matchesFilter(filter, photo, entry, lensStats);
  });
  const byName = (a: LibraryItem, b: LibraryItem) =>
    nameCollator.compare(basename(a.photo.relPath), basename(b.photo.relPath)) ||
    nameCollator.compare(a.photo.relPath, b.photo.relPath) ||
    a.folderId.localeCompare(b.folderId);
  const byTime = (a: LibraryItem, b: LibraryItem) => captureTime(a.photo) - captureTime(b.photo) || byName(a, b);
  // Plan 56: the storytelling sorts (view state) read the index facts and the library's rating; ties go by time.
  items.sort(
    view.sort === 'name'
      ? byName
      : storyComparator(view.sort, (item) => ({ ...item.photo, rating: item.entry?.rating }), byTime),
  );
  return items.map((item) => item.key);
}

/** `${folderPath}\n${relPath}` of every asset of a project: what "in the project" means for a library photo. */
export function projectPaths(book: Pick<Book, 'assets' | 'folders'>, primary: string | null): Set<string> {
  const paths = new Set<string>();
  for (const asset of Object.values(book.assets) as Asset[]) {
    paths.add(`${assetFolderPath(book, asset, primary)}\n${asset.path}`);
  }
  return paths;
}

/** Photos passing both flag filters, as one; null when no photo can (picks and rejects). */
function bothFlags(a: FlagFilter, b: FlagFilter): FlagFilter | null {
  if (a === b || b === 'all') return a;
  if (a === 'all') return b;
  // Undecided photos have no flag: they pass *Hide rejects* and fail picks and rejects.
  if (a === 'undecided' || b === 'undecided') return a === 'no-rejects' || b === 'no-rejects' ? 'undecided' : null;
  if (a === 'no-rejects' || b === 'no-rejects') return a === 'picks' || b === 'picks' ? 'picks' : null;
  return null;
}

/**
 * The filter **Save as collection…** stores for what a library view shows now: the source's own condition (its folder,
 * a built-in's criterion, a saved collection's filter) and the view's filters, both at once (the stricter flag, stars
 * and ISO, every search word of both; the view's lens, else the source's: plan 41). Null when the two cannot be one
 * filter (picks and rejects, or two different lenses). `hideUsed` and the sort are the view's, not the collection's.
 */
export function collectionFilterFor(source: LibrarySource, view: Filters): CollectionFilter | null {
  const own = viewFilter(view);
  const base: CollectionFilter = { flag: 'all', minRating: 0, query: '' };
  if (source.kind === 'folder') base.folders = [source.id];
  else if (source.kind === 'collection') {
    if (source.id === 'picks') base.flag = 'picks';
    else if (source.id === 'edited') base.edited = true;
    else if (source.id === 'worth-a-look') base.lens = 'any';
    else base.iso = denoiseThresholds().iso;
  } else Object.assign(base, structuredClone(source.filter));
  // One lens a filter: the view's, else the source's (a view lens inside Worth a look is the narrower one). Two
  // different lenses cannot be one filter: nothing is saved.
  const baseLens = base.lens !== 'none' ? base.lens : undefined;
  if (own.lens && baseLens && own.lens !== baseLens && baseLens !== 'any') return null;
  const lens = own.lens ?? baseLens;
  const iso = Math.max(base.iso ?? 0, own.iso ?? 0);
  const flag = bothFlags(base.flag, own.flag);
  if (flag === null) return null;
  return {
    ...base,
    flag,
    minRating: Math.max(base.minRating, own.minRating),
    query: [...new Set([...queryTerms(base.query), ...queryTerms(own.query)])].join(' '),
    ...(base.edited || own.edited ? { edited: true } : {}),
    ...(iso > 0 ? { iso } : {}),
    lens,
  };
}

/**
 * One entry of `collections.json` as read: kept as it was on disk (`raw`, with any field this version does not know),
 * and `parsed` when it validates. Entries that do not are not listed but are written back untouched, so a newer
 * app's collection (or one this version cannot read) survives a rename or delete here.
 */
interface CollectionEntry {
  raw: unknown;
  parsed: SavedCollection | null;
}

/** Saved collections (`<appdata>/collections.json`), loaded once per session and written through on every change. */
export interface CollectionsState {
  /** The collections that parsed, in saved order. */
  saved: SavedCollection[];
  /** Every entry of the file, parsed or not (what a write puts back). */
  entries: CollectionEntry[];
  /** The file has been read this session. */
  loaded: boolean;
  /** Reading it failed (not a missing file): writes are refused so they never replace what could not be read. */
  readError: string | null;
  /** Read the file (once; `force` reads it again). Never rejects: an unreadable file is no collections. */
  load: (force?: boolean) => Promise<void>;
  /** Save a new collection; resolves it (its id is the route parameter). */
  create: (name: string, filter: CollectionFilter) => Promise<SavedCollection>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Forget the list (tests). */
  reset: () => void;
}

let loading: Promise<void> | null = null;
/** Writes run one after another, each with the list as it is when it runs. */
let writing: Promise<unknown> = Promise.resolve();

/** Parse every entry on its own; a repeated id is kept raw (written back) but not listed. */
function toEntries(raw: readonly unknown[]): CollectionEntry[] {
  const seen = new Set<string>();
  return raw.map((entry) => {
    const [parsed] = parseSavedCollections([entry]);
    if (!parsed || seen.has(parsed.id)) return { raw: entry, parsed: null };
    seen.add(parsed.id);
    return { raw: entry, parsed };
  });
}

const listed = (entries: readonly CollectionEntry[]): SavedCollection[] =>
  entries.flatMap((e) => (e.parsed ? [e.parsed] : []));

export const useCollectionsStore = create<CollectionsState>()((set, get) => {
  /** Apply `change` to the entries and write them; a failed write puts the previous ones back and rejects. */
  const commit = (change: (entries: CollectionEntry[]) => CollectionEntry[]): Promise<void> => {
    const run = writing.then(async () => {
      const { readError, entries: before } = get();
      if (readError) throw new Error(`The saved collections could not be read (${readError}); nothing was changed.`);
      const next = change(before);
      set({ entries: next, saved: listed(next) });
      try {
        await writeCollections(next.map((e) => e.raw));
      } catch (err) {
        set({ entries: before, saved: listed(before) });
        throw err;
      }
    });
    writing = run.catch(() => {});
    return run;
  };
  return {
    saved: [],
    entries: [],
    loaded: false,
    readError: null,
    load: (force = false) => {
      if (get().loaded && !force) return Promise.resolve();
      loading ??= readCollections()
        .then((raw) => {
          const entries = toEntries(Array.isArray(raw) ? raw : []);
          const skipped = entries.filter((e) => !e.parsed).length;
          if (skipped > 0) devLog('collections', 'entries not understood, kept as they are', { skipped });
          set({ entries, saved: listed(entries), loaded: true, readError: null });
        })
        .catch((err) => {
          devLog('collections', 'not read', { error: String(err) });
          set({ loaded: true, readError: String(err) });
        })
        .finally(() => {
          loading = null;
        });
      return loading;
    },
    create: async (name, filter) => {
      await get().load();
      const collection: SavedCollection = { id: newId(), name: name.trim(), filter };
      await commit((entries) => [...entries, { raw: collection, parsed: collection }]);
      devLog('collections', 'saved', { id: collection.id });
      return collection;
    },
    rename: (id, name) =>
      commit((entries) =>
        entries.map((e) => {
          if (e.parsed?.id !== id) return e;
          const trimmed = name.trim();
          // The raw entry keeps the fields this version does not know.
          return { raw: { ...(e.raw as object), name: trimmed }, parsed: { ...e.parsed, name: trimmed } };
        }),
      ),
    remove: (id) => commit((entries) => entries.filter((e) => e.parsed?.id !== id)),
    reset: () => set({ saved: [], entries: [], loaded: false, readError: null }),
  };
});

/** The saved collection with this id, if loaded. */
export const savedCollection = (id: string): SavedCollection | undefined =>
  useCollectionsStore.getState().saved.find((c) => c.id === id);
