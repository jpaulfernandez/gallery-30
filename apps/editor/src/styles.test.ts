import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Plan 43: `user-select: none` on everything, with an opt-in for text fields. These checks read the sources: the
 * base layer must keep the opt-in, and every text-entry component must render an element the opt-in matches (an
 * `<input>`, a `<textarea>`, a `contentEditable` element or `.selectable`), so no field loses its selection.
 */

const src = fileURLToPath(new URL('.', import.meta.url));
const css = readFileSync(join(src, 'styles.css'), 'utf8');

/** The selector list of the rule that sets `user-select: text`, as written in the base layer. */
function optInSelectors(): string[] {
  const match = /([^{}]+)\{\s*-webkit-user-select:\s*text;\s*user-select:\s*text;\s*\}/.exec(css);
  return (match?.[1] ?? '').split(',').map((s) => s.trim());
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

describe('selection in the chrome', () => {
  it('is off everywhere, with the text-field opt-in', () => {
    expect(css).toMatch(/\*\s*\{\s*-webkit-user-select:\s*none;\s*user-select:\s*none;/);
    expect(optInSelectors()).toEqual(
      expect.arrayContaining(['input', 'textarea', '[contenteditable]', '[contenteditable] *', '.selectable']),
    );
    // Anything selectable shows its highlight, including the `select-text` utility's elements.
    for (const selector of ['input', 'textarea', '[contenteditable]', '.selectable', '.select-text']) {
      expect(css).toContain(`${selector}::selection`);
    }
    expect(css).toMatch(/overscroll-behavior:\s*none/);
    expect(css).toMatch(/-webkit-user-drag:\s*none/);
  });

  it('stays on in every Input and TextEditor component', () => {
    const fields = sources(src).filter((path) => /(Input|TextEditor)[^/]*\.tsx$/.test(path));
    // TextEditor exists today; components/ui/Input (plan 45) and its kin join this list as they land.
    expect(fields.some((path) => path.endsWith('TextEditor.tsx'))).toBe(true);
    for (const path of fields) {
      const code = readFileSync(path, 'utf8');
      const matches = /<input\b|<textarea\b|contentEditable|\bselectable\b/.test(code);
      expect(matches, `${path} renders no element the selection opt-in matches`).toBe(true);
    }
  });
});
