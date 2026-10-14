import { createDevelop, DEVELOP_DEFAULTS, DevelopSchema } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import {
  clipOf,
  DEVELOP_CLIP_TYPE,
  decode,
  decodeClip,
  encode,
  MAX_CLIP_CHARS,
  MAX_CLIP_MASKS,
  MAX_CLIP_POINTS,
  previousOf,
} from './clipboard';
import { newBrushComponent, newMask, newRadial } from './masks';
import { COPY_SECTIONS, DEFAULT_COPY_SECTIONS } from './sync';

const source = DevelopSchema.parse({
  ...createDevelop(),
  light: { exposure: 1, highlights: -40 },
  whiteBalance: { mode: 'incremental', temperature: 10, tint: -2 },
  curve: { parametric: { shadows: 20 } },
  color: { saturation: -15 },
  detail: { clarity: 30, denoise: { model: 'scunet' } },
  geometry: {
    rotate: 180,
    flipH: true,
    upright: { mode: 'level' },
    transform: { vertical: 12 },
    crop: { rect: { x: 0.1, y: 0.1, w: 0.6, h: 0.5 }, angle: -2 },
  },
  masks: [newMask('Spot', newRadial([0.4, 0.5], [0.2, 0.2]), 'm1')],
});

describe('develop clipboard payload', () => {
  it('round-trips through the clipboard text', () => {
    for (const sections of [DEFAULT_COPY_SECTIONS, COPY_SECTIONS, ['masks'] as const, ['crop', 'basic'] as const]) {
      const text = encode(source, sections);
      expect(JSON.parse(text).type).toBe(DEVELOP_CLIP_TYPE);
      expect(decode(text)).toEqual(clipOf(source, sections));
    }
  });

  it('holds only the sections it lists, the rest at the defaults; rotation and flips never', () => {
    const basic = clipOf(source, ['basic']);
    expect(basic.sections).toEqual(['basic']);
    expect(basic.settings.light).toEqual(source.light);
    expect(basic.settings.whiteBalance).toEqual(source.whiteBalance);
    expect(basic.settings.curve).toEqual(DEVELOP_DEFAULTS.curve);
    expect(basic.settings.detail).toEqual(DEVELOP_DEFAULTS.detail);
    expect(basic.settings.masks).toEqual([]);

    const detail = clipOf(source, ['detail']);
    expect(detail.settings.detail.clarity).toBe(30);
    expect(detail.settings.detail.denoise).toBeNull();
    expect(clipOf(source, ['denoise']).settings.detail).toEqual({
      ...DEVELOP_DEFAULTS.detail,
      denoise: source.detail.denoise,
    });

    const geometry = clipOf(source, ['crop', 'transform']).settings.geometry;
    expect(geometry.crop).toEqual(source.geometry.crop);
    expect(geometry.upright.mode).toBe('level');
    expect(geometry.transform.vertical).toBe(12);
    expect(geometry.rotate).toBe(0);
    expect(geometry.flipH).toBe(false);
    expect(clipOf(source, ['crop']).settings.geometry.upright).toEqual(DEVELOP_DEFAULTS.geometry.upright);

    expect(clipOf(source, ['masks']).settings.masks).toEqual(source.masks);
    // Sections come out in the dialog's order, without repeats.
    expect(clipOf(source, ['masks', 'basic', 'masks']).sections).toEqual(['basic', 'masks']);
  });

  it('is a deep copy', () => {
    const own = structuredClone(source);
    const clip = clipOf(own, COPY_SECTIONS);
    own.curve.luma[0] = [0, 0.5];
    own.masks[0]?.components.pop();
    expect(clip.settings.curve.luma[0]).toEqual([0, 0]);
    expect(clip.settings.masks[0]?.components).toHaveLength(1);
  });

  it('ignores text that is not a payload', () => {
    const good = JSON.parse(encode(source, ['basic']));
    for (const text of [
      '',
      'hello',
      '/Users/me/photo.jpg',
      '{',
      '[1, 2]',
      '{"a": 1}',
      JSON.stringify({ ...good, type: 'text/plain' }),
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify({ ...good, sections: [] }),
      JSON.stringify({ ...good, sections: ['looks'] }),
      JSON.stringify({ ...good, settings: { version: 99 } }),
      JSON.stringify({ ...good, settings: { ...good.settings, light: { exposure: 'bright' } } }),
    ]) {
      expect(decode(text), text.slice(0, 40)).toBeNull();
    }
  });

  it('keeps the sections it knows from a payload that lists more, and tolerates surrounding whitespace', () => {
    const payload = JSON.parse(encode(source, ['basic', 'color']));
    const clip = decode(`\n  ${JSON.stringify({ ...payload, sections: ['color', 'looks', 'basic'] })}  \n`);
    expect(clip?.sections).toEqual(['basic', 'color']);
    expect(clip?.settings.color.saturation).toBe(-15);
  });
});

describe('decodeClip', () => {
  const good = () => JSON.parse(encode(source, ['basic', 'masks']));

  it('tells text marked as ours that this build cannot read from other text', () => {
    expect(decodeClip(encode(source, ['basic'])).kind).toBe('clip');
    expect(decodeClip('hello')).toEqual({ kind: 'foreign' });
    expect(decodeClip('{"a": 1}')).toEqual({ kind: 'foreign' });
    expect(decodeClip(JSON.stringify({ ...good(), version: 2 }))).toEqual({ kind: 'unreadable', reason: 'version' });
    expect(decodeClip(JSON.stringify({ ...good(), settings: { version: 99 } }))).toEqual({
      kind: 'unreadable',
      reason: 'invalid',
    });
  });

  it('refuses payloads past the size bounds before validating them', () => {
    const masks = Array.from({ length: MAX_CLIP_MASKS + 1 }, (_, i) =>
      newMask(`m${i}`, newRadial([0.5, 0.5], [0.1, 0.1])),
    );
    expect(decodeClip(JSON.stringify({ ...good(), settings: { ...good().settings, masks } }))).toEqual({
      kind: 'unreadable',
      reason: 'size',
    });
    const points = Array.from({ length: MAX_CLIP_POINTS + 1 }, (): [number, number] => [0.5, 0.5]);
    const brush = newMask('Brush', newBrushComponent([{ points, size: 10, feather: 50, flow: 100, erase: false }]));
    const heavy = JSON.stringify({ ...good(), settings: { ...good().settings, masks: [brush] } });
    expect(heavy.length).toBeLessThan(MAX_CLIP_CHARS);
    expect(decodeClip(heavy)).toEqual({ kind: 'unreadable', reason: 'size' });
    const long = JSON.stringify({ ...good(), pad: 'x'.repeat(MAX_CLIP_CHARS) });
    expect(decodeClip(long)).toEqual({ kind: 'unreadable', reason: 'size' });
    expect(decodeClip(`{"pad": "${'x'.repeat(MAX_CLIP_CHARS)}"}`)).toEqual({ kind: 'foreign' });
  });
});

describe('previousOf', () => {
  it('is the photo before the current one in the list as shown', () => {
    expect(previousOf(['a', 'b', 'c'], 'c')).toBe('b');
    expect(previousOf(['c', 'b', 'a'], 'c')).toBeNull();
    expect(previousOf(['a', 'b'], 'a')).toBeNull();
    expect(previousOf(['a', 'b'], 'z')).toBeNull();
  });
});
