import {
  type BookTemplate,
  CURRENT_VERSION,
  Page,
  PageSchema,
  type PageSize,
  parseBook,
  type ResolveImage,
  type Theme,
  ThemeSchema,
} from '@photobook/shared';
import '@photobook/shared/renderer.css';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { fileUrl, type ProjectSummary, readProject } from '../../lib/tauri';

/**
 * Plan 50: a project's cover on Home, its first page drawn by the shared renderer (`<Page>`, exactly as the page strip
 * and the viewer draw it) at about 160 px. What the renderer needs (the first page, the page size, the theme and the
 * cached thumbnail of every photo on that page) plus the page count is read once from the project file and cached per
 * project id + modified time, in memory and in localStorage with a small cap, so Home opens without reading the
 * projects again. A project with no pages draws the empty paper.
 */

/** What a cover is drawn from; also what the cache holds. */
export interface CoverSnapshot {
  /** The book schema version it was read with; a cached snapshot of another version is read again. */
  schema: number;
  template: PageSize;
  theme: Theme;
  /** The first page, or null for a project with no pages (the empty paper). */
  page: Page | null;
  /** Absolute path of the cached 256 px thumbnail of each photo asset on that page, by asset id. */
  thumbs: Record<string, string>;
  pageCount: number;
}

/** The cover box's long edge, px. */
export const COVER_SIZE = 160;
/** The page's long edge inside the box, px (the rest is the box's margin around the paper). */
const PAPER_SIZE = 136;

/** Snapshots kept in memory, and in localStorage (`COVER_STORE`), most recently used last. */
const MEMORY_CAP = 48;
const STORE_CAP = 24;
/** The stored list's size cap in characters; the oldest snapshots go first. */
const STORE_BYTES = 200_000;
const COVER_STORE = 'photobook.home.covers';

const memory = new Map<string, CoverSnapshot>();
const pending = new Map<string, Promise<CoverSnapshot>>();
/** The stored list, parsed once per session (oldest first); null until first read. */
let stored: Map<string, unknown> | null = null;

/** The cache key: the project id and the file's modified time, so a saved change reads the file again. */
export const coverKey = (project: Pick<ProjectSummary, 'id' | 'updatedAt'>): string =>
  `${project.id}:${project.updatedAt}`;

const idOfKey = (key: string): string => key.slice(0, key.lastIndexOf(':'));

/** A stored snapshot, parsed; null when it does not match what this version draws. */
function validSnapshot(value: unknown): CoverSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Partial<CoverSnapshot>;
  if (s.schema !== CURRENT_VERSION || typeof s.pageCount !== 'number') return null;
  if (!s.template || !(s.template.width > 0) || !(s.template.height > 0)) return null;
  const theme = ThemeSchema.safeParse(s.theme);
  const page = s.page === null ? null : PageSchema.safeParse(s.page);
  if (!theme.success || (page !== null && !page.success)) return null;
  const thumbs: Record<string, string> = {};
  for (const [id, path] of Object.entries(s.thumbs ?? {})) if (typeof path === 'string') thumbs[id] = path;
  return {
    schema: s.schema,
    template: { width: s.template.width, height: s.template.height },
    theme: theme.data,
    page: page === null ? null : page.data,
    thumbs,
    pageCount: s.pageCount,
  };
}

/** The stored list as a map, read from localStorage on the first call of the session. */
function storeMap(): Map<string, unknown> {
  if (stored) return stored;
  stored = new Map();
  try {
    const raw = localStorage.getItem(COVER_STORE);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list)) {
      for (const e of list) if (Array.isArray(e) && typeof e[0] === 'string') stored.set(e[0], e[1]);
    }
  } catch {
    // Nothing usable stored.
  }
  return stored;
}

/** Put `snapshot` last in the stored list, dropping the project's older keys and the oldest beyond the caps. */
function writeStore(key: string, snapshot: CoverSnapshot): void {
  const map = storeMap();
  const id = idOfKey(key);
  for (const k of [...map.keys()]) if (idOfKey(k) === id) map.delete(k);
  map.set(key, snapshot);
  const list = [...map.entries()];
  while (list.length > STORE_CAP) list.shift();
  try {
    let text = JSON.stringify(list);
    while (text.length > STORE_BYTES && list.length > 1) {
      list.shift();
      text = JSON.stringify(list);
    }
    stored = new Map(list);
    localStorage.setItem(COVER_STORE, text);
  } catch {
    // The stored copy is a convenience; the memory copy still holds it for this session.
  }
}

function remember(key: string, snapshot: CoverSnapshot): void {
  const id = idOfKey(key);
  for (const k of memory.keys()) if (idOfKey(k) === id) memory.delete(k);
  memory.set(key, snapshot);
  while (memory.size > MEMORY_CAP) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/** The cached snapshot for `key` (memory first, then localStorage), or undefined. */
export function cachedCover(key: string): CoverSnapshot | undefined {
  const hit = memory.get(key);
  if (hit) {
    // Most recently used last.
    memory.delete(key);
    memory.set(key, hit);
    return hit;
  }
  const snapshot = validSnapshot(storeMap().get(key));
  if (!snapshot) return undefined;
  remember(key, snapshot);
  return snapshot;
}

/** Forget every cached cover (tests). */
export function clearCoverCache(): void {
  memory.clear();
  pending.clear();
  stored = null;
  try {
    localStorage.removeItem(COVER_STORE);
  } catch {
    // Nothing stored.
  }
}

/**
 * The thumbnail cache root, `<appdata>/cache`, from the project's `coverThumb` (`<appdata>/cache/<hash>/thumb.jpg`,
 * the path Rust lists and the asset protocol serves); null when the project has no cached cover photo.
 */
export function cacheRootOf(coverThumb: string | null): string | null {
  const match = coverThumb?.match(/^(.*)[/\\][0-9a-f]{64}[/\\]thumb\.jpg$/);
  return match?.[1] ?? null;
}

/** The photo asset ids on a page: its photo elements', then its background's. */
function photoIds(page: Page): string[] {
  const ids = page.elements.flatMap((el) => (el.type === 'photo' && el.asset ? [el.asset] : []));
  if (typeof page.background === 'object') ids.push(page.background.asset);
  return ids;
}

/** The thumbnail cache root of any listed project (they all share `<appdata>/cache`), or null when none has one. */
export function sharedCacheRoot(projects: readonly Pick<ProjectSummary, 'coverThumb'>[]): string | null {
  for (const p of projects) {
    const root = cacheRootOf(p.coverThumb);
    if (root) return root;
  }
  return null;
}

/** The snapshot of a parsed project: its first page and the thumbnails of the photos on it. */
export function coverSnapshot(
  book: { template: BookTemplate; theme: Theme; pages: Page[]; assets: Record<string, { hash?: string }> },
  cacheRoot: string | null,
): CoverSnapshot {
  const first = book.pages[0];
  const thumbs: Record<string, string> = {};
  if (first && cacheRoot) {
    const ids = photoIds(first);
    const sep = cacheRoot.includes('\\') && !cacheRoot.includes('/') ? '\\' : '/';
    for (const id of ids) {
      const hash = book.assets[id]?.hash;
      if (hash) thumbs[id] = [cacheRoot, hash, 'thumb.jpg'].join(sep);
    }
  }
  const page = first ? { ...first, notes: undefined, guides: [] } : null;
  return {
    schema: CURRENT_VERSION,
    template: { width: book.template.width, height: book.template.height },
    theme: book.theme,
    page,
    thumbs,
    pageCount: book.pages.length,
  };
}

/**
 * Read (or reuse) the project's cover snapshot. The cache root is the project's own `coverThumb`'s, else `fallbackRoot`
 * (another listed project's, `sharedCacheRoot`). A first page with photos but no known root is drawn without them and
 * not cached, so the next visit reads it again instead of keeping a blank cover until the file changes.
 */
export function loadCover(project: ProjectSummary, fallbackRoot: string | null = null): Promise<CoverSnapshot> {
  const key = coverKey(project);
  const hit = cachedCover(key);
  if (hit) return Promise.resolve(hit);
  const running = pending.get(key);
  if (running) return running;
  const job = (async () => {
    const book = parseBook(await readProject(project.id));
    const root = cacheRootOf(project.coverThumb) ?? fallbackRoot;
    const snapshot = coverSnapshot(book, root);
    const first = book.pages[0];
    if (root || !first || photoIds(first).length === 0) {
      remember(key, snapshot);
      writeStore(key, snapshot);
    }
    return snapshot;
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/**
 * The project's cover snapshot: undefined while it is read, null when it cannot be (a project the registry could not
 * read, or a file that does not parse; the card says why from the summary or draws the paper).
 */
export function useProjectCover(
  project: ProjectSummary,
  fallbackRoot: string | null = null,
): CoverSnapshot | null | undefined {
  const key = coverKey(project);
  const [state, setState] = useState<{ key: string; snapshot: CoverSnapshot | null } | null>(() => {
    const hit = project.error ? undefined : cachedCover(key);
    return hit ? { key, snapshot: hit } : null;
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the project's id and modified time
  useEffect(() => {
    if (project.error) {
      setState({ key, snapshot: null });
      return;
    }
    let live = true;
    loadCover(project, fallbackRoot).then(
      (snapshot) => live && setState({ key, snapshot }),
      (err) => {
        devLog('projects', 'cover not read', { id: project.id, error: errorMessage(err) });
        if (live) setState({ key, snapshot: null });
      },
    );
    return () => {
      live = false;
    };
  }, [key, project.error, fallbackRoot]);
  return state?.key === key ? state.snapshot : undefined;
}

/** The resolver for a snapshot's thumbnails: the cached file through the asset protocol, or nothing yet. */
function thumbResolver(thumbs: Record<string, string>): ResolveImage {
  return (assetId) => {
    const path = thumbs[assetId];
    return path ? { src: fileUrl(path), loading: 'lazy' } : null;
  };
}

/** The page's size inside the cover box: the long edge `PAPER_SIZE`, the template's aspect. */
export function paperSize(template: PageSize, long = PAPER_SIZE): { width: number; height: number } {
  const ratio = template.width / template.height;
  return ratio >= 1
    ? { width: long, height: Math.round(long / ratio) }
    : { width: Math.round(long * ratio), height: long };
}

/**
 * The cover: a `COVER_SIZE` box (`panel-2`) with the first page on its paper. `resolve` defaults to the snapshot's
 * cached thumbnails (the kitchen sink passes the fixture resolver). No accent here: the cover is a photo, so the
 * card's focus ring sits on the card chrome around it.
 */
export function ProjectCover({
  snapshot,
  resolve,
}: {
  /** Undefined while loading (an empty box), null when unreadable (the box only). */
  snapshot: CoverSnapshot | null | undefined;
  resolve?: ResolveImage;
}) {
  const fallback = useMemo(() => thumbResolver(snapshot?.thumbs ?? {}), [snapshot]);
  const size = snapshot ? paperSize(snapshot.template) : null;
  return (
    <span
      className="flex items-center justify-center rounded-md bg-panel-2"
      style={{ width: COVER_SIZE, height: COVER_SIZE }}
      data-cover={
        snapshot === undefined ? 'loading' : snapshot === null ? 'unreadable' : snapshot.page ? 'page' : 'empty'
      }
    >
      {snapshot && size && (
        <span className="block overflow-hidden rounded-xs shadow-raised" style={{ width: size.width }}>
          {snapshot.page ? (
            <Page
              page={snapshot.page}
              template={snapshot.template}
              theme={snapshot.theme}
              resolve={resolve ?? fallback}
              pageWidthPx={size.width}
            />
          ) : (
            // A project with no pages: the empty paper in the theme's background.
            <span
              aria-hidden="true"
              className="block"
              style={{ height: size.height, background: snapshot.theme.background }}
            />
          )}
        </span>
      )}
    </span>
  );
}
