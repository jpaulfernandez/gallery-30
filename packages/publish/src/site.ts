import {
  EMPTY_SITE,
  hashPassword,
  type Manifest,
  mergeSiteBook,
  newSalt,
  parseSite,
  SITE_KEY,
  type Site,
  type SitePassword,
  verifyPassword,
} from '@photobook/shared';
import { CACHE_NONE, CONTENT_TYPES, type ObjectStore } from './store.js';

export async function readSite(store: ObjectStore): Promise<Site> {
  const body = await store.get(SITE_KEY);
  if (!body) return EMPTY_SITE;
  try {
    return parseSite(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    // An unreadable site file is rebuilt from scratch rather than blocking a publish.
    return EMPTY_SITE;
  }
}

/** Validated before the write: the viewer parses `site.json` on every open, so it must never hold a bad value. */
export function writeSite(store: ObjectStore, site: Site): Promise<void> {
  const valid = parseSite(site);
  return store.put(SITE_KEY, new TextEncoder().encode(`${JSON.stringify(valid, null, 2)}\n`), {
    contentType: CONTENT_TYPES.json,
    cacheControl: CACHE_NONE,
  });
}

export interface PasswordSettings {
  /** Empty: leave the current password alone. */
  word: string;
  expiresAt: string | null;
}

/**
 * The password record `site.json` should carry: unchanged when the word still matches (and the
 * expiry is the same), otherwise a new salt and a bumped version so every device is asked again.
 */
export async function nextPassword(
  current: SitePassword | null,
  settings: PasswordSettings,
): Promise<SitePassword | null> {
  if (!settings.word) return current;
  const word = settings.word.trim();
  if (current && (await verifyPassword(word, current))) {
    return current.expiresAt === settings.expiresAt ? current : { ...current, expiresAt: settings.expiresAt };
  }
  const salt = newSalt();
  return {
    hash: await hashPassword(word, salt),
    salt,
    version: (current?.version ?? 0) + 1,
    expiresAt: settings.expiresAt,
  };
}

/** Merge a published book into the site file (in when listed, out otherwise). */
export function siteWithBook(site: Site, manifest: Manifest): Site {
  return mergeSiteBook(
    site,
    {
      slug: manifest.slug,
      title: manifest.title,
      cover: manifest.pages[0]?.thumbnail ?? null,
      pages: manifest.pages.length,
      publishedAt: manifest.publishedAt,
    },
    manifest.listed,
  );
}
