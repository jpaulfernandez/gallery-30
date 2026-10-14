import { describe, expect, it } from 'vitest';
import {
  BorderSchema,
  BUILT_IN_EXPORT_PRESETS,
  builtInExportPresets,
  defaultExportDir,
  EXPORT_ENGINE_VERSION,
  ExportOptionsSchema,
  exportCacheName,
  exportExtension,
  type FileNameContext,
  fileName,
  formatsFor,
  parseExportPreset,
  presetHash,
  presetHashInput,
  safeSegment,
  sameExportSettings,
  stemOf,
  uniqueFileNames,
  uniquePresetName,
  WatermarkSchema,
  watermarkProblem,
} from './export.js';

const ctx = (over: Partial<FileNameContext> = {}): FileNameContext => ({
  name: 'DSCF1001',
  seq: 7,
  total: 12,
  date: new Date(2026, 9, 3, 14, 5).getTime(),
  rating: 4,
  format: 'jpeg',
  ...over,
});

describe('export presets', () => {
  it('has the built-ins of the plans', () => {
    expect(BUILT_IN_EXPORT_PRESETS.map((p) => [p.id, p.name, p.builtIn])).toEqual([
      ['social', 'Social', true],
      ['web', 'Web', true],
      ['full-quality', 'Full quality', true],
      ['original-sidecar', 'Original + sidecar', true],
      ['custom', 'Custom', true],
    ]);
    const [social, web, full] = BUILT_IN_EXPORT_PRESETS;
    expect(social?.options).toMatchObject({ format: 'jpeg', quality: 88, longEdge: 2048, colour: 'srgb' });
    expect(social?.options.metadata).toBe('copyright');
    expect(web?.options).toMatchObject({ quality: 85, longEdge: 1600, metadata: 'none', colour: 'srgb' });
    expect(full?.options).toMatchObject({ quality: 95, longEdge: null, metadata: 'all', sharpen: 'off' });
    for (const p of BUILT_IN_EXPORT_PRESETS) expect(p.destination).toBeNull();
  });

  it('round-trips a saved preset through JSON (what the file holds)', () => {
    const preset = parseExportPreset({
      id: '01K7A00000000000000000000A',
      name: '  Client proofs ',
      options: { format: 'webp', quality: 80, longEdge: 3000, sharpen: 'standard' },
      naming: '{date}-{seq}',
      destination: '/Users/me/Proofs',
      skipExported: false,
    });
    expect(preset).not.toBeNull();
    const back = parseExportPreset(JSON.parse(JSON.stringify(preset)));
    expect(back).toEqual(preset);
    expect(back?.name).toBe('Client proofs');
    expect(back?.options).toEqual({
      format: 'webp',
      quality: 80,
      longEdge: 3000,
      colour: 'srgb',
      metadata: 'all',
      sharpen: 'standard',
    });
  });

  it('rejects presets that do not validate', () => {
    expect(parseExportPreset({ id: 'x', name: '' })).toBeNull();
    expect(parseExportPreset({ id: 'x', name: 'a', options: { format: 'gif' } })).toBeNull();
    expect(parseExportPreset({ id: 'x', name: 'a', options: { quality: 0 } })).toBeNull();
    expect(parseExportPreset({ id: 'x', name: 'a', options: { longEdge: 10 } })).toBeNull();
    // Defaults fill a minimal file.
    expect(parseExportPreset({ id: 'x', name: 'a' })?.options).toEqual(ExportOptionsSchema.parse({}));
  });

  it('hashes only the encode options, with the engine version', async () => {
    const [social, web] = BUILT_IN_EXPORT_PRESETS;
    if (!social || !web) throw new Error('built-ins');
    const h = await presetHash(social.options);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(await presetHash({ ...social.options })).toBe(h);
    // Defaults spelled out or left out hash the same.
    expect(await presetHash({ quality: 90 })).toBe(await presetHash({ format: 'jpeg', quality: 90, colour: 'srgb' }));
    expect(await presetHash(web.options)).not.toBe(h);
    expect(await presetHash({ ...social.options, quality: 87 })).not.toBe(h);
    expect(presetHashInput(social.options).endsWith(`\n${EXPORT_ENGINE_VERSION}`)).toBe(true);
    // A pinned value: changing it means every cache entry moves (bump EXPORT_ENGINE_VERSION on purpose).
    expect(presetHashInput({})).toBe(
      `{"colour":"srgb","format":"jpeg","longEdge":null,"metadata":"all","quality":90,"sharpen":"off"}\n${EXPORT_ENGINE_VERSION}`,
    );
    // Pinned in Rust too (`preset_hash_matches_the_editor` in crates/develop/src/export.rs).
    expect(await presetHash({})).toBe('f41a1742bb388ad2');
    expect(
      await presetHash({ format: 'webp', quality: 80, longEdge: 2048, colour: 'display-p3', sharpen: 'standard' }),
    ).toBe('3e88c31eda227aa2');
  });

  it('leaves out what the format ignores', async () => {
    // PNG is lossless; PNG and WebP carry no Exif.
    expect(await presetHash({ format: 'png', quality: 10 })).toBe(await presetHash({ format: 'png', quality: 90 }));
    expect(await presetHash({ format: 'webp', metadata: 'none' })).toBe(await presetHash({ format: 'webp' }));
    expect(await presetHash({ format: 'webp', quality: 10 })).not.toBe(await presetHash({ format: 'webp' }));
    expect(await presetHash({ metadata: 'none' })).not.toBe(await presetHash({}));
  });

  it('makes preset names unique', () => {
    expect(uniquePresetName(' Social ', ['Web'])).toBe('Social');
    expect(uniquePresetName('social', ['Social', 'social 2'])).toBe('social 3');
  });

  it('compares settings without name or id', () => {
    const [social] = BUILT_IN_EXPORT_PRESETS;
    if (!social) throw new Error('built-ins');
    expect(sameExportSettings(social, { ...social, id: 'other', name: 'Other', builtIn: false })).toBe(true);
    expect(sameExportSettings(social, { ...social, naming: '{seq}' })).toBe(false);
    expect(sameExportSettings(social, { ...social, options: { ...social.options, quality: 70 } })).toBe(false);
  });

  it('hashes the plan 12 options like Rust and keeps plan 11 hashes without them', async () => {
    // Absent watermark and border: the plan 11 value above.
    expect(await presetHash({ watermark: undefined, border: undefined })).toBe('f41a1742bb388ad2');
    expect(await presetHash({ format: 'tiff', quality: 10 })).toBe(await presetHash({ format: 'tiff', quality: 90 }));
    expect(await presetHash({ format: 'avif', metadata: 'none' })).toBe(await presetHash({ format: 'avif' }));
    expect(await presetHash({ format: 'heic', metadata: 'none' })).not.toBe(await presetHash({ format: 'heic' }));
    expect(await presetHash({ format: 'original', longEdge: 800 })).toBe(await presetHash({ format: 'original' }));
    expect(await presetHash({ watermark: { text: '© Jan' } })).not.toBe(await presetHash({}));
    expect(await presetHash({ border: {} })).not.toBe(await presetHash({}));
    // Pinned in Rust too (`new_formats_and_options_keep_the_plan_11_hashes_and_hash_what_matters`).
    expect(
      await presetHash({
        format: 'tiff',
        quality: 90,
        longEdge: 3000,
        colour: 'display-p3',
        metadata: 'copyright',
        sharpen: 'off',
        watermark: {
          kind: 'text',
          text: '© Jan',
          font: 'fraunces',
          colour: '#FFFFFF',
          size: 0.04,
          opacity: 0.5,
          position: 'bottom-left',
          margin: 0.02,
        },
        border: { width: 2.5, unit: 'percent', colour: '#000000' },
      }),
    ).toBe('9c77f4b4907ad2c8');
    const image = (imageName: string, text: string) =>
      presetHash({ watermark: { kind: 'image', image: 'ab'.repeat(32), imageName, text } });
    expect(await image('a.png', 'x')).toBe(await image('b.png', 'y'));
    expect(await presetHash({ format: 'original' })).toBe('21d61ae3a1acf283');
  });

  it('says when a watermark is incomplete', () => {
    expect(watermarkProblem(undefined)).toBeNull();
    expect(watermarkProblem(WatermarkSchema.parse({ text: '© Jan' }))).toBeNull();
    expect(watermarkProblem(WatermarkSchema.parse({ text: '  ' }))).toMatch(/text/);
    expect(watermarkProblem(WatermarkSchema.parse({ kind: 'image' }))).toMatch(/image/);
  });

  it('validates watermark and border', () => {
    expect(WatermarkSchema.parse({}).position).toBe('bottom-right');
    expect(WatermarkSchema.safeParse({ colour: 'white' }).success).toBe(false);
    expect(WatermarkSchema.safeParse({ image: 'not-a-hash' }).success).toBe(false);
    expect(WatermarkSchema.safeParse({ size: 0.9 }).success).toBe(false);
    expect(BorderSchema.safeParse({ width: 30, unit: 'percent' }).success).toBe(false);
    expect(BorderSchema.safeParse({ width: 30, unit: 'px' }).success).toBe(true);
    expect(BorderSchema.parse({ colour: '#ABCDEF' }).colour).toBe('#abcdef');
  });

  it('offers HEIC only where it can be written, and Full quality becomes HEIC there', () => {
    expect(formatsFor({ heic: false })).not.toContain('heic');
    expect(formatsFor({ heic: true })).toContain('heic');
    expect(builtInExportPresets({ heic: false })).toBe(BUILT_IN_EXPORT_PRESETS);
    const full = builtInExportPresets({ heic: true }).find((p) => p.id === 'full-quality');
    expect(full?.options).toMatchObject({ format: 'heic', colour: 'display-p3', longEdge: null, metadata: 'all' });
    expect(full?.builtIn).toBe(true);
  });

  it('keeps Original stems unique so two sources never share a sidecar', () => {
    expect(uniqueFileNames(['IMG_1.nef', 'IMG_1.jpg'])).toEqual(['IMG_1.nef', 'IMG_1.jpg']);
    expect(uniqueFileNames(['IMG_1.nef', 'IMG_1.jpg', 'img_1.HEIC'], { byStem: true })).toEqual([
      'IMG_1.nef',
      'IMG_1 2.jpg',
      'img_1 3.HEIC',
    ]);
  });

  it('keeps the source extension for Original', () => {
    expect(exportExtension('original', 'trip/DSCF1001.RAF')).toBe('raf');
    expect(exportExtension('tiff', 'trip/DSCF1001.RAF')).toBe('tif');
    expect(fileName('{name}', ctx({ format: 'original', sourceExt: 'HEIC' }))).toBe('DSCF1001.heic');
    expect(fileName('{name}', ctx({ format: 'avif' }))).toBe('DSCF1001.avif');
  });

  it('names cache entries by photo and develop hash', () => {
    expect(exportCacheName('aa', 'bb', 'jpeg')).toBe('aa-bb.jpg');
    expect(exportCacheName('aa', 'bb', 'webp')).toBe('aa-bb.webp');
    expect(exportCacheName('aa', 'bb', 'png')).toBe('aa-bb.png');
  });
});

describe('file naming tokens', () => {
  it('fills {name}, {seq}, {date} and {rating}', () => {
    expect(fileName('{name}', ctx())).toBe('DSCF1001.jpg');
    expect(fileName('{seq}', ctx())).toBe('007.jpg');
    expect(fileName('{date}', ctx())).toBe('2026-10-03.jpg');
    expect(fileName('{rating}', ctx())).toBe('4.jpg');
    expect(fileName('Lisbon {date} {seq} ({rating}★) {name}', ctx({ format: 'webp' }))).toBe(
      'Lisbon 2026-10-03 007 (4★) DSCF1001.webp',
    );
  });

  it('pads {seq} to the size of the export, at least three digits', () => {
    expect(fileName('{seq}', ctx({ seq: 1, total: 9 }))).toBe('001.jpg');
    expect(fileName('{seq}', ctx({ seq: 42, total: 1200 }))).toBe('0042.jpg');
  });

  it('is case-insensitive and keeps other braces', () => {
    expect(fileName('{NAME}-{Seq}', ctx())).toBe('DSCF1001-007.jpg');
    expect(fileName('{name}{x}', ctx())).toBe('DSCF1001{x}.jpg');
  });

  it('makes the result a safe file name', () => {
    expect(fileName('a/b\\c:d*e?f"g<h>i|j', ctx({ format: 'png' }))).toBe('a_b_c_d_e_f_g_h_i_j.png');
    expect(fileName('..{name}', ctx())).toBe('DSCF1001.jpg');
    expect(fileName('', ctx())).toBe('DSCF1001.jpg');
    expect(fileName('  ', ctx({ name: '' }))).toBe('photo.jpg');
    expect(fileName('{date}', ctx({ date: null }))).toBe('undated.jpg');
    expect(safeSegment('x'.repeat(400)).length).toBeLessThanOrEqual(180);
  });

  it('makes names unique within an export, ignoring case', () => {
    expect(uniqueFileNames(['a.jpg', 'b.jpg', 'A.jpg', 'a.jpg', 'a 2.jpg'])).toEqual([
      'a.jpg',
      'b.jpg',
      'A 2.jpg',
      'a 3.jpg',
      'a 2 2.jpg',
    ]);
  });

  it('takes the stem of a source path and builds the default destination', () => {
    expect(stemOf('trip/day 1/DSCF1001.RAF')).toBe('DSCF1001');
    expect(stemOf('.hidden')).toBe('.hidden');
    expect(defaultExportDir('/Users/me/Lisbon/', 'Social')).toBe('/Users/me/Lisbon/Exports/Social');
    expect(defaultExportDir('C:\\Photos\\Lisbon', 'Full quality')).toBe('C:\\Photos\\Lisbon\\Exports\\Full quality');
    expect(defaultExportDir('/p', 'a/b')).toBe('/p/Exports/a_b');
  });
});
