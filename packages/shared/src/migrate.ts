import { BookLoadError } from './errors.js';
import { CURRENT_VERSION } from './schema.js';

type Json = Record<string, unknown>;

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
