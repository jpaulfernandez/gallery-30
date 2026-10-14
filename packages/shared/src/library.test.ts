import { describe, expect, it } from 'vitest';
import {
  createDevelop,
  createEmptyBook,
  emptyLibrary,
  LIBRARY_FILE,
  type Library,
  LibraryLoadError,
  LibrarySchema,
  libraryBackupAllowed,
  parseLibrary,
  resolveAssetDevelop,
  resolveDevelop,
  serializeLibrary,
  withResolvedDevelop,
} from './index.js';

const HASH = 'a'.repeat(64);

function edited(exposure: number) {
  const develop = createDevelop();
  develop.light.exposure = exposure;
  return develop;
}

describe('library file', () => {
  it('lives in the hidden .photobook folder', () => {
    expect(LIBRARY_FILE).toBe('.photobook/library.json');
  });

  it('starts empty and valid', () => {
    const library = emptyLibrary();
    expect(library).toEqual({ version: 1, photos: {} });
    expect(LibrarySchema.safeParse(library).success).toBe(true);
    // Fresh objects: mutating one never leaks into the next.
    library.photos[HASH] = { versions: {} };
    expect(emptyLibrary().photos).toEqual({});
  });

  it('parses entries and fills the defaults (versions)', () => {
    const library = parseLibrary(
      JSON.stringify({
        version: 1,
        photos: {
          [HASH]: { rating: 4, flag: 'pick', develop: { version: 1, light: { exposure: 1.5 } } },
          b: { flag: 'reject' },
        },
      }),
    );
    expect(library.photos[HASH]?.rating).toBe(4);
    expect(library.photos[HASH]?.flag).toBe('pick');
    expect(library.photos[HASH]?.develop?.light.exposure).toBe(1.5);
    // Parsed through DevelopSchema: the whole default tree is there.
    expect(library.photos[HASH]?.develop?.geometry.crop).toBeNull();
    expect(library.photos[HASH]?.versions).toEqual({});
    expect(library.photos.b).toEqual({ flag: 'reject', versions: {} });
  });

  it('round-trips through serializeLibrary', () => {
    const library: Library = {
      version: 1,
      photos: {
        [HASH]: { rating: 2, develop: edited(0.5), versions: { v1: { name: 'B&W', develop: edited(-1) } } },
        b: { flag: 'pick', versions: {} },
      },
    };
    const text = serializeLibrary(library);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseLibrary(text)).toEqual(library);
    expect(serializeLibrary(parseLibrary(text))).toBe(text);
  });

  it('rejects an unknown version, bad JSON and bad entries', () => {
    expect(() => parseLibrary(JSON.stringify({ version: 2, photos: {} }))).toThrow(LibraryLoadError);
    expect(() => parseLibrary(JSON.stringify({ version: 2, photos: {} }))).toThrow(/version 2 is not supported/);
    expect(() => parseLibrary(JSON.stringify({ photos: {} }))).toThrow(/no "version"/);
    expect(() => parseLibrary('{"version":1,')).toThrow(/not valid JSON/);
    expect(() => parseLibrary('[]')).toThrow(LibraryLoadError);
    expect(() => parseLibrary(JSON.stringify({ version: 1, photos: { [HASH]: { rating: 9 } } }))).toThrow(
      /Invalid library.json/,
    );
    expect(() => parseLibrary(JSON.stringify({ version: 1, photos: { [HASH]: { flag: 'maybe' } } }))).toThrow(
      LibraryLoadError,
    );
    const kindOf = (text: string) => {
      try {
        parseLibrary(text);
      } catch (err) {
        return err instanceof LibraryLoadError ? [err.kind, err.photo] : ['other'];
      }
      return ['ok'];
    };
    expect(kindOf('{')).toEqual(['json', undefined]);
    expect(kindOf(JSON.stringify({ version: 3, photos: {} }))).toEqual(['version', undefined]);
    // The first bad entry is named, so the editor can log which photo failed.
    expect(kindOf(JSON.stringify({ version: 1, photos: { ok: {}, [HASH]: { rating: 0 } } }))).toEqual(['schema', HASH]);
    expect(kindOf(JSON.stringify({ version: 1, photos: [] }))).toEqual(['schema', undefined]);
  });
});

describe('library cull state (plan 40)', () => {
  it('reads and round-trips a target (a number or a share) and culledAt, still version 1', () => {
    const library: Library = {
      version: 1,
      photos: { b: { flag: 'pick', versions: {} } },
      cull: { target: { share: 0.1 }, culledAt: '2026-10-13T10:00:00.000Z' },
    };
    const text = serializeLibrary(library);
    expect(JSON.parse(text).version).toBe(1);
    expect(parseLibrary(text)).toEqual(library);
    expect(parseLibrary(JSON.stringify({ version: 1, photos: {}, cull: { target: 60 } })).cull).toEqual({ target: 60 });
    // A library without the field (every one written before plan 40) parses as before.
    expect(parseLibrary(JSON.stringify({ version: 1, photos: {} })).cull).toBeUndefined();
  });

  it('drops a malformed field alone, never the library', () => {
    const library = parseLibrary(
      JSON.stringify({ version: 1, photos: { b: { flag: 'reject' } }, cull: { target: -3, culledAt: '2026-10-13' } }),
    );
    expect(library.cull).toEqual({ culledAt: '2026-10-13' });
    expect(library.photos.b?.flag).toBe('reject');
    expect(parseLibrary(JSON.stringify({ version: 1, photos: {}, cull: { target: { share: 2 } } })).cull).toEqual({});
    // A malformed `cull` as a whole (null, a string) is dropped too: the photos are kept, no fall back to the backup.
    const nulled = parseLibrary(JSON.stringify({ version: 1, photos: { b: { flag: 'pick' } }, cull: null }));
    expect(nulled.cull).toBeUndefined();
    expect(nulled.photos.b?.flag).toBe('pick');
    expect(parseLibrary(JSON.stringify({ version: 1, photos: {}, cull: 'done' })).cull).toBeUndefined();
  });
});

describe('resolveDevelop', () => {
  const photo = { develop: edited(1), versions: { v1: { name: 'Warm', develop: edited(2) } } };

  it('returns the master edit, a version, or undefined', () => {
    expect(resolveDevelop(photo)?.light.exposure).toBe(1);
    expect(resolveDevelop(photo, 'v1')?.light.exposure).toBe(2);
    // A version that is gone falls back to the master.
    expect(resolveDevelop(photo, 'gone')?.light.exposure).toBe(1);
    expect(resolveDevelop({ versions: {} })).toBeUndefined();
    expect(resolveDevelop(undefined, 'v1')).toBeUndefined();
  });
});

describe('resolveAssetDevelop', () => {
  const library: Library = {
    version: 1,
    photos: {
      [HASH]: { develop: edited(1), versions: { v1: { name: 'Warm', develop: edited(2) } } },
      rated: { rating: 3, versions: {} },
    },
  };

  it('prefers the snapshot, then the library (version or master), then the legacy field', () => {
    const legacy = edited(-1);
    expect(
      resolveAssetDevelop({ hash: HASH, developSnapshot: edited(5), develop: legacy }, library)?.light.exposure,
    ).toBe(5);
    expect(resolveAssetDevelop({ hash: HASH, develop: legacy }, library)?.light.exposure).toBe(1);
    expect(resolveAssetDevelop({ hash: HASH, version: 'v1', develop: legacy }, library)?.light.exposure).toBe(2);
    expect(resolveAssetDevelop({ hash: HASH, version: 'gone' }, library)?.light.exposure).toBe(1);
    // No entry, no hash, no library, or an entry without an edit: the legacy field (a v7 book), else unedited.
    expect(resolveAssetDevelop({ hash: 'other', develop: legacy }, library)).toBe(legacy);
    expect(resolveAssetDevelop({ develop: legacy }, library)).toBe(legacy);
    expect(resolveAssetDevelop({ hash: HASH, develop: legacy })).toBe(legacy);
    expect(resolveAssetDevelop({ hash: 'rated', develop: legacy }, library)).toBe(legacy);
    expect(resolveAssetDevelop({ hash: 'rated' }, library)).toBeUndefined();
    expect(resolveAssetDevelop({ hash: HASH }, emptyLibrary())).toBeUndefined();
  });
});

describe('withResolvedDevelop', () => {
  it('puts the resolved settings on every asset and keeps unchanged objects', () => {
    const book = createEmptyBook({ title: 'T', folders: { f: { path: '/tmp/t' } } });
    const plain = { path: 'b.jpg', folder: 'f', hash: 'b' };
    book.assets = { a: { path: 'a.jpg', folder: 'f', hash: HASH, develop: edited(-1) }, b: plain };
    const library: Library = { version: 1, photos: { [HASH]: { develop: edited(1), versions: {} } } };
    const out = withResolvedDevelop(book, () => library);
    expect(out).not.toBe(book);
    expect(out.assets.a?.develop?.light.exposure).toBe(1);
    expect(out.assets.b).toBe(plain);
    expect(book.assets.a?.develop?.light.exposure).toBe(-1);
    expect(withResolvedDevelop(book, () => undefined)).toBe(book);
    const cleared = withResolvedDevelop(
      { ...book, assets: { a: { path: 'a.jpg', folder: 'f', hash: HASH, version: 'v' } } },
      () => library,
    );
    expect(cleared.assets.a?.develop?.light.exposure).toBe(1);
  });
});

describe('libraryBackupAllowed', () => {
  const errorOf = (text: string): unknown => {
    try {
      parseLibrary(text);
    } catch (err) {
      return err;
    }
    throw new Error('parsed');
  };

  it('allows the backup for every problem except a library from a newer Photobook', () => {
    expect(libraryBackupAllowed(errorOf('{'))).toBe(true);
    expect(libraryBackupAllowed(errorOf(JSON.stringify({ photos: {} })))).toBe(true);
    expect(libraryBackupAllowed(errorOf(JSON.stringify({ version: 0, photos: {} })))).toBe(true);
    expect(libraryBackupAllowed(errorOf(JSON.stringify({ version: 1, photos: { [HASH]: { rating: 9 } } })))).toBe(true);
    const newer = errorOf(JSON.stringify({ version: 2, photos: {} }));
    expect(newer).toMatchObject({ kind: 'version', newer: true });
    expect(libraryBackupAllowed(newer)).toBe(false);
  });
});
