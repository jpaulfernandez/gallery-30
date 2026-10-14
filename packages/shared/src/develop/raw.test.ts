import { describe, expect, it } from 'vitest';
import { isRawPath, renderedDevelop } from './raw.js';
import { createDevelop, DEVELOP_DEFAULTS, DevelopSchema } from './schema.js';

describe('RAW assets', () => {
  it('recognises RAW extensions case-insensitively', () => {
    expect(isRawPath('a/B.CR2')).toBe(true);
    expect(isRawPath('x.dng')).toBe(true);
    expect(isRawPath('trip/IMG_0001.ARW')).toBe(true);
    expect(isRawPath('x.jpg')).toBe(false);
    expect(isRawPath('x.heic')).toBe(false);
    expect(isRawPath('cr2')).toBe(false);
    expect(isRawPath('folder.cr2/photo.png')).toBe(false);
  });

  it('renders RAW always (defaults when unedited) and other photos only when edited', () => {
    const edited = DevelopSchema.parse({ version: 1, light: { exposure: 1 } });
    expect(renderedDevelop({ path: 'a.CR2' })).toBe(DEVELOP_DEFAULTS);
    expect(renderedDevelop({ path: 'a.CR2', develop: edited })).toBe(edited);
    const defaults = createDevelop();
    expect(renderedDevelop({ path: 'a.nef', develop: defaults })).toBe(defaults);
    expect(renderedDevelop({ path: 'a.jpg' })).toBeUndefined();
    expect(renderedDevelop({ path: 'a.jpg', develop: defaults })).toBeUndefined();
    expect(renderedDevelop({ path: 'a.jpg', develop: edited })).toBe(edited);
  });
});
