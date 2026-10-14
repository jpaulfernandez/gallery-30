import { z } from 'zod';
import { canonicalJson } from './publish/canonical.js';
import { sha256Hex } from './publish/password.js';
import { OutputProfileSchema } from './schema.js';

/**
 * Export from Develop (workflow plan 11): presets as data, the preset hash that keys the export cache, and the file
 * naming tokens. A preset is saved one file each in `<appdata>/export-presets/<ULID>.json` (the editor's
 * `list_export_presets` / `save_export_preset`; Rust only checks the id, the name and the size, this schema is the
 * contract). The encode options (`ExportOptions`) travel unchanged to the Rust `export_photo` command, which owns
 * resize, output sharpening and encode (`crates/develop/src/export.rs`).
 *
 * Plan 12 adds AVIF, HEIC (10-bit, macOS only), TIFF (16-bit) and Original (the source file plus an XMP sidecar) to
 * `EXPORT_FORMATS`, and a watermark and a border to `ExportOptionsSchema` (the same fields as `ExportOptions` in
 * Rust). Both are optional and absent when off, so presets without them keep their plan 11 hash.
 */

/**
 * Bumped whenever the export writes different bytes for the same options and develop hash (a change to resize, output
 * sharpening or an encoder in `crates/develop/src/export.rs`). Part of every preset hash, so a bump moves the whole
 * export cache. (A develop engine change is already in the develop hash.) Equal to `EXPORT_ENGINE_VERSION` in
 * `crates/develop/src/export.rs`.
 */
export const EXPORT_ENGINE_VERSION = 'export/1';

/**
 * Output formats: JPEG, PNG and WebP (plan 11); AVIF (10-bit AV1), HEIC (10-bit, through ImageIO: macOS only, see
 * `formatsFor`), TIFF (16 bits per channel) and Original (a copy of the source file with an XMP sidecar holding the
 * edit, for Lightroom and other editors; nothing is developed) (plan 12).
 */
export const EXPORT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'heic', 'tiff', 'original'] as const;
export const ExportFormatSchema = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

/**
 * File extension (no dot) of each format: what the cache entry and the exported file end with. Original keeps the
 * source's own extension (`exportExtension`).
 */
export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  heic: 'heic',
  tiff: 'tif',
  original: '',
};

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  jpeg: 'JPEG',
  png: 'PNG',
  webp: 'WebP',
  avif: 'AVIF',
  heic: 'HEIC (10-bit)',
  tiff: 'TIFF (16-bit)',
  original: 'Original + XMP sidecar',
};

/** Formats whose `quality` decides the bytes (lossy). PNG and TIFF are lossless; Original is a copy. */
export const formatHasQuality = (format: ExportFormat): boolean =>
  format === 'jpeg' || format === 'webp' || format === 'avif' || format === 'heic';

/** Formats that carry Exif (TIFF: its descriptive tags). PNG, WebP and AVIF carry the colour profile only. */
export const formatHasMetadata = (format: ExportFormat): boolean =>
  format === 'jpeg' || format === 'heic' || format === 'tiff';

/** What this machine can write: HEIC needs macOS (ImageIO); the editor asks Rust (`export_capabilities`). */
export interface ExportCapabilities {
  heic: boolean;
}

/** The formats to offer: all of them, less HEIC where it cannot be written. */
export function formatsFor(caps: ExportCapabilities): ExportFormat[] {
  return EXPORT_FORMATS.filter((f) => f !== 'heic' || caps.heic);
}

/** The exported file's extension: the format's, or the source's own for Original (lower case, `jpg` when none). */
export function exportExtension(format: ExportFormat, sourcePath: string): string {
  if (format !== 'original') return EXPORT_EXTENSIONS[format];
  const base = sourcePath.split(/[\\/]/).pop() ?? sourcePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : 'jpg';
}

/**
 * Which Exif goes into the file: `all` (the source's, Orientation reset to 1), `copyright` (only Copyright and
 * Artist) or `none`. JPEG and HEIC carry Exif; TIFF the descriptive TIFF tags (make, model, date, artist, copyright);
 * PNG, WebP and AVIF carry the colour profile and no Exif.
 */
export const ExportMetadataSchema = z.enum(['all', 'copyright', 'none']);
export type ExportMetadata = z.infer<typeof ExportMetadataSchema>;

/** Output sharpening for screen, applied at the target size after the resize (the develop sharpen op). */
export const OutputSharpenSchema = z.enum(['off', 'low', 'standard', 'high']);
export type OutputSharpen = z.infer<typeof OutputSharpenSchema>;

/** Smallest and largest long edge a preset may ask for, px. */
export const EXPORT_MIN_EDGE = 64;
export const EXPORT_MAX_EDGE = 32768;

const HexColourSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((c) => c.toLowerCase());

/** Where a watermark sits on the photo. */
export const WATERMARK_POSITIONS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const;
export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number];

/** The shared book fonts (`packages/shared/fonts`) a text watermark can be set in; Rust reads the same files. */
export const WATERMARK_FONTS = ['inter', 'fraunces', 'instrument-serif', 'jetbrains-mono'] as const;
export type WatermarkFont = (typeof WATERMARK_FONTS)[number];
export const WATERMARK_FONT_LABELS: Record<WatermarkFont, string> = {
  inter: 'Inter',
  fraunces: 'Fraunces',
  'instrument-serif': 'Instrument Serif',
  'jetbrains-mono': 'JetBrains Mono',
};

/**
 * A watermark laid over the photo after the resize: one line of text in a shared font, or an imported PNG (copied
 * to `<appdata>/watermarks/<sha256>.png` by `import_watermark`; `image` is that SHA-256, so the hash follows its
 * content). `size` is the text's em size, or the image's long edge, as a fraction of the photo's long edge; `margin`
 * the inset from the photo's edges, the same way.
 */
export const WatermarkSchema = z.object({
  kind: z.enum(['text', 'image']).default('text'),
  text: z.string().max(200).default(''),
  font: z.enum(WATERMARK_FONTS).default('inter'),
  colour: HexColourSchema.default('#ffffff'),
  image: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  imageName: z.string().max(255).nullable().default(null),
  size: z.number().min(0.01).max(0.5).default(0.03),
  opacity: z.number().min(0.05).max(1).default(0.7),
  position: z.enum(WATERMARK_POSITIONS).default('bottom-right'),
  margin: z.number().min(0).max(0.25).default(0.02),
});
export type Watermark = z.infer<typeof WatermarkSchema>;

/** Why a watermark cannot be drawn (no image chosen, no text), or null when it can or there is none. */
export function watermarkProblem(w: Watermark | undefined): string | null {
  if (!w) return null;
  if (w.kind === 'image' && !w.image) return 'Choose the watermark image, or switch the watermark off.';
  if (w.kind === 'text' && !w.text.trim()) return 'Type the watermark text, or switch the watermark off.';
  return null;
}

/** Largest border, px and percent. */
export const BORDER_MAX_PX = 2000;
export const BORDER_MAX_PERCENT = 25;

/**
 * A solid border around the photo. With a long edge the photo is fitted to the long edge less both borders, so the
 * file keeps the preset's long edge; without one the border adds to the developed size. Percent is of the file's
 * long edge (the preset's, else the photo's).
 */
export const BorderSchema = z
  .object({
    width: z.number().min(0).max(BORDER_MAX_PX).default(2),
    unit: z.enum(['px', 'percent']).default('percent'),
    colour: HexColourSchema.default('#ffffff'),
  })
  .refine((b) => b.unit === 'px' || b.width <= BORDER_MAX_PERCENT, { message: 'A border is at most 25%' });
export type Border = z.infer<typeof BorderSchema>;

/** What decides the bytes of an exported file (with the photo and its develop hash): hashed by `presetHash`. */
export const ExportOptionsSchema = z.object({
  format: ExportFormatSchema.default('jpeg'),
  /** 1 to 100 for JPEG and WebP; PNG is lossless and ignores it. */
  quality: z.number().int().min(1).max(100).default(90),
  /** Long edge in pixels; null keeps the developed size. Never upscales. */
  longEdge: z.number().int().min(EXPORT_MIN_EDGE).max(EXPORT_MAX_EDGE).nullable().default(null),
  /** Output colour space (the dialog offers Display P3 for wide-gamut sources; Full quality HEIC uses it). */
  colour: OutputProfileSchema.default('srgb'),
  metadata: ExportMetadataSchema.default('all'),
  sharpen: OutputSharpenSchema.default('off'),
  /** Absent when off (plan 12). */
  watermark: WatermarkSchema.optional(),
  /** Absent when off (plan 12). */
  border: BorderSchema.optional(),
});
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;
export type ExportOptionsInput = z.input<typeof ExportOptionsSchema>;

export const EXPORT_PRESET_NAME_MAX = 80;
export const EXPORT_NAMING_MAX = 200;

export const ExportPresetSchema = z.object({
  /** A ULID for a saved preset; a built-in's fixed id (`BUILT_IN_EXPORT_PRESETS`). */
  id: z.string().min(1),
  name: z.string().trim().min(1).max(EXPORT_PRESET_NAME_MAX),
  /** Built-ins live here, never on disk. */
  builtIn: z.boolean().default(false),
  options: ExportOptionsSchema.prefault({}),
  /** File name pattern without the extension: text and the tokens `{name}`, `{seq}`, `{date}`, `{rating}`. */
  naming: z.string().max(EXPORT_NAMING_MAX).default('{name}'),
  /** Absolute folder; null exports next to each photo, into `<photo folder>/Exports/<preset name>/`. */
  destination: z.string().min(1).nullable().default(null),
  /** Skip photos whose exported file is already there with these settings (same size and time as the cached one). */
  skipExported: z.boolean().default(true),
});
export type ExportPreset = z.infer<typeof ExportPresetSchema>;
export type ExportPresetInput = z.input<typeof ExportPresetSchema>;

const builtIn = (preset: ExportPresetInput): ExportPreset => ExportPresetSchema.parse({ ...preset, builtIn: true });

/**
 * The built-in presets (WORKFLOW_PLAN 14.4): Social (2048 px JPEG 88, copyright only), Web (1600 px JPEG 85, no
 * metadata), Full quality (developed size, JPEG 95, all metadata; HEIC 10-bit Display P3 where HEIC can be written,
 * `builtInExportPresets`), Original + sidecar (the source file and an XMP sidecar) and Custom (a starting point).
 */
export const BUILT_IN_EXPORT_PRESETS: readonly ExportPreset[] = Object.freeze([
  builtIn({
    id: 'social',
    name: 'Social',
    options: { format: 'jpeg', quality: 88, longEdge: 2048, metadata: 'copyright', sharpen: 'low' },
  }),
  builtIn({
    id: 'web',
    name: 'Web',
    options: { format: 'jpeg', quality: 85, longEdge: 1600, metadata: 'none', sharpen: 'low' },
  }),
  builtIn({
    id: 'full-quality',
    name: 'Full quality',
    options: { format: 'jpeg', quality: 95, longEdge: null, metadata: 'all', sharpen: 'off' },
  }),
  builtIn({
    id: 'original-sidecar',
    name: 'Original + sidecar',
    options: { format: 'original' },
    destination: null,
  }),
  builtIn({ id: 'custom', name: 'Custom', options: { format: 'jpeg', quality: 90, longEdge: null } }),
]);

/** Full quality where HEIC can be written: the developed size as 10-bit HEIC in Display P3, all metadata. */
export const FULL_QUALITY_HEIC_OPTIONS: ExportOptionsInput = {
  format: 'heic',
  quality: 90,
  longEdge: null,
  colour: 'display-p3',
  metadata: 'all',
  sharpen: 'off',
};

/** The built-ins for this machine: Full quality is HEIC 10-bit where HEIC can be written, else JPEG 95. */
export function builtInExportPresets(caps: ExportCapabilities): readonly ExportPreset[] {
  if (!caps.heic) return BUILT_IN_EXPORT_PRESETS;
  return BUILT_IN_EXPORT_PRESETS.map((p) =>
    p.id === 'full-quality' ? builtIn({ ...p, options: FULL_QUALITY_HEIC_OPTIONS }) : p,
  );
}

/** Parse a preset (a file read from disk, a draft); null when it does not validate. */
export function parseExportPreset(value: unknown): ExportPreset | null {
  const parsed = ExportPresetSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A watermark without what never reaches the pixels: the image's file name, and the fields of the other kind. */
function hashedWatermark(w: Watermark): Record<string, unknown> {
  const { imageName: _name, text, font, colour, image, ...rest } = w;
  return w.kind === 'image' ? { ...rest, image } : { ...rest, text, font, colour };
}

/**
 * The options that decide the bytes: the parsed options without the ones the format ignores (`quality` for PNG and
 * TIFF, which are lossless; `metadata` for PNG, WebP and AVIF, which carry no Exif; everything but the format for
 * Original, a copy), so changing those shares the cache. An absent watermark or border is left out, and so are a
 * watermark's image file name and the fields of the kind it does not use.
 */
export function hashedExportOptions(options: ExportOptionsInput): Record<string, unknown> {
  const { quality, metadata, watermark, border, ...rest } = ExportOptionsSchema.parse(options);
  if (rest.format === 'original') return { format: 'original' };
  return {
    ...rest,
    ...(formatHasQuality(rest.format) ? { quality } : {}),
    ...(formatHasMetadata(rest.format) ? { metadata } : {}),
    ...(watermark ? { watermark: hashedWatermark(watermark) } : {}),
    ...(border ? { border } : {}),
  };
}

/**
 * The exact string `presetHash` hashes: the canonical JSON of `hashedExportOptions`, a newline, the engine version.
 * `export_photo` recomputes it in Rust (`photobook_develop::export::preset_hash`) and refuses a hash that differs.
 */
export function presetHashInput(options: ExportOptionsInput): string {
  return `${canonicalJson(hashedExportOptions(options))}\n${EXPORT_ENGINE_VERSION}`;
}

/** Hex digits of a preset hash. */
export const PRESET_HASH_LENGTH = 16;

/**
 * The export cache key of a preset's options (16 hex digits of SHA-256): files encoded with equal options share
 * `<folder>/.photobook-cache/export/<presetHash>/`. Name, naming, destination and skip do not count.
 */
export async function presetHash(options: ExportOptionsInput): Promise<string> {
  return (await sha256Hex(presetHashInput(options))).slice(0, PRESET_HASH_LENGTH);
}

/** `<assetHash>-<developHash>.<ext>`: a photo's file in its folder's export cache for one preset hash. */
export function exportCacheName(assetHash: string, developHash: string, format: ExportFormat): string {
  return `${assetHash}-${developHash}.${EXPORT_EXTENSIONS[format]}`;
}

/** What the naming tokens are filled from. */
export interface FileNameContext {
  /** The source file name, without folder and extension. */
  name: string;
  /** 1-based position in the export. */
  seq: number;
  /** How many photos the export has (pads `{seq}`). */
  total: number;
  /** Capture time, epoch ms (the file time until EXIF dates are read); `{date}` is `YYYY-MM-DD` in local time. */
  date: number | null;
  /** Star rating, 0 for unrated. */
  rating: number;
  /** Output format: its extension is appended. */
  format: ExportFormat;
  /** The source's extension, for Original (which keeps it); `jpg` when absent. */
  sourceExt?: string;
}

export const NAMING_TOKENS = ['{name}', '{seq}', '{date}', '{rating}'] as const;

const pad = (n: number, width: number) => String(n).padStart(width, '0');

function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

/** Characters no file name may hold on macOS, Windows or Linux, and control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const UNSAFE = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;
const MAX_STEM = 180;

/** A string made safe as one path segment: unsafe characters become `_`, no leading dots or spaces. */
export function safeSegment(text: string, fallback = 'photo'): string {
  const cleaned = text
    .replace(UNSAFE, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '')
    .slice(0, MAX_STEM)
    .trim();
  return cleaned || fallback;
}

/**
 * The exported file's name: `pattern` with its tokens filled (`{name}` the source name, `{seq}` the position padded to
 * at least three digits, `{date}` `YYYY-MM-DD`, `{rating}` 0 to 5), made safe as a file name, plus the format's
 * extension. Tokens are case-insensitive; other text in braces is kept as typed. An empty result falls back to the
 * source name.
 */
export function fileName(pattern: string, ctx: FileNameContext): string {
  const width = Math.max(3, String(Math.max(ctx.total, ctx.seq)).length);
  const filled = pattern.replace(/\{(name|seq|date|rating)\}/gi, (_, token: string) => {
    switch (token.toLowerCase()) {
      case 'name':
        return ctx.name;
      case 'seq':
        return pad(ctx.seq, width);
      case 'date':
        return ctx.date === null ? 'undated' : isoDate(ctx.date);
      default:
        return String(ctx.rating);
    }
  });
  const ext = ctx.format === 'original' ? (ctx.sourceExt || 'jpg').toLowerCase() : EXPORT_EXTENSIONS[ctx.format];
  return `${safeSegment(filled, safeSegment(ctx.name))}.${ext}`;
}

/**
 * `names` with repeats (compared case-insensitively: macOS and Windows file systems are) given ` 2`, ` 3`, … before
 * the extension, in order, so no two photos of one export overwrite each other. With `byStem`, names that differ
 * only in their extension count as repeats too: an Original export writes `<stem>.xmp` next to each file, so a RAW +
 * JPEG pair (`IMG_1.nef`, `IMG_1.jpg`) becomes `IMG_1.nef` and `IMG_1 2.jpg` and never shares one sidecar.
 */
export function uniqueFileNames(names: readonly string[], { byStem = false }: { byStem?: boolean } = {}): string[] {
  const taken = new Set<string>();
  const split = (name: string) => {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
  };
  const keyOf = (name: string) => (byStem ? split(name).stem : name).toLowerCase();
  return names.map((name) => {
    const { stem, ext } = split(name);
    let candidate = name;
    for (let n = 2; taken.has(keyOf(candidate)); n++) candidate = `${stem} ${n}${ext}`;
    taken.add(keyOf(candidate));
    return candidate;
  });
}

/** The source file name without its folder and extension. */
export function stemOf(relPath: string): string {
  const base = relPath.split(/[\\/]/).filter(Boolean).pop() ?? relPath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** `<folder>/Exports/<preset name>`: where a preset without a destination exports a photo of `folder`. */
export function defaultExportDir(folder: string, presetName: string): string {
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${sep}Exports${sep}${safeSegment(presetName, 'Export')}`;
}

/**
 * `name`, or `name 2`, `name 3`, … when another preset already has it (compared case-insensitively): presets with
 * the same name would share `Exports/<name>/`.
 */
export function uniquePresetName(name: string, taken: readonly string[]): string {
  const base = name.trim();
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} ${n}`;
  return candidate;
}

/** Whether two presets export the same way (name and id aside): the dialog's "modified" mark. */
export function sameExportSettings(a: ExportPresetInput, b: ExportPresetInput): boolean {
  const pick = (p: ExportPresetInput) => {
    const { options, naming, destination, skipExported } = ExportPresetSchema.parse({ ...p, id: 'x', name: 'x' });
    return { options, naming, destination, skipExported };
  };
  return canonicalJson(pick(a)) === canonicalJson(pick(b));
}
