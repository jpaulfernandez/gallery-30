import { z } from 'zod';
import { DevelopSchema } from './develop/schema.js';
import {
  DEFAULT_PRINT_SETTINGS,
  MAX_BLEED_MM,
  MAX_PRINT_DPI,
  MIN_PRINT_DPI,
  PAPER_SIZES,
  PRINT_IMPOSITIONS,
  PRINT_ORIENTATIONS,
} from './print/print.js';
// Workflow plan 16: the slideshow output's settings.
import {
  DEFAULT_SLIDESHOW_SETTINGS,
  SECONDS_PER_SLIDE,
  SLIDESHOW_MOTIONS,
  SLIDESHOW_ORDERS,
  SLIDESHOW_SIZE_IDS,
  SLIDESHOW_TRANSITIONS,
} from './slideshow/settings.js';
import { DEFAULT_SOCIAL_NETWORK, SOCIAL_NETWORKS } from './social/templates.js';

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
 * - 4: `publish.password`, the book's own soft password (null: open to anyone with the link). It
 *   replaces the old site-wide password; defaults to null, so 3 -> 4 only bumps the number.
 * - 5: optional asset `rating` and `flag` (photo review in the editor). Optional, so 4 -> 5 only
 *   bumps the number.
 * - 6: optional asset `develop` (non-destructive photo edits, see `DevelopSchema`). Optional, so 5 -> 6
 *   only bumps the number.
 * - 7: `outputProfile`, the colour space developed photos are rendered in (`'srgb'` or `'display-p3'`).
 *   Defaults to `'srgb'`, so 6 -> 7 only bumps the number.
 * - 8: the workflow fields, in one bump (workflow plan 03): `folders` replaces `sourceFolder` and every asset names its
 *   `folder`; assets gain `version`, `publishedDh`, `developSnapshot` and `alt`, and their `rating`, `flag` and
 *   `develop` become legacy (the per-folder library holds them, see `library.ts`); `outputs`, `captions` and
 *   `page.guides`. 7 -> 8 turns `sourceFolder` into one folder entry (see `migrate`).
 */
export const CURRENT_VERSION = 8 as const;

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

/**
 * One photo folder a project draws from (`Book.folders`, keyed by id). `path` is absolute, or relative to the project
 * file's folder (the publish CLI resolves it that way; `.` is the folder the project file sits in).
 */
export const FolderRefSchema = z.object({
  path: z.string().min(1),
});

export const AssetSchema = z.object({
  /** Path relative to the asset's folder (`folders[asset.folder].path`), `/`-separated. A hint: relink goes by hash. */
  path: z.string().min(1),
  /**
   * SHA-256 hex of the file's bytes: the photo's identity and its key in the folder's library. Filled lazily after the
   * folder scan, so still optional here (a photo joins a project only once hashed from plan 05 on).
   */
  hash: z.string().optional(),
  /** Id into `Book.folders`: the folder `path` is relative to. */
  folder: id,
  /** A virtual copy in the library (`LibraryPhoto.versions`) this project uses; absent means the master edit. */
  version: id.optional(),
  /** Develop hash the last publish used for this photo (change detection, "edited since publish"). */
  publishedDh: z.string().optional(),
  /**
   * Develop settings frozen into the project ("Snapshot edits"): when present they win over the library, so later
   * edits of the photo do not reach this project. Off by default. See `resolveAssetDevelop`.
   */
  developSnapshot: DevelopSchema.optional(),
  /** Alt text for the published photo (AI captions, plan 35). */
  alt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Bytes. */
  size: z.number().int().nonnegative().optional(),
  /** Unix epoch milliseconds. */
  mtime: z.number().nonnegative().optional(),
  /** EXIF orientation, 1 to 8. */
  orientation: z.number().int().min(1).max(8).optional(),
  /**
   * Legacy (books up to v7): star rating 1 to 5. The folder's library holds it now (`LibraryPhoto.rating`); the editor
   * lifts it there on open and leaves it out of the saved file. Never published.
   */
  rating: z.number().int().min(1).max(5).optional(),
  /** Legacy (books up to v7): pick or reject flag, lifted into the library like `rating`. Never published. */
  flag: z.enum(['pick', 'reject']).optional(),
  /**
   * Legacy (books up to v7): develop settings (exposure, colour, crop, masks, ...). The folder's library holds the edit
   * now (`LibraryPhoto.develop`, keyed by `hash`); the editor lifts this field there on open and leaves it out of the
   * saved file. Read through `resolveAssetDevelop` (snapshot, then library, then this field), never directly.
   */
  develop: DevelopSchema.optional(),
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

/** A persistent ruler guide on a page (plan 31): a vertical line at `value` of the width (`x`) or height (`y`). */
export const PageGuideSchema = z.object({
  axis: z.enum(['x', 'y']),
  /** Fraction of the page width (`x`) or height (`y`), clamped onto the page (0 to 1) when read. */
  value: z.number().transform((v) => Math.min(1, Math.max(0, v))),
});

export const PageSchema = z.object({
  id,
  layout: z.string().min(1),
  /** Hex color, or a full-bleed photo behind the slots. */
  background: PageBackgroundSchema,
  elements: z.array(ElementSchema),
  /** Designer-only; stripped by publish. */
  notes: z.string().optional(),
  /** Ruler guides the canvas snaps to. Designer-only; stripped by publish and left out of the fingerprint. */
  // A malformed guide (bad axis, no number) is dropped and a malformed list read as none: a guide never rejects a file.
  guides: z
    .array(PageGuideSchema.nullable().catch(null))
    .catch([])
    .transform((list) => list.filter((g): g is z.infer<typeof PageGuideSchema> => g !== null)),
});

/**
 * A soft password: what the viewer checks a typed word against. Only the salted hash is stored, here
 * and in the published manifest; the word itself is never written anywhere. See `hashPassword`.
 */
export const AccessPasswordSchema = z.object({
  /** `hashPassword(word, salt)`: SHA-256 hex over `salt + word`. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  salt: z.string().min(1),
  /** Increases on every change; the viewer stores the version it was granted. */
  version: z.number().int().positive(),
  /** Grants older than this are asked again; null never expires. */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
});

export const PublishInfoSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase letters, digits and dashes'),
  visibility: z.enum(['listed', 'unlisted']),
  lastPublishedAt: z.iso.datetime({ offset: true }).nullable(),
  /** Random per-book segment of every image key on R2; generated once, never changed. */
  r2Prefix: z.string().min(1),
  /** `publishFingerprint(book)` at the last successful publish; differs from the current one when there are unpublished changes. */
  publishedFingerprint: z.string().optional(),
  /** Viewers must type this book's password once per device; null means no password. */
  password: AccessPasswordSchema.nullable().default(null),
});

/**
 * The colour space developed photos are rendered in and tagged with (Develop step D6.2). `srgb` is what the web
 * assumes; `display-p3` keeps the wider colours of Apple displays and iPhone photos (browsers on sRGB screens
 * convert it). Photos without develop edits are published from their originals, profile kept, either way.
 */
export const OutputProfileSchema = z.enum(['srgb', 'display-p3']);
export const OUTPUT_PROFILES = OutputProfileSchema.options;

const OutputBase = {
  id,
  name: z.string(),
  /** Unix epoch milliseconds. */
  createdAt: z.number(),
};

/** The network a social post is made for (`social/templates.ts`: page size, frame limit, safe area, caption limit). */
export const SocialNetworkSchema = z.enum(SOCIAL_NETWORKS);

/**
 * A social post (plans 13, 14). Its frames are pages: same renderer, same ids, with the page size fixed by the
 * network (`frameTemplate`). `network` and `caption` are defaulted, so posts written before plan 14 (4:5, no caption)
 * read as Instagram carousels without a version bump.
 */
export const SocialOutputSchema = z.object({
  ...OutputBase,
  kind: z.literal('social'),
  network: SocialNetworkSchema.default(DEFAULT_SOCIAL_NETWORK),
  frames: z.array(PageSchema).default([]),
  /** The post's caption, exported as `caption.txt` next to the frames. */
  caption: z.string().default(''),
});

/**
 * A print document (workflow plan 15): settings only, the pages are its source's (the book's, or a post's). Every field
 * has a default (`DEFAULT_PRINT_SETTINGS`, `print/print.ts`), so prints written by plan 13 read without a version bump.
 */
export const PrintOutputSchema = z.object({
  ...OutputBase,
  kind: z.literal('print'),
  /** `book`, or the id of the output whose pages are printed (an unknown id prints the book). */
  source: z.string().min(1).default(DEFAULT_PRINT_SETTINGS.source),
  imposition: z.enum(PRINT_IMPOSITIONS).default(DEFAULT_PRINT_SETTINGS.imposition),
  paper: z.enum(PAPER_SIZES).default(DEFAULT_PRINT_SETTINGS.paper),
  orientation: z.enum(PRINT_ORIENTATIONS).default(DEFAULT_PRINT_SETTINGS.orientation),
  bleedMm: z.number().min(0).max(MAX_BLEED_MM).default(DEFAULT_PRINT_SETTINGS.bleedMm),
  marks: z.boolean().default(DEFAULT_PRINT_SETTINGS.marks),
  dpi: z.number().int().min(MIN_PRINT_DPI).max(MAX_PRINT_DPI).default(DEFAULT_PRINT_SETTINGS.dpi),
});

/**
 * A slideshow video (workflow plan 16): settings only, its slides are its source's pages (the book's, a post's frames)
 * or the project's picks (`slideshow/slides.ts`). Every field has a default (`DEFAULT_SLIDESHOW_SETTINGS`), a new kind
 * in the union, so no version bump.
 */
export const SlideshowOutputSchema = z.object({
  ...OutputBase,
  kind: z.literal('slideshow'),
  /** `book`, `picks`, or the id of a social post whose frames are the slides (an unknown id shows the book). */
  source: z.string().min(1).default(DEFAULT_SLIDESHOW_SETTINGS.source),
  order: z.enum(SLIDESHOW_ORDERS).default(DEFAULT_SLIDESHOW_SETTINGS.order),
  secondsPerSlide: z
    .number()
    .min(SECONDS_PER_SLIDE.min)
    .max(SECONDS_PER_SLIDE.max)
    .default(DEFAULT_SLIDESHOW_SETTINGS.secondsPerSlide),
  transition: z.enum(SLIDESHOW_TRANSITIONS).default(DEFAULT_SLIDESHOW_SETTINGS.transition),
  motion: z.enum(SLIDESHOW_MOTIONS).default(DEFAULT_SLIDESHOW_SETTINGS.motion),
  size: z.enum(SLIDESHOW_SIZE_IDS).default(DEFAULT_SLIDESHOW_SETTINGS.size),
  /** The audio track: a copy in the app data dir (`<appdata>/audio/<sha256>.<ext>`, imported by `import_audio`). */
  audioPath: z.string().min(1).optional(),
  /** The audio file's name as picked (shown in the inspector). */
  audioName: z.string().optional(),
});

/**
 * An output document of the project besides the book itself (workflow plan 13): a social post, a print. Each
 * references `book.assets` ids, so the dangling-id check covers them. Outputs are not published with the book.
 */
export const OutputSchema = z.discriminatedUnion('kind', [
  SocialOutputSchema,
  PrintOutputSchema,
  SlideshowOutputSchema,
]);

/** The caption brief (plan 34 fills in the dialog): what the AI captions are told about the project. */
export const BriefSchema = z.object({
  about: z.string().default(''),
  photographer: z.string().default(''),
  placeTime: z.string().default(''),
  people: z.array(z.string()).default([]),
  voice: z.enum(['editorial', 'diary', 'minimal', 'playful']).default('editorial'),
  avoid: z.string().default(''),
  examples: z.array(z.string()).default([]),
  useExisting: z.boolean().default(false),
});

/** AI caption settings of the project (plans 34, 35). */
export const CaptionsSchema = z.object({
  brief: BriefSchema.optional(),
});

/** Every page-like document of a book with its schema path: the pages, then each output's frames. */
function pageLists(book: { pages: Page[]; outputs: Output[] }): Array<{ path: (string | number)[]; pages: Page[] }> {
  const lists: Array<{ path: (string | number)[]; pages: Page[] }> = [{ path: ['pages'], pages: book.pages }];
  book.outputs.forEach((output, o) => {
    if (output.kind === 'social') lists.push({ path: ['outputs', o, 'frames'], pages: output.frames });
  });
  return lists;
}

export const BookSchema = z
  .object({
    version: z.literal(CURRENT_VERSION),
    id,
    title: z.string(),
    /** The photo folders the project draws from, by id (`asset.folder`). One per book until projects span folders. */
    folders: z.record(z.string(), FolderRefSchema),
    template: BookTemplateSchema,
    theme: ThemeSchema.prefault({}),
    assets: z.record(z.string(), AssetSchema),
    pages: z.array(PageSchema),
    publish: PublishInfoSchema,
    /** Layouts saved with this book (`source: 'custom'`), resolved by id next to the library. */
    customLayouts: z.array(LayoutDataSchema).default([]),
    /** Output colour space of developed photos (`OutputProfileSchema`); sRGB unless chosen in Book settings. */
    outputProfile: OutputProfileSchema.default('srgb'),
    /** Output documents besides the book (social posts, print); see `OutputSchema`. */
    outputs: z.array(OutputSchema).default([]),
    /** AI caption settings (`CaptionsSchema`). */
    captions: CaptionsSchema.default({}),
  })
  .superRefine((book, ctx) => {
    // Page ids are unique across the book and every output's frames: the editor finds a page by id alone (plan 13).
    const pageIds = new Set<string>();
    for (const { path, pages } of pageLists(book)) {
      pages.forEach((page, p) => {
        if (pageIds.has(page.id)) {
          ctx.addIssue({ code: 'custom', path: [...path, p, 'id'], message: `duplicate page id "${page.id}"` });
        }
        pageIds.add(page.id);
      });
    }
    // Every asset reference must resolve, so the renderer never sees a dangling id: pages and output frames.
    for (const { path, pages } of pageLists(book)) {
      pages.forEach((page, p) => {
        if (typeof page.background === 'object' && !Object.hasOwn(book.assets, page.background.asset)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, p, 'background', 'asset'],
            message: `unknown asset "${page.background.asset}"`,
          });
        }
        page.elements.forEach((el, e) => {
          if (el.type === 'photo' && el.asset !== null && !Object.hasOwn(book.assets, el.asset)) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, p, 'elements', e, 'asset'],
              message: `unknown asset "${el.asset}"`,
            });
          }
        });
      });
    }
    // Every asset names one of the book's folders.
    for (const [assetId, asset] of Object.entries(book.assets)) {
      if (!Object.hasOwn(book.folders, asset.folder)) {
        ctx.addIssue({
          code: 'custom',
          path: ['assets', assetId, 'folder'],
          message: `unknown folder "${asset.folder}"`,
        });
      }
    }
  });

export type BookTemplateName = z.infer<typeof BookTemplateNameSchema>;
export type BookTemplate = z.infer<typeof BookTemplateSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export type ThemeInput = z.input<typeof ThemeSchema>;
export type TextKind = z.infer<typeof TextKindSchema>;
export type LayoutItem = z.infer<typeof LayoutItemSchema>;
export type LayoutGroup = z.infer<typeof LayoutGroupSchema>;
export type LayoutData = z.infer<typeof LayoutDataSchema>;
export type FolderRef = z.infer<typeof FolderRefSchema>;
export type Asset = z.infer<typeof AssetSchema>;
/** An asset before the store assigns its folder (the scan and drops know the file, the store knows the folder). */
export type AssetDraft = Omit<Asset, 'folder'> & Partial<Pick<Asset, 'folder'>>;
export type AssetFlag = NonNullable<Asset['flag']>;
export type Frame = z.infer<typeof FrameSchema>;
export type Crop = z.infer<typeof CropSchema>;
export type Shape = z.infer<typeof ShapeSchema>;
export type ShapeKind = Shape['kind'];
export type PhotoElement = z.infer<typeof PhotoElementSchema>;
export type TextElement = z.infer<typeof TextElementSchema>;
export type Element = z.infer<typeof ElementSchema>;
export type PageBackground = z.infer<typeof PageBackgroundSchema>;
export type PageGuide = z.infer<typeof PageGuideSchema>;
export type Page = z.infer<typeof PageSchema>;
export type SocialOutput = z.infer<typeof SocialOutputSchema>;
export type PrintOutput = z.infer<typeof PrintOutputSchema>;
export type SlideshowOutput = z.infer<typeof SlideshowOutputSchema>;
export type Output = z.infer<typeof OutputSchema>;
export type OutputKind = Output['kind'];
export type Brief = z.infer<typeof BriefSchema>;
export type Captions = z.infer<typeof CaptionsSchema>;
export type AccessPassword = z.infer<typeof AccessPasswordSchema>;
export type OutputProfile = z.infer<typeof OutputProfileSchema>;
export type PublishInfo = z.infer<typeof PublishInfoSchema>;
export type Book = z.infer<typeof BookSchema>;
/** What may be on disk before defaults are applied (e.g. `theme` omitted). */
export type BookInput = z.input<typeof BookSchema>;
