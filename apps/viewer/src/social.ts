import {
  DISPLAY_NAME_MAX,
  type EventAction,
  type EventRequest,
  type EventTargetType,
  type LikesResponse,
  LikesResponseSchema,
  type LikeTargetType,
  type LikeToggleRequest,
  type LikeToggleResponse,
  LikeToggleResponseSchema,
  likeKey,
  socialRoutes,
  socialUrl,
} from '@photobook/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { readLocal, writeLocal } from './storage';

/**
 * The social API client (likes and the download log on the Worker at `site.api`) and the bits of
 * local state it needs: a random per-device id and the self-reported display name. When the site
 * has no API, likes are hidden and nothing is logged; downloads and shares work regardless.
 */

const DEVICE_KEY = 'photobook.device';
const NAME_KEY = 'photobook.name';
const DEVICE_LENGTH = 16;
const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** What "Skip" on the name prompt stores. */
export const ANONYMOUS = 'Anonymous';

// Kept for the session when local storage is unavailable (private mode, blocked storage).
let sessionDevice: string | null = null;
let sessionName: string | null = null;

function randomId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += URL_SAFE[b & 63];
  return id;
}

/** This device's id: 16 random url-safe characters, generated once and kept in local storage. */
export function deviceId(): string {
  const stored = readLocal(DEVICE_KEY);
  if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return stored;
  if (!sessionDevice) {
    sessionDevice = randomId(DEVICE_LENGTH);
    writeLocal(DEVICE_KEY, sessionDevice);
  }
  return sessionDevice;
}

/** Trim and cut to the API's 1 to 40 characters; null when nothing is left. */
export function cleanName(raw: string): string | null {
  const name = raw.trim().slice(0, DISPLAY_NAME_MAX).trim();
  return name.length > 0 ? name : null;
}

/** The display name this device chose (or "Anonymous" after Skip), or null before the prompt. */
export function readName(): string | null {
  return cleanName(readLocal(NAME_KEY) ?? '') ?? sessionName;
}

export function writeName(name: string): void {
  sessionName = cleanName(name) ?? ANONYMOUS;
  writeLocal(NAME_KEY, sessionName);
}

// --- HTTP --------------------------------------------------------------------------------------

async function postJson(url: string, body: unknown, keepalive = false): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    // A keepalive request stays CORS-simple (text/plain, which the Worker parses as JSON all the
    // same): keepalive with a preflight is rejected or unreliable in some engines.
    headers: { 'Content-Type': keepalive ? 'text/plain;charset=UTF-8' : 'application/json' },
    body: JSON.stringify(body),
    keepalive,
  });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

/** Every like count in the book plus the likes of this device. */
export async function fetchLikes(api: string, bookId: string, device: string): Promise<LikesResponse> {
  const url = `${socialUrl(api, socialRoutes.likes(bookId))}?device=${encodeURIComponent(device)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return LikesResponseSchema.parse(await res.json());
}

/** Set or clear this device's like on a target; resolves to the server's state and count. */
export async function toggleLike(api: string, request: LikeToggleRequest): Promise<LikeToggleResponse> {
  return LikeToggleResponseSchema.parse(await postJson(socialUrl(api, socialRoutes.like), request));
}

/** Log a download, share, zip or page share. Fire and forget: never throws, never blocks the action. */
export function logEvent(api: string, request: EventRequest): void {
  postJson(socialUrl(api, socialRoutes.events), request, true).catch(() => {
    // Logging is best effort.
  });
}

// --- Likes state -------------------------------------------------------------------------------

export interface Likes {
  count: (type: LikeTargetType, id: string) => number;
  liked: (type: LikeTargetType, id: string) => boolean;
  /** Optimistic: flips at once, settles on the server's count, reverts (and calls `onError`) on failure. */
  toggle: (type: LikeTargetType, id: string, displayName: string | null) => void;
}

interface LikesState {
  counts: Record<string, number>;
  mine: Set<string>;
}

const EMPTY_LIKES: LikesState = { counts: {}, mine: new Set() };

/** The book's likes, fetched once on open. Inert (all zero) without an API. */
export function useLikes(api: string | null, bookId: string, onError: () => void): Likes {
  const [state, setState] = useState<LikesState>(EMPTY_LIKES);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Latest request per target: an older response never overwrites a newer tap.
  const seq = useRef(new Map<string, number>());
  // Requests per target run one after another, so the server applies taps in tap order.
  const queue = useRef(new Map<string, Promise<void>>());
  // Last state the server confirmed per tapped target (`server` false: what was shown before the
  // first tap, while the book's likes were still loading).
  const confirmed = useRef(new Map<string, { liked: boolean; count: number; server: boolean }>());
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!api) return;
    let live = true;
    fetchLikes(api, bookId, deviceId()).then(
      (res) => {
        if (!live) return;
        for (const [key, c] of confirmed.current) {
          if (!c.server)
            confirmed.current.set(key, { liked: res.mine.includes(key), count: res.counts[key] ?? 0, server: true });
        }
        setState((s) => {
          const counts = { ...res.counts };
          const mine = new Set(res.mine);
          // A tap made while this was loading is newer than the response: keep it.
          for (const key of seq.current.keys()) {
            const count = s.counts[key];
            if (count === undefined) delete counts[key];
            else counts[key] = count;
            if (s.mine.has(key)) mine.add(key);
            else mine.delete(key);
          }
          return { counts, mine };
        });
      },
      () => {
        // Counts stay at zero; a like still works and corrects its own count.
      },
    );
    return () => {
      live = false;
    };
  }, [api, bookId]);

  const set = (key: string, liked: boolean, count: number) =>
    setState((s) => {
      const mine = new Set(s.mine);
      if (liked) mine.add(key);
      else mine.delete(key);
      return { counts: { ...s.counts, [key]: Math.max(0, count) }, mine };
    });

  const toggle = useCallback(
    (type: LikeTargetType, id: string, displayName: string | null) => {
      if (!api) return;
      const key = likeKey(type, id);
      const before = stateRef.current;
      const wasLiked = before.mine.has(key);
      const wasCount = before.counts[key] ?? 0;
      const liked = !wasLiked;
      if (!confirmed.current.has(key)) confirmed.current.set(key, { liked: wasLiked, count: wasCount, server: false });
      set(key, liked, wasCount + (liked ? 1 : -1));
      const n = (seq.current.get(key) ?? 0) + 1;
      seq.current.set(key, n);
      const request: LikeToggleRequest = {
        bookId,
        targetType: type,
        targetId: id,
        deviceId: deviceId(),
        displayName,
        liked,
      };
      const run = (queue.current.get(key) ?? Promise.resolve()).then(() =>
        toggleLike(api, request).then(
          (res) => {
            confirmed.current.set(key, { liked: res.liked, count: res.count, server: true });
            if (seq.current.get(key) === n) set(key, res.liked, res.count);
          },
          () => {
            if (seq.current.get(key) !== n) return;
            // Back to what the server last said (an earlier tap may have gone through).
            const last = confirmed.current.get(key) ?? { liked: wasLiked, count: wasCount };
            set(key, last.liked, last.count);
            onErrorRef.current();
          },
        ),
      );
      queue.current.set(key, run);
    },
    [api, bookId],
  );

  return useMemo<Likes>(
    () => ({
      count: (type, id) => state.counts[likeKey(type, id)] ?? 0,
      liked: (type, id) => state.mine.has(likeKey(type, id)),
      toggle,
    }),
    [state, toggle],
  );
}

// --- What the reader hands to the drawer, side panel, lightbox and collection ------------------

export interface Social {
  /** A Worker is configured: likes are shown and events logged. */
  enabled: boolean;
  bookId: string;
  slug: string;
  title: string;
  likes: Likes;
  /** Like or unlike, asking for the display name first if this device has none. */
  toggleLike: (type: LikeTargetType, id: string) => void;
  /**
   * Run `action` once this device has a display name, asking for it first (once per device).
   * Without an API nothing is logged, so it runs at once with null. Synchronous when no prompt is
   * needed, so a share sheet opened from `action` keeps the tap's user activation.
   */
  withName: (action: (name: string | null) => void) => void;
  /** Log an event with the stored name; a no-op without an API. */
  log: (action: EventAction, targetType: EventTargetType, targetId: string | string[], pageId: string | null) => void;
  /** Asset ids in the collection, in the order they were added. */
  collection: string[];
  toggleCollection: (assetId: string) => void;
  removeFromCollection: (assetId: string) => void;
  clearCollection: () => void;
  openCollection: () => void;
  toast: (message: string) => void;
}
