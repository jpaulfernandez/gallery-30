import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Plan 49: the tooltip sweep (ODDHALLS_UI_PLAN 4.1, 6). Every icon-only button names itself in a `Tooltip` (with its
 * shortcut where it has one): an `IconButton` always does; a `Button` with an `icon` and no label, or a `<button>`
 * whose content is only icons, must sit inside a `<Tooltip>` in the same file. A switch (`role="switch"`) is not an
 * icon button: its label is beside it. The TypeScript parser finds the elements, as `scripts/check-palette.mjs` does.
 *
 * Limits: a button with only a `title` and no `aria-label` is not seen; an icon passed as an expression (`{icon}`,
 * `{children}`) does not count as an icon, so such a button passes; a `<Tooltip>` around a whole toolbar counts for
 * every button in it; a local wrapper component that renders a `<button>` is checked where it is written, not at its
 * call sites, and components from outside `src` are not scanned.
 */

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ts = createRequire(join(src, '..', '..', '..', 'package.json'))('typescript') as typeof import('typescript');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.tsx') && !name.includes('.test.') ? [path] : [];
  });
}

type Tsx = import('typescript').Node;

function attributes(open: import('typescript').JsxOpeningLikeElement): Map<string, import('typescript').JsxAttribute> {
  const map = new Map<string, import('typescript').JsxAttribute>();
  for (const attr of open.attributes.properties) if (ts.isJsxAttribute(attr)) map.set(attr.name.getText(), attr);
  return map;
}

/** An icon: an `svg`, a component named `…Icon`, or anything marked `aria-hidden`. */
function isIcon(child: Tsx): boolean {
  const open = ts.isJsxElement(child) ? child.openingElement : ts.isJsxSelfClosingElement(child) ? child : null;
  if (!open) return false;
  const tag = open.tagName.getText();
  return tag === 'svg' || tag.endsWith('Icon') || attributes(open).has('aria-hidden');
}

/** `file:line tag` for each icon-only button outside a `Tooltip`. */
function untipped(path: string, text = readFileSync(path, 'utf8')): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: Tsx, inTooltip: boolean) => {
    let tipped = inTooltip;
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'Tooltip') tipped = true;
    const open = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (open && !tipped) {
      const tag = open.tagName.getText();
      const attrs = attributes(open);
      const children = ts.isJsxElement(node)
        ? node.children.filter((c) => !(ts.isJsxText(c) && c.text.trim() === ''))
        : [];
      const iconOnly =
        (tag === 'Button' && attrs.has('icon') && children.length === 0) ||
        (tag === 'button' &&
          attrs.has('aria-label') &&
          attrs.get('role')?.initializer?.getText() !== '"switch"' &&
          children.every(isIcon));
      if (iconOnly) {
        const line = file.getLineAndCharacterOfPosition(open.getStart()).line + 1;
        hits.push(`${relative(src, path)}:${line} <${tag}>`);
      }
    }
    ts.forEachChild(node, (child) => visit(child, tipped));
  };
  visit(file, false);
  return hits;
}

describe('icon buttons', () => {
  it('every icon-only button has a Tooltip (IconButton, or a Button / <button> inside <Tooltip>)', () => {
    const files = sources(src);
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap((path) => untipped(path))).toEqual([]);
  });

  it('finds an icon-only button without one (positive control)', () => {
    const sample = [
      'const a = <Button icon={<PlusIcon />} aria-label="Add" />;',
      'const b = <button type="button" aria-label="Close"><svg /></button>;',
      'const c = <Tooltip label="Close"><button type="button" aria-label="Close"><svg /></button></Tooltip>;',
      'const d = <button type="button" role="switch" aria-label="On" />;',
      'const e = <button type="button" aria-label="Page 1"><Page /></button>;',
    ].join('\n');
    expect(untipped(join(src, 'sample.tsx'), sample)).toEqual(['sample.tsx:1 <Button>', 'sample.tsx:2 <button>']);
  });
});
