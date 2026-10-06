import type { CSSProperties } from 'react';
import type { TextElement } from '../schema.js';
import { num } from './util.js';

export type TextPresetName = TextElement['style'];

export interface TextPreset {
  /** Family name as declared in `fonts/fonts.css`. */
  family: string;
  /** Font size as a fraction of the page height. */
  size: number;
  weight: number;
  lineHeight: number;
  letterSpacing?: string;
  fontStyle?: 'normal' | 'italic';
}

export const TEXT_PRESETS: Record<TextPresetName, TextPreset> = {
  title: { family: 'Fraunces', size: 0.06, weight: 600, lineHeight: 1.1 },
  caption: { family: 'Instrument Serif', size: 0.028, weight: 400, lineHeight: 1.3 },
  date: { family: 'JetBrains Mono', size: 0.02, weight: 500, lineHeight: 1.2, letterSpacing: '0.04em' },
  body: { family: 'Inter', size: 0.024, weight: 400, lineHeight: 1.45 },
  quote: { family: 'Fraunces', size: 0.045, weight: 500, lineHeight: 1.25, fontStyle: 'italic' },
};

/** Font stacks for the self-hosted families (names match `fonts/fonts.css`). */
export const FONT_STACKS: Record<string, string> = {
  Inter: '"Inter", ui-sans-serif, system-ui, sans-serif',
  Fraunces: '"Fraunces", ui-serif, Georgia, serif',
  'JetBrains Mono': '"JetBrains Mono", ui-monospace, Menlo, monospace',
  'Instrument Serif': '"Instrument Serif", ui-serif, Georgia, serif',
};

export function fontStack(family: string): string {
  return FONT_STACKS[family] ?? `"${family.replace(/"/g, '')}", system-ui, sans-serif`;
}

export const DEFAULT_TEXT_COLOR = '#1a1a1a';

export interface TextStyleOptions {
  /** Page height / page width. */
  pageAspect: number;
  /** Page height in px for the font-size fallback where container units are unsupported. */
  pageHeightPx: number;
}

/**
 * Typography for a text element: preset, then element-level overrides. The font size scales with
 * the page through container units. The page is an `inline-size` container, which only answers
 * width queries, so a size that is a fraction of the page height is expressed in `cqw` times the
 * page's height/width ratio. `--pb-fs-px` is the fallback (see renderer.css).
 */
export function textStyle(el: TextElement, { pageAspect, pageHeightPx }: TextStyleOptions): CSSProperties {
  const preset = TEXT_PRESETS[el.style];
  const size = el.size ?? preset.size;
  return {
    fontFamily: fontStack(el.family ?? preset.family),
    fontWeight: el.weight ?? preset.weight,
    lineHeight: preset.lineHeight,
    letterSpacing: preset.letterSpacing,
    fontStyle: preset.fontStyle,
    color: el.color ?? DEFAULT_TEXT_COLOR,
    textAlign: el.align,
    '--pb-fs': `${num(size * pageAspect * 100)}cqw`,
    '--pb-fs-px': `${num(size * pageHeightPx, 2)}px`,
  } as CSSProperties;
}
