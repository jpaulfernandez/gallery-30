import { z } from 'zod';
import { BookLoadError } from './errors.js';
import { newId, randomToken, slugify } from './ids.js';
import { LAYOUT_BLANK } from './layouts/blank.js';
import { migrate } from './migrate.js';
import {
  type Book,
  BookSchema,
  type BookTemplate,
  type BookTemplateName,
  CURRENT_VERSION,
  type Page,
  ThemeSchema,
} from './schema.js';
import { DEFAULT_TEMPLATE, templateFor } from './templates.js';

export interface CreateEmptyBookOptions {
  title: string;
  /** Absolute path of the photo folder the book lives in. */
  sourceFolder: string;
  /** Template name or a full template (for `custom`). Defaults to phone portrait. */
  template?: BookTemplateName | BookTemplate;
}

/** A blank page: no elements, `layout: 'blank'`. Pick a layout to add slots. */
export function createEmptyPage(background = '#ffffff'): Page {
  return { id: newId(), layout: LAYOUT_BLANK, background, elements: [] };
}

export function createEmptyBook({ title, sourceFolder, template = DEFAULT_TEMPLATE }: CreateEmptyBookOptions): Book {
  const theme = ThemeSchema.parse({});
  const book: Book = {
    version: CURRENT_VERSION,
    id: newId(),
    title,
    sourceFolder,
    template: typeof template === 'string' ? templateFor(template) : template,
    theme,
    assets: {},
    pages: [createEmptyPage(theme.defaultPageBackground)],
    publish: {
      slug: `${slugify(title)}-${randomToken(4)}`,
      visibility: 'unlisted',
      lastPublishedAt: null,
      r2Prefix: randomToken(5),
    },
    customLayouts: [],
  };
  // Cheap guard that the factory and the schema never drift apart.
  return BookSchema.parse(book);
}

/** Migrate any supported version to the current one, then validate. Throws `BookLoadError`. */
export function loadBook(json: unknown): Book {
  const migrated = migrate(json);
  const result = BookSchema.safeParse(migrated);
  if (!result.success) {
    throw new BookLoadError(`Invalid book.photobook.json:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Parse the raw text of a project file. */
export function parseBook(text: string): Book {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new BookLoadError(`book.photobook.json is not valid JSON: ${(err as Error).message}`);
  }
  return loadBook(json);
}

/** Stable, human-diffable serialization for writing to disk. */
export function serializeBook(book: Book): string {
  return `${JSON.stringify(book, null, 2)}\n`;
}
