import {
  EMPTY_SITE,
  type Manifest,
  manifestUrl,
  parseManifest,
  parseSite,
  type Site,
  siteUrl,
} from '@photobook/shared';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`${status} for ${url}`);
    this.name = 'HttpError';
  }
}

const isMissing = (e: unknown): boolean => e instanceof HttpError && (e.status === 404 || e.status === 403);

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.json();
}

/** `site.json`; a missing file is an empty site (no password, no listed books). */
export async function loadSite(base: string): Promise<Site> {
  try {
    return parseSite(await fetchJson(siteUrl(base)));
  } catch (e) {
    if (isMissing(e)) return EMPTY_SITE;
    throw e;
  }
}

/** `books/<slug>/manifest.json`, or null when the book does not exist. */
export async function loadManifest(base: string, slug: string): Promise<Manifest | null> {
  try {
    return parseManifest(await fetchJson(manifestUrl(base, slug)));
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}
