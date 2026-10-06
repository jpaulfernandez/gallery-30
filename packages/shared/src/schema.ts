import { z } from 'zod';

/**
 * Zod schema for `book.photobook.json`. This file is the source of truth:
 * every type the editor, viewer and publish CLI use is inferred from it.
 * Matches the "Data model" section of docs/design/PRD.md.
 */

export const BOOK_FILE_NAME = 'book.photobook.json';
/**
 * Project file format version. History:
 * - 1: initial format.
 * - 2: optional photo `shape`, `customLayouts`, the theme spacing tokens, text `overlay` / `box`
 *   and the `quote` text style. Every addition is optional with a default, so 1 -> 2 only bumps
 *   the number (see `migrate`).
 * - 3: optional `publish.publishedFingerprint` (see `publishFingerprint`), so the editor can show
 *   "unpublished changes". Optional, so 2 -> 3 only bumps the number.
 */
export const CURRENT_VERSION = 3 as const;

const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'expected a hex color like #ffffff');

const id = z.string().min(1);

export const BookTemplateNameSchema = z.enum([
  'phone-portrait',
  'square',
  'story',
  'a4-portrait',
  'a4-landscape',
  'custom',
]);

export const BookTemplateSchema = z.object({
  name: BookTemplateNameSchema,
  width: z.number().positive(),
  height: z.number().positive(),
});

/**
 * Book-wide design tokens. Unless noted, every spacing token is a fraction of the page WIDTH, as in
 * `docs/design/reference/layout-guide.md` (8 x 10 in reference page: 1 in = 0.125 of the width). On the
 * y axis the same absolute distance is `token * width / height` of the page height.
 * All fields are optional on disk and filled with the guide's values; see `THEME_DEFAULTS`.
 */
export const ThemeSchema = z.object({
  /** Stage colour behind the page in the editor and viewer. */
  background: hexColor.default('#ffffff'),
  /** Background colour for new pages. */
  defaultPageBackground: hexColor.default('#ffffff'),
  fonts: z.array(z.string().min(1)).default(['Inter', 'Fraunces']),
  /** Safe margin (0.64 in). Fraction of the page width, like every spacing token. */
  margin: z.number().min(0).max(0.5).default(0.08),
  /** Standard gap between photos (0.2 in). Fraction of the page width. */
  gutter: z.number().min(0).max(0.5).default(0.025),
  /** Wide gap for airy two-photo pages (0.4 in). */
  wideGutter: z.number().min(0).max(0.5).default(0.05),
  /** How far full-bleed photos extend past the trim (0.125 in). */
  bleed: z.number().min(0).max(0.5).default(0.0156),
  /** Faces and text never sit closer to the trim than this (0.5 in). */
  hardMargin: z.number().min(0).max(0.5).default(0.0625),
  /** Photo edge to its own caption (0.12 in). */
  captionOffset: z.number().min(0).max(0.5).default(0.015),
  /** Caption to any photo it does not describe (0.3 in). */
  captionClearance: z.number().min(0).max(0.5).default(0.0375),
  /** Snap grid step (8 pt on an 8 in wide page). */
  grid: z.number().positive().max(0.5).default(0.0139),
});

/** Text roles a layout item can hold (see `docs/design/reference/layouts-4x5.html`). */
export const TEXT_KINDS = [
  'cap',
  'cap1',
  'capR',
  'overlay',
  'title',
  'titleLg',
  'para',
  'quote',
  'cell',
  'key',
] as const;
export const TextKindSchema = z.enum(TEXT_KINDS);

/**
 * One box of a serializable layout, in page fractions (x, w of the width; y, h of the height).
 * Library layouts are authored on a 4:5 page with an 8% margin and 2.5% gutter; see `layoutItemsFor`.
 */
export const LayoutItemSchema = z.object({
  kind: z.enum(['photo', ...TEXT_KINDS]),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});

export const LayoutGroupSchema = z.enum(['photos', 'captioned', 'custom']);

/** A layout as data: the built-in library and a book's own saved layouts share this shape. */
export const LayoutDataSchema = z
  .object({
    id,
    name: z.string().min(1),
    /** Number of photo items, 1 to 6. */
    photos: z.number().int().min(1).max(6),
    group: LayoutGroupSchema,
    /** What the layout is best for (picker subtitle). */
    best: z.string().optional(),
    /** Some photo runs off the trim. */
    bleed: z.boolean().optional(),
    source: z.enum(['library', 'custom']),
    /** Reading order: photos are filled in this order, text items likewise. */
    items: z.array(LayoutItemSchema),
  })
  .refine((l) => l.items.filter((i) => i.kind === 'photo').length === l.photos, {
    message: '`photos` must equal the number of photo items',
    path: ['photos'],
  });

export const AssetSchema = z.object({
  /** Path relative to `sourceFolder`. */
  path: z.string().min(1),
  /** SHA-256 hex; filled lazily after the folder scan. */
  hash: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Bytes. */
  size: z.number().int().nonnegative().optional(),
  /** Unix epoch milliseconds. */
  mtime: z.number().nonnegative().optional(),
  /** EXIF orientation, 1 to 8. */
  orientation: z.number().int().min(1).max(8).optional(),
});

/** Position and size as fractions of the page (0..1). */
export const FrameSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});

/** Pan offset (fractions of the slot) and zoom applied to a cover-fit photo. */
export const CropSchema = z.object({
  x: z.number(),
  y: z.number(),
  scale: z.number().positive(),
});

/** Frame shape kinds, in the order the inspector shows them. `rect` is the default (no `shape` on disk). */
export const SHAPE_KINDS = ['rect', 'rounded', 'circle', 'ellipse', 'arch', 'diamond', 'polygon', 'blob'] as const;

/**
 * Clip shape of a photo slot. The photo is laid out and cropped in the full rectangular frame as
 * usual; the shape only clips it. See `shapeClip` in `renderer/shapes.ts`.
 */
export const ShapeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rect') }),
  /** Rounded corners; `radius` is a fraction of the frame's short side. */
  z.object({ kind: z.literal('rounded'), radius: z.number().min(0).max(0.5) }),
  /** The largest circle centred in the frame (the editor keeps the frame square). */
  z.object({ kind: z.literal('circle') }),
  /** An ellipse filling the frame. */
  z.object({ kind: z.literal('ellipse') }),
  /** Regular polygon, or a star when `inset` (inner radius / outer radius) is set. */
  z.object({
    kind: z.literal('polygon'),
    sides: z.number().int().min(3).max(12),
    /** Degrees clockwise; 0 puts a vertex at the top. */
    rotation: z.number(),
    inset: z.number().min(0).max(1).optional(),
  }),
  /** Smooth organic blob: `points` radii drawn from `seed`, varying by up to `roughness * 35%`. */
  z.object({
    kind: z.literal('blob'),
    points: z.number().int().min(3).max(12),
    seed: z.number().int(),
    roughness: z.number().min(0).max(1),
  }),
  /** A rectangle with a semicircular top. */
  z.object({ kind: z.literal('arch') }),
  /** A rhombus touching the middle of each side of the frame. */
  z.object({ kind: z.literal('diamond') }),
]);

export const PhotoElementSchema = z.object({
  type: z.literal('photo'),
  id,
  /** Asset id, or null for an empty slot. */
  asset: id.nullable(),
  frame: FrameSchema,
  crop: CropSchema,
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)], {
    error: 'rotate must be 0, 90, 180 or 270',
  }),
  filter: z.enum(['none', 'bw', 'fade']),
  /** Slot aspect ratio chosen in the inspector, e.g. "4:5". */
  ratio: z.string().optional(),
  /** Clip shape; absent means a plain rectangle. */
  shape: ShapeSchema.optional(),
});

export const TextElementSchema = z.object({
  type: z.literal('text'),
  id,
  text: z.string(),
  style: z.enum(['title', 'caption', 'date', 'body', 'quote']),
  frame: FrameSchema,
  align: z.enum(['left', 'center', 'right']),
  family: z.string().optional(),
  /** Font size as a fraction of the page height. */
  size: z.number().positive().optional(),
  weight: z.number().int().min(100).max(1000).optional(),
  color: hexColor.optional(),
  pill: z.boolean().optional(),
  /** Text over a photo: the renderer draws a soft dark gradient behind it. */
  overlay: z.boolean().optional(),
  /** Text in a lightly tinted box (a grid cell that holds a story). */
  box: z.boolean().optional(),
});

export const ElementSchema = z.discriminatedUnion('type', [PhotoElementSchema, TextElementSchema]);

export const PageBackgroundSchema = z.union([hexColor, z.object({ asset: id })]);

export const PageSchema = z.object({
  id,
  layout: z.string().min(1),
  /** Hex color, or a full-bleed photo behind the slots. */
  background: PageBackgroundSchema,
  elements: z.array(ElementSchema),
  /** Designer-only; stripped by publish. */
  notes: z.string().optional(),
});

export const PublishInfoSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase letters, digits and dashes'),
  visibility: z.enum(['listed', 'unlisted']),
  lastPublishedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Random per-book segment of every image key on R2; generated once, never changed. */
  r2Prefix: z.string().min(1),
  /** `publishFingerprint(book)` at the last successful publish; differs from the current one when there are unpublished changes. */
  publishedFingerprint: z.string().optional(),
});

export const BookSchema = z
  .object({
    version: z.literal(CURRENT_VERSION),
    id,
    title: z.string(),
    sourceFolder: z.string().min(1),
    template: BookTemplateSchema,
    theme: ThemeSchema.prefault({}),
    assets: z.record(z.string(), AssetSchema),
    pages: z.array(PageSchema),
    publish: PublishInfoSchema,
    /** Layouts saved with this book (`source: 'custom'`), resolved by id next to the library. */
    customLayouts: z.array(LayoutDataSchema).default([]),
  })
  .superRefine((book, ctx) => {
    // Every asset reference must resolve, so the renderer never sees a dangling id.
    book.pages.forEach((page, p) => {
      if (typeof page.background === 'object' && !(page.background.asset in book.assets)) {
        ctx.addIssue({
          code: 'custom',
          path: ['pages', p, 'background', 'asset'],
          message: `unknown asset "${page.background.asset}"`,
        });
      }
      page.elements.forEach((el, e) => {
        if (el.type === 'photo' && el.asset !== null && !(el.asset in book.assets)) {
          ctx.addIssue({
            code: 'custom',
            path: ['pages', p, 'elements', e, 'asset'],
            message: `unknown asset "${el.asset}"`,
          });
        }
      });
    });
  });

export type BookTemplateName = z.infer<typeof BookTemplateNameSchema>;
export type BookTemplate = z.infer<typeof BookTemplateSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export type ThemeInput = z.input<typeof ThemeSchema>;
export type TextKind = z.infer<typeof TextKindSchema>;
export type LayoutItem = z.infer<typeof LayoutItemSchema>;
export type LayoutGroup = z.infer<typeof LayoutGroupSchema>;
export type LayoutData = z.infer<typeof LayoutDataSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Frame = z.infer<typeof FrameSchema>;
export type Crop = z.infer<typeof CropSchema>;
export type Shape = z.infer<typeof ShapeSchema>;
export type ShapeKind = Shape['kind'];
export type PhotoElement = z.infer<typeof PhotoElementSchema>;
export type TextElement = z.infer<typeof TextElementSchema>;
export type Element = z.infer<typeof ElementSchema>;
export type PageBackground = z.infer<typeof PageBackgroundSchema>;
export type Page = z.infer<typeof PageSchema>;
export type PublishInfo = z.infer<typeof PublishInfoSchema>;
export type Book = z.infer<typeof BookSchema>;
/** What may be on disk before defaults are applied (e.g. `theme` omitted). */
export type BookInput = z.input<typeof BookSchema>;
