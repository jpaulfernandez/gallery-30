import type { AccessGrant } from '@photobook/shared';

/**
 * Local storage, wrapped: Safari private mode and blocked storage throw, and the viewer must keep
 * working without it (it just asks for the word again and opens on page 1).
 */

const ACCESS_KEY = 'photobook.access';
const LAST_PAGE_PREFIX = 'photobook.lastPage.';
const ROTATE_HINT_KEY = 'photobook.rotateHint';

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // Storage unavailable: nothing to do.
  }
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

export function readGrant(): AccessGrant | null {
  const raw = read(local, ACCESS_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as AccessGrant).version === 'number' &&
      typeof (value as AccessGrant).grantedAt === 'string'
    ) {
      return value as AccessGrant;
    }
  } catch {
    // Corrupt value: treat as no grant.
  }
  return null;
}

export function writeGrant(grant: AccessGrant): void {
  write(local, ACCESS_KEY, JSON.stringify(grant));
}

/** Last page read in a book (1-based), or null. */
export function readLastPage(slug: string): number | null {
  const raw = read(local, LAST_PAGE_PREFIX + slug);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const page = Number(raw);
  return page >= 1 ? page : null;
}

export function writeLastPage(slug: string, page: number): void {
  write(local, LAST_PAGE_PREFIX + slug, String(page));
}

export const rotateHintShown = (): boolean => read(session, ROTATE_HINT_KEY) === '1';
export const markRotateHintShown = (): void => write(session, ROTATE_HINT_KEY, '1');

const GUIDE_KEY = 'photobook.guideShown';

/** The one-time "how to read" overlay: once per device (session storage when local is blocked). */
export const guideShown = (): boolean => read(local, GUIDE_KEY) === '1' || read(session, GUIDE_KEY) === '1';
export const markGuideShown = (): void => {
  write(local, GUIDE_KEY, '1');
  write(session, GUIDE_KEY, '1');
};

const SAVE_HINT_KEY = 'photobook.saveHintShown';

/** The one-time iPhone "press and hold the photo" hint after the first Download: like the guide flag. */
export const saveHintShown = (): boolean => read(local, SAVE_HINT_KEY) === '1' || read(session, SAVE_HINT_KEY) === '1';
export const markSaveHintShown = (): void => {
  write(local, SAVE_HINT_KEY, '1');
  write(session, SAVE_HINT_KEY, '1');
};

/** Plain local storage access for the social and collection modules (same try/catch wrapping). */
export const readLocal = (key: string): string | null => read(local, key);
export const writeLocal = (key: string, value: string): void => write(local, key, value);
export function removeLocal(key: string): void {
  try {
    local().removeItem(key);
  } catch {
    // Storage unavailable: nothing to do.
  }
}
