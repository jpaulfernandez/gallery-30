import { type Theme, type ThemeInput, ThemeSchema } from './schema.js';

/**
 * Every theme token at its default (the layout guide's values for an 8 x 10 in page). Spacing
 * tokens are fractions of the page width; see `ThemeSchema`.
 */
export const THEME_DEFAULTS: Readonly<Theme> = Object.freeze(ThemeSchema.parse({}));

/**
 * A complete theme from a partial one (an older in-memory object, a test literal, or nothing):
 * missing or `undefined` fields take `THEME_DEFAULTS`. Does not validate ranges; use `ThemeSchema`
 * for untrusted input.
 */
export function resolveTheme(theme?: Partial<ThemeInput> | null): Theme {
  const out: Theme = { ...THEME_DEFAULTS, fonts: [...THEME_DEFAULTS.fonts] };
  if (!theme) return out;
  for (const [key, value] of Object.entries(theme)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
