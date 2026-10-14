import { bookPrefix, SITE_KEY, type Site } from '@photobook/shared';
import type { Reporter } from './log.js';
import { readSite, writeSite } from './site.js';
import { StateFile } from './state.js';
import type { ObjectStore } from './store.js';

/** Delete everything under `books/<slug>/` and take the book out of `site.json`. */
export async function unpublish(options: {
  slug: string;
  store: ObjectStore;
  reporter: Reporter;
  /** Project file, to forget its state entries; optional. */
  projectPath?: string;
  bucket: string;
}): Promise<{ deleted: number; site: Site }> {
  const { slug, store, reporter } = options;
  const prefix = `${bookPrefix(slug)}/`;
  const keys = await reporter.step(
    'prune',
    () => store.list(prefix),
    (k) => `${k.length} object(s) under ${prefix}`,
  );
  if (keys.length) await store.delete(keys);
  const site = await reporter.step(
    'site',
    async () => {
      const current = await readSite(store);
      const next = { ...current, books: current.books.filter((b) => b.slug !== slug) };
      if (next.books.length !== current.books.length || keys.length) await writeSite(store, next);
      return next;
    },
    (s) => `${s.books.length} listed book(s) remain in ${SITE_KEY}`,
  );
  if (options.projectPath) {
    const state = await StateFile.load(options.projectPath, options.bucket);
    state.forgetPrefix(prefix);
    await state.save();
  }
  return { deleted: keys.length, site };
}

/**
 * Remove the legacy site-wide password from `site.json` (passwords are per book now) and record the
 * configured social API origin.
 */
export async function clearSitePassword(options: {
  store: ObjectStore;
  reporter: Reporter;
  /** Social API origin to record in `site.json`; empty keeps the current value. */
  apiUrl?: string;
}): Promise<Site> {
  const site = await readSite(options.store);
  const api = options.apiUrl || site.api;
  if (site.password === null && api === site.api) {
    options.reporter.info('site.json has no site-wide password');
    return site;
  }
  const next = { ...site, password: null, api };
  await writeSite(options.store, next);
  options.reporter.info('site.json site-wide password removed');
  return next;
}
