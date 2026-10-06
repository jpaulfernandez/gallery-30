import type { SocialEvent, SocialLike } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import {
  eventPageId,
  eventPhotoIds,
  likeGroups,
  newestFirst,
  pageStats,
  photoStats,
  relativeTime,
  summarize,
  topPhotos,
} from './activity';

let n = 0;
function event(patch: Partial<SocialEvent> & Pick<SocialEvent, 'targetType' | 'targetId' | 'action'>): SocialEvent {
  n += 1;
  return {
    id: `e${n}`,
    bookId: 'book',
    displayName: 'Ana',
    deviceId: 'device-ana',
    pageId: null,
    createdAt: '2026-10-05T10:00:00.000Z',
    ...patch,
  };
}

function like(patch: Partial<SocialLike> & Pick<SocialLike, 'targetType' | 'targetId'>): SocialLike {
  return { deviceId: 'device-ana', displayName: 'Ana', createdAt: '2026-10-05T10:00:00.000Z', ...patch };
}

describe('event targets', () => {
  it('lists the photos of single and collection events once each, none for pages', () => {
    expect(eventPhotoIds(event({ targetType: 'photo', targetId: 'A', action: 'download' }))).toEqual(['A']);
    expect(eventPhotoIds(event({ targetType: 'collection', targetId: ['A', 'B', 'A'], action: 'zip' }))).toEqual([
      'A',
      'B',
    ]);
    expect(eventPhotoIds(event({ targetType: 'page', targetId: 'P1', action: 'page_share' }))).toEqual([]);
  });

  it('finds the page: the target for page events, pageId otherwise, none for collections', () => {
    expect(eventPageId(event({ targetType: 'page', targetId: 'P1', action: 'page_share' }))).toBe('P1');
    expect(eventPageId(event({ targetType: 'photo', targetId: 'A', action: 'download', pageId: 'P2' }))).toBe('P2');
    expect(eventPageId(event({ targetType: 'collection', targetId: ['A'], action: 'zip' }))).toBeNull();
  });
});

describe('photoStats', () => {
  const events = [
    event({ targetType: 'photo', targetId: 'A', action: 'download', pageId: 'P1' }),
    event({ targetType: 'photo', targetId: 'A', action: 'share', pageId: 'P1', deviceId: 'device-bo' }),
    event({ targetType: 'photo', targetId: 'B', action: 'download', pageId: 'P2' }),
    event({ targetType: 'collection', targetId: ['A', 'B', 'C'], action: 'zip' }),
    event({ targetType: 'page', targetId: 'P1', action: 'page_share' }),
  ];
  const likes = [
    like({ targetType: 'photo', targetId: 'B' }),
    like({ targetType: 'photo', targetId: 'B', deviceId: 'device-bo' }),
    like({ targetType: 'photo', targetId: 'D' }),
    like({ targetType: 'page', targetId: 'P1' }),
  ];

  it('counts saves from downloads, shares and zips, and likes, per photo', () => {
    const stats = photoStats({ events, likes });
    expect(Object.fromEntries(stats.map((s) => [s.assetId, [s.saves, s.likes]]))).toEqual({
      A: [3, 0],
      B: [2, 2],
      C: [1, 0],
      D: [0, 1],
    });
  });

  it('orders by saves plus likes, then saves, then id', () => {
    expect(photoStats({ events, likes }).map((s) => s.assetId)).toEqual(['B', 'A', 'C', 'D']);
  });

  it('ignores page likes and page shares', () => {
    expect(photoStats({ events: [events[4] as SocialEvent], likes: [likes[3] as SocialLike] })).toEqual([]);
  });

  it('is empty without activity', () => {
    expect(photoStats({ events: [], likes: [] })).toEqual([]);
  });

  it('topPhotos keeps the best few and drops photos with nothing', () => {
    const stats = [
      ...photoStats({ events, likes }),
      { assetId: 'Z', saves: 0, likes: 0 },
      { assetId: 'Y', saves: 5, likes: 1 },
    ];
    expect(topPhotos(stats, 3).map((s) => s.assetId)).toEqual(['Y', 'B', 'A']);
    expect(topPhotos(stats, 99).map((s) => s.assetId)).not.toContain('Z');
  });
});

describe('pageStats', () => {
  it('splits photo events on a page from page shares and adds page likes', () => {
    const events = [
      event({ targetType: 'photo', targetId: 'A', action: 'download', pageId: 'P1' }),
      event({ targetType: 'photo', targetId: 'B', action: 'download', pageId: 'P1' }),
      event({ targetType: 'photo', targetId: 'A', action: 'download', pageId: 'P2' }),
      event({ targetType: 'collection', targetId: ['A', 'B'], action: 'zip' }),
      event({ targetType: 'page', targetId: 'P1', action: 'page_share' }),
      event({ targetType: 'page', targetId: 'P3', action: 'page_share', pageId: 'P3' }),
    ];
    const likes = [like({ targetType: 'page', targetId: 'P2' }), like({ targetType: 'photo', targetId: 'A' })];
    const byId = Object.fromEntries(pageStats({ events, likes }).map((s) => [s.pageId, s]));
    expect(byId).toEqual({
      P1: { pageId: 'P1', saves: 2, shares: 1, likes: 0 },
      P2: { pageId: 'P2', saves: 1, shares: 0, likes: 1 },
      P3: { pageId: 'P3', saves: 0, shares: 1, likes: 0 },
    });
  });
});

describe('likeGroups', () => {
  it('groups likes by target, most liked first, newest liker first', () => {
    const groups = likeGroups([
      like({ targetType: 'photo', targetId: 'A', displayName: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' }),
      like({ targetType: 'page', targetId: 'P1', displayName: 'Bo', createdAt: '2026-10-02T00:00:00.000Z' }),
      like({ targetType: 'photo', targetId: 'A', displayName: 'Cy', createdAt: '2026-10-03T00:00:00.000Z' }),
      like({ targetType: 'page', targetId: 'P1', displayName: null, createdAt: '2026-10-04T00:00:00.000Z' }),
      like({ targetType: 'photo', targetId: 'B' }),
    ]);
    expect(groups.map((g) => `${g.type}:${g.id}`)).toEqual(['page:P1', 'photo:A', 'photo:B']);
    expect(groups[1]?.likes.map((l) => l.displayName)).toEqual(['Cy', 'Ana']);
  });
});

describe('summarize', () => {
  it('counts events, distinct devices, saved photos and likes', () => {
    const events = [
      event({ targetType: 'photo', targetId: 'A', action: 'download' }),
      event({ targetType: 'collection', targetId: ['A', 'B'], action: 'zip', deviceId: 'device-bo' }),
    ];
    const likes = [like({ targetType: 'page', targetId: 'P1', deviceId: 'device-cy' })];
    expect(summarize({ events, likes })).toEqual({ events: 2, devices: 3, photosSaved: 2, likes: 1 });
  });
});

describe('newestFirst', () => {
  it('sorts by time without touching the input', () => {
    const a = event({ targetType: 'photo', targetId: 'A', action: 'download', createdAt: '2026-10-01T00:00:00.000Z' });
    const b = event({ targetType: 'photo', targetId: 'B', action: 'download', createdAt: '2026-10-03T00:00:00.000Z' });
    const input = [a, b];
    expect(newestFirst(input).map((e) => e.targetId)).toEqual(['B', 'A']);
    expect(input[0]).toBe(a);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-06T12:00:00.000Z');
  it.each([
    ['2026-10-06T11:59:40.000Z', 'just now'],
    ['2026-10-06T11:55:00.000Z', '5 min ago'],
    ['2026-10-06T09:00:00.000Z', '3 h ago'],
    ['2026-10-04T12:00:00.000Z', '2 d ago'],
  ])('%s -> %s', (iso, label) => {
    expect(relativeTime(iso, now)).toBe(label);
  });

  it('falls back to a date after a week, and echoes junk', () => {
    expect(relativeTime('2026-09-01T00:00:00.000Z', now)).toMatch(/2026/);
    expect(relativeTime('not a date', now)).toBe('not a date');
  });
});
