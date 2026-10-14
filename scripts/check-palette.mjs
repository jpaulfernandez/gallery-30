#!/usr/bin/env node
// Plan 44: the editor draws colour only through the tokens of `apps/editor/src/styles.css` (ODDHALLS_UI_PLAN 2.2).
// Runs in `pnpm lint`. Fails on any Tailwind palette class in `apps/editor/src` (`text-red-400`, `bg-zinc-800`,
// `text-white`, `bg-black/60`, `shadow-black/40`, with any variant or opacity modifier) and on an arbitrary colour
// class (`bg-[#141414]`, `border-[rgb(…)]`, `text-[oklch(…)]`).
//
// Plan 45: buttons come from `components/ui` (ODDHALLS_UI_PLAN 4.1). Outside `components/ui` it also fails on a
// `<button>` (or a popover trigger) whose own `className` draws the old outlined button: `rounded-md border
// border-line` or `border-line bg-panel-2`. A Biome rule cannot see class names, so the TypeScript parser finds the
// elements.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(repo, 'apps/editor/src');

const PALETTE = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'mauve',
  'olive',
  'mist',
  'taupe',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'white',
  'black',
].join('|');
const UTILITY =
  'bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|shadow|inset-shadow|drop-shadow|fill|stroke|from|via|to|divide|placeholder|caret|accent|decoration';
const PALETTE_CLASS = new RegExp(
  `(?<![\\w-])(?:[\\w-]+:)*-?(?:${UTILITY})-(?:${PALETTE})(?:-(?:50|[1-9]00|950))?(?:/[\\w.%\\[\\]]+)?(?![\\w-])`,
  'g',
);
const ARBITRARY_COLOUR =
  /(?<![\w-])(?:[\w-]+:)*-?[a-z-]+-\[(?:#|rgba?\(|oklch\(|oklab\(|hsla?\(|color\()[^\]]*\](?:\/[\w.%]+)?/g;

const ts = createRequire(join(repo, 'package.json'))('typescript');
const OLD_BUTTON = /rounded-md border border-line|border-line bg-panel-2/;
/** Elements that render a button with the `className` they are given. */
const BUTTONS = new Set(['button', 'PopoverButton', 'Popover']);
const UI_DIR = join(src, 'components', 'ui') + sep;

/** The initializer of every `const` in `file`, by name (`const button = '…'`, `const tab = (on) => …`). */
function constTexts(file) {
  const texts = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const && node.declarations.length > 0) {
      for (const d of node.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) texts.set(d.name.text, d.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return texts;
}

/** `expr`'s text plus the initializer of every same-file `const` it names (two levels deep). */
function resolvedText(expr, consts) {
  const parts = [expr.getText()];
  const seen = new Set();
  let frontier = [expr];
  for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
    const names = [];
    const collect = (node) => {
      if (ts.isIdentifier(node)) names.push(node.text);
      ts.forEachChild(node, collect);
    };
    for (const node of frontier) collect(node);
    frontier = [];
    for (const name of names) {
      if (seen.has(name) || !consts.has(name)) continue;
      seen.add(name);
      const init = consts.get(name);
      parts.push(init.getText());
      frontier.push(init);
    }
  }
  return parts.join('\n');
}

/**
 * Every button in `text` whose `className` draws the old outlined button: `[line, class text]`. The class text is
 * the attribute's own, plus any same-file `const` it uses (`className={button}`, `` `${tabClass(on)} …` ``).
 */
function oldButtons(path, text) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const consts = constTexts(file);
  const hits = [];
  const visit = (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && BUTTONS.has(node.tagName.getText())) {
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText() !== 'className' || !attr.initializer) continue;
        const value = resolvedText(attr.initializer, consts);
        const m = value.match(OLD_BUTTON);
        if (m) hits.push([file.getLineAndCharacterOfPosition(node.getStart()).line + 1, m[0]]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const failures = [];
for (const path of sources(src)) {
  const rel = relative(repo, path);
  const text = readFileSync(path, 'utf8');
  for (const m of text.matchAll(PALETTE_CLASS)) {
    const line = text.slice(0, m.index).split('\n').length;
    failures.push(`${rel}:${line}: palette class \`${m[0]}\` (use a token from styles.css)`);
  }
  for (const m of text.matchAll(ARBITRARY_COLOUR)) {
    const line = text.slice(0, m.index).split('\n').length;
    failures.push(`${rel}:${line}: arbitrary colour \`${m[0]}\` (use a token from styles.css)`);
  }
  if (path.endsWith('.tsx') && !path.startsWith(UI_DIR)) {
    for (const [line, cls] of oldButtons(path, text)) {
      failures.push(`${rel}:${line}: button drawn with \`${cls}\` (use Button from components/ui)`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  console.error(`check-palette: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log('check-palette: ok');
