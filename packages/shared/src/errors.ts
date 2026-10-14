/** Thrown when a project file cannot be read, migrated or validated. Message is user-facing. */
export class BookLoadError extends Error {
  override name = 'BookLoadError';
}

/**
 * Thrown when a folder's `.photobook/library.json` cannot be read or validated. Message is user-facing. `kind`: not
 * JSON, another `version`, or a shape the schema rejects (then `photo` is the content hash of the first bad entry,
 * when the problem is inside one). `newer`: the version is higher than this build reads (a newer Photobook wrote it).
 */
export class LibraryLoadError extends Error {
  override name = 'LibraryLoadError';
  constructor(
    message: string,
    readonly kind: 'json' | 'version' | 'schema' = 'schema',
    readonly photo?: string,
    readonly newer = false,
  ) {
    super(message);
  }
}
