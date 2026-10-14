import { z } from 'zod';
import { AccessPasswordSchema, BookTemplateSchema, PageSchema, ThemeSchema } from '../schema.js';

/**
 * `books/<slug>/manifest.json`: what the viewer fetches. Derived from the project file by the
 * publish CLI: no designer notes, no local paths. Pages keep their shape (and their `asset` ids,
 * which are ULIDs) so the shared `<Page>` renders them as-is; `images` maps each asset id to its
 * published versions, and the viewer's resolver is a lookup into it.
 */

export const MANIFEST_VERSION = 1 as const;

/** One published size of the browse ladder. `w` is the actual pixel width of that file. */
export const LadderEntrySchema = z.object({
  w: z.number().int().positive(),
  url: z.url(),
});

export const ImageRecordSchema = z.object({
  /** Upright pixel size of the original (what the download version's aspect is). */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  download: z.object({
    url: z.url(),
    bytes: z.number().int().nonnegative(),
    /** Suggested file name for the `download` attribute (the original's name). */
    filename: z.string().min(1),
  }),
  /** 2048 px JPEG for the lightbox and the share sheet. */
  share: z.url(),
  /** Browse ladder, ascending by width. */
  avif: z.array(LadderEntrySchema),
  webp: z.array(LadderEntrySchema),
  /** Tiny blurred WebP as a data URL. */
  placeholder: z.string().startsWith('data:'),
  /**
   * Alt text for screen readers (the asset's `alt`, plan 35), set on the photo's `<img>` by the viewer. Absent when the
   * photo has none (and in manifests published before alt text), which renders as `alt=""`.
   */
  alt: z.string().optional(),
});

export const ManifestPageSchema = PageSchema.omit({ notes: true, guides: true }).extend({
  /**
   * Jump-grid thumbnail: the rendered page (320 px wide) when page images were produced, else the
   * smallest browse size of the page's first photo, else null.
   */
  thumbnail: z.url().nullable(),
  /** The whole page rendered at 1080 x 1350 (Instagram feed), or null when not rendered. */
  shareFeed: z.url().nullable().default(null),
  /** The whole page rendered at 1080 x 1920 (Instagram story), or null when not rendered. */
  shareStory: z.url().nullable().default(null),
});

export const ManifestSchema = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    id: z.string().min(1),
    slug: z.string().min(1),
    title: z.string(),
    listed: z.boolean(),
    /**
     * The book's soft password, or null for none. Absent only in manifests published before
     * per-book passwords: the viewer then falls back to the legacy `site.password`.
     */
    password: AccessPasswordSchema.nullable().optional(),
    template: BookTemplateSchema,
    theme: ThemeSchema,
    publishedAt: z.iso.datetime({ offset: true }),
    images: z.record(z.string(), ImageRecordSchema),
    pages: z.array(ManifestPageSchema),
  })
  .superRefine((m, ctx) => {
    m.pages.forEach((page, p) => {
      if (typeof page.background === 'object' && !(page.background.asset in m.images)) {
        ctx.addIssue({ code: 'custom', path: ['pages', p, 'background', 'asset'], message: 'unknown image' });
      }
      page.elements.forEach((el, e) => {
        if (el.type === 'photo' && el.asset !== null && !(el.asset in m.images)) {
          ctx.addIssue({ code: 'custom', path: ['pages', p, 'elements', e, 'asset'], message: 'unknown image' });
        }
      });
    });
  });

export type LadderEntry = z.infer<typeof LadderEntrySchema>;
export type ImageRecord = z.infer<typeof ImageRecordSchema>;
export type ManifestPage = z.infer<typeof ManifestPageSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export function parseManifest(json: unknown): Manifest {
  return ManifestSchema.parse(json);
}

/** Asset ids a page shows: the background photo first, then the photo slots in order. */
export function pageAssetIds(page: {
  background: ManifestPage['background'];
  elements: ManifestPage['elements'];
}): string[] {
  const ids: string[] = [];
  if (typeof page.background === 'object') ids.push(page.background.asset);
  for (const el of page.elements) if (el.type === 'photo' && el.asset) ids.push(el.asset);
  return ids;
}
