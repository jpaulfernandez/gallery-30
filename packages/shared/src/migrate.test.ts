import { describe, expect, it } from 'vitest';
import { fixtureBook } from './fixtures/fixturePage.js';
import { BookLoadError, CURRENT_VERSION, loadBook, migrate, parseBook, serializeBook } from './index.js';

/** The fixture book as a version 1 file on disk (what builds before the bump wrote). */
const v1Text = (): string => serializeBook({ ...fixtureBook, version: 1 as never });

describe('migrate', () => {
  it('is at version 3', () => {
    expect(CURRENT_VERSION).toBe(3);
  });

  it('upgrades a version 1 file to the current version without touching anything else', () => {
    const v1 = JSON.parse(v1Text());
    const out = migrate(v1) as Record<string, unknown>;
    expect(out.version).toBe(3);
    expect({ ...out, version: 1 }).toEqual(v1);
    // The input is not mutated.
    expect(v1.version).toBe(1);
  });

  it('loads a real version 1 file and parses it as the current book', () => {
    const book = parseBook(v1Text());
    expect(book.version).toBe(3);
    expect(book).toEqual({ ...fixtureBook, version: 3 });
  });

  it('loads a minimal version 1 file without the later optional fields', () => {
    const v1 = JSON.parse(v1Text());
    delete v1.customLayouts;
    delete v1.theme;
    const book = loadBook(v1);
    expect(book.customLayouts).toEqual([]);
    expect(book.theme.margin).toBe(0.08);
  });

  it('passes the current version through and rejects unknown ones', () => {
    const current = JSON.parse(serializeBook(fixtureBook));
    expect(migrate(current)).toBe(current);
    expect(() => migrate({ ...current, version: 4 })).toThrow(BookLoadError);
    expect(() => migrate({ ...current, version: 0 })).toThrow(/Unsupported .* version 0/);
    expect(() => migrate({ ...current, version: '1' })).toThrow(/Unsupported/);
    const { version: _v, ...noVersion } = current;
    expect(() => migrate(noVersion)).toThrow(/no "version"/);
  });
});
