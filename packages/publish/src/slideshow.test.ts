import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FULL_FRAME } from '@photobook/shared';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublishConfig } from './config.js';
import { createReporter, type ReportEvent } from './log.js';
import type { ProcessedAsset } from './manifest.js';
import { localImage } from './pages.js';
import {
  blendInto,
  cropScript,
  prepareFramesDir,
  renderSlideshow,
  SLIDESHOW_MANIFEST,
  type SlideshowFramesManifest,
  slideFrameSize,
  slideshowFramesDir,
} from './slideshow.js';
import { hasChromium } from './testChromium.js';

/** Workflow plan 16: `photobook render-slideshow`, every frame of a slideshow video as a still. */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'six');
const SLIDESHOW = '01FIXTURESLIDESHOW000000S1';

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

describe('slideshow frame helpers', () => {
  it('blends a layer over what is below at its opacity', () => {
    const acc = new Uint8Array([0, 100, 200]);
    blendInto(acc, new Uint8Array([200, 200, 0]), 0.25);
    expect([...acc]).toEqual([50, 125, 150]);
    blendInto(acc, new Uint8Array([1, 2, 3]), 1);
    expect([...acc]).toEqual([1, 2, 3]);
  });

  it('scales the page so the crop fills the viewport', () => {
    expect(cropScript(FULL_FRAME)).toContain('scale(1) translate(0vw, 0vh)');
    expect(cropScript({ x: 0.1, y: 0.05, w: 0.8, h: 0.8 })).toContain('scale(1.25) translate(-10vw, -5vh)');
  });
});

describe('slideshow photo sizes and the frames folder', () => {
  const book = { width: 1080, height: 1350 };
  const asset = {
    asset: { hash: 'a'.repeat(64) },
    meta: {
      width: 6000,
      height: 4000,
      download: { file: 'download.jpg', maxEdge: 4096 },
      ladder: [{ w: 2048, width: 2048, height: 1365 }],
    },
  } as unknown as ProcessedAsset;
  const sizeFor = (video: { width: number; height: number }, motion: 'none' | 'ken-burns') =>
    slideFrameSize(book, video, motion);

  it('sizes a slide as its page is shown, Ken Burns zoom included', () => {
    // A 4:5 page in a 4K landscape video is 1728 x 2160, zoomed 1.15.
    expect(sizeFor({ width: 3840, height: 2160 }, 'ken-burns')).toEqual({ width: 1988, height: 2484 });
    expect(sizeFor({ width: 1920, height: 1080 }, 'none')).toEqual({ width: 864, height: 1080 });
  });

  it('takes the download JPEG for 4K and the browse WebP for a still 1080p slide', () => {
    const fourK = localImage(asset, '/p/project.json', sizeFor({ width: 3840, height: 2160 }, 'ken-burns'));
    expect(fourK.path.endsWith('download.jpg')).toBe(true);
    expect(Math.max(fourK.width, fourK.height)).toBe(4096);
    const hd = localImage(asset, '/p/project.json', sizeFor({ width: 1920, height: 1080 }, 'none'));
    expect(hd.path.endsWith('w2048.webp')).toBe(true);
  });

  it('clears only its own files from the frames folder and refuses one with other content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pb-frames-dir-'));
    try {
      await prepareFramesDir(join(dir, 'new'));
      for (const name of ['000001.jpg', '000002.jpg', SLIDESHOW_MANIFEST, '.000003.jpg.42.tmp']) {
        await writeFile(join(dir, 'new', name), 'x');
      }
      await prepareFramesDir(join(dir, 'new'));
      expect(await readdir(join(dir, 'new'))).toEqual([]);
      await writeFile(join(dir, 'new', 'holiday.jpg'), 'x');
      await writeFile(join(dir, 'new', '000001.jpg'), 'x');
      await expect(prepareFramesDir(join(dir, 'new'))).rejects.toThrow(/holds other files \(holiday.jpg\)/);
      expect((await readdir(join(dir, 'new'))).sort()).toEqual(['000001.jpg', 'holiday.jpg']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasChromium)('render-slideshow', () => {
  let dir: string;
  let project: string;

  const write = async (settings: Record<string, unknown>) => {
    const doc = JSON.parse(await readFile(project, 'utf8'));
    doc.outputs = [{ id: SLIDESHOW, name: 'Trip', createdAt: 1, kind: 'slideshow', ...settings }];
    await writeFile(project, JSON.stringify(doc));
    return doc;
  };

  const quiet = () => {
    const events: ReportEvent[] = [];
    return { events, reporter: createReporter('json', (line) => events.push(JSON.parse(line) as ReportEvent)) };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pb-slideshow-'));
    await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes('.photobook-publish') });
    project = join(dir, 'book.photobook.json');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('renders slides × seconds × fps frames with Ken Burns and crossfades, then frames.json', async () => {
    await write({ secondsPerSlide: 1, size: 'square-1080p', transition: 'crossfade', motion: 'ken-burns' });
    const { events, reporter } = quiet();
    const {
      dir: out,
      manifest,
      rendered,
    } = await renderSlideshow({ projectPath: project, outputId: SLIDESHOW, config, reporter });
    expect(out).toBe(slideshowFramesDir(project, SLIDESHOW));
    expect(manifest).toEqual({
      version: 1,
      output: SLIDESHOW,
      fps: 30,
      width: 1080,
      height: 1080,
      frames: 3 * 1 * 30,
      slides: 3,
      seconds: 3,
    } satisfies SlideshowFramesManifest);
    expect(rendered).toBe(90);
    const files = (await readdir(out)).sort();
    expect(files).toEqual([
      ...Array.from({ length: 90 }, (_, i) => `${String(i + 1).padStart(6, '0')}.jpg`),
      SLIDESHOW_MANIFEST,
    ]);
    expect(JSON.parse(await readFile(join(out, SLIDESHOW_MANIFEST), 'utf8'))).toEqual(manifest);
    const meta = await sharp(join(out, '000045.jpg')).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1080, 1080]);
    // Ken Burns: consecutive frames of a slide differ.
    const a = await sharp(join(out, '000002.jpg')).raw().toBuffer();
    const b = await sharp(join(out, '000010.jpg')).raw().toBuffer();
    expect(a.equals(b)).toBe(false);
    const progress = events.filter((e) => e.type === 'progress' && e.step === 'slideshow');
    expect(progress.at(-1)).toMatchObject({ done: 90, total: 90 });
  }, 120_000);

  it('shows the picks whole on black, and links held frames instead of drawing them again', async () => {
    const doc = await write({
      source: 'picks',
      secondsPerSlide: 1,
      size: 'square-1080p',
      transition: 'none',
      motion: 'none',
    });
    // Two picks in the folder's library (by content hash): the 3:2 photo 1 and the 2:3 photo 2.
    const hashes = ['01FIXTUREASSET0000000000A1', '01FIXTUREASSET0000000000A2'].map((id) => doc.assets[id].hash);
    await mkdir(join(dir, '.photobook'), { recursive: true });
    await writeFile(
      join(dir, '.photobook', 'library.json'),
      JSON.stringify({ version: 1, photos: Object.fromEntries(hashes.map((h: string) => [h, { flag: 'pick' }])) }),
    );
    const {
      manifest,
      rendered,
      dir: out,
    } = await renderSlideshow({
      projectPath: project,
      outputId: SLIDESHOW,
      config,
      reporter: quiet().reporter,
    });
    expect([manifest.slides, manifest.frames, rendered]).toEqual([2, 60, 2]);
    // Held frames are hard links to the first frame of their slide.
    expect((await stat(join(out, '000030.jpg'))).ino).toBe((await stat(join(out, '000001.jpg'))).ino);
    // Photo 1 is 3:2 in a square: black bars above and below.
    const { data, info } = await sharp(join(out, '000001.jpg')).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[(y * info.width + x) * info.channels] as number;
    expect(at(540, 10)).toBeLessThan(16);
    expect(at(540, 1070)).toBeLessThan(16);
  }, 120_000);

  it('fails clearly with no picks', async () => {
    await write({ source: 'picks' });
    await expect(
      renderSlideshow({ projectPath: project, outputId: SLIDESHOW, config, reporter: quiet().reporter }),
    ).rejects.toThrow(/no photo of the project is picked/);
  });
});
