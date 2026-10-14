import { describe, expect, it } from 'vitest';
import { fixtureBook } from './fixtures/fixturePage.js';
import { developRenderName, OUTPUT_PROFILES, outputProfileSuffix, publishFingerprint } from './index.js';

describe('output profile', () => {
  it('names renders with the profile suffix the Rust side uses', () => {
    const a = 'a1'.repeat(32);
    const d = 'b2'.repeat(32);
    expect(OUTPUT_PROFILES).toEqual(['srgb', 'display-p3']);
    expect(outputProfileSuffix()).toBe('');
    expect(outputProfileSuffix('display-p3')).toBe('-p3');
    expect(developRenderName(a, d)).toBe(`${a}-${d}.jpg`);
    expect(developRenderName(a, d, 'srgb')).toBe(`${a}-${d}.jpg`);
    expect(developRenderName(a, d, 'display-p3')).toBe(`${a}-${d}-p3.jpg`);
  });

  it('changes the publish fingerprint only for Display P3', async () => {
    const base = await publishFingerprint(fixtureBook);
    expect(await publishFingerprint({ ...fixtureBook, outputProfile: 'srgb' })).toBe(base);
    expect(await publishFingerprint({ ...fixtureBook, outputProfile: 'display-p3' })).not.toBe(base);
  });
});
