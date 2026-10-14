import { describe, expect, it } from 'vitest';
import { fixtureBook } from './fixtures/fixturePage.js';
import {
  type Book,
  BookLoadError,
  CURRENT_VERSION,
  DEVELOP_DEFAULTS,
  DevelopSchema,
  type DevelopSettings,
  developHash,
  loadBook,
  migrate,
  parseBook,
  serializeBook,
} from './index.js';

type Json = Record<string, unknown>;

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** `book` as a version 7 file on disk: `sourceFolder` instead of `folders`, no asset `folder`, outputs, captions or guides. */
function v7Doc(book: Book = fixtureBook): Json {
  const { folders, outputs: _o, captions: _c, ...rest } = JSON.parse(serializeBook(book)) as Json & Book;
  const [folder] = Object.values(folders);
  return {
    ...rest,
    version: 7,
    sourceFolder: folder?.path,
    assets: Object.fromEntries(Object.entries(rest.assets).map(([id, { folder: _f, ...asset }]) => [id, asset])),
    pages: rest.pages.map(({ guides: _g, ...page }) => page),
  };
}

/** `doc` with its one folder id replaced by `id` (the migration draws a new ULID per run). */
function withFolderId(doc: Json, id: string): Json {
  const folders = doc.folders as Record<string, unknown>;
  const [from] = Object.keys(folders) as [string];
  const assets = Object.fromEntries(
    Object.entries(doc.assets as Record<string, Json>).map(([key, a]) => [
      key,
      a.folder === from ? { ...a, folder: id } : a,
    ]),
  );
  return { ...doc, folders: { [id]: folders[from] }, assets };
}

describe('migrate', () => {
  it('is at version 8', () => {
    expect(CURRENT_VERSION).toBe(8);
  });

  it('turns a version 7 file into version 8: one folder, every asset in it, empty outputs, captions and guides', () => {
    const v7 = v7Doc();
    const before = structuredClone(v7);
    const out = migrate(v7) as Json;
    // The input is not mutated.
    expect(v7).toEqual(before);
    expect(out.version).toBe(8);
    expect('sourceFolder' in out).toBe(false);
    const folders = out.folders as Record<string, { path: string }>;
    const ids = Object.keys(folders);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(ULID);
    expect(folders[ids[0] as string]).toEqual({ path: '/fixture' });
    const assets = out.assets as Record<string, Json>;
    // Asset ids are kept; each asset gains the folder and nothing else changes.
    expect(Object.keys(assets)).toEqual(Object.keys(v7.assets as Json));
    for (const [id, asset] of Object.entries(assets)) {
      expect(asset).toEqual({ ...(v7.assets as Record<string, Json>)[id], folder: ids[0] });
    }
    const pages = out.pages as Json[];
    expect(pages.map((p) => p.id)).toEqual((v7.pages as Json[]).map((p) => p.id));
    for (const [i, page] of pages.entries()) expect(page).toEqual({ ...(v7.pages as Json[])[i], guides: [] });
    expect(out.outputs).toEqual([]);
    expect(out.captions).toEqual({});
    // Everything else is the version 7 document.
    const { folders: _f, assets: _a, pages: _p, outputs: _o, captions: _c, ...rest } = out;
    const { sourceFolder: _s, assets: _a7, pages: _p7, ...rest7 } = v7;
    expect(rest).toEqual({ ...rest7, version: 8 });
  });

  it('loads a version 7 file as the current book', () => {
    const book = loadBook(v7Doc());
    const [folderId] = Object.keys(book.folders) as [string];
    expect(book).toEqual(withFolderId(JSON.parse(serializeBook(fixtureBook)), folderId));
    expect(book).toEqual(loadBook(withFolderId(JSON.parse(serializeBook(fixtureBook)), folderId)));
  });

  it('keeps the legacy rating, flag and develop of a version 7 asset (the editor lifts them into the library)', () => {
    const v7 = v7Doc();
    const [id] = Object.keys(v7.assets as Json) as [string];
    (v7.assets as Record<string, Json>)[id] = {
      ...(v7.assets as Record<string, Json>)[id],
      rating: 4,
      flag: 'pick',
      develop: { version: 1, light: { exposure: 0.5 } },
    };
    const asset = loadBook(v7).assets[id];
    expect(asset).toMatchObject({ rating: 4, flag: 'pick' });
    expect(asset?.develop?.light.exposure).toBe(0.5);
  });

  it('leaves the develop hash of a migrated asset unchanged', async () => {
    const v7 = v7Doc();
    const [id] = Object.keys(v7.assets as Json) as [string];
    const settings = { version: 1, light: { exposure: 0.5 }, geometry: { flipH: true }, color: { saturation: 20 } };
    (v7.assets as Record<string, Json>)[id] = { ...(v7.assets as Record<string, Json>)[id], develop: settings };
    const migrated = loadBook(v7).assets[id]?.develop;
    expect(migrated).toBeDefined();
    expect(await developHash(migrated as DevelopSettings)).toBe(await developHash(DevelopSchema.parse(settings)));
  });

  it('upgrades a version 1 file through the number-only steps to the same book as version 7', () => {
    const v1: Json = { ...v7Doc(), version: 1 };
    const out = migrate(v1) as Json;
    expect(out.version).toBe(8);
    expect(v1.version).toBe(1);
    const [id] = Object.keys(out.folders as Json) as [string];
    expect(out).toEqual(withFolderId(migrate(v7Doc()) as Json, id));
  });

  it('loads a minimal version 1 file without the later optional fields', () => {
    const v1: Json = { ...v7Doc(), version: 1 };
    delete v1.customLayouts;
    delete v1.theme;
    delete v1.outputProfile;
    const book = loadBook(v1);
    expect(book.customLayouts).toEqual([]);
    expect(book.theme.margin).toBe(0.08);
    expect(book.outputProfile).toBe('srgb');
  });

  it('parses a version 8 file unchanged and passes it through migrate as is', () => {
    const current = JSON.parse(serializeBook(fixtureBook));
    expect(migrate(current)).toBe(current);
    expect(parseBook(serializeBook(fixtureBook))).toEqual(fixtureBook);
  });

  it('rejects unknown versions', () => {
    const current = JSON.parse(serializeBook(fixtureBook));
    expect(() => migrate({ ...current, version: 9 })).toThrow(BookLoadError);
    expect(() => migrate({ ...current, version: 0 })).toThrow(/Unsupported .* version 0/);
    expect(() => migrate({ ...current, version: '1' })).toThrow(/Unsupported/);
    const { version: _v, ...noVersion } = current;
    expect(() => migrate(noVersion)).toThrow(/no "version"/);
  });

  it('gives a version 6 file an sRGB output profile', () => {
    const { outputProfile: _o, ...v6 }: Json = { ...v7Doc(), version: 6 };
    expect(loadBook(v6).outputProfile).toBe('srgb');
  });

  it('keeps a Display P3 output profile and rejects unknown ones', () => {
    const json = JSON.parse(serializeBook(fixtureBook));
    const book = loadBook({ ...json, outputProfile: 'display-p3' });
    expect(book.outputProfile).toBe('display-p3');
    expect(parseBook(serializeBook(book))).toEqual(book);
    expect(() => loadBook({ ...json, outputProfile: 'adobe-rgb' })).toThrow(BookLoadError);
  });

  it('parses a book without develop settings, leaving `develop` absent', () => {
    const book = loadBook(JSON.parse(serializeBook(fixtureBook)));
    for (const asset of Object.values(book.assets)) expect('develop' in asset).toBe(false);
  });

  it('parses a book with develop settings, filling their defaults', () => {
    const json = JSON.parse(serializeBook(fixtureBook));
    const [firstId] = Object.keys(json.assets) as [string];
    json.assets[firstId].develop = { version: 1, light: { exposure: 0.5 }, geometry: { flipH: true } };
    const book = loadBook(json);
    const develop = book.assets[firstId]?.develop;
    expect(develop?.light).toEqual({ ...DEVELOP_DEFAULTS.light, exposure: 0.5 });
    expect(develop?.geometry.flipH).toBe(true);
    expect(develop?.curve).toEqual(DEVELOP_DEFAULTS.curve);
    expect(develop?.masks).toEqual([]);
    // Round-trips through the file format unchanged.
    expect(parseBook(serializeBook(book))).toEqual(book);
  });

  it('rejects develop settings of an unknown develop version or out of range', () => {
    const json = JSON.parse(serializeBook(fixtureBook));
    const [firstId] = Object.keys(json.assets) as [string];
    json.assets[firstId].develop = { version: 2 };
    expect(() => loadBook(json)).toThrow(BookLoadError);
    json.assets[firstId].develop = { version: 1, light: { exposure: 9 } };
    expect(() => loadBook(json)).toThrow(BookLoadError);
  });
});
