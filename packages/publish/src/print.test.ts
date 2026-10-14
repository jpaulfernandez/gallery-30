import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PRINT_SETTINGS,
  type DevelopSettingsInput,
  developHash,
  mmToPt,
  type PrintSettings,
  sheetSize,
  trimBox,
} from '@photobook/shared';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublishConfig } from './config.js';
import { freeze, imageId } from './freeze.js';
import { createReporter, type ReportEvent } from './log.js';
import { pageHash, pagesDir } from './pages.js';
import { developRenderPath } from './paths.js';
import { neededEdges, printTempPath, prunePrintCache, renderPrint, sweepStaleTemps } from './print.js';
import { publish } from './publish.js';
import { MemoryStore } from './store.js';
import { hasChromium } from './testChromium.js';

/** Workflow plan 15: `photobook print`, a print output as a PDF through the page images' renderer. */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'six');
const DEVELOPED = '01FIXTUREASSET0000000000A1';
const PRINT = '01FIXTUREPRINT0000000000P1';
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

/** Every page's MediaBox `[x0 y0 x1 y1]` in points, from the PDF's page objects. */
function mediaBoxes(pdf: Buffer): number[][] {
  const text = pdf.toString('latin1');
  return [...text.matchAll(/\/MediaBox\s*\[\s*([-\d.\s]+)\]/g)].map((m) =>
    (m[1] ?? '').trim().split(/\s+/).map(Number),
  );
}

/** Number of page objects (`/Type /Page`, not `/Pages`). */
const pageCount = (pdf: Buffer): number => [...pdf.toString('latin1').matchAll(/\/Type\s*\/Page(?![s\w])/g)].length;

describe('print photo sizes', () => {
  it('asks for the long edge each photo shows at, times the zoom, at the dpi', () => {
    const page = {
      id: 'p',
      layout: 'custom',
      background: '#fff',
      guides: [],
      elements: [
        {
          type: 'photo' as const,
          id: 'e',
          asset: 'a',
          frame: { x: 0, y: 0, w: 0.5, h: 1 },
          crop: { x: 0, y: 0, scale: 2 },
          rotate: 0 as const,
          filter: 'none' as const,
        },
      ],
    };
    // A 3:2 photo in a 100 x 254 mm slot (content 200 x 254 mm): cover height 254 mm, width 381 mm, zoomed twice.
    const edges = neededEdges([page] as never, { w: 200, h: 254 }, 300, () => 1.5);
    expect(edges.get('a')).toBe(Math.ceil((381 * 2 * 300) / 25.4));
  });
});

describe.skipIf(!hasChromium)('print', () => {
  let dir: string;
  let project: string;

  const setPrint = async (settings: Partial<PrintSettings>) => {
    const doc = JSON.parse(await readFile(project, 'utf8'));
    doc.outputs = [{ id: PRINT, name: 'Zine', createdAt: 1, kind: 'print', ...DEFAULT_PRINT_SETTINGS, ...settings }];
    await writeFile(project, JSON.stringify(doc));
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pb-print-'));
    await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes('.photobook-publish') });
    project = join(dir, 'book.photobook.json');
    // Two pages: page 1 (white, a developed photo in a slot) and page 2 (a full-bleed photo background).
    const doc = JSON.parse(await readFile(project, 'utf8'));
    doc.pages = doc.pages.slice(0, 2);
    doc.assets[DEVELOPED].develop = EDIT;
    const render = developRenderPath(dir, doc.assets[DEVELOPED].hash, await developHash(EDIT));
    await mkdir(dirname(render), { recursive: true });
    await sharp({ create: { width: 600, height: 400, channels: 3, background: '#336699' } })
      .jpeg({ quality: 95 })
      .toFile(render);
    await writeFile(project, JSON.stringify(doc));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const quiet = () => {
    const events: ReportEvent[] = [];
    return { events, reporter: createReporter('json', (line) => events.push(JSON.parse(line) as ReportEvent)) };
  };

  it('writes one PDF page per page at the trim plus the bleed, and spreads with marks on wider sheets', async () => {
    const settings = { paper: '8x10', bleedMm: 3, marks: false, imposition: 'pages' } as const;
    await setPrint(settings);
    const out = join(dir, 'export', 'zine.pdf');
    const { events, reporter } = quiet();
    const result = await renderPrint({ projectPath: project, outputId: PRINT, out, config, reporter });
    expect(result.files).toEqual([out]);
    const pdf = await readFile(out);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(2);
    const size = sheetSize({ ...DEFAULT_PRINT_SETTINGS, ...settings });
    expect(size).toEqual({ w: 209.2, h: 260 });
    const boxes = mediaBoxes(pdf);
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    for (const [x0, y0, x1, y1] of boxes) {
      expect([x0, y0]).toEqual([0, 0]);
      expect(Math.abs((x1 ?? 0) - mmToPt(size.w))).toBeLessThan(1);
      expect(Math.abs((y1 ?? 0) - mmToPt(size.h))).toBeLessThan(1);
    }
    expect(events.some((e) => e.type === 'step' && e.step === 'print' && e.status === 'done')).toBe(true);

    // Spreads: the cover alone, then page 2 alone on the left half; with marks, a slug around the bleed.
    const spreads = { ...settings, imposition: 'spreads', marks: true } as const;
    await setPrint(spreads);
    const wide = join(dir, 'export', 'spreads.pdf');
    await renderPrint({ projectPath: project, outputId: PRINT, out: wide, config, reporter });
    const spreadPdf = await readFile(wide);
    expect(pageCount(spreadPdf)).toBe(2);
    const spreadSize = sheetSize({ ...DEFAULT_PRINT_SETTINGS, ...spreads });
    for (const [, , x1, y1] of mediaBoxes(spreadPdf)) {
      expect(Math.abs((x1 ?? 0) - mmToPt(spreadSize.w))).toBeLessThan(1);
      expect(Math.abs((y1 ?? 0) - mmToPt(spreadSize.h))).toBeLessThan(1);
    }
  }, 120_000);

  it('draws an untouched page byte for byte as the web render; the bleed runs on, the marks sit outside it', async () => {
    // The book's page images (pages.ts): the feed PNG of page 1, 1080 x 1350.
    await publish({
      projectPath: project,
      config,
      reporter: quiet().reporter,
      store: new MemoryStore(),
      record: false,
    });
    const frozen = await freeze(project);
    const first = frozen.book.pages[0];
    if (!first) throw new Error('fixture page 1 missing');
    const hash = pageHash(frozen.book, first, (id) => {
      const a = frozen.assets.get(id);
      return a && imageId(a);
    });
    const feed = join(pagesDir(project, hash), 'feed.png');
    await stat(feed);

    // 8 x 10 in at 135 dpi is 1080 x 1350 px: the web render's size. Same photos (the web ladder) for the comparison.
    await setPrint({ paper: '8x10', bleedMm: 3, marks: true, imposition: 'pages' });
    const proofs = join(dir, 'proofs');
    const { reporter } = quiet();
    const result = await renderPrint({
      projectPath: project,
      outputId: PRINT,
      out: proofs,
      png: true,
      dpi: 135,
      webImages: true,
      config,
      reporter,
    });
    expect(result.files.map((f) => f.slice(proofs.length + 1))).toEqual(['01.png', '02.png']);
    const page1 = result.placements.find((p) => p.page === 0);
    expect(page1?.box).toMatchObject({ w: 1080, h: 1350 });
    const box = page1?.box ?? { x: 0, y: 0, w: 0, h: 0 };
    const sheet1 = result.files[0] ?? '';
    const trimmed = await sharp(sheet1)
      .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
      .removeAlpha()
      .raw()
      .toBuffer();
    const web = await sharp(feed).removeAlpha().raw().toBuffer();
    expect(trimmed.equals(web)).toBe(true);

    // Page 2 is a full-bleed photo: the bleed band left of the trim is the photo, not paper white.
    const sheet2 = result.files[1] ?? '';
    const box2 = result.placements.find((p) => p.page === 1)?.box ?? box;
    const { data, info } = await sharp(sheet2).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => {
      const i = (y * info.width + x) * 3;
      return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
    };
    const midY = box2.y + Math.round(box2.h / 2);
    const inBleed = at(box2.x - 4, midY);
    const insideTrim = at(box2.x + 2, midY);
    expect(inBleed.some((v) => v < 245)).toBe(true);
    for (let c = 0; c < 3; c++) expect(Math.abs((inBleed[c] ?? 0) - (insideTrim[c] ?? 0))).toBeLessThan(40);
    // A crop mark on the trim's top edge, left of the bleed: dark. The slug corner off the marks: white.
    const bleedPx = Math.round((3 * 135) / 25.4);
    const markX = box2.x - bleedPx - Math.round((3 * 135) / 25.4);
    expect(at(markX, box2.y).every((v) => v < 80)).toBe(true);
    expect(at(2, 2)).toEqual([255, 255, 255]);
  }, 180_000);

  it('embeds print-size photos from the developed render', async () => {
    await setPrint({ paper: '8x10', bleedMm: 0, marks: false, imposition: 'pages' });
    const proofs = join(dir, 'print-proofs');
    const result = await renderPrint({
      projectPath: project,
      outputId: PRINT,
      out: proofs,
      png: true,
      dpi: 135,
      config,
      reporter: quiet().reporter,
    });
    const { data, info } = await sharp(result.files[0] ?? '')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Page 1's photo slot centre shows the render (#336699), not the original.
    const x = Math.round(1080 * 0.5);
    const y = Math.round(1350 * (0.08 + 0.25));
    const i = (y * info.width + x) * 3;
    expect(Math.abs((data[i] ?? 0) - 0x33)).toBeLessThan(8);
    expect(Math.abs((data[i + 1] ?? 0) - 0x66)).toBeLessThan(8);
    expect(Math.abs((data[i + 2] ?? 0) - 0x99)).toBeLessThan(8);
    await expect(
      renderPrint({
        projectPath: project,
        outputId: 'nope',
        out: proofs,
        png: true,
        config,
        reporter: quiet().reporter,
      }),
    ).rejects.toThrow(/no output "nope"/);
  }, 120_000);

  /** Use the fixture's three pages (white, a photo background, #111111). */
  const allPages = async () => {
    const original = JSON.parse(await readFile(join(FIXTURE, 'book.photobook.json'), 'utf8'));
    const doc = JSON.parse(await readFile(project, 'utf8'));
    doc.pages = original.pages;
    await writeFile(project, JSON.stringify(doc));
  };

  /** The `step: images` progress details of a run. */
  const imageDetails = (events: ReportEvent[]) =>
    events.flatMap((e) => (e.type === 'progress' && e.step === 'images' ? [e.detail ?? ''] : []));

  it('spreads: page 1 alone on the right half, then 2 left and 3 right', async () => {
    await allPages();
    const settings = { paper: '8x10', bleedMm: 3, marks: false, imposition: 'spreads' } as const;
    await setPrint(settings);
    const result = await renderPrint({
      projectPath: project,
      outputId: PRINT,
      out: join(dir, 'spreads'),
      png: true,
      dpi: 72,
      config,
      reporter: quiet().reporter,
    });
    expect(result.files).toHaveLength(2);
    const at = (page: number) => result.placements.find((p) => p.page === page);
    const trim = trimBox({ ...DEFAULT_PRINT_SETTINGS, ...settings });
    const px = (mm: number) => Math.round((mm * 72) / 25.4);
    const half = px(trim.x + trim.w / 2);
    expect(at(0)).toMatchObject({ sheet: 0, box: { x: half } });
    expect(at(1)).toMatchObject({ sheet: 1, box: { x: px(trim.x) } });
    expect(at(2)).toMatchObject({ sheet: 1, box: { x: half } });
    // The cover sheet's left half is blank paper.
    const { data, info } = await sharp(result.files[0] ?? '')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const i = (Math.round(info.height / 2) * info.width + Math.round(half / 2)) * 3;
    expect([data[i], data[i + 1], data[i + 2]]).toEqual([255, 255, 255]);
  }, 120_000);

  it('centres a page of another shape on bands of its background colour', async () => {
    await allPages();
    // 4:5 pages on A5 (1:1.42): full width, centred vertically.
    await setPrint({ paper: 'a5', bleedMm: 0, marks: false, imposition: 'pages' });
    const result = await renderPrint({
      projectPath: project,
      outputId: PRINT,
      out: join(dir, 'centred'),
      png: true,
      dpi: 100,
      config,
      reporter: quiet().reporter,
    });
    const sheet = { w: Math.round((148 * 100) / 25.4), h: Math.round((210 * 100) / 25.4) };
    const page3 = result.placements.find((p) => p.page === 2)?.box;
    expect(page3?.x).toBe(0);
    expect(page3?.w).toBe(sheet.w);
    expect(Math.abs((page3?.y ?? 0) - (sheet.h - (page3?.h ?? 0)) / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs((page3?.h ?? 0) - sheet.w * 1.25)).toBeLessThanOrEqual(1);
    // Page 3 is #111111: the band above it is too.
    const { data, info } = await sharp(result.files[2] ?? '')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const i = (2 * info.width + Math.round(info.width / 2)) * 3;
    expect([data[i], data[i + 1], data[i + 2]]).toEqual([0x11, 0x11, 0x11]);
  }, 120_000);

  it('reuses print-size photos, misses after a develop change, and keeps three per photo', async () => {
    await setPrint({ paper: '8x10', bleedMm: 0, marks: false, imposition: 'pages' });
    const run = async () => {
      const { events, reporter } = quiet();
      await renderPrint({
        projectPath: project,
        outputId: PRINT,
        out: join(dir, 'p'),
        png: true,
        dpi: 72,
        config,
        reporter,
      });
      return imageDetails(events);
    };
    const first = await run();
    expect(first.some((d) => d.includes('cached'))).toBe(false);
    const second = await run();
    expect(second.every((d) => d.endsWith(' cached'))).toBe(true);

    // A new edit of photo 1: its render has a new develop hash, so its print file is new; the others stay cached.
    const doc = JSON.parse(await readFile(project, 'utf8'));
    const edit: DevelopSettingsInput = { version: 1, light: { exposure: -0.5 } };
    doc.assets[DEVELOPED].develop = edit;
    const hash = doc.assets[DEVELOPED].hash as string;
    const render = developRenderPath(dir, hash, await developHash(edit));
    await sharp({ create: { width: 600, height: 400, channels: 3, background: '#993366' } })
      .jpeg()
      .toFile(render);
    await writeFile(project, JSON.stringify(doc));
    const third = await run();
    const developedName = doc.assets[DEVELOPED].path as string;
    expect(third.find((d) => d.startsWith(developedName))?.endsWith(' cached')).toBe(false);
    expect(third.filter((d) => !d.startsWith(developedName)).every((d) => d.endsWith(' cached'))).toBe(true);

    // Older files of a photo beyond three are pruned; the one in use always stays.
    const printDir = join(dir, '.photobook-publish', 'print');
    const old = Date.now() / 1000 - 3600;
    for (let n = 0; n < 4; n++) {
      const name = join(printDir, `${hash}-old${n}-128.jpg`);
      await writeFile(name, 'x');
      await utimes(name, old - n, old - n);
    }
    const used = (await readdir(printDir)).filter((n) => n.startsWith(hash) && !n.includes('-old'));
    const removed = await prunePrintCache(project, [hash], new Set(used.slice(-1)));
    const left = (await readdir(printDir)).filter((n) => n.startsWith(`${hash}-`));
    expect(left).toHaveLength(3);
    expect(left).toContain(used.at(-1));
    expect(removed.length).toBe(used.length + 4 - 3);
  }, 180_000);

  it('rasterises photos with a CSS filter (B&W, Fade) at 300 dpi whatever the dpi setting', async () => {
    // Chromium's PDF backend (Skia) draws a filtered image as a bitmap at 300 dpi, losslessly (Flate) with a mask.
    const doc = JSON.parse(await readFile(project, 'utf8'));
    const slot = doc.pages[0].elements.find((e: { asset?: string }) => e.asset === DEVELOPED);
    slot.filter = 'bw';
    await writeFile(project, JSON.stringify(doc));
    await setPrint({ paper: '8x10', bleedMm: 0, marks: false, imposition: 'pages', dpi: 150 });
    const out = join(dir, 'bw.pdf');
    await renderPrint({ projectPath: project, outputId: PRINT, out, config, reporter: quiet().reporter });
    const widths = [...(await readFile(out)).toString('latin1').matchAll(/\/Subtype \/Image\s*\/Width (\d+)/g)].map(
      (m) => Number(m[1]),
    );
    // The slot is 0.84 of 8 in wide: 2016 px at 300 dpi (the source is only 600 px wide; at 150 dpi it would be 1008).
    const slotPx = Math.round(0.84 * 8 * 300);
    expect(widths.some((w) => Math.abs(w - slotPx) < 40)).toBe(true);
  }, 120_000);

  it('sweeps temp PDFs left by killed runs, never a live one', async () => {
    const out = join(dir, 'zine.pdf');
    await writeFile(printTempPath(out, 999_999_99), 'stale');
    await writeFile(printTempPath(out, process.pid), 'mine');
    expect(await sweepStaleTemps(out)).toEqual([`.zine.pdf.${999_999_99}.print.tmp.pdf`]);
    await stat(printTempPath(out, process.pid));
  });
});
