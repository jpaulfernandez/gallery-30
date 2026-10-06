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

/** Rewrite `site.json` alone with the configured password (step 2.4: a password change). */
export async function syncPassword(options: {
  store: ObjectStore;
  reporter: Reporter;
  word: string;
  expiresAt: string | null;
  /** Remove the password entirely. */
  clear?: boolean;
  /** Social API origin to record in `site.json`; empty keeps the current value. */
  apiUrl?: string;
}): Promise<Site> {
  const { nextPassword } = await import('./site.js');
  const site = await readSite(options.store);
  const password = options.clear
    ? null
    : await nextPassword(site.password, { word: options.word, expiresAt: options.expiresAt });
  const api = options.apiUrl || site.api;
  if (password === site.password && api === site.api) {
    options.reporter.info('site.json password unchanged');
    return site;
  }
  const next = { ...site, password, api };
  await writeSite(options.store, next);
  options.reporter.info(
    password ? `site.json password set (version ${password.version})` : 'site.json password cleared',
  );
  return next;
}
