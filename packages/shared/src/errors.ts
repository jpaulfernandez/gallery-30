/** Thrown when a project file cannot be read, migrated or validated. Message is user-facing. */
export class BookLoadError extends Error {
  override name = 'BookLoadError';
}
