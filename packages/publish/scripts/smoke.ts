/**
 * Step 2.8 smoke check against the real bucket: publish the six-photo fixture to its test slug,
 * assert the keys (46 image versions and 9 page images), the manifest and site.json, publish again and assert only the manifest and
 * site file were written, then unpublish. Needs the usual settings (see docs/PUBLISHING.md) and
 * Playwright's Chromium (`pnpm --filter @photobook/publish exec playwright install chromium`).
 *
 *   pnpm --filter @photobook/publish smoke [--keep]
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imagePrefix, manifestKey, manifestUrl, parseManifest, parseSite, SITE_KEY, siteUrl } from '@photobook/shared';
import { loadConfig, requireR2 } from '../src/config.js';
import { createReporter } from '../src/log.js';
import { createStore, publish } from '../src/publish.js';
import { unpublish } from '../src/unpublish.js';

const SLUG = 'smoke-fixture-six';
/** 46 image versions of the six photos plus 3 pages x (feed.png, story.png, thumb.webp). */
const OBJECTS = 55;
const keep = process.argv.includes('--keep');

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`smoke: ${message}`);
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const r2 = requireR2(config);
  const store = createStore(config);
  const reporter = createReporter('human');

  // A temp copy with a test slug, so the fixture and its state file stay untouched.
  const dir = await mkdtemp(join(tmpdir(), 'pb-smoke-'));
  await cp(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'six'), dir, {
    recursive: true,
    filter: (src) => !src.includes('.photobook-publish'),
  });
  const project = join(dir, 'book.photobook.json');
  const { readFile, writeFile } = await import('node:fs/promises');
  const book = JSON.parse(await readFile(project, 'utf8'));
  book.publish.slug = SLUG;
  book.sourceFolder = dir;
  await writeFile(project, JSON.stringify(book));

  try {
    reporter.info(`Publishing ${SLUG} to ${r2.bucket}`);
    const first = await publish({ projectPath: project, config, reporter, store, record: false });
    assert(
      first.uploaded + first.skipped === OBJECTS,
      `expected ${OBJECTS} image objects, got ${first.uploaded + first.skipped}`,
    );

    const manifestBody = await fetch(manifestUrl(r2.publicUrl, SLUG), { cache: 'no-store' });
    assert(manifestBody.ok, `manifest not public: ${manifestBody.status}`);
    const manifest = parseManifest(await manifestBody.json());
    assert(manifest.pages.length === 3, 'manifest has 3 pages');
    const siteBody = await fetch(siteUrl(r2.publicUrl), { cache: 'no-store' });
    assert(siteBody.ok, `site.json not public: ${siteBody.status}`);
    const site = parseSite(await siteBody.json());
    assert(
      site.books.some((b) => b.slug === SLUG),
      'site.json lists the book',
    );
    const image = await fetch(manifest.images['01FIXTUREASSET0000000000A1']?.webp[0]?.url as string, {
      method: 'HEAD',
    });
    assert(image.ok && image.headers.get('cache-control')?.includes('immutable'), 'image is public and immutable');
    assert(manifestBody.headers.get('cache-control')?.includes('no-cache'), 'manifest is no-cache');
    const shareFeed = manifest.pages[0]?.shareFeed;
    assert(shareFeed, 'page 1 has a rendered feed PNG (is Chromium installed?)');
    const feed = await fetch(shareFeed, { method: 'HEAD' });
    assert(
      feed.ok && feed.headers.get('cache-control')?.includes('immutable'),
      `page feed PNG is public and immutable: ${feed.status}`,
    );

    const keys = await store.list(`${imagePrefix(SLUG, book.publish.r2Prefix)}/`);
    assert(keys.length === OBJECTS, `expected ${OBJECTS} keys on R2, got ${keys.length}`);

    reporter.info('Publishing again: expect only the manifest and site.json');
    const second = await publish({ projectPath: project, config, reporter, store, record: false });
    assert(second.uploaded === 0 && second.skipped === OBJECTS, `second run uploaded ${second.uploaded}`);
    reporter.info(`OK: ${manifestKey(SLUG)} and ${SITE_KEY} verified`);
  } finally {
    if (!keep) {
      await unpublish({ slug: SLUG, store, reporter, bucket: r2.bucket });
      const site = parseSite(await (await fetch(siteUrl(r2.publicUrl), { cache: 'no-store' })).json());
      assert(!site.books.some((b) => b.slug === SLUG), 'site.json no longer lists the book');
      reporter.info('Unpublished the smoke book');
    }
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
