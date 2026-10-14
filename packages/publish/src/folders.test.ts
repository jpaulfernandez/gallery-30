import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Book,
  DevelopSchema,
  type DevelopSettingsInput,
  developHash,
  LIBRARY_FILE,
  type Library,
  loadBook,
  serializeBook,
  serializeLibrary,
} from '@photobook/shared';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublishConfig } from './config.js';
import { freeze, imageId, LibraryUnreadableError } from './freeze.js';
import { createReporter, type ReportEvent } from './log.js';
import { developRenderPath } from './paths.js';
import { publish } from './publish.js';
import { MemoryStore } from './store.js';

/**
 * Plan 03: the CLI resolves asset paths through `book.folders` and develop settings through each folder's library, so
 * a v7 project and the same project after the editor migrated it (v8, edits in `library.json`) publish identically.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'six');
const EDITED = '01FIXTUREASSET0000000000A1';
const OTHER = '01FIXTUREASSET0000000000A2';
const FOLDER = '01FIXTUREFOLDER0000000000F1';
const EDIT: DevelopSettingsInput = { version: 1, light: { exposure: 0.5 } };
const OTHER_EDIT: DevelopSettingsInput = { version: 1, color: { saturation: 30 } };

function config(): PublishConfig {
  return {
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
}

function reporter() {
  const events: ReportEvent[] = [];
  return { r: createReporter('json', (line) => events.push(JSON.parse(line) as ReportEvent)), events };
}

let dir: string;
let project: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pb-folders-'));
  await cp(FIXTURE, dir, { recursive: true, filter: (src) => !src.includes('.photobook-publish') });
  project = join(dir, 'book.photobook.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const readDoc = async () => JSON.parse(await readFile(project, 'utf8'));
const writeDoc = (doc: unknown) => writeFile(project, JSON.stringify(doc));

async function hashOf(id: string): Promise<string> {
  return (await readDoc()).assets[id].hash as string;
}

async function writeLibrary(root: string, photos: Library['photos']): Promise<void> {
  await mkdir(join(root, '.photobook'), { recursive: true });
  await writeFile(join(root, LIBRARY_FILE), serializeLibrary({ version: 1, photos }));
}

/** A render of `develop` for asset `id` under `root` (600 x 400, so it is distinguishable from the original). */
async function writeRender(root: string, id: string, develop: DevelopSettingsInput): Promise<string> {
  const path = developRenderPath(root, await hashOf(id), await developHash(develop));
  await mkdir(dirname(path), { recursive: true });
  await sharp({ create: { width: 600, height: 400, channels: 3, background: '#336699' } })
    .jpeg()
    .toFile(path);
  return path;
}

/** The project as a version 7 file: `sourceFolder`, no folder ids, outputs, captions or guides; `develop` on assets. */
async function writeV7(develop: Record<string, DevelopSettingsInput>): Promise<void> {
  const { folders: _f, outputs: _o, captions: _c, ...doc } = await readDoc();
  for (const [id, asset] of Object.entries(doc.assets as Record<string, Record<string, unknown>>)) {
    delete asset.folder;
    if (develop[id]) asset.develop = develop[id];
  }
  for (const page of doc.pages) delete page.guides;
  await writeDoc({ ...doc, version: 7, sourceFolder: dir });
}

/** What the editor does on open: migrate, lift `develop` into the library by hash, save the book without it. */
async function migrateLikeTheEditor(): Promise<void> {
  const book = loadBook(await readDoc());
  const photos: Library['photos'] = {};
  const assets: Book['assets'] = {};
  for (const [id, { develop, rating: _r, flag: _f, ...asset }] of Object.entries(book.assets)) {
    if (develop && asset.hash) photos[asset.hash] = { develop, versions: {} };
    assets[id] = asset;
  }
  await writeLibrary(dir, photos);
  await writeFile(project, serializeBook({ ...book, assets }));
}

async function dryRun() {
  const res = await publish({
    projectPath: project,
    config: config(),
    reporter: reporter().r,
    dryRun: true,
    store: new MemoryStore(),
  });
  const ids = Object.fromEntries([...res.frozen.assets].map(([id, a]) => [id, imageId(a)]));
  return { fingerprint: res.fingerprint, ids, frozen: res.frozen };
}

describe('folders and the library in the CLI', () => {
  it('publishes a v7 project and its editor-migrated v8 form with the same keys and fingerprint', async () => {
    await writeRender(dir, EDITED, EDIT);
    await writeRender(dir, OTHER, OTHER_EDIT);
    await writeV7({ [EDITED]: EDIT, [OTHER]: OTHER_EDIT });
    const before = await dryRun();
    expect(before.ids[EDITED]).toBe(`${await hashOf(EDITED)}-${await developHash(EDIT)}`);

    await migrateLikeTheEditor();
    const saved = await readDoc();
    expect(saved.version).toBe(8);
    expect(saved.folders).toEqual({ [Object.keys(saved.folders)[0] as string]: { path: dir } });
    for (const asset of Object.values(saved.assets) as Array<Record<string, unknown>>) {
      expect('develop' in asset).toBe(false);
    }
    const after = await dryRun();
    expect(after.ids).toEqual(before.ids);
    expect(after.fingerprint).toBe(before.fingerprint);
    // The resolved book carries the library's edit, as the manifest and fingerprint need.
    expect(after.frozen.book.assets[EDITED]?.develop).toEqual(DevelopSchema.parse(EDIT));
  });

  it('prefers the library over a legacy field, and a snapshot over both', async () => {
    const doc = await readDoc();
    doc.assets[EDITED].develop = OTHER_EDIT;
    await writeDoc(doc);
    await writeLibrary(dir, { [await hashOf(EDITED)]: { develop: DevelopSchema.parse(EDIT), versions: {} } });
    const frozen = await freeze(project, { allowMissingRenders: true });
    expect(frozen.assets.get(EDITED)?.developHash).toBe(await developHash(EDIT));

    doc.assets[EDITED].developSnapshot = { version: 1, light: { exposure: -1 } };
    await writeDoc(doc);
    const snap = await freeze(project, { allowMissingRenders: true });
    expect(snap.assets.get(EDITED)?.developHash).toBe(await developHash({ version: 1, light: { exposure: -1 } }));
  });

  it('uses a version the asset points at', async () => {
    const doc = await readDoc();
    doc.assets[EDITED].version = 'v1';
    await writeDoc(doc);
    await writeLibrary(dir, {
      [await hashOf(EDITED)]: {
        develop: DevelopSchema.parse(EDIT),
        versions: { v1: { name: 'B&W', develop: DevelopSchema.parse(OTHER_EDIT) } },
      },
    });
    const frozen = await freeze(project, { allowMissingRenders: true });
    expect(frozen.assets.get(EDITED)?.developHash).toBe(await developHash(OTHER_EDIT));
  });

  it('resolves a relative folder against the project file and an absent absolute one to its folder', async () => {
    const frozen = await freeze(project);
    expect(frozen.folders.get(FOLDER)).toBe(dir);
    expect(frozen.assets.get(EDITED)?.absPath).toBe(join(dir, 'DSCF2001.jpg'));
    const doc = await readDoc();
    doc.folders[FOLDER].path = '/no/such/folder';
    await writeDoc(doc);
    expect((await freeze(project)).folders.get(FOLDER)).toBe(dir);
  });

  it('reads each folder at its own path, with its own library and renders', async () => {
    const second = join(dir, 'second');
    await mkdir(second);
    await rename(join(dir, 'DSCF2002.jpg'), join(second, 'DSCF2002.jpg'));
    const doc = await readDoc();
    doc.folders.F2 = { path: 'second' };
    doc.assets[OTHER].folder = 'F2';
    await writeDoc(doc);
    await writeLibrary(second, { [await hashOf(OTHER)]: { develop: DevelopSchema.parse(OTHER_EDIT), versions: {} } });
    const render = await writeRender(second, OTHER, OTHER_EDIT);
    const frozen = await freeze(project);
    expect(frozen.folders.get('F2')).toBe(second);
    expect(frozen.assets.get(OTHER)).toMatchObject({
      folder: 'F2',
      root: second,
      absPath: render,
      sourcePath: join(second, 'DSCF2002.jpg'),
      developHash: await developHash(OTHER_EDIT),
    });
    // The first folder's library does not leak into the second.
    expect(frozen.assets.get(EDITED)?.developHash).toBeUndefined();
  });

  it('falls back to library.json.bak, and warns, when the library cannot be parsed', async () => {
    const hash = await hashOf(EDITED);
    await writeLibrary(dir, { [hash]: { develop: DevelopSchema.parse(EDIT), versions: {} } });
    await rename(join(dir, LIBRARY_FILE), join(dir, `${LIBRARY_FILE}.bak`));
    for (const bad of [
      '{ not json',
      JSON.stringify({ version: 1, photos: { [hash]: { rating: 9 } } }),
      '{"photos":{}}',
    ]) {
      await writeFile(join(dir, LIBRARY_FILE), bad);
      const frozen = await freeze(project, { allowMissingRenders: true });
      expect(frozen.assets.get(EDITED)?.developHash).toBe(await developHash(EDIT));
      expect(frozen.warnings).toEqual([expect.stringContaining('using library.json.bak')]);
    }
  });

  it('stops when the library cannot be used and there is no usable .bak, unless --ignore-library', async () => {
    await mkdir(join(dir, '.photobook'), { recursive: true });
    await writeFile(join(dir, LIBRARY_FILE), '{ not json');
    const err = await freeze(project, { allowMissingRenders: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LibraryUnreadableError);
    expect((err as Error).message).toMatch(/no library\.json\.bak[\s\S]*--ignore-library/);
    // A real (dry) run fails before anything else; the CLI prints the message.
    const store = new MemoryStore();
    await expect(
      publish({ projectPath: project, config: config(), reporter: reporter().r, dryRun: true, store }),
    ).rejects.toBeInstanceOf(LibraryUnreadableError);
    expect(store.ops).toEqual([]);

    // A .bak that does not parse either stops it too.
    await writeFile(join(dir, `${LIBRARY_FILE}.bak`), '[]');
    await expect(freeze(project, { allowMissingRenders: true })).rejects.toThrow(/not usable either/);

    const { r, events } = reporter();
    const res = await publish({
      projectPath: project,
      config: config(),
      reporter: r,
      dryRun: true,
      store: new MemoryStore(),
      ignoreLibrary: true,
    });
    expect(res.frozen.assets.get(EDITED)?.developHash).toBeUndefined();
    expect(events.find((e) => e.type === 'log' && e.level === 'warn')).toMatchObject({
      message: expect.stringContaining("publishing without the library's edits (--ignore-library)"),
    });
  });

  it('never falls back from a library written by a newer Photobook', async () => {
    const hash = await hashOf(EDITED);
    await writeLibrary(dir, { [hash]: { develop: DevelopSchema.parse(EDIT), versions: {} } });
    await rename(join(dir, LIBRARY_FILE), join(dir, `${LIBRARY_FILE}.bak`));
    await writeFile(join(dir, LIBRARY_FILE), JSON.stringify({ version: 2, photos: {} }));
    await expect(freeze(project, { allowMissingRenders: true })).rejects.toThrow(/version 2[\s\S]*update Photobook/);
    const ignored = await freeze(project, { allowMissingRenders: true, ignoreLibrary: true });
    expect(ignored.assets.get(EDITED)?.developHash).toBeUndefined();
  });

  it('warns when a v8 project has hashed photos but its folder has no library.json', async () => {
    const frozen = await freeze(project);
    expect(frozen.warnings).toEqual([expect.stringMatching(/library\.json does not exist: 6 photo\(s\)/)]);
    // A v7 file keeps its own edits: no warning.
    await writeV7({});
    expect((await freeze(project)).warnings).toEqual([]);
  });
});
