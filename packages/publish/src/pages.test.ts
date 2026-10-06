import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBook, manifestKey, PAGE_IMAGE_SIZES, parseManifest } from '@photobook/shared';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublishConfig } from './config.js';
import { createReporter, type ReportEvent } from './log.js';
import { fitPageWidth, pageHash, pagesDir, readPageMeta } from './pages.js';
import { publish } from './publish.js';
import { MemoryStore } from './store.js';
import { hasChromium } from './testChromium.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'six');

const config: PublishConfig = {
  source: 'test',
  r2: {
    accountId: 'acc',
    accessKeyId: 'k',
    secretAccessKey: 's',
    bucket: 'test-bucket',
    publicUrl: 'https://cdn.example.test',
    transport: 's3',
  },
  viewerUrl: '',
  sitePassword: '',
  sitePasswordExpiresAt: null,
  download: { maxEdge: 4096, quality: 88 },
  concurrency: 2,
  social: { apiUrl: '', adminToken: '' },
};

async function fixtureBook() {
  return loadBook(JSON.parse(await readFile(join(FIXTURE, 'book.photobook.json'), 'utf8')));
}

describe('page geometry and hash', () => {
  it('fills the frame width when the ratios match, else the largest size that fits', () => {
    expect(fitPageWidth({ width: 1080, height: 1350 }, PAGE_IMAGE_SIZES.feed)).toBe(1080);
    expect(fitPageWidth({ width: 1080, height: 1350 }, PAGE_IMAGE_SIZES.story)).toBe(1080);
    expect(fitPageWidth({ width: 1080, height: 1920 }, PAGE_IMAGE_SIZES.feed)).toBe(759);
    expect(fitPageWidth({ width: 1080, height: 1920 }, PAGE_IMAGE_SIZES.story)).toBe(1080);
    expect(fitPageWidth({ width: 1, height: 1 }, PAGE_IMAGE_SIZES.feed)).toBe(1080);
    expect(fitPageWidth({ width: 2, height: 3 }, PAGE_IMAGE_SIZES.feed)).toBe(900);
  });

  it('hashes what the page looks like, not its notes', async () => {
    const book = await fixtureBook();
    const hashOf = (b: typeof book, i = 0) =>
      pageHash(b, b.pages[i] as (typeof b.pages)[number], (id) => b.assets[id]?.hash);
    const base = hashOf(book);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf(book, 1)).not.toBe(base);

    const notes = structuredClone(book);
    (notes.pages[0] as (typeof book.pages)[number]).notes = 'changed';
    expect(hashOf(notes)).toBe(base);

    const crop = structuredClone(book);
    const photo = crop.pages[0]?.elements[0];
    if (photo?.type !== 'photo') throw new Error('fixture page 1 starts with a photo');
    photo.crop = { ...photo.crop, scale: 1.5 };
    expect(hashOf(crop)).not.toBe(base);

    const swapped = structuredClone(book);
    (swapped.assets['01FIXTUREASSET0000000000A1'] as { hash?: string }).hash = 'f'.repeat(64);
    expect(hashOf(swapped)).not.toBe(base);
    expect(hashOf(swapped, 2)).toBe(hashOf(book, 2));
  });
});

describe.skipIf(!hasChromium)('page images', () => {
  let dir: string;
  let project: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pb-pages-'));
    // A publish run from the fixture folder leaves `.photobook-publish/` there; never copy that cache.
    await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes('.photobook-publish') });
    project = join(dir, 'book.photobook.json');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const run = async (store: MemoryStore) => {
    const events: ReportEvent[] = [];
    const reporter = createReporter('json', (line) => events.push(JSON.parse(line) as ReportEvent));
    const res = await publish({ projectPath: project, config, reporter, store, record: false });
    return { res, events };
  };

  it('renders feed and story PNGs at their frame size and a 320 px thumbnail, letterboxed on the page colour', async () => {
    await run(new MemoryStore());
    const book = await fixtureBook();
    for (const [i, page] of book.pages.entries()) {
      const hash = pageHash(book, page, (id) => book.assets[id]?.hash);
      const pdir = pagesDir(project, hash);
      const meta = await readPageMeta(pdir, hash);
      expect(meta, `page ${i + 1} meta`).not.toBeNull();

      const feed = await sharp(join(pdir, 'feed.png')).metadata();
      expect([feed.format, feed.width, feed.height]).toEqual(['png', 1080, 1350]);
      const story = await sharp(join(pdir, 'story.png')).metadata();
      expect([story.format, story.width, story.height]).toEqual(['png', 1080, 1920]);
      const thumb = await sharp(join(pdir, 'thumb.webp')).metadata();
      expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 320, 400]);

      // The 4:5 page sits in the middle of the story frame; the bands above and below are the
      // page colour, or the theme background for a photo background (page 2).
      const expected = typeof page.background === 'string' ? page.background : book.theme.background;
      const rgb = [1, 3, 5].map((o) => Number.parseInt(expected.slice(o, o + 2), 16));
      const { data } = await sharp(join(pdir, 'story.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      for (const y of [0, 1919]) {
        const at = (y * 1080 + 540) * 3;
        expect([...data.subarray(at, at + 3)], `page ${i + 1} story band at y=${y}`).toEqual(rgb);
      }
      // Photos are present: the feed's centre of page 1's slot is not the page colour.
      if (i === 0) {
        const raw = await sharp(join(pdir, 'feed.png')).removeAlpha().raw().toBuffer();
        const at = (Math.round(1350 * 0.33) * 1080 + 540) * 3;
        expect([...raw.subarray(at, at + 3)]).not.toEqual([255, 255, 255]);
      }
    }
  });

  it('re-renders and re-uploads only the page whose look changed', async () => {
    const store = new MemoryStore();
    await run(store);
    const before = parseManifest(store.json(manifestKey('fixture-six')));

    // A caption edit on page 1 and a notes edit on page 3.
    const json = JSON.parse(await readFile(project, 'utf8'));
    json.pages[0].elements[1].text = 'Day one, again';
    json.pages[2].notes = 'only notes changed';
    await writeFile(project, JSON.stringify(json));

    store.ops.length = 0;
    const { res, events } = await run(store);
    expect(events.find((e) => e.type === 'step' && e.step === 'pages' && e.status === 'done')).toMatchObject({
      detail: '1 rendered, 2 cached',
    });
    expect(res.uploaded).toBe(3);
    const puts = store.ops.filter((o) => o.startsWith('put ')).map((o) => o.slice(4));
    expect(puts.filter((k) => k.includes('/pages/'))).toHaveLength(3);
    const after = parseManifest(store.json(manifestKey('fixture-six')));
    expect(after.pages[0]?.shareFeed).not.toBe(before.pages[0]?.shareFeed);
    expect(after.pages.slice(1).map((p) => p.shareFeed)).toEqual(before.pages.slice(1).map((p) => p.shareFeed));
    const hashes = new Set(puts.map((k) => /\/pages\/([0-9a-f]{64})-/.exec(k)?.[1]).filter(Boolean));
    expect(hashes.size).toBe(1);
    expect(after.pages[0]?.thumbnail).toContain(`/pages/${[...hashes][0]}-thumb.webp`);
  });
});
