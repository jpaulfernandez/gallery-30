import { EMPTY_SITE, type Manifest, mergeSiteBook, parseSite, SITE_KEY, type Site } from '@photobook/shared';
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
      locked: Boolean(manifest.password),
    },
    manifest.listed,
  );
}
