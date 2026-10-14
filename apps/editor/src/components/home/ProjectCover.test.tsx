// @vitest-environment jsdom
import { createEmptyBook, serializeBook, ThemeSchema } from '@photobook/shared';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../../lib/tauri';

const readProject = vi.hoisted(() => vi.fn());
vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  readProject,
  fileUrl: (path: string) => `asset://localhost${path}`,
}));

const { cacheRootOf, cachedCover, clearCoverCache, coverSnapshot, loadCover, ProjectCover, sharedCacheRoot } =
  await import('./ProjectCover');

const HASH = 'a'.repeat(64);
const ROOT = '/appdata/cache';

const summary = (id: string, updatedAt: number, patch: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id,
  path: `/appdata/projects/${id}/project.photobook.json`,
  external: false,
  title: id,
  folders: [],
  updatedAt,
  openedAt: null,
  coverHash: HASH,
  coverThumb: `${ROOT}/${HASH}/thumb.jpg`,
  error: null,
  ...patch,
});

const bookJson = (pages: number) => {
  const book = createEmptyBook({ title: 'Zine', folders: { F: { path: '/photos' } } });
  const [blank] = book.pages;
  if (!blank) throw new Error('An empty book has a page');
  book.pages = Array.from({ length: pages }, (_, i) => ({ ...blank, id: `${blank.id}${i}` }));
  return serializeBook(book);
};

/** A one-page book whose page holds one photo of hash `HASH`. */
const photoBookJson = () => {
  const book = createEmptyBook({ title: 'Zine', folders: { F: { path: '/photos' } } });
  const [blank] = book.pages;
  if (!blank) throw new Error('An empty book has a page');
  book.assets = { x: { path: 'a.jpg', folder: 'F', hash: HASH } } as typeof book.assets;
  book.pages = [
    {
      ...blank,
      elements: [
        {
          type: 'photo',
          id: 'e1',
          asset: 'x',
          frame: { x: 0, y: 0, w: 1, h: 1 },
          crop: { x: 0, y: 0, scale: 1 },
          rotate: 0,
          filter: 'none',
        },
      ],
    },
  ];
  return serializeBook(book);
};

afterEach(() => {
  cleanup();
  clearCoverCache();
  readProject.mockReset();
});

describe('cover cache', () => {
  it('reads a project once per id and modified time, and again after it is saved', async () => {
    readProject.mockResolvedValue(bookJson(3));
    const first = await loadCover(summary('A', 1));
    expect(first.pageCount).toBe(3);
    await loadCover(summary('A', 1));
    expect(readProject).toHaveBeenCalledTimes(1);
    // The stored copy survives the session's memory.
    expect(JSON.parse(localStorage.getItem('photobook.home.covers') ?? '[]')).toHaveLength(1);
    await loadCover(summary('A', 2));
    expect(readProject).toHaveBeenCalledTimes(2);
    // The older key of the same project is dropped.
    expect(cachedCover('A:1')).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('photobook.home.covers') ?? '[]').map((e: [string]) => e[0])).toEqual([
      'A:2',
    ]);
  });

  it('takes the cache root from another listed project when the cover photo has no thumbnail yet', async () => {
    readProject.mockResolvedValue(photoBookJson());
    const bare = summary('A', 1, { coverThumb: null });
    expect(sharedCacheRoot([bare, summary('B', 1)])).toBe(ROOT);
    const snapshot = await loadCover(bare, ROOT);
    expect(snapshot.thumbs).toEqual({ x: `${ROOT}/${HASH}/thumb.jpg` });
    expect(cachedCover('A:1')).toBe(snapshot);
  });

  it('does not cache a cover whose photos it could not place, so the next read tries again', async () => {
    readProject.mockResolvedValue(photoBookJson());
    const bare = summary('A', 1, { coverThumb: null });
    const snapshot = await loadCover(bare);
    expect(snapshot.thumbs).toEqual({});
    expect(cachedCover('A:1')).toBeUndefined();
    expect(localStorage.getItem('photobook.home.covers')).toBeNull();
    await loadCover(bare, ROOT);
    expect(readProject).toHaveBeenCalledTimes(2);
    expect(cachedCover('A:1')?.thumbs).toEqual({ x: `${ROOT}/${HASH}/thumb.jpg` });
  });

  it('keeps at most 24 stored covers, the oldest leaving first', async () => {
    readProject.mockResolvedValue(bookJson(1));
    for (let i = 0; i < 30; i++) await loadCover(summary(`P${i}`, 1));
    const keys = JSON.parse(localStorage.getItem('photobook.home.covers') ?? '[]').map((e: [string]) => e[0]);
    expect(keys).toHaveLength(24);
    expect(keys[0]).toBe('P6:1');
  });

  it('ignores a stored cover it cannot draw', () => {
    localStorage.setItem('photobook.home.covers', JSON.stringify([['A:1', { schema: 1, pageCount: 1 }]]));
    expect(cachedCover('A:1')).toBeUndefined();
  });
});

describe('coverSnapshot', () => {
  it('finds the cache root from the cover thumbnail', () => {
    expect(cacheRootOf(`${ROOT}/${HASH}/thumb.jpg`)).toBe(ROOT);
    expect(cacheRootOf(null)).toBeNull();
    expect(cacheRootOf('/elsewhere/thumb.jpg')).toBeNull();
  });

  it('maps the first page photos and background to their cached thumbnails', () => {
    const theme = ThemeSchema.parse({});
    const page = {
      id: 'P',
      layout: 'blank',
      background: { asset: 'bg' },
      elements: [
        {
          type: 'photo' as const,
          id: 'e1',
          asset: 'x',
          frame: { x: 0, y: 0, w: 1, h: 1 },
          crop: { x: 0, y: 0, scale: 1 },
          rotate: 0 as const,
          filter: 'none' as const,
        },
      ],
      guides: [],
    };
    const snapshot = coverSnapshot(
      {
        template: { width: 1000, height: 1000 } as never,
        theme,
        pages: [page as never],
        assets: { x: { hash: HASH }, bg: { hash: 'b'.repeat(64) } },
      },
      ROOT,
    );
    expect(snapshot.thumbs).toEqual({ x: `${ROOT}/${HASH}/thumb.jpg`, bg: `${ROOT}/${'b'.repeat(64)}/thumb.jpg` });
    expect(snapshot.pageCount).toBe(1);
  });
});

describe('ProjectCover', () => {
  it('draws the first page through the shared renderer', async () => {
    readProject.mockResolvedValue(bookJson(2));
    const snapshot = await loadCover(summary('A', 1));
    render(<ProjectCover snapshot={snapshot} />);
    expect(document.querySelector('[data-cover="page"] .pb-page')).toBeTruthy();
  });

  it('draws the empty paper for a project with no pages, not an error', async () => {
    readProject.mockResolvedValue(bookJson(0));
    const snapshot = await loadCover(summary('A', 1));
    expect(snapshot.page).toBeNull();
    expect(snapshot.pageCount).toBe(0);
    render(<ProjectCover snapshot={snapshot} />);
    expect(document.querySelector('[data-cover="empty"]')).toBeTruthy();
    expect(document.querySelector('.pb-page')).toBeNull();
  });
});
