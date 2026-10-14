import { BookLoadError } from './errors.js';
import { newId } from './ids.js';
import { CURRENT_VERSION } from './schema.js';

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 7 -> 8 (workflow plan 03): `sourceFolder` becomes the book's one folder entry (a new id, the same path) and every
 * asset names it; `outputs: []`, `captions: {}` and `guides: []` on every page. Asset and page ids, and every other
 * field (legacy `rating`, `flag`, `develop` included, which the editor lifts into the library), are kept as they are.
 * Does not mutate its input; the folder id is fresh per run (`newId()`), so two runs on one file differ only in it.
 */
function toV8(doc: Json): Json {
  const { sourceFolder, ...rest } = doc;
  const folderId = newId();
  const path = typeof sourceFolder === 'string' && sourceFolder.length > 0 ? sourceFolder : '.';
  const assets = isJson(doc.assets)
    ? Object.fromEntries(
        Object.entries(doc.assets).map(([id, asset]) => [id, isJson(asset) ? { ...asset, folder: folderId } : asset]),
      )
    : doc.assets;
  const pages = Array.isArray(doc.pages)
    ? doc.pages.map((page: unknown) => (isJson(page) ? { ...page, guides: [] } : page))
    : doc.pages;
  return { ...rest, version: 8, folders: { [folderId]: { path } }, assets, pages, outputs: [], captions: {} };
}

/**
 * One step per version bump: `STEPS[n]` turns a version n document into version n + 1. Steps never
 * mutate their input.
 */
const STEPS: Record<number, (doc: Json) => Json> = {
  // 1 -> 2: shape, customLayouts, theme tokens, text overlay / box and the quote style were added,
  // all optional with defaults (the schema fills them), so only the number changes.
  1: (doc) => ({ ...doc, version: 2 }),
  // 2 -> 3: optional `publish.publishedFingerprint`; only the number changes.
  2: (doc) => ({ ...doc, version: 3 }),
  // 3 -> 4: `publish.password` (defaults to null); only the number changes.
  3: (doc) => ({ ...doc, version: 4 }),
  // 4 -> 5: optional asset `rating` and `flag`; only the number changes.
  4: (doc) => ({ ...doc, version: 5 }),
  // 5 -> 6: optional asset `develop`; only the number changes.
  5: (doc) => ({ ...doc, version: 6 }),
  // 6 -> 7: `outputProfile` (defaults to 'srgb'); only the number changes.
  6: (doc) => ({ ...doc, version: 7 }),
  // 7 -> 8: folders, asset folder / version / snapshot, outputs, captions, page guides (see `toV8`).
  7: toV8,
};

/**
 * Bring a project file of any supported version up to CURRENT_VERSION by running each step in
 * turn. Add a step per version bump. Validation happens afterwards in `loadBook`.
 */
export function migrate(json: unknown): unknown {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new BookLoadError('book.photobook.json must contain a JSON object');
  }
  let doc = json as Json;
  const start = doc.version;
  if (start === undefined) throw new BookLoadError('book.photobook.json has no "version" field');
  while (doc.version !== CURRENT_VERSION) {
    const step = typeof doc.version === 'number' ? STEPS[doc.version] : undefined;
    if (!step) {
      throw new BookLoadError(
        `Unsupported book.photobook.json version ${JSON.stringify(start)} (this build reads up to ${CURRENT_VERSION})`,
      );
    }
    doc = step(doc);
  }
  return doc;
}
