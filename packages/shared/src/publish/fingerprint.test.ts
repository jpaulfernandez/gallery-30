import { describe, expect, it } from 'vitest';
import { createDevelop } from '../develop/schema.js';
import { fixtureBook } from '../fixtures/fixturePage.js';
import { DEFAULT_PRINT_SETTINGS } from '../print/print.js';
import { type Book, BriefSchema } from '../schema.js';
import { ALT_MAX, normalizeAlt } from './alt.js';
import { publishableContent, publishFingerprint } from './fingerprint.js';

/** The fixture book with a content hash on every asset, as after a folder scan. */
const hashedBook = (): Book =>
  structuredClone({
    ...fixtureBook,
    assets: Object.fromEntries(Object.entries(fixtureBook.assets).map(([id, a]) => [id, { ...a, hash: `sha-${id}` }])),
  });

/** A photo some page uses. */
function usedAssetId(book: Book): string {
  for (const page of book.pages) {
    for (const el of page.elements) if (el.type === 'photo' && el.asset) return el.asset;
  }
  throw new Error('fixture has no photo');
}

describe('publishFingerprint with develop settings', () => {
  it('keeps the fingerprint a book had before the Develop module when no asset has develop settings', async () => {
    // Computed with the pre-develop `publishableContent` (assets map of id -> hash).
    expect(await publishFingerprint(fixtureBook)).toBe(
      '416077d7d4d1c62fe00ef222f53457f58d2a7c67926004725ccde970fc96d4fb',
    );
    expect(await publishFingerprint(hashedBook())).toBe(
      'cc11623f8b26110d661c6753213311755b456a59fd9e595a11cf74d3e29081bb',
    );
  });

  it('keeps the fingerprint when develop settings are present but all at their defaults', async () => {
    const book = hashedBook();
    const id = usedAssetId(book);
    const before = await publishFingerprint(book);
    (book.assets[id] as Book['assets'][string]).develop = createDevelop();
    expect(await publishFingerprint(book)).toBe(before);
  });

  it('changes when a used photo is edited, and again when the edit changes', async () => {
    const book = hashedBook();
    const id = usedAssetId(book);
    const before = await publishFingerprint(book);
    const develop = createDevelop();
    develop.light.exposure = 0.5;
    (book.assets[id] as Book['assets'][string]).develop = develop;
    const edited = await publishFingerprint(book);
    expect(edited).not.toBe(before);
    expect((publishableContent(book) as { assets: Record<string, unknown> }).assets[id]).toEqual({
      hash: `sha-${id}`,
      develop,
    });
    develop.light.exposure = 0.6;
    expect(await publishFingerprint(book)).not.toBe(edited);
  });

  it('ignores develop settings on photos no page uses', async () => {
    const book = hashedBook();
    const before = await publishFingerprint(book);
    const develop = createDevelop();
    develop.color.saturation = 40;
    book.assets.unused = { path: 'unused.jpg', folder: 'fixture-folder', hash: 'sha-unused', develop };
    expect(await publishFingerprint(book)).toBe(before);
  });

  it('ignores page guides, folders, outputs and captions (none of them is published)', async () => {
    const book = hashedBook();
    const before = await publishFingerprint(book);
    const next: Book = {
      ...book,
      folders: { other: { path: '/elsewhere' } },
      pages: book.pages.map((p) => ({ ...p, guides: [{ axis: 'y', value: 0.25 }] })),
      outputs: [{ id: 'o', name: 'Print', createdAt: 1, kind: 'print', ...DEFAULT_PRINT_SETTINGS }],
      captions: { brief: BriefSchema.parse({ about: 'x' }) },
    };
    expect(await publishFingerprint(next)).toBe(before);
  });

  it('hashes a develop snapshot ahead of the asset field', async () => {
    const book = hashedBook();
    const id = usedAssetId(book);
    const develop = createDevelop();
    develop.light.exposure = 0.5;
    (book.assets[id] as Book['assets'][string]).develop = develop;
    const edited = await publishFingerprint(book);
    const snapshot = createDevelop();
    snapshot.light.exposure = -0.5;
    (book.assets[id] as Book['assets'][string]).developSnapshot = snapshot;
    expect((publishableContent(book) as { assets: Record<string, unknown> }).assets[id]).toEqual({
      hash: `sha-${id}`,
      develop: snapshot,
    });
    expect(await publishFingerprint(book)).not.toBe(edited);
  });
});

describe('publishFingerprint with alt text (plan 35)', () => {
  it('keeps the fingerprint without alt text or with a blank one, and changes with alt text on a used photo', async () => {
    const book = hashedBook();
    const id = usedAssetId(book);
    const before = await publishFingerprint(book);
    (book.assets[id] as Book['assets'][string]).alt = '  ';
    expect(await publishFingerprint(book)).toBe(before);
    (book.assets[id] as Book['assets'][string]).alt = 'Two people at a tram stop at dusk.';
    const withAlt = await publishFingerprint(book);
    expect(withAlt).not.toBe(before);
    expect((publishableContent(book) as { assets: Record<string, unknown> }).assets[id]).toEqual({
      hash: `sha-${id}`,
      alt: 'Two people at a tram stop at dusk.',
    });
    (book.assets[id] as Book['assets'][string]).alt = 'A tram stop at dusk.';
    expect(await publishFingerprint(book)).not.toBe(withAlt);
  });

  it('keeps develop and alt together, and ignores alt text on photos no page uses', async () => {
    const book = hashedBook();
    const id = usedAssetId(book);
    const develop = createDevelop();
    develop.light.exposure = 0.5;
    (book.assets[id] as Book['assets'][string]).develop = develop;
    (book.assets[id] as Book['assets'][string]).alt = 'A street.';
    expect((publishableContent(book) as { assets: Record<string, unknown> }).assets[id]).toEqual({
      hash: `sha-${id}`,
      develop,
      alt: 'A street.',
    });
    const before = await publishFingerprint(book);
    book.assets.unused = { path: 'unused.jpg', folder: 'fixture-folder', hash: 'sha-unused', alt: 'Unused.' };
    expect(await publishFingerprint(book)).toBe(before);
  });
});

describe('alt text normalisation (plan 35)', () => {
  it('fingerprints alt text as normalizeAlt has it, so spacing alone changes nothing', async () => {
    const book = hashedBook();
    const id = usedAssetId(book);
    (book.assets[id] as Book['assets'][string]).alt = 'A tram  at\ndusk.';
    const spaced = await publishFingerprint(book);
    expect((publishableContent(book) as { assets: Record<string, { alt?: string }> }).assets[id]?.alt).toBe(
      normalizeAlt('A tram  at\ndusk.'),
    );
    (book.assets[id] as Book['assets'][string]).alt = 'A tram at dusk.';
    expect(await publishFingerprint(book)).toBe(spaced);
  });

  it('normalizes to one line of at most ALT_MAX characters, cut at a word', () => {
    expect(normalizeAlt('  A   tram\n at dusk. ')).toBe('A tram at dusk.');
    expect(normalizeAlt(undefined)).toBe('');
    const long = normalizeAlt(`A street, ${'with houses and trams '.repeat(10)}`);
    expect(long.length).toBeLessThanOrEqual(ALT_MAX);
    expect(long.endsWith(' ')).toBe(false);
  });
});
