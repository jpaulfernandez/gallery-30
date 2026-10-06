import { readFile, rename, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import {
  type Book,
  bookPrefix,
  imagePrefix,
  manifestKey,
  manifestUrl,
  publicUrl,
  publishFingerprint,
} from '@photobook/shared';
import { type PublishConfig, requireR2, socialApiUrl } from './config.js';
import { type FrozenBook, freeze } from './freeze.js';
import { outDir, processAsset } from './images.js';
import { mapLimit, retry } from './limit.js';
import type { Reporter } from './log.js';
import { buildManifest, type ImageObject, imageObjects, type ProcessedAsset } from './manifest.js';
import { pageImageObjects, type RenderedPage, renderPages } from './pages.js';
import { S3Store } from './r2.js';
import { nextPassword, readSite, siteWithBook, writeSite } from './site.js';
import { StateFile } from './state.js';
import { CACHE_IMMUTABLE, CACHE_NONE, CONTENT_TYPES, type ObjectStore, UnsupportedError } from './store.js';
import { WranglerStore } from './wranglerStore.js';

export interface PublishOptions {
  projectPath: string;
  config: PublishConfig;
  reporter: Reporter;
  dryRun?: boolean;
  prune?: boolean;
  /** Skip rendering page images: no share PNGs, thumbnails fall back to the first photo. */
  skipPages?: boolean;
  /** Do not write `publish.lastPublishedAt` into the project file (the editor records it itself). */
  record?: boolean;
  /** Injected store (tests); defaults to the configured transport. */
  store?: ObjectStore;
  now?: () => Date;
}

export interface PublishResult {
  url: string;
  publishedAt: string;
  fingerprint: string;
  uploaded: number;
  skipped: number;
  bytes: number;
  pruned: number;
  frozen: FrozenBook;
}

export class UploadError extends Error {
  constructor(public readonly keys: string[]) {
    super(`${keys.length} object(s) failed to upload after 3 attempts; rerun to resume:`);
  }
}

export function createStore(config: PublishConfig): ObjectStore {
  const r2 = requireR2(config);
  return r2.transport === 'wrangler' ? new WranglerStore(r2.bucket) : new S3Store(r2);
}

/** The whole pipeline: freeze -> images -> pages -> plan -> upload -> manifest -> site -> (prune) -> record. */
export async function publish(options: PublishOptions): Promise<PublishResult> {
  const { projectPath, config, reporter, dryRun = false, record = true } = options;
  const now = options.now ?? (() => new Date());
  const r2 = requireR2(config);
  // Checked before any work: a bad value in site.json would break every book on the site.
  const apiUrl = socialApiUrl(config);
  const store = options.store ?? createStore(config);
  const base = r2.publicUrl;

  const frozen = await reporter.step(
    'freeze',
    () => freeze(projectPath),
    (f) => `${f.book.pages.length} pages, ${f.assets.size} photos used, ${f.rehashed} rehashed`,
  );
  const { book } = frozen;
  const state = await StateFile.load(frozen.projectPath, r2.bucket);
  const imageOptions = { downloadMaxEdge: config.download.maxEdge, downloadQuality: config.download.quality };

  // Images: cores - 1 workers, each asset's variants written under its hash.
  const assets = [...frozen.assets.values()];
  const processed = new Map<string, ProcessedAsset>();
  const concurrency = config.concurrency ?? Math.max(1, cpus().length - 1);
  await reporter.step(
    'images',
    async () => {
      let done = 0;
      let fresh = 0;
      await mapLimit(assets, concurrency, async (asset) => {
        const t0 = performance.now();
        const { meta, cached } = await processAsset(asset, frozen.projectPath, imageOptions);
        processed.set(asset.id, { asset, meta });
        done++;
        if (!cached) fresh++;
        reporter.emit({
          type: 'progress',
          step: 'images',
          done,
          total: assets.length,
          detail: `${asset.relPath} ${cached ? 'cached' : `${((performance.now() - t0) / 1000).toFixed(1)}s`}`,
        });
      });
      return fresh;
    },
    (fresh) => `${fresh} processed, ${assets.length - fresh} cached`,
  );

  // Pages: feed and story PNGs plus the jump-grid thumbnail, cached by render hash.
  let pageImages = new Map<string, RenderedPage>();
  if (options.skipPages) {
    reporter.emit({ type: 'step', step: 'pages', status: 'skipped', detail: '--skip-pages' });
  } else {
    const result = await reporter.step(
      'pages',
      () => renderPages(frozen, processed, reporter),
      (r) =>
        r.skipped
          ? `skipped (Chromium unavailable), ${r.cached} cached kept`
          : `${r.rendered} rendered, ${r.cached} cached`,
    );
    pageImages = result.pages;
  }

  // Plan: which objects are new. Known keys skip the HEAD; the rest are checked.
  const objects: Array<ImageObject & { dir: string }> = [];
  const seen = new Set<string>();
  const add = (o: ImageObject, dir: string) => {
    if (seen.has(o.key)) return;
    seen.add(o.key);
    objects.push({ ...o, dir });
  };
  for (const p of processed.values()) {
    const dir = outDir(frozen.projectPath, p.asset.hash);
    for (const o of imageObjects(book, p)) add(o, dir);
  }
  for (const r of pageImages.values()) for (const o of pageImageObjects(book, r)) add(o, r.dir);
  const toUpload = await reporter.step(
    'plan',
    async () => {
      const unknown = objects.filter((o) => !state.has(o.key));
      const checks = await mapLimit(unknown, 8, async (o) => ({ o, exists: await store.exists(o.key) }));
      for (const c of checks) if (c.exists) state.mark(c.o.key);
      await state.save();
      return checks.filter((c) => !c.exists).map((c) => c.o);
    },
    (list) => `${list.length} to upload, ${objects.length - list.length} already on R2`,
  );
  const bytes = toUpload.reduce((n, o) => n + o.bytes, 0);
  const publishedAt = now().toISOString();
  const pageHashes = new Map([...pageImages].map(([id, r]) => [id, r.hash]));
  const manifest = buildManifest(book, base, processed, publishedAt, pageHashes);
  const fingerprint = await publishFingerprint(book);
  const url = manifestUrl(base, book.publish.slug);
  const link = config.viewerUrl ? bookLink(config.viewerUrl, book.publish.slug) : undefined;

  if (dryRun) {
    reporter.info(
      `Manifest: ${manifestKey(book.publish.slug)} (${manifest.pages.length} pages), site.json ${manifest.listed ? 'lists' : 'omits'} this book`,
    );
    reporter.emit({
      type: 'result',
      url,
      link,
      publishedAt,
      fingerprint,
      uploaded: toUpload.length,
      skipped: objects.length - toUpload.length,
      bytes,
      dryRun: true,
    });
    return {
      url,
      publishedAt,
      fingerprint,
      uploaded: toUpload.length,
      skipped: objects.length - toUpload.length,
      bytes,
      pruned: 0,
      frozen,
    };
  }

  // Upload: 8 in parallel, 3 attempts each, then stop and list what is missing.
  await reporter.step(
    'upload',
    async () => {
      const failed: string[] = [];
      let done = 0;
      try {
        await mapLimit(toUpload, 8, async (o) => {
          try {
            const body = new Uint8Array(await readFile(join(o.dir, o.file)));
            await retry(3, () => store.put(o.key, body, { contentType: o.contentType, cacheControl: CACHE_IMMUTABLE }));
            state.mark(o.key);
          } catch (err) {
            failed.push(o.key);
            reporter.warn(`${o.key}: ${(err as Error).message}`);
          }
          done++;
          if (done % 10 === 0 || done === toUpload.length) {
            reporter.emit({ type: 'progress', step: 'upload', done, total: toUpload.length, detail: o.file });
            await state.save();
          }
        });
      } finally {
        await state.save();
      }
      if (failed.length) throw new UploadError(failed.sort());
    },
    () => `${toUpload.length} objects, ${(bytes / 1e6).toFixed(1)} MB`,
  );

  await reporter.step('manifest', () =>
    store.put(manifestKey(book.publish.slug), encodeJson(manifest), {
      contentType: CONTENT_TYPES.json,
      cacheControl: CACHE_NONE,
    }),
  );

  await reporter.step(
    'site',
    async () => {
      const site = await readSite(store);
      const password = await nextPassword(site.password, {
        word: config.sitePassword,
        expiresAt: config.sitePasswordExpiresAt,
      });
      const api = apiUrl ?? site.api;
      const next = siteWithBook({ ...site, password, api }, manifest);
      await writeSite(store, next);
      return next;
    },
    (site) =>
      `${site.books.length} listed book(s), password ${site.password ? `v${site.password.version}` : 'not set'}`,
  );

  let pruned = 0;
  if (options.prune) {
    pruned = await reporter.step(
      'prune',
      async () => {
        // Page images live under `<imagePrefix>/pages/`, so they are listed and kept here too.
        const keep = new Set(objects.map((o) => o.key));
        const prefix = `${imagePrefix(book.publish.slug, book.publish.r2Prefix)}/`;
        let existing: string[];
        try {
          existing = await store.list(prefix);
        } catch (err) {
          if (err instanceof UnsupportedError) {
            reporter.warn(err.message);
            return 0;
          }
          throw err;
        }
        const stale = existing.filter((k) => !keep.has(k));
        if (stale.length) {
          await store.delete(stale);
          for (const k of stale) state.forget(k);
          await state.save();
        }
        return stale.length;
      },
      (n) => `${n} stale object(s) removed`,
    );
  }

  if (record) {
    await reporter.step('record', () => recordPublish(frozen.projectPath, publishedAt, fingerprint));
  }

  reporter.emit({
    type: 'result',
    url,
    link,
    publishedAt,
    fingerprint,
    uploaded: toUpload.length,
    skipped: objects.length - toUpload.length,
    bytes,
    dryRun: false,
  });
  return {
    url,
    publishedAt,
    fingerprint,
    uploaded: toUpload.length,
    skipped: objects.length - toUpload.length,
    bytes,
    pruned,
    frozen,
  };
}

export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

/**
 * Write `publish.lastPublishedAt` and `publishedFingerprint` into the project file, keeping the
 * rest byte-for-byte (the editor is the owner of the file; this is a minimal, atomic touch with a
 * `.bak` like the editor's own writes).
 */
export async function recordPublish(projectPath: string, publishedAt: string, fingerprint: string): Promise<void> {
  const text = await readFile(projectPath, 'utf8');
  const json = JSON.parse(text) as { publish: Book['publish'] };
  json.publish = { ...json.publish, lastPublishedAt: publishedAt, publishedFingerprint: fingerprint };
  const next = `${JSON.stringify(json, null, 2)}\n`;
  const tmp = `${projectPath}.${process.pid}.tmp`;
  await writeFile(tmp, next);
  await writeFile(`${projectPath}.bak`, text).catch(() => {});
  await rename(tmp, projectPath);
}

/** `books/<slug>/` for messages. */
export const bookFolder = (book: Book): string => `${bookPrefix(book.publish.slug)}/`;

/** The public link of a book in the viewer, given the viewer's origin. */
export const bookLink = (viewerOrigin: string, slug: string): string => publicUrl(viewerOrigin, slug);
