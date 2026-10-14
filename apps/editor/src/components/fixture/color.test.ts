import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chromaOf, contrast, parseColor, toHex } from './color';
import { COLOR_TOKENS, CONTRAST_PAIRS, CONTRAST_TOLERANCE } from './KitchenSink';

/**
 * Plan 44's Check, on the stylesheet itself: every token exists, the stage has no hue, the hex fallbacks are the
 * OKLCH values converted, and the contrast pairs match ODDHALLS_UI_PLAN 2.2.
 */

const css = readFileSync(fileURLToPath(new URL('../../styles.css', import.meta.url)), 'utf8');

function block(start: string): Record<string, string> {
  const from = css.indexOf(start);
  const body = css.slice(css.indexOf('{', from) + 1, css.indexOf('}', from));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', m[2] ?? '']));
}

const theme = block('@theme');
const oklch = block('@supports (color: oklch(0 0 0))');

const color = (token: string) => {
  const parsed = parseColor(oklch[`color-${token}`] ?? '');
  if (!parsed) throw new Error(`no OKLCH value for ${token}`);
  return parsed;
};

describe('tokens v2', () => {
  it('defines every colour token, radius, shadow and duration', () => {
    for (const t of COLOR_TOKENS) expect(theme[`color-${t}`], t).toBeDefined();
    for (const r of ['xs', 'sm', 'md', 'lg', 'pill']) expect(theme[`radius-${r}`], r).toBeDefined();
    for (const s of [
      'shadow-raised',
      'shadow-float',
      'highlight-top',
      'ease-out',
      'dur-fast',
      'dur-base',
      'dur-slow',
    ]) {
      expect(theme[s], s).toBeDefined();
    }
    expect(css).toMatch(/@utility section-title/);
    expect(css).toMatch(/@utility tag/);
    expect(css).toMatch(/@utility scrollbar/);
  });

  it('keeps the stage fixed and the surround on it by default', () => {
    expect(theme['color-surround']).toBe('var(--color-stage)');
    expect(oklch['color-surround']).toBeUndefined();
  });

  it('gives the stage and the mid surround zero chroma', () => {
    expect(chromaOf(color('stage'))).toBeLessThan(1e-6);
    expect(chromaOf(color('stage-mid'))).toBeLessThan(1e-6);
    expect(chromaOf(parseColor(theme['color-stage'] ?? '') ?? color('fg'))).toBeLessThan(1e-3);
  });

  it('keeps each hex fallback equal to its OKLCH value', () => {
    for (const [name, value] of Object.entries(oklch)) {
      const hex = theme[name];
      if (!hex?.startsWith('#')) continue;
      expect(toHex(parseColor(value) ?? color('fg')), name).toBe(hex);
    }
  });

  it('matches the contrast table', () => {
    for (const p of CONTRAST_PAIRS) {
      const ratio = contrast(color(p.fg), color(p.bg));
      expect(Math.abs(ratio - p.table), `${p.fg} on ${p.bg}: ${ratio.toFixed(2)}`).toBeLessThanOrEqual(
        CONTRAST_TOLERANCE,
      );
    }
  });

  it('sets every duration to zero under reduced motion', () => {
    const reduced = block('@media (prefers-reduced-motion: reduce)');
    // Plan 47 adds the cell stagger, a duration too; plan 49 the check's stroke and the job's hold.
    expect(reduced).toEqual({
      'dur-fast': '0ms',
      'dur-base': '0ms',
      'dur-slow': '0ms',
      'dur-check': '0ms',
      'dur-hold': '0ms',
      stagger: '0ms',
    });
  });
});

describe('parseColor', () => {
  it('reads the formats a browser computes', () => {
    expect(toHex(parseColor('rgb(15, 15, 15)') ?? color('fg'))).toBe('#0f0f0f');
    expect(parseColor('rgba(255, 255, 255, 0.12)')?.a).toBeCloseTo(0.12);
    expect(toHex(parseColor('color(srgb 1 0 0)') ?? color('fg'))).toBe('#ff0000');
    expect(parseColor('oklch(1 0 0 / 0.07)')?.a).toBeCloseTo(0.07);
    expect(parseColor('nonsense')).toBeNull();
  });
});
