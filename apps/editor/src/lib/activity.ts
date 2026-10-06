import type { ActivityResponse, EventAction, SocialEvent, SocialLike } from '@photobook/shared';

/**
 * Pure aggregation behind the Downloads tab: what the Worker's activity response means per photo and
 * per page. Ids are the book's stable ULIDs (asset ids and page ids); this module never looks at the
 * book, so ids of photos or pages removed since are just ids here.
 *
 * - A photo is "saved" by any event that targets it: a download, a share, or a zip / share-all
 *   collection that contains it. One event counts once per photo however often the id repeats.
 * - A page's saves are the photo events logged with that `pageId`; its shares are the page-level
 *   events (target type page, or action page_share). Collections carry no page.
 */

export type Activity = Pick<ActivityResponse, 'events' | 'likes'>;

export const ACTION_LABEL: Record<EventAction, string> = {
  download: 'Downloaded',
  share: 'Shared',
  zip: 'Zip',
  page_share: 'Page share',
};

export interface PhotoStats {
  assetId: string;
  /** Events that targeted the photo (download, share, zip). */
  saves: number;
  likes: number;
}

export interface PageStats {
  pageId: string;
  /** Photo events logged on this page. */
  saves: number;
  /** Page-level events (the Instagram page share). */
  shares: number;
  likes: number;
}

export interface LikeGroup {
  type: 'page' | 'photo';
  id: string;
  likes: SocialLike[];
}

/** Asset ids an event touched, de-duplicated, in order. Empty for page-level events. */
export function eventPhotoIds(event: SocialEvent): string[] {
  if (event.targetType === 'page') return [];
  const ids = Array.isArray(event.targetId) ? event.targetId : [event.targetId];
  return [...new Set(ids)];
}

/** The page an event belongs to: the page itself for page events, else the `pageId` it was logged on. */
export function eventPageId(event: SocialEvent): string | null {
  if (event.targetType === 'page') {
    const id = Array.isArray(event.targetId) ? event.targetId[0] : event.targetId;
    return id ?? event.pageId;
  }
  return event.pageId;
}

const isPageLevel = (event: SocialEvent): boolean => event.targetType === 'page' || event.action === 'page_share';

/** Higher score first; ties by saves, then likes, then id so the order is stable. */
function compareStats(a: { saves: number; likes: number }, b: { saves: number; likes: number }): number {
  return b.saves + b.likes - (a.saves + a.likes) || b.saves - a.saves || b.likes - a.likes;
}

/** Counts per photo (every photo with a save or a like), most saved and liked first. */
export function photoStats({ events, likes }: Activity): PhotoStats[] {
  const stats = new Map<string, PhotoStats>();
  const get = (assetId: string): PhotoStats => {
    let s = stats.get(assetId);
    if (!s) {
      s = { assetId, saves: 0, likes: 0 };
      stats.set(assetId, s);
    }
    return s;
  };
  for (const event of events) for (const id of eventPhotoIds(event)) get(id).saves += 1;
  for (const like of likes) if (like.targetType === 'photo') get(like.targetId).likes += 1;
  return [...stats.values()].sort((a, b) => compareStats(a, b) || a.assetId.localeCompare(b.assetId));
}

/** Counts per page (every page with a save, a share or a like), in no particular order. */
export function pageStats({ events, likes }: Activity): PageStats[] {
  const stats = new Map<string, PageStats>();
  const get = (pageId: string): PageStats => {
    let s = stats.get(pageId);
    if (!s) {
      s = { pageId, saves: 0, shares: 0, likes: 0 };
      stats.set(pageId, s);
    }
    return s;
  };
  for (const event of events) {
    const pageId = eventPageId(event);
    if (!pageId) continue;
    if (isPageLevel(event)) get(pageId).shares += 1;
    else get(pageId).saves += 1;
  }
  for (const like of likes) if (like.targetType === 'page') get(like.targetId).likes += 1;
  return [...stats.values()];
}

/** The `limit` photos with the most saves plus likes; photos with neither are not listed. */
export function topPhotos(stats: readonly PhotoStats[], limit = 5): PhotoStats[] {
  return stats
    .filter((s) => s.saves + s.likes > 0)
    .sort((a, b) => compareStats(a, b) || a.assetId.localeCompare(b.assetId))
    .slice(0, limit);
}

/** Likes grouped by target, most liked first (ties: pages before photos, then id); each group newest first. */
export function likeGroups(likes: readonly SocialLike[]): LikeGroup[] {
  const groups = new Map<string, LikeGroup>();
  for (const like of likes) {
    const key = `${like.targetType}:${like.targetId}`;
    let group = groups.get(key);
    if (!group) {
      group = { type: like.targetType, id: like.targetId, likes: [] };
      groups.set(key, group);
    }
    group.likes.push(like);
  }
  for (const group of groups.values()) group.likes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...groups.values()].sort(
    (a, b) => b.likes.length - a.likes.length || a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
  );
}

export interface ActivitySummary {
  events: number;
  /** Distinct devices that logged an event or a like. */
  devices: number;
  /** Distinct photos that were saved at least once. */
  photosSaved: number;
  likes: number;
}

export function summarize({ events, likes }: Activity): ActivitySummary {
  const devices = new Set<string>();
  const saved = new Set<string>();
  for (const event of events) {
    devices.add(event.deviceId);
    for (const id of eventPhotoIds(event)) saved.add(id);
  }
  for (const like of likes) devices.add(like.deviceId);
  return { events: events.length, devices: devices.size, photosSaved: saved.size, likes: likes.length };
}

/** Events newest first (the Worker already sorts them; this keeps the list right if it ever does not). */
export function newestFirst(events: readonly SocialEvent[]): SocialEvent[] {
  return [...events].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a date. `now` is a test seam. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diff = now - then;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} d ago`;
  return new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
