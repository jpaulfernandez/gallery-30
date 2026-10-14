import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEVELOP_DEFAULTS,
  type DevelopSettingsInput,
  developHash,
  imagePrefix,
  manifestKey,
  type OutputProfile,
  parseManifest,
  RAW_EXTENSIONS,
} from '@photobook/shared';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublishConfig } from './config.js';
import { assetKind, freeze, imageId, MissingAssetsError, MissingRendersError, outName } from './freeze.js';
import { createReporter, type ReportEvent } from './log.js';
import { developRenderPath } from './paths.js';
import { publish } from './publish.js';
import { MemoryStore } from './store.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'six');
const BASE = 'https://cdn.example.test';
const DEVELOPED = '01FIXTUREASSET0000000000A1';
const PLAIN = '01FIXTUREASSET0000000000A2';

const EDIT: DevelopSettingsInput = { version: 1, light: { exposure: 0.5 } };
const EDIT_AGAIN: DevelopSettingsInput = { version: 1, light: { exposure: 0.8 } };

function config(): PublishConfig {
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
  };
}

function reporter() {
  const events: ReportEvent[] = [];
  const r = createReporter('json', (line) => events.push(JSON.parse(line) as ReportEvent));
  return { r, events };
}

describe('developed photos', () => {
  let dir: string;
  let project: string;

  /** Set (or clear) the develop settings of the first asset in the copied project file. */
  async function setDevelop(develop: DevelopSettingsInput | undefined): Promise<void> {
    const doc = JSON.parse(await readFile(project, 'utf8'));
    if (develop) doc.assets[DEVELOPED].develop = develop;
    else delete doc.assets[DEVELOPED].develop;
    await writeFile(project, JSON.stringify(doc));
  }

  /** Set the book's output colour in the copied project file. */
  async function setProfile(profile: OutputProfile): Promise<void> {
    const doc = JSON.parse(await readFile(project, 'utf8'));
    doc.outputProfile = profile;
    await writeFile(project, JSON.stringify(doc));
  }

  /** A render distinguishable from the original: 600 x 400 instead of 1200 x 800. */
  async function writeRender(develop: DevelopSettingsInput, profile?: OutputProfile): Promise<string> {
    const doc = JSON.parse(await readFile(project, 'utf8'));
    const path = developRenderPath(dir, doc.assets[DEVELOPED].hash, await developHash(develop), profile);
    await mkdir(dirname(path), { recursive: true });
    await sharp({ create: { width: 600, height: 400, channels: 3, background: '#336699' } })
      .jpeg()
      .toFile(path);
    return path;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pb-develop-'));
    await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes('.photobook-publish') });
    project = join(dir, 'book.photobook.json');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('leaves undeveloped assets alone', async () => {
    const frozen = await freeze(project);
    const a = frozen.assets.get(DEVELOPED);
    expect(a).toMatchObject({ kind: 'jpeg', relPath: 'DSCF2001.jpg' });
    expect(a?.absPath).toBe(join(dir, 'DSCF2001.jpg'));
    expect(a?.developHash).toBeUndefined();
    expect(a?.sourcePath).toBeUndefined();
    expect(a && imageId(a)).toBe(a?.hash);
    expect(a && outName(a)).toBe(a?.hash);
  });

  it('treats default develop settings as unedited', async () => {
    await setDevelop({ version: 1 });
    const a = (await freeze(project)).assets.get(DEVELOPED);
    expect(a?.developHash).toBeUndefined();
    expect(a?.absPath).toBe(join(dir, 'DSCF2001.jpg'));
  });

  it('points a developed asset at its render, keeping the content hash', async () => {
    await setDevelop(EDIT);
    const render = await writeRender(EDIT);
    const plain = (await freeze(project)).assets.get(PLAIN);
    const a = (await freeze(project)).assets.get(DEVELOPED);
    const dh = await developHash(EDIT);
    expect(a).toMatchObject({
      absPath: render,
      sourcePath: join(dir, 'DSCF2001.jpg'),
      developHash: dh,
      kind: 'jpeg',
      relPath: 'DSCF2001.jpg',
    });
    expect(a?.renderMissing).toBeUndefined();
    expect(render).toBe(join(dir, '.photobook-cache', 'develop', `${a?.hash}-${dh}.jpg`));
    expect(a && imageId(a)).toBe(`${a?.hash}-${dh}`);
    expect(plain?.developHash).toBeUndefined();
  });

  it('fails with MissingRendersError naming the photo when the render is missing', async () => {
    await setDevelop(EDIT);
    const err = await freeze(project).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingRendersError);
    expect(err).not.toBeInstanceOf(MissingAssetsError);
    expect((err as MissingRendersError).paths).toEqual(['DSCF2001.jpg']);
    expect((err as Error).message).toContain('DSCF2001.jpg');
    expect((err as Error).message).toContain('Open the book in the editor and let it render');
  });

  describe('output profile', () => {
    it('uses the -p3 render of a Display P3 book, with its own image id and cache folder', async () => {
      await setDevelop(EDIT);
      const srgb = await writeRender(EDIT);
      const p3 = await writeRender(EDIT, 'display-p3');
      const dh = await developHash(EDIT);
      const plain = (await freeze(project)).assets.get(DEVELOPED);
      expect(p3).toBe(join(dir, '.photobook-cache', 'develop', `${plain?.hash}-${dh}-p3.jpg`));
      expect(plain).toMatchObject({ absPath: srgb, outputProfile: 'srgb' });
      await setProfile('display-p3');
      const a = (await freeze(project)).assets.get(DEVELOPED);
      expect(a).toMatchObject({ absPath: p3, developHash: dh, outputProfile: 'display-p3', kind: 'jpeg' });
      expect(a?.renderMissing).toBeUndefined();
      expect(a && imageId(a)).toBe(`${a?.hash}-${dh}-p3`);
      expect(a && outName(a)).toBe(`${a?.hash}-${dh}-p3`);
      expect(a && imageId(a)).not.toBe(plain && imageId(plain));
    });

    it('an sRGB render does not satisfy a Display P3 book', async () => {
      await setDevelop(EDIT);
      await writeRender(EDIT); // sRGB name only
      await setProfile('display-p3');
      const err = await freeze(project).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MissingRendersError);
      expect((err as MissingRendersError).paths).toEqual(['DSCF2001.jpg']);
      expect((err as Error).message).toContain('Open the book in the editor and let it render');
      const provisional = (await freeze(project, { allowMissingRenders: true })).assets.get(DEVELOPED);
      expect(provisional).toMatchObject({ renderMissing: true, absPath: join(dir, 'DSCF2001.jpg') });
      expect(provisional && outName(provisional)).toBe(`${provisional?.hash}-${await developHash(EDIT)}-p3.unrendered`);
    });

    it('a -p3 render does not satisfy an sRGB book', async () => {
      await setDevelop(EDIT);
      await writeRender(EDIT, 'display-p3');
      await expect(freeze(project)).rejects.toBeInstanceOf(MissingRendersError);
    });

    it('a RAW in a Display P3 book needs the -p3 render of its default settings', async () => {
      await rename(join(dir, 'DSCF2001.jpg'), join(dir, 'DSCF2001.CR2'));
      const doc = JSON.parse(await readFile(project, 'utf8'));
      doc.assets[DEVELOPED].path = 'DSCF2001.CR2';
      doc.outputProfile = 'display-p3';
      await writeFile(project, JSON.stringify(doc));
      await writeRender({ version: 1 });
      await expect(freeze(project)).rejects.toBeInstanceOf(MissingRendersError);
      const p3 = await writeRender({ version: 1 }, 'display-p3');
      expect((await freeze(project)).assets.get(DEVELOPED)).toMatchObject({ absPath: p3, outputProfile: 'display-p3' });
    });
  });

  it('allowMissingRenders freezes the asset as provisional, with a separate cache folder', async () => {
    await setDevelop(EDIT);
    const a = (await freeze(project, { allowMissingRenders: true })).assets.get(DEVELOPED);
    expect(a).toMatchObject({ renderMissing: true, absPath: join(dir, 'DSCF2001.jpg') });
    expect(a && outName(a)).toBe(`${a && imageId(a)}.unrendered`);
  });

  it('a real publish fails before uploading anything when a render is missing', async () => {
    await setDevelop(EDIT);
    const store = new MemoryStore();
    await expect(
      publish({ projectPath: project, config: config(), reporter: reporter().r, store, skipPages: true }),
    ).rejects.toThrow(MissingRendersError);
    expect(store.ops).toEqual([]);
  });

  it('a dry run warns about the missing render and uploads nothing', async () => {
    await setDevelop(EDIT);
    const store = new MemoryStore();
    const { r, events } = reporter();
    const res = await publish({ projectPath: project, config: config(), reporter: r, store, dryRun: true });
    expect(store.objects.size).toBe(0);
    expect(res.frozen.assets.get(DEVELOPED)?.renderMissing).toBe(true);
    const warns = events.filter((e) => e.type === 'log' && e.level === 'warn');
    expect(warns).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('DSCF2001.jpg: developed, render missing') }),
    );
    expect(events.find((e) => e.type === 'step' && e.step === 'freeze' && e.status === 'done')).toMatchObject({
      detail: expect.stringContaining('1 developed (0 rendered)'),
    });
    expect(events.find((e) => e.type === 'step' && e.step === 'pages')).toMatchObject({ status: 'skipped' });
  });

  it('publishes the render under keys that include the develop hash, and prunes the old ones', async () => {
    const slug = 'fixture-six';
    const prefix = `${imagePrefix(slug, 'fx6pre')}/`;
    const store = new MemoryStore();
    const opts = { config: config(), store, skipPages: true, record: false };
    const doc = JSON.parse(await readFile(project, 'utf8'));
    const hash = doc.assets[DEVELOPED].hash as string;

    // Unedited first: plain hash keys.
    await publish({ projectPath: project, reporter: reporter().r, ...opts });
    expect([...store.objects.keys()].some((k) => k.startsWith(`${prefix}${hash}-w480`))).toBe(true);

    // Edited: new keys, the render's pixels (600 px wide, not 1200), same manifest entry for the asset id.
    await setDevelop(EDIT);
    await writeRender(EDIT);
    const dh1 = await developHash(EDIT);
    const first = reporter();
    const res = await publish({ projectPath: project, reporter: first.r, prune: true, ...opts });
    expect(res.pruned).toBe(8); // the old plain-hash ladder: download, share, 3 x (avif, webp)
    const keys = [...store.objects.keys()];
    expect(keys.some((k) => k.startsWith(`${prefix}${hash}-w480`))).toBe(false);
    expect(keys).toContain(`${prefix}${hash}-${dh1}-w480.avif`);
    const manifest = parseManifest(store.json(manifestKey(slug)));
    const record = manifest.images[DEVELOPED];
    expect(record).toMatchObject({ width: 600, height: 400 });
    expect(record?.avif.map((e) => e.w)).toEqual([480, 600]);
    expect(record?.avif[0]?.url).toBe(`${BASE}/${prefix}${hash}-${dh1}-w480.avif`);
    expect(record?.download.filename).toBe('DSCF2001.jpg');
    expect(first.events.find((e) => e.type === 'step' && e.step === 'freeze' && e.status === 'done')).toMatchObject({
      detail: expect.stringContaining('1 developed (1 rendered)'),
    });

    // Re-edited: the new render gets new keys and the previous develop hash's objects are pruned.
    await setDevelop(EDIT_AGAIN);
    await writeRender(EDIT_AGAIN);
    const dh2 = await developHash(EDIT_AGAIN);
    expect(dh2).not.toBe(dh1);
    const again = await publish({ projectPath: project, reporter: reporter().r, prune: true, ...opts });
    expect(again.pruned).toBe(6); // 600 px: download, share, 2 x (avif, webp)
    const after = [...store.objects.keys()];
    expect(after.some((k) => k.includes(dh1))).toBe(false);
    expect(after).toContain(`${prefix}${hash}-${dh2}-w480.avif`);
    expect(parseManifest(store.json(manifestKey(slug))).images[DEVELOPED]?.avif[0]?.url).toContain(dh2);

    // Nothing changed: no new uploads, the cached ladder is reused.
    const third = reporter();
    const same = await publish({ projectPath: project, reporter: third.r, ...opts });
    expect(same.uploaded).toBe(0);
    expect(third.events.find((e) => e.type === 'step' && e.step === 'images' && e.status === 'done')).toMatchObject({
      detail: '0 processed, 6 cached',
    });
  });

  describe('camera RAW', () => {
    /** The first asset as a RAW file: same bytes (and hash) under a `.CR2` name. */
    async function makeRaw(): Promise<void> {
      await rename(join(dir, 'DSCF2001.jpg'), join(dir, 'DSCF2001.CR2'));
      const doc = JSON.parse(await readFile(project, 'utf8'));
      doc.assets[DEVELOPED].path = 'DSCF2001.CR2';
      await writeFile(project, JSON.stringify(doc));
    }

    it('uses the RAW extensions of the Rust decoder', async () => {
      const rust = await readFile(
        join(dirname(fileURLToPath(import.meta.url)), '../../../crates/develop/src/decode/mod.rs'),
        'utf8',
      );
      const list = /pub const RAW_EXTENSIONS: &\[&str\] =\s*&\[([^\]]*)\]/.exec(rust)?.[1];
      expect(list).toBeDefined();
      expect([...(list ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...RAW_EXTENSIONS]);
    });

    it('classifies RAW extensions', () => {
      expect(assetKind('a/IMG_1.CR2')).toBe('raw');
      expect(assetKind('x.dng')).toBe('raw');
      expect(assetKind('x.nef')).toBe('raw');
      expect(assetKind('x.JPG')).toBe('jpeg');
      expect(assetKind('x.heif')).toBe('heic');
    });

    it('always publishes a RAW through its render, keyed by the default settings when unedited', async () => {
      await makeRaw();
      const err = await freeze(project).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MissingRendersError);
      expect((err as MissingRendersError).paths).toEqual(['DSCF2001.CR2']);

      const dh = await developHash(DEVELOP_DEFAULTS);
      expect(await developHash({ version: 1 })).toBe(dh);
      const render = await writeRender({ version: 1 });
      const a = (await freeze(project)).assets.get(DEVELOPED);
      expect(a).toMatchObject({ absPath: render, developHash: dh, kind: 'jpeg', relPath: 'DSCF2001.CR2' });
      expect(a?.sourcePath).toBe(join(dir, 'DSCF2001.CR2'));
      // Default settings written into the file change nothing.
      await setDevelop({ version: 1 });
      expect((await freeze(project)).assets.get(DEVELOPED)).toMatchObject({ absPath: render, developHash: dh });
    });

    it('an edited RAW uses the hash of its settings; a dry run keeps it provisional', async () => {
      await makeRaw();
      await setDevelop(EDIT);
      const provisional = (await freeze(project, { allowMissingRenders: true })).assets.get(DEVELOPED);
      expect(provisional).toMatchObject({ renderMissing: true, kind: 'raw', developHash: await developHash(EDIT) });
      const render = await writeRender(EDIT);
      expect((await freeze(project)).assets.get(DEVELOPED)).toMatchObject({ absPath: render, kind: 'jpeg' });
    });
  });
});
