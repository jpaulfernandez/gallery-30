import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPassword,
  hashPassword,
  imagePrefix,
  manifestKey,
  pagesPrefix,
  parseManifest,
  parseSite,
  SITE_KEY,
  verifyPassword,
} from '@photobook/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PublishConfig, parseEnvFile, serializeEnvFile } from './config.js';
import { createReporter, type ReportEvent } from './log.js';
import { publish } from './publish.js';
import { MemoryStore } from './store.js';
import { hasChromium } from './testChromium.js';
import { clearSitePassword, unpublish } from './unpublish.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'six');
const BASE = 'https://cdn.example.test';
/** Tests whose counts include the 9 page images (3 pages x feed, story, thumb) need Chromium. */
const itPages = it.skipIf(!hasChromium);
const PAGES = `${BASE}/${pagesPrefix('fixture-six', 'fx6pre')}/`;

function config(overrides: Partial<PublishConfig> = {}): PublishConfig {
  return {
    source: 'test',
    r2: {
      accountId: 'acc',
      accessKeyId: 'k',
      secretAccessKey: 's',
      bucket: 'test-bucket',
      publicUrl: BASE,
      transport: 's3',
    },
    viewerUrl: '',
    download: { maxEdge: 4096, quality: 88 },
    concurrency: 2,
    social: { apiUrl: '', adminToken: '' },
    ...overrides,
  };
}

function reporter() {
  const events: ReportEvent[] = [];
  const r = createReporter('json', (line) => events.push(JSON.parse(line) as ReportEvent));
  return { r, events };
}

describe('publish pipeline', () => {
  let dir: string;
  let project: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pb-six-'));
    // A publish run from the fixture folder leaves `.photobook-publish/` there; never copy that cache.
    await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes('.photobook-publish') });
    project = join(dir, 'book.photobook.json');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  itPages('publishes everything once, then only the manifest and site file', async () => {
    const store = new MemoryStore();
    const first = reporter();
    const res = await publish({
      projectPath: project,
      config: config(),
      reporter: first.r,
      store,
      now: () => new Date('2026-10-05T10:00:00Z'),
    });

    // Each photo: download + share + the ladder sizes up to its own width in AVIF and WebP.
    // 1200 px long edge -> 480, 960, 1200 (3 sizes, 8 objects); the 900 px square -> 480, 900 (6 objects).
    // That is 46 image objects, plus 3 pages x (feed.png, story.png, thumb.webp).
    expect(res.uploaded).toBe(55);
    expect(res.skipped).toBe(0);
    expect(store.objects.size).toBe(57);
    expect(res.url).toBe(`${BASE}/books/fixture-six/manifest.json`);
    const puts = store.ops.filter((o) => o.startsWith('put '));
    expect(puts).toHaveLength(57);
    expect(store.objects.get(manifestKey('fixture-six'))?.options.cacheControl).toBe('no-cache');
    const anyImage = [...store.objects.keys()].find((k) => k.endsWith('-w480.avif'));
    expect(anyImage).toMatch(/^books\/fixture-six\/fx6pre\/[0-9a-f]{64}-w480\.avif$/);
    expect(store.objects.get(anyImage as string)?.options).toEqual({
      contentType: 'image/avif',
      cacheControl: 'public, max-age=31536000, immutable',
    });

    const pageKeys = [...store.objects.keys()].filter((k) => k.startsWith(`${pagesPrefix('fixture-six', 'fx6pre')}/`));
    expect(pageKeys).toHaveLength(9);
    expect(store.objects.get(pageKeys.find((k) => k.endsWith('-feed.png')) as string)?.options).toEqual({
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(store.objects.get(pageKeys.find((k) => k.endsWith('-thumb.webp')) as string)?.options.contentType).toBe(
      'image/webp',
    );

    // The manifest: valid, no notes, rendered page images, orientation applied to the EXIF-6 photo.
    const manifest = parseManifest(store.json(manifestKey('fixture-six')));
    expect(manifest.pages).toHaveLength(3);
    expect(manifest.pages.some((p) => 'notes' in p)).toBe(false);
    for (const page of manifest.pages) {
      const hash = page.thumbnail?.slice(PAGES.length, PAGES.length + 64) as string;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(page.thumbnail).toBe(`${PAGES}${hash}-thumb.webp`);
      expect(page.shareFeed).toBe(`${PAGES}${hash}-feed.png`);
      expect(page.shareStory).toBe(`${PAGES}${hash}-story.png`);
    }
    expect(new Set(manifest.pages.map((p) => p.thumbnail)).size).toBe(3);
    expect(manifest.images['01FIXTUREASSET0000000000A5']).toMatchObject({ width: 800, height: 1200 });
    expect(manifest.images['01FIXTUREASSET0000000000A1']?.avif.map((e) => e.w)).toEqual([480, 960, 1200]);
    expect(manifest.images['01FIXTUREASSET0000000000A6']?.webp.map((e) => e.w)).toEqual([480, 900]);
    expect(manifest.images['01FIXTUREASSET0000000000A1']?.download.filename).toBe('DSCF2001.jpg');
    expect(manifest.listed).toBe(true);
    expect(manifest.publishedAt).toBe('2026-10-05T10:00:00.000Z');

    // site.json lists the book with its cover.
    const site = parseSite(store.json(SITE_KEY));
    expect(site.password).toBeNull();
    expect(site.books).toEqual([
      {
        slug: 'fixture-six',
        title: 'Six photos',
        cover: manifest.pages[0]?.thumbnail,
        pages: 3,
        publishedAt: manifest.publishedAt,
        locked: false,
      },
    ]);

    // The project file records the publish.
    const recorded = JSON.parse(await readFile(project, 'utf8'));
    expect(recorded.publish.lastPublishedAt).toBe('2026-10-05T10:00:00.000Z');
    expect(recorded.publish.publishedFingerprint).toBe(res.fingerprint);
    expect(first.events.at(-1)).toMatchObject({ type: 'result', uploaded: 55, dryRun: false });
    const pageProgress = first.events.filter((e) => e.type === 'progress' && e.step === 'pages');
    expect(pageProgress).toHaveLength(3);
    for (const e of pageProgress)
      expect(e).toMatchObject({ total: 3, detail: expect.stringMatching(/^page [1-3] \d+\.\ds$/) });

    // Second run: images and pages cached, keys known from the state file, only manifest + site written.
    store.ops.length = 0;
    const second = reporter();
    const again = await publish({ projectPath: project, config: config(), reporter: second.r, store });
    expect(again.uploaded).toBe(0);
    expect(again.skipped).toBe(55);
    expect(store.ops.filter((o) => o.startsWith('head '))).toHaveLength(0);
    expect(store.ops.filter((o) => o.startsWith('put ')).sort()).toEqual([
      `put ${manifestKey('fixture-six')}`,
      `put ${SITE_KEY}`,
    ]);
    const imagesStep = second.events.find((e) => e.type === 'step' && e.step === 'images' && e.status === 'done');
    expect(imagesStep).toMatchObject({ detail: '0 processed, 6 cached' });
    const pagesStep = second.events.find((e) => e.type === 'step' && e.step === 'pages' && e.status === 'done');
    expect(pagesStep).toMatchObject({ detail: '0 rendered, 3 cached' });
    const cachedPages = second.events.flatMap((e) => (e.type === 'progress' && e.step === 'pages' ? [e.detail] : []));
    expect(cachedPages).toEqual(['page 1 cached', 'page 2 cached', 'page 3 cached']);
    expect(parseManifest(store.json(manifestKey('fixture-six'))).pages).toEqual(manifest.pages);
  });

  it('--skip-pages leaves the share PNGs out and falls back to photo thumbnails', async () => {
    const store = new MemoryStore();
    const { r, events } = reporter();
    const res = await publish({ projectPath: project, config: config(), reporter: r, store, skipPages: true });
    expect(res.uploaded).toBe(46);
    expect(store.objects.size).toBe(48);
    expect([...store.objects.keys()].some((k) => k.includes('/pages/'))).toBe(false);
    expect(events.find((e) => e.type === 'step' && e.step === 'pages')).toMatchObject({
      status: 'skipped',
      detail: '--skip-pages',
    });
    const manifest = parseManifest(store.json(manifestKey('fixture-six')));
    expect(manifest.pages.map((p) => [p.shareFeed, p.shareStory])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    expect(manifest.pages[0]?.thumbnail).toMatch(/-w480\.webp$/);
    // Page 2 has a photo background: its thumbnail is that photo's smallest WebP.
    expect(manifest.pages[1]?.thumbnail).toBe(manifest.images['01FIXTUREASSET0000000000A5']?.webp[0]?.url);
    expect(parseSite(store.json(SITE_KEY)).books[0]?.cover).toBe(manifest.pages[0]?.thumbnail);
  });

  itPages('dry run uploads nothing and reports the plan', async () => {
    const store = new MemoryStore();
    const { r, events } = reporter();
    const res = await publish({ projectPath: project, config: config(), reporter: r, store, dryRun: true });
    expect(res.uploaded).toBe(55);
    expect(store.objects.size).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'result', dryRun: true, uploaded: 55, skipped: 0 });
    const recorded = JSON.parse(await readFile(project, 'utf8'));
    expect(recorded.publish.lastPublishedAt).toBeNull();
  });

  it('keeps other books in site.json and drops this one when unlisted', async () => {
    const store = new MemoryStore();
    const other = { slug: 'other', title: 'Other', cover: null, pages: 2, publishedAt: '2026-01-01T00:00:00.000Z' };
    await store.put(SITE_KEY, new TextEncoder().encode(JSON.stringify({ password: null, books: [other] })), {
      contentType: 'application/json',
      cacheControl: 'no-cache',
    });
    await publish({ projectPath: project, config: config(), reporter: reporter().r, store, record: false });
    expect(parseSite(store.json(SITE_KEY)).books.map((b) => b.slug)).toEqual(['other', 'fixture-six']);

    // Flip to unlisted: only the manifest and site.json change; the other book is untouched.
    const book = JSON.parse(await readFile(project, 'utf8'));
    book.publish.visibility = 'unlisted';
    await (await import('node:fs/promises')).writeFile(project, JSON.stringify(book));
    store.ops.length = 0;
    await publish({ projectPath: project, config: config(), reporter: reporter().r, store, record: false });
    expect(store.ops.filter((o) => o.startsWith('put ')).sort()).toEqual([
      `put ${manifestKey('fixture-six')}`,
      `put ${SITE_KEY}`,
    ]);
    expect(parseSite(store.json(SITE_KEY)).books).toEqual([{ ...other, locked: false }]);
    expect(parseManifest(store.json(manifestKey('fixture-six'))).listed).toBe(false);
    expect([...store.objects.keys()].filter((k) => k.startsWith('books/other/'))).toEqual([]);
  });

  itPages('prunes stale objects under the image prefix only, keeping page images', async () => {
    const store = new MemoryStore();
    const prefix = imagePrefix('fixture-six', 'fx6pre');
    const stale = `${prefix}/deadbeef-w480.avif`;
    const stalePage = `${pagesPrefix('fixture-six', 'fx6pre')}/deadbeef-feed.png`;
    const foreign = 'books/other/zzz/abc-w480.avif';
    const opts = { contentType: 'image/avif', cacheControl: 'x' };
    await store.put(stale, new Uint8Array(1), opts);
    await store.put(stalePage, new Uint8Array(1), opts);
    await store.put(foreign, new Uint8Array(1), opts);
    const res = await publish({
      projectPath: project,
      config: config(),
      reporter: reporter().r,
      store,
      prune: true,
      record: false,
    });
    expect(res.pruned).toBe(2);
    expect(store.objects.has(stale)).toBe(false);
    expect(store.objects.has(stalePage)).toBe(false);
    expect(store.objects.has(foreign)).toBe(true);
    expect([...store.objects.keys()].filter((k) => k.startsWith(`${prefix}/`))).toHaveLength(55);
  });

  it('publishes the book password in its manifest and keeps the legacy site password until cleared', async () => {
    const store = new MemoryStore();
    // A site published before per-book passwords: one site-wide password.
    const legacy = { hash: await hashPassword('old', 'salt'), salt: 'salt', version: 1, expiresAt: null };
    await store.put(SITE_KEY, new TextEncoder().encode(JSON.stringify({ password: legacy, books: [] })), {
      contentType: 'application/json',
      cacheControl: 'no-cache',
    });

    const doc = JSON.parse(await readFile(project, 'utf8'));
    const password = await createPassword(' kyoto ', null);
    doc.publish = { ...doc.publish, visibility: 'listed', password };
    await writeFile(project, JSON.stringify(doc));
    await publish({ projectPath: project, config: config(), reporter: reporter().r, store, record: false });

    const manifest = parseManifest(store.json(manifestKey('fixture-six')));
    expect(manifest.password).toEqual(password);
    expect(await verifyPassword('kyoto', password)).toBe(true);
    expect(await verifyPassword('Kyoto', password)).toBe(false);
    const site = parseSite(store.json(SITE_KEY));
    expect(site.books.map((b) => [b.slug, b.locked])).toEqual([['fixture-six', true]]);
    expect(site.password).toEqual(legacy);

    // Password off: the manifest says so explicitly (no fallback to the site password).
    doc.publish.password = null;
    await writeFile(project, JSON.stringify(doc));
    await publish({ projectPath: project, config: config(), reporter: reporter().r, store, record: false });
    expect(parseManifest(store.json(manifestKey('fixture-six'))).password).toBeNull();
    expect(parseSite(store.json(SITE_KEY)).books[0]?.locked).toBe(false);

    await clearSitePassword({ store, reporter: reporter().r });
    expect(parseSite(store.json(SITE_KEY)).password).toBeNull();
  });

  itPages('unpublish deletes the book folder and its site entry', async () => {
    const store = new MemoryStore();
    await publish({ projectPath: project, config: config(), reporter: reporter().r, store, record: false });
    const { deleted } = await unpublish({
      slug: 'fixture-six',
      store,
      reporter: reporter().r,
      projectPath: project,
      bucket: 'test-bucket',
    });
    expect(deleted).toBe(56);
    expect([...store.objects.keys()]).toEqual([SITE_KEY]);
    expect(parseSite(store.json(SITE_KEY)).books).toEqual([]);
  });
});

describe('settings file', () => {
  it('round-trips through the dotenv format', () => {
    const text = serializeEnvFile({ R2_BUCKET: 'photobook', VIEWER_URL: 'two words #1', DOWNLOAD_QUALITY: '90' });
    expect(parseEnvFile(text)).toEqual({
      R2_BUCKET: 'photobook',
      VIEWER_URL: 'two words #1',
      DOWNLOAD_QUALITY: '90',
    });
    expect(parseEnvFile("# c\nA=1\nB='x y'\n\nbad line\n")).toEqual({ A: '1', B: 'x y' });
  });
});
