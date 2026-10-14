import { describe, expect, it } from 'vitest';
import type { Brief } from '../schema.js';
import { emptyBrief } from './brief.js';
import { buildSystem, EDITORIAL_STYLE, VOICE_NOTES } from './style.js';

const brief: Brief = {
  about: 'A week in Lisbon with friends, June 2026',
  photographer: 'Jan Paul; first person plural, "we"',
  placeTime: 'Lisbon, June 3–9, 2026',
  people: ['Ana', 'Rui'],
  voice: 'editorial',
  avoid: 'the word "vibrant"',
  examples: ['The 28 tram climbs past the cathedral while we wait for the light.'],
  useExisting: true,
};

const index = [
  'Photo index (the photos of this book, in book order):',
  'Photo 1 (p. 1): A yellow tram on a steep street. People: 3. Setting: Alfama. Time: evening. Mood: warm.',
  'Photo 2 (p. 2): not described yet.',
].join('\n');

describe('buildSystem', () => {
  it('is the fixed style sheet, the brief and the index (snapshot)', () => {
    expect(buildSystem(brief, index, { existing: ['Ana reads the menu twice before ordering.'] })).toMatchSnapshot();
  });

  it('is byte-identical for the same inputs', () => {
    const a = buildSystem(brief, index, { existing: ['x y z w'] });
    const b = buildSystem(structuredClone(brief), `${index}`, { existing: ['x y z w'] });
    expect(a).toBe(b);
  });

  it('carries the Editorial rules', () => {
    const system = buildSystem({ ...emptyBrief(), about: 'Porto' }, '');
    expect(system).toContain(EDITORIAL_STYLE);
    expect(system).toContain('12 to 30 words');
    expect(system).toMatch(/No exclamation marks, no hashtags, no emoji, no superlatives/);
    expect(system).toContain('Name only the people listed in the brief');
    expect(system).toContain('- People: name no one');
    expect(system).not.toContain('Photo index');
  });

  it('adds the existing captions only when the brief says so, and the voice note', () => {
    const off = buildSystem({ ...brief, useExisting: false, voice: 'minimal' }, index, {
      existing: ['Only mine here.'],
    });
    expect(off).not.toContain('Only mine here.');
    expect(off).toContain(VOICE_NOTES.minimal);
    const on = buildSystem(brief, index, { existing: ['Only mine here.', brief.examples[0] as string] });
    expect(on).toContain('- Only mine here.');
    // An example given twice is listed once.
    expect(on.split(brief.examples[0] as string).length).toBe(2);
  });

  it('puts every brief field on one line', () => {
    const system = buildSystem({ ...brief, about: 'Lisbon\n\nwith   friends' }, '');
    expect(system).toContain('- About: Lisbon with friends');
  });
});
