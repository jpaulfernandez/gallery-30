import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DevelopSettingsInput, developHash, loadBook } from '@photobook/shared';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublishConfig } from './config.js';
import {
  captionText,
  cleanPostFolder,
  encodeFrameWithin,
  FRAME_MIN_QUALITY,
  parseFrameList,
  renderFrames,
} from './frames.js';
import { freeze, imageId } from './freeze.js';
import { processAsset } from './images.js';
import { createReporter, type ReportEvent } from './log.js';
import type { ProcessedAsset } from './manifest.js';
import { pageDocumentHtml, pageHash, pagesDir } from './pages.js';
import { developRenderPath } from './paths.js';
import { publish } from './publish.js';
import { MemoryStore } from './store.js';
import { hasChromium } from './testChromium.js';

/** Workflow plan 14: `photobook render-frames`, a social post's frames rendered like the book's page images. */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'six');
const DEVELOPED = '01FIXTUREASSET0000000000A1';
const POST = '01FIXTUREPOST00000000000P01';
const EDIT: DevelopSettingsInput = { version: 1, light: { exposure: 0.5 } };

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
  download: { maxEdge: 4096, quality: 88 },
  concurrency: 2,
  social: { apiUrl: '', adminToken: '' },
};

describe('render-frames arguments', () => {
  it('parses frame lists', () => {
    expect(parseFrameList('1,3, 10')).toEqual([1, 3, 10]);
    expect(parseFrameList('')).toEqual([]);
    expect(() => parseFrameList('0')).toThrow(/from 1/);
    expect(() => parseFrameList('a')).toThrow();
  });

  it('ends the caption file with one newline', () => {
    expect(captionText('Hello')).toBe('Hello\n');
    expect(captionText('Hello\n')).toBe('Hello\n');
    expect(captionText('')).toBe('');
  });
});

describe('post folder cleaning and file size', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pb-frames-clean-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('removes earlier frames the new export does not write and stale temp files, nothing else', async () => {
    for (const name of [
      '01.jpg',
      '02.jpg',
      '11.jpg',
      '12.jpg',
      '01.png',
      '.03.jpg.123.tmp',
      'notes.txt',
      'caption.txt',
    ]) {
      await writeFile(join(dir, name), 'x');
    }
    const removed = await cleanPostFolder(dir, new Set(['01.jpg', '02.jpg', 'caption.txt']));
    expect(removed).toEqual(['.03.jpg.123.tmp', '01.png', '11.jpg', '12.jpg']);
    expect((await readdir(dir)).sort()).toEqual(['01.jpg', '02.jpg', 'caption.txt', 'notes.txt']);
    expect(await cleanPostFolder(join(dir, 'missing'), new Set())).toEqual([]);
  });

  it('re-encodes a JPEG frame at lower quality to fit a network file limit', async () => {
    // Noise does not compress: a 1080 x 1350 frame of it is well over 1 MB at quality 92.
    const raw = Buffer.alloc(1080 * 1350 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    const png = await sharp(raw, { raw: { width: 1080, height: 1350, channels: 3 } })
      .png()
      .toBuffer();
    const free = await encodeFrameWithin(png, 'jpeg');
    expect(free.over).toBe(false);
    expect(free.quality).toBe(92);
    const limit = Math.round(free.body.length * 0.7);
    const capped = await encodeFrameWithin(png, 'jpeg', 92, limit);
    expect(capped.quality).toBeLessThan(92);
    expect(capped.body.length <= limit || capped.quality === FRAME_MIN_QUALITY).toBe(true);
    const impossible = await encodeFrameWithin(png, 'jpeg', 92, 1000);
    expect([impossible.quality, impossible.over]).toEqual([FRAME_MIN_QUALITY, true]);
    expect((await encodeFrameWithin(png, 'png', 92, 1000)).over).toBe(true);
  });
});

describe.skipIf(!hasChromium)('render-frames', () => {
  let dir: string;
  let project: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pb-frames-'));
    await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes('.photobook-publish') });
    project = join(dir, 'book.photobook.json');
    // Photo 1 is developed: its render (a flat #336699, unlike the original) must be what the frames show.
    const doc = JSON.parse(await readFile(project, 'utf8'));
    doc.assets[DEVELOPED].develop = EDIT;
    const render = developRenderPath(dir, doc.assets[DEVELOPED].hash, await developHash(EDIT));
    await mkdir(dirname(render), { recursive: true });
    await sharp({ create: { width: 600, height: 400, channels: 3, background: '#336699' } })
      .jpeg({ quality: 95 })
      .toFile(render);
    // A 10-frame Instagram carousel: the book's three pages, cycled, as frames (new page ids, same elements).
    const frames = Array.from({ length: 10 }, (_, i) => ({
      ...structuredClone(doc.pages[i % 3]),
      id: `01FIXTUREFRAME0000000000F${String(i).padStart(2, '0')}`,
    }));
    doc.outputs = [
      {
        id: POST,
        name: 'Carousel',
        createdAt: 1,
        kind: 'social',
        network: 'instagram-carousel',
        frames,
        caption: 'Ten frames from the fixture',
      },
    ];
    await writeFile(project, JSON.stringify(doc));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const quiet = () => {
    const events: ReportEvent[] = [];
    return { events, reporter: createReporter('json', (line) => events.push(JSON.parse(line) as ReportEvent)) };
  };

  it('exports a 10-frame carousel at 1080x1350 with the developed render, matching the page images', async () => {
    // The book's page images (pages.ts) for comparison: the publish step's feed PNG of page 1.
    await publish({
      projectPath: project,
      config,
      reporter: quiet().reporter,
      store: new MemoryStore(),
      record: false,
    });
    const book = loadBook(JSON.parse(await readFile(project, 'utf8')));
    const first = book.pages[0];
    if (!first) throw new Error('fixture page 1 missing');
    const frozen = await freeze(project);
    const hash = pageHash(frozen.book, frozen.book.pages[0] ?? first, (id) => {
      const a = frozen.assets.get(id);
      return a && imageId(a);
    });
    const feed = join(pagesDir(project, hash), 'feed.png');
    await stat(feed);

    const out = join(dir, 'export', 'carousel');
    const { events, reporter } = quiet();
    const result = await renderFrames({
      projectPath: project,
      outputId: POST,
      outDir: out,
      caption: true,
      config,
      reporter,
    });
    expect(result.files.map((f) => f.slice(out.length + 1))).toEqual(
      Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(2, '0')}.jpg`),
    );
    for (const file of result.files) {
      const meta = await sharp(file).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1080, 1350]);
    }
    expect(await readFile(join(out, 'caption.txt'), 'utf8')).toBe('Ten frames from the fixture\n');
    expect(events.filter((e) => e.type === 'progress' && e.step === 'frames')).toHaveLength(10);

    // Frame 1 is page 1: as a PNG it is the page image pixel for pixel; the JPEG is within encoding error.
    const png = join(dir, 'export', 'png');
    await renderFrames({
      projectPath: project,
      outputId: POST,
      outDir: png,
      frames: [1],
      format: 'png',
      config,
      reporter,
    });
    const raw = (path: string) => sharp(path).removeAlpha().raw().toBuffer();
    const [pageImage, framePng, frameJpeg] = await Promise.all([
      raw(feed),
      raw(join(png, '01.png')),
      raw(result.files[0] ?? ''),
    ]);
    expect(framePng.equals(pageImage)).toBe(true);
    let diff = 0;
    for (let i = 0; i < pageImage.length; i++) diff += Math.abs((pageImage[i] ?? 0) - (frameJpeg[i] ?? 0));
    expect(diff / pageImage.length).toBeLessThan(2);

    // The developed render is what frame 1 shows: the photo slot's centre is #336699, not the original.
    const x = Math.round(1080 * 0.5);
    const y = Math.round(1350 * (0.08 + 0.25));
    const at = (y * 1080 + x) * 3;
    const [r, g, b] = [...framePng.subarray(at, at + 3)];
    expect(Math.abs((r ?? 0) - 0x33)).toBeLessThan(8);
    expect(Math.abs((g ?? 0) - 0x66)).toBeLessThan(8);
    expect(Math.abs((b ?? 0) - 0x99)).toBeLessThan(8);
  }, 120_000);

  it('renders only the frames asked for, and only the caption with an empty list', async () => {
    const out = join(dir, 'one');
    // A frame from an earlier, longer export: --clean removes it.
    await mkdir(out, { recursive: true });
    await writeFile(join(out, '11.jpg'), 'old');
    const { reporter } = quiet();
    const two = await renderFrames({
      projectPath: project,
      outputId: POST,
      outDir: out,
      frames: [2],
      clean: true,
      config,
      reporter,
    });
    expect(two.files.map((f) => f.slice(out.length + 1))).toEqual(['02.jpg']);
    expect(await readdir(out)).toEqual(['02.jpg']);
    const caption = await renderFrames({
      projectPath: project,
      outputId: POST,
      outDir: join(dir, 'caption'),
      frames: [],
      caption: true,
      config,
      reporter,
    });
    expect(caption.files).toEqual([]);
    expect(caption.caption).toBe(join(dir, 'caption', 'caption.txt'));
    await expect(
      renderFrames({ projectPath: project, outputId: POST, outDir: out, frames: [11], config, reporter }),
    ).rejects.toThrow(/10 frame\(s\); there is no frame 11/);
    await expect(
      renderFrames({ projectPath: project, outputId: 'nope', outDir: out, config, reporter }),
    ).rejects.toThrow(/no output "nope"/);
  }, 60_000);
});

describe('frame photo sources', () => {
  let dir: string;
  let project: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pb-frames-src-'));
    await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes('.photobook-publish') });
    project = join(dir, 'book.photobook.json');
    // A large developed render (4000 x 2667, 3:2): the WebP ladder stops at 2048.
    const doc = JSON.parse(await readFile(project, 'utf8'));
    doc.assets[DEVELOPED].develop = EDIT;
    const render = developRenderPath(dir, doc.assets[DEVELOPED].hash, await developHash(EDIT));
    await mkdir(dirname(render), { recursive: true });
    await sharp({ create: { width: 4000, height: 2667, channels: 3, background: '#336699' } })
      .jpeg()
      .toFile(render);
    await writeFile(project, JSON.stringify(doc));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('takes the download JPEG for a story-sized frame, the WebP for a 4:5 one and for book pages', async () => {
    const frozen = await freeze(project);
    const processed = new Map<string, ProcessedAsset>();
    for (const asset of frozen.assets.values()) {
      processed.set(asset.id, {
        asset,
        meta: (
          await processAsset(asset, project, {
            downloadMaxEdge: config.download.maxEdge,
            downloadQuality: config.download.quality,
          })
        ).meta,
      });
    }
    const page = frozen.book.pages[0];
    if (!page) throw new Error('fixture page 1 missing');
    const html = (size: { width: number; height: number }, forFrame: boolean) =>
      pageDocumentHtml(frozen.book, page, processed, project, size, { frame: size.width }, 'frame', { forFrame });
    // 1920 px tall x 3:2 needs 2880 px: more than the 2048 px WebP.
    expect(await html({ width: 1080, height: 1920 }, true)).toContain('/download.jpg');
    // 1350 px tall x 3:2 needs 2025 px: the WebP is enough, as for the book's page images.
    const portrait = await html({ width: 1080, height: 1350 }, true);
    expect(portrait).toContain('/w2048.webp');
    expect(portrait).toBe(await html({ width: 1080, height: 1350 }, false));
    expect(await html({ width: 1080, height: 1920 }, false)).toContain('/w2048.webp');
  }, 60_000);
});
