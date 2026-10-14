import { z } from 'zod';
import { DevelopSchema, type DevelopSettings } from './develop/schema.js';
import { LibraryLoadError } from './errors.js';
import { type Asset, AssetSchema, type Book } from './schema.js';

/**
 * The per-folder library (workflow plan 02, WORKFLOW_PLAN 2.2 and 14): the cull state and the edits of every photo
 * of one folder, in `<folder>/.photobook/library.json`, keyed by the SHA-256 of the file's bytes (the same hash as
 * `Asset.hash`). A project never sees the library's keys as ids: duplicated files (same bytes, two paths) share one
 * entry, and the entry survives deleting, moving or re-creating the project file.
 *
 * The library is the source of truth for `rating`, `flag` and `develop`. Book v8 references photos by `hash` and
 * `folder` and resolves their edit here (`resolveAssetDevelop`); the asset fields of the same names are legacy, lifted
 * into the library when the editor opens a book and left out of the file it saves.
 */

export const LIBRARY_VERSION = 1 as const;

/** Where the library lives, relative to the folder. */
export const LIBRARY_FILE = '.photobook/library.json';

/** A virtual copy of a photo's edit (plan 08 adds the UI). */
export const LibraryVersionSchema = z.object({
  name: z.string(),
  develop: DevelopSchema,
});

/** Longest description kept in the photo index (characters); longer answers are cut. */
export const AI_DESCRIPTION_MAX = 600;

/** When the light says a photo was taken (plan 33); `unknown` when it does not. */
export const AI_TIMES_OF_DAY = ['dawn', 'morning', 'midday', 'afternoon', 'evening', 'night', 'unknown'] as const;

/**
 * Workflow plan 33: what the photo index model saw in a photo (`ai_describe`), cached by content hash so every project
 * on the folder shares it and it is never computed twice. Optional on the entry, so the library stays version 1.
 */
export const LibraryPhotoAiSchema = z.object({
  /** The model the request asked for (the index model), e.g. `claude-haiku-5-5`; Refresh compares it. */
  model: z.string().min(1),
  /** The model that answered when it was not `model` (a server-side fallback). */
  servedBy: z.string().min(1).optional(),
  /** When it was described, ISO 8601. */
  at: z.string(),
  /** Two short lines: what is in the frame, where, what is happening (capped at {@link AI_DESCRIPTION_MAX}). */
  description: z.string().max(AI_DESCRIPTION_MAX),
  /** People clearly visible. */
  people: z.number().int().nonnegative(),
  /** A word or two: street, beach, kitchen, ... */
  setting: z.string(),
  timeOfDay: z.enum(AI_TIMES_OF_DAY),
  /** One word. */
  mood: z.string(),
});

/** A photo's cull overrides (plan 39). Each field drops alone when malformed, so a bad one never costs its siblings. */
export const LibraryPhotoCullSchema = z.object({
  group: z
    .union([z.literal('solo'), z.ulid()])
    .optional()
    .catch(undefined),
});

export const LibraryPhotoSchema = z.object({
  /** Star rating 1 to 5; absent means unrated. */
  rating: AssetSchema.shape.rating,
  /** Pick or reject; absent means unflagged. */
  flag: AssetSchema.shape.flag,
  /** The master edit; absent means unedited. */
  develop: DevelopSchema.optional(),
  /** Virtual copies by ULID. Parsed now, used from plan 08. */
  versions: z.record(z.string(), LibraryVersionSchema).default({}),
  /**
   * The photo index entry (plan 33); absent until the photo is described. A bad value drops only this field (it is a
   * cache: the photo is described again), never the whole library.
   */
  ai: LibraryPhotoAiSchema.optional().catch(undefined),
  /**
   * Cull group overrides (plan 39), by the user and never computed: `group: 'solo'` keeps the photo out of every
   * group, a ULID puts it in one group with every photo of the same ULID (Merge, Split). Groups themselves are not
   * stored (`groupPhotos`). Unlike `ai` (a cache, described again), an override is the user's: a malformed `group` is
   * dropped (the photo falls back to the computed groups) and the rest of the entry and of `cull` is kept.
   */
  cull: LibraryPhotoCullSchema.optional(),
});

/**
 * A folder's cull state (plan 40): the Decide pass's target ("keep about 60", or a share of the photos) and when the
 * folder was last culled (every photo kept or rejected), ISO 8601. Each field drops alone when malformed.
 */
export const LibraryCullSchema = z.object({
  target: z
    .union([z.number().int().positive(), z.object({ share: z.number().gt(0).max(1) })])
    .optional()
    .catch(undefined),
  culledAt: z.string().min(1).optional().catch(undefined),
});

export const LibrarySchema = z.object({
  version: z.literal(LIBRARY_VERSION),
  /** Photos by content hash (SHA-256 hex). */
  photos: z.record(z.string().min(1), LibraryPhotoSchema),
  /**
   * The folder's cull target and culled state (plan 40); optional, so the library stays version 1. A malformed value
   * (not an object) is dropped, never the library.
   */
  cull: LibraryCullSchema.optional().catch(undefined),
});

export type Library = z.infer<typeof LibrarySchema>;
export type LibraryPhoto = z.infer<typeof LibraryPhotoSchema>;
export type LibraryVersion = z.infer<typeof LibraryVersionSchema>;
export type LibraryPhotoAi = z.infer<typeof LibraryPhotoAiSchema>;
export type LibraryPhotoCull = z.infer<typeof LibraryPhotoCullSchema>;
export type LibraryCull = z.infer<typeof LibraryCullSchema>;
export type CullTarget = NonNullable<LibraryCull['target']>;

export function emptyLibrary(): Library {
  return { version: LIBRARY_VERSION, photos: {} };
}

/** Parse the raw text of a `library.json`. Throws `LibraryLoadError` for bad JSON, another version or a bad shape. */
export function parseLibrary(text: string): Library {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new LibraryLoadError(`library.json is not valid JSON: ${(err as Error).message}`, 'json');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new LibraryLoadError('library.json must contain a JSON object', 'json');
  }
  const version = (json as { version?: unknown }).version;
  if (version !== LIBRARY_VERSION) {
    throw new LibraryLoadError(
      version === undefined
        ? 'library.json has no "version" field'
        : `library.json version ${JSON.stringify(version)} is not supported (this app reads version ${LIBRARY_VERSION})`,
      'version',
      undefined,
      typeof version === 'number' && version > LIBRARY_VERSION,
    );
  }
  const result = LibrarySchema.safeParse(json);
  if (!result.success) {
    const path = result.error.issues[0]?.path ?? [];
    const photo = path[0] === 'photos' && typeof path[1] === 'string' ? path[1] : undefined;
    throw new LibraryLoadError(`Invalid library.json:\n${z.prettifyError(result.error)}`, 'schema', photo);
  }
  return result.data;
}

/**
 * The one rule for a `library.json` that `parseLibrary` rejected, shared by the editor and the publish CLI: fall back
 * to `library.json.bak` for any problem (bad JSON, a bad entry, a missing or unknown version) except a library written
 * by a newer Photobook, which is used by neither and never written over.
 */
export function libraryBackupAllowed(err: unknown): boolean {
  return !(err instanceof LibraryLoadError && err.newer);
}

/** Stable, human-diffable serialization for writing to disk (each photo's keys in schema order). */
export function serializeLibrary(library: Library): string {
  const photos = Object.fromEntries(
    Object.entries(library.photos).map(([hash, { rating, flag, develop, versions, ...rest }]) => [
      hash,
      { rating, flag, develop, versions, ...rest },
    ]),
  );
  return `${JSON.stringify({ ...library, photos }, null, 2)}\n`;
}

/**
 * The develop settings a reference to `photo` renders with: version `versionId` when given and present, else the
 * master edit (a version that was deleted falls back to the master). Undefined means unedited.
 */
export function resolveDevelop(photo: LibraryPhoto | undefined, versionId?: string): DevelopSettings | undefined {
  if (!photo) return undefined;
  if (versionId !== undefined && Object.hasOwn(photo.versions, versionId)) return photo.versions[versionId]?.develop;
  return photo.develop;
}

/** What `resolveAssetDevelop` reads of an asset. */
export type AssetDevelopRef = Pick<Asset, 'hash' | 'version' | 'develop' | 'developSnapshot'>;

/**
 * The develop settings a project's asset renders with, everywhere (canvas, preview, publish, export). In order:
 * 1. `developSnapshot`, settings frozen into the project ("Snapshot edits");
 * 2. the library entry of the asset's `hash`: its `version` when set and present, else the master edit;
 * 3. the legacy `asset.develop` of a book written before v8 (or one whose library could not be read);
 * 4. undefined: unedited.
 * Step 3 also covers a library entry without an edit, matching the editor's field-by-field lift on open (a book
 * `develop` the entry lacks is lifted into it).
 */
export function resolveAssetDevelop(asset: AssetDevelopRef, library?: Library): DevelopSettings | undefined {
  const hash = asset.hash;
  const photo = hash && library && Object.hasOwn(library.photos, hash) ? library.photos[hash] : undefined;
  return resolvePhotoDevelop(asset, photo);
}

/** `resolveAssetDevelop` with the asset's library entry already looked up (`photo`, undefined when it has none). */
export function resolvePhotoDevelop(
  asset: AssetDevelopRef,
  photo: LibraryPhoto | undefined,
): DevelopSettings | undefined {
  if (asset.developSnapshot) return asset.developSnapshot;
  return resolveDevelop(photo, asset.version) ?? asset.develop;
}

/**
 * `book` with every asset's `develop` replaced by `resolveAssetDevelop(asset, libraryOf(asset))` (removed when
 * unedited): the book as publishing sees it, so the fingerprint, the manifest and the renders all use the resolved
 * settings. Assets whose settings are unchanged keep their identity; so does the book when nothing changed.
 */
export function withResolvedDevelop(book: Book, libraryOf: (asset: Asset) => Library | undefined): Book {
  let changed = false;
  const assets: Book['assets'] = {};
  for (const [id, asset] of Object.entries(book.assets)) {
    const develop = resolveAssetDevelop(asset, libraryOf(asset));
    if (develop === asset.develop) {
      assets[id] = asset;
      continue;
    }
    changed = true;
    const { develop: _legacy, ...rest } = asset;
    assets[id] = develop ? { ...rest, develop } : rest;
  }
  return changed ? { ...book, assets } : book;
}
