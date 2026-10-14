import type {
  AiAttempt,
  AiModel,
  AiUsage,
  DevelopGeometry,
  DevelopMaskComponent,
  DevelopPoint,
  DevelopSettings,
  ExportFormat,
  ExportOptions,
  ExportPreset,
  OutputProfile,
  UprightGuide,
} from '@photobook/shared';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { DeepPartial } from './develop/merge';
import type { DevelopSectionKey } from './develop/sections';

/**
 * Typed wrappers around the Rust commands in src-tauri/src/commands.
 * Add one function here per new command so components never call `invoke` with strings.
 */

// Projects (src-tauri/src/commands/projects.rs): `<appData>/projects/<id>/project.photobook.json`, or anywhere else
// after Save as (remembered in `<appData>/projects.json`).

/** A folder a project draws from, as the Home list shows it. */
export interface ProjectFolder {
  /** The folder id inside the project (`book.folders`); empty for a project file older than v8. */
  id: string;
  path: string;
  /** The registry name when imported, else the folder's own name. */
  name: string;
  /** In the folders registry, so its photos are in scope. */
  imported: boolean;
  /** Not on disk now. */
  missing: boolean;
}

/** One project of `listProjects`. */
export interface ProjectSummary {
  id: string;
  /** The project file. */
  path: string;
  /** Saved outside app data (Save as, Open project file…). */
  external: boolean;
  title: string;
  folders: ProjectFolder[];
  /** Epoch ms the file was last written. */
  updatedAt: number;
  /** Epoch ms the project was last opened, if ever. */
  openedAt: number | null;
  /** Content hash of the cover photo (the first photo on the earliest page with one). */
  coverHash: string | null;
  /** Absolute path of the cover's cached thumbnail, when it exists. */
  coverThumb: string | null;
  /** Why the file could not be read; such a project can only be deleted. */
  error: string | null;
}

/** Every project, last opened first. */
export function listProjects(): Promise<ProjectSummary[]> {
  return invoke<ProjectSummary[]>('list_projects');
}

/** Write a new project in app data. `json` is a serialized book whose folders are all imported. */
export function createProject(id: string, json: string): Promise<ProjectSummary> {
  return invoke<ProjectSummary>('create_project', { id, json });
}

/** Raw text of the project file. */
export function readProject(id: string): Promise<string> {
  return invoke<string>('read_project', { id });
}

/** Atomically replace the project file (temp file + rename; the previous version kept as `.bak`). */
export function writeProject(id: string, json: string): Promise<void> {
  return invoke('write_project', { id, json });
}

/** Move the project to the system Trash. */
export function deleteProject(id: string): Promise<void> {
  return invoke('delete_project', { id });
}

/** Save the project as `path` (picked in the save dialog); it lives there from now on. */
export function saveProjectAs(id: string, path: string, json: string): Promise<ProjectSummary> {
  return invoke<ProjectSummary>('save_project_as', { id, path, json });
}

/** Register a project file picked in the open dialog; returns it (an already known file keeps its id). */
export function openProjectFile(path: string): Promise<ProjectSummary> {
  return invoke<ProjectSummary>('open_project_file', { path });
}

/** Turn the folder's legacy `book.photobook.json` into a project; null when it has none. */
export function importLegacyBook(folderId: string): Promise<ProjectSummary | null> {
  return invoke<ProjectSummary | null>('import_legacy_book', { folderId });
}

/** Show the project file in the Finder. */
export function revealProject(id: string): Promise<void> {
  return invoke('reveal_project', { id });
}

/** The last opened project's id, from `<appData>/recent.json`. */
export function getRecent(): Promise<string | null> {
  return invoke<string | null>('get_recent');
}

/** Remember `id` as the last opened project (and when it was opened). */
export function setRecent(id: string): Promise<void> {
  return invoke('set_recent', { id });
}

// Folders registry (src-tauri/src/commands/folders.rs): `<appData>/folders.json`.

/** An imported photo folder. Every disk command is scoped to these folders plus app data. */
export interface Folder {
  /** ULID minted on first import. */
  id: string;
  /** Canonical absolute path. */
  path: string;
  /** Display name: the folder's own name until renamed. */
  name: string;
  /** Epoch milliseconds of the first import. */
  addedAt: number;
  /** Epoch milliseconds the folder was last found on disk. */
  lastSeen: number;
  /** Not on disk right now (moved, deleted, or on an unplugged drive). */
  missing: boolean;
}

/** The imported folders in import order. */
export function listFolders(): Promise<Folder[]> {
  return invoke<Folder[]>('list_folders');
}

/**
 * Import a folder picked in the native dialog (or already imported). Idempotent by canonical path: importing it
 * again returns the same entry with a fresh `lastSeen`.
 */
export function importFolder(path: string): Promise<Folder> {
  return invoke<Folder>('import_folder', { path });
}

/** Forget a folder. Its `.photobook/` and `.photobook-cache/` files stay on disk. */
export function removeFolder(id: string): Promise<void> {
  return invoke('remove_folder', { id });
}

export function renameFolder(id: string, name: string): Promise<Folder> {
  return invoke<Folder>('rename_folder', { id, name });
}

/**
 * A photo's technical numbers (plan 38, `photobook_develop::stats`), from its 1600 px upright proxy. They rank and
 * explain; thresholds live in the callers.
 */
export interface PhotoStats {
  /** Mean noise-corrected Laplacian variance over an 8 × 8 tile grid (8-bit levels²). */
  sharpness: number;
  /** The sharpest tile's: a sharp subject on a soft background still scores high. */
  sharpnessMax: number;
  /** That tile's index, `row * 8 + column`, over the upright frame. */
  sharpestTile: number;
  /** Structure-tensor anisotropy, 0 (isotropic) to 1 (every edge one way: a pan or motion blur). */
  motion: number;
  /** Share of pixels with any channel ≥ 250. */
  clipHigh: number;
  /** Share of pixels with every channel ≤ 5. */
  clipLow: number;
  /** Median Rec. 709 luma, 0 to 1. */
  medianLum: number;
}

/**
 * What the cull groups and ranks on (plan 38): one set of optional fields shared by `IndexEntry`, `ScannedFile`,
 * `AssetInfo` and `PhotoFile`, filled by `prepare_asset` and kept in the folder index. Later index fields are added
 * here (and to `PHOTO_FACT_KEYS` in `store/library.ts`) only.
 */
export interface PhotoFacts {
  /** Capture time, epoch ms of the camera's clock read as UTC (Exif `DateTimeOriginal` + `SubSecTimeOriginal`). */
  taken?: number;
  /** Camera maker and model from the Exif, cleaned ("Fujifilm", "X-T5"). */
  make?: string;
  model?: string;
  lens?: string;
  /** Focal length, mm. */
  focal?: number;
  /** DCT perceptual hash of the proxy, 16 hex chars; compare by Hamming distance. */
  phash?: string;
  stats?: PhotoStats;
  /** Exposure time, seconds (Exif `ExposureTime`; plan 52). */
  shutter?: number;
  /** The f-number (Exif `FNumber`; plan 52). */
  aperture?: number;
  /** Where the photo was taken, decimal degrees (the Exif GPS IFD; plan 52). */
  gps?: { lat: number; lon: number };
  /**
   * Five colours of the photo as sRGB hex (`#rrggbb`), most of the picture first: k-means in Oklab on the proxy
   * scaled to 240 px (plan 56; the storytelling sorts of `@photobook/shared` read it).
   */
  palette?: string[];
}

/** One photo of a folder's `.photobook/index.json` (workflow plan 05): what scanning, hashing and preparing found. */
export interface IndexEntry extends PhotoFacts {
  /** SHA-256 hex of the file's bytes. */
  hash: string;
  size: number;
  /** Modification time, epoch ms (`ScannedFile.mtimeMs`). */
  mtime: number;
  kind: AssetKind;
  /** Upright pixel size and EXIF orientation, once `prepare_asset` has run. */
  width?: number;
  height?: number;
  orientation?: number;
  /** ISO speed from the file's Exif (`prepare_asset`, plan 23), when it has one. */
  iso?: number;
  /** σ at mid-grey of the photo's measured noise profile (`noiseProfile`, plan 23), once measured. */
  noise?: number;
}

/** The folder's photo index by relative path; empty when it has none or it cannot be read. */
export function readIndex(folder: string): Promise<Record<string, IndexEntry>> {
  return invoke<Record<string, IndexEntry>>('read_index', { folder });
}

/** Replace the folder's photo index (temp file + rename; no backup, it is a cache). */
export function writeIndex(folder: string, photos: Record<string, IndexEntry>): Promise<void> {
  return invoke('write_index', { folder, photos });
}

// Saved collections (src-tauri/src/commands/collections.rs): `<appData>/collections.json`, parsed with
// `parseSavedCollections` (workflow plan 06).

/** The saved collections as stored (Rust checks ids and names only; parse the result). */
export function readCollections(): Promise<unknown[]> {
  return invoke<unknown[]>('read_collections');
}

/**
 * Replace every saved collection (temp file + rename). Entries go back as they were read (unknown fields and entries
 * this version cannot parse included); Rust checks each id and name.
 */
export function writeCollections(collections: readonly unknown[]): Promise<void> {
  return invoke('write_collections', { collections });
}

// Library (src-tauri/src/commands/library.rs): `<folder>/.photobook/library.json`, parsed with `parseLibrary`.

/**
 * Raw text of the folder's library, or null when it has none. A missing or unparsable file is replaced by its `.bak`
 * when that is usable (the unparsable one is moved aside to `library.json.corrupt`).
 */
export function readLibrary(folder: string): Promise<string | null> {
  return invoke<string | null>('read_library', { folder });
}

/** The folder's `library.json.bak` (the version before the last write), or null when it has no usable one. */
export function readLibraryBackup(folder: string): Promise<string | null> {
  return invoke<string | null>('read_library_backup', { folder });
}

/** Atomically write the folder's library (creates `.photobook/`; the previous version is kept as `library.json.bak`). */
export function writeLibrary(folder: string, json: string): Promise<void> {
  return invoke('write_library', { folder, json });
}

// Assets (src-tauri/src/commands/assets.rs). These mirror Rust payloads, not the book schema.

/** `raw`: a camera RAW (`isRawPath` in `@photobook/shared`; published through its develop render). */
export type AssetKind = 'jpeg' | 'png' | 'heic' | 'raw';

export interface ScannedFile extends PhotoFacts {
  /** Relative to the source folder, `/`-separated. */
  relPath: string;
  /** Bytes. */
  size: number;
  /** Modification time, epoch milliseconds. */
  mtimeMs: number;
  kind: AssetKind;
  /**
   * From the folder's index when its entry still matches the file (same size, mtime and kind): the hash, and the
   * upright size and orientation once prepared. Absent otherwise.
   */
  hash?: string;
  width?: number;
  height?: number;
  orientation?: number;
  iso?: number;
  /** σ at mid-grey of the measured noise profile, from the index (plan 23). */
  noise?: number;
}

export interface AssetInfo extends PhotoFacts {
  /** Upright pixel size of the original (EXIF orientation applied). */
  width: number;
  height: number;
  /** EXIF orientation 1 to 8 (1 when absent). */
  orientation: number;
  /** Absolute path of the 256 px upright JPEG thumbnail; load it with `fileUrl`. */
  thumbPath: string;
  /** Absolute path of the 1600 px upright JPEG proxy the canvas renders. */
  proxyPath: string;
  /**
   * A camera RAW. Its thumb and proxy are the camera's embedded JPEG (or a developed render when there is none);
   * the assets store swaps in the default develop render once it exists.
   */
  isRaw: boolean;
  /** RAW only: the as-shot white balance `[Kelvin, tint]`, where the Absolute white balance sliders start. */
  asShot?: [number, number];
  /** ISO speed from the file's Exif (plan 23), absent when unknown. */
  iso?: number;
  /**
   * σ at mid-grey of the photo's measured noise profile, once `noiseProfile` has run for it; null when there is none
   * (or it is of an older engine), which clears a stale value from the folder index.
   */
  noise?: number | null;
}

/** Payload of `asset:hashed`, one per file. Exactly one of `hash` and `error` is set. */
export interface AssetHashedEvent {
  job: number;
  relPath: string;
  hash: string | null;
  error: string | null;
}

/** Payload of `asset:hash-progress`, sent after every file. */
export interface HashProgressEvent {
  job: number;
  done: number;
  total: number;
}

/**
 * Every JPEG, PNG, HEIC and camera RAW under `folder` (recursive, hidden and project files skipped), sorted by path,
 * with the index's hash and size on the files it still describes.
 */
export function scanFolder(folder: string): Promise<ScannedFile[]> {
  return invoke<ScannedFile[]>('scan_folder', { folder });
}

/**
 * SHA-256 of `relPaths` in order, on a few Rust threads. Results arrive as `asset:hashed` and
 * `asset:hash-progress` events tagged with `job`; listen before calling. A new call cancels the
 * previous job. Resolves when every file has been reported (or the job was cancelled).
 */
export function hashFiles(folder: string, relPaths: string[], job: number): Promise<void> {
  return invoke('hash_files', { folder, relPaths, job });
}

/** Ensure `<appdata>/cache/<hash>/{thumb,proxy}.jpg` exist (instant when cached) and return their info. */
export function prepareAsset(folder: string, relPath: string, hash: string): Promise<AssetInfo> {
  return invoke<AssetInfo>('prepare_asset', { folder, relPath, hash });
}

/** Absolute path of the thumbnail and proxy cache root, `<appdata>/cache`. */
export function readCacheDir(): Promise<string> {
  return invoke<string>('read_cache_dir');
}

export function onAssetHashed(handler: (event: AssetHashedEvent) => void): Promise<UnlistenFn> {
  return listen<AssetHashedEvent>('asset:hashed', (e) => handler(e.payload));
}

export function onHashProgress(handler: (event: HashProgressEvent) => void): Promise<UnlistenFn> {
  return listen<HashProgressEvent>('asset:hash-progress', (e) => handler(e.payload));
}

/** Webview URL (asset protocol) for an absolute path in the cache or the source folder. */
export function fileUrl(path: string): string {
  return convertFileSrc(path);
}

// Publish (src-tauri/src/commands/publish.rs).

/** Keys of `<appdata>/publish.env`; the CLI reads the same file (packages/publish/src/config.ts). */
export const PUBLISH_SETTING_KEYS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_URL',
  'R2_TRANSPORT',
  'VIEWER_URL',
  'DOWNLOAD_MAX_EDGE',
  'DOWNLOAD_QUALITY',
  'PUBLISH_CONCURRENCY',
  'SOCIAL_API_URL',
  'SOCIAL_ADMIN_TOKEN',
] as const;
export type PublishSettingKey = (typeof PUBLISH_SETTING_KEYS)[number];
export type PublishSettings = Partial<Record<PublishSettingKey, string>>;

export function readPublishSettings(): Promise<PublishSettings> {
  return invoke<PublishSettings>('read_publish_settings');
}

/** Write the given keys (an empty value removes the key); other keys in the file are kept. */
export function writePublishSettings(values: PublishSettings): Promise<void> {
  // The file may still hold keys this build no longer knows (e.g. the old SITE_PASSWORD); send only known ones.
  const known = Object.fromEntries(
    Object.entries(values).filter(([key]) => (PUBLISH_SETTING_KEYS as readonly string[]).includes(key)),
  );
  return invoke('write_publish_settings', { values: known });
}

export type PublishCommand = 'publish' | 'unpublish' | 'password-clear' | 'doctor';

export interface PublishLineEvent {
  job: number;
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface PublishExitEvent {
  job: number;
  /** Exit code; null when killed. */
  code: number | null;
}

/**
 * Run the publish CLI. Output arrives as `publish:line` events (stdout lines are JSON events of
 * the CLI's `--json` mode) and one `publish:exit`; listen before calling. Resolves on exit.
 */
export function runPublish(options: {
  job: number;
  command: PublishCommand;
  /** The open project's id (`publish`, `unpublish`); Rust passes its file to the CLI. */
  project?: string | null;
  dryRun?: boolean;
  prune?: boolean;
}): Promise<void> {
  return invoke('run_publish', {
    job: options.job,
    command: options.command,
    project: options.project ?? null,
    dryRun: options.dryRun ?? false,
    prune: options.prune ?? false,
  });
}

export function cancelPublish(job: number): Promise<void> {
  return invoke('cancel_publish', { job });
}

export function onPublishLine(handler: (event: PublishLineEvent) => void): Promise<UnlistenFn> {
  return listen<PublishLineEvent>('publish:line', (e) => handler(e.payload));
}

export function onPublishExit(handler: (event: PublishExitEvent) => void): Promise<UnlistenFn> {
  return listen<PublishExitEvent>('publish:exit', (e) => handler(e.payload));
}

// Social post export (workflow plan 14, src-tauri/src/commands/social.rs): the CLI's `render-frames`, one process per job.

/** One `render-frames` run: the whole `post`, or a part: `prepare` (process the photos), one `frame`, the `caption`. */
export interface RenderFramesRequest {
  project: string;
  output: string;
  /** `post`: caption, then every frame, earlier leftovers removed (what the editor runs). */
  task: 'post' | 'prepare' | 'frame' | 'caption';
  /** Destination folder; files go to `<dest>/<slug>/`. */
  dest: string;
  slug: string;
  /** 1-based, for `frame`. */
  frame?: number;
  format?: 'jpeg' | 'png';
  quality?: number;
}

/** Run one `render-frames` job; its lines and exit arrive as `social:line` / `social:exit` events. */
export function runRenderFrames(job: number, request: RenderFramesRequest): Promise<void> {
  return invoke('run_render_frames', { job, request });
}

export function cancelRenderFrames(job: number): Promise<void> {
  return invoke('cancel_render_frames', { job });
}

export function onSocialLine(handler: (event: PublishLineEvent) => void): Promise<UnlistenFn> {
  return listen<PublishLineEvent>('social:line', (e) => handler(e.payload));
}

export function onSocialExit(handler: (event: PublishExitEvent) => void): Promise<UnlistenFn> {
  return listen<PublishExitEvent>('social:exit', (e) => handler(e.payload));
}

// Print PDF (workflow plan 15, src-tauri/src/commands/print.rs): the CLI's `print`, one process per export.

/** One `print` job: print output `output` of project `project` to `<dest>/<file>` (`<slug>.pdf`). */
export interface PrintRequest {
  project: string;
  output: string;
  dest: string;
  file: string;
  /** Overwrite an existing PDF of that name (the sheet asks first); otherwise the job refuses. */
  replace?: boolean;
}

/** Run one `print` job; its lines and exit arrive as `print:line` / `print:exit` events. */
export function runPrint(job: number, request: PrintRequest): Promise<void> {
  return invoke('run_print', { job, request });
}

export function cancelPrint(job: number): Promise<void> {
  return invoke('cancel_print', { job });
}

/** Whether `<dest>/<file>` exists already (the Export PDF sheet asks before replacing it). */
export function printTargetExists(dest: string, file: string): Promise<boolean> {
  return invoke<boolean>('print_target_exists', { dest, file });
}

export function onPrintLine(handler: (event: PublishLineEvent) => void): Promise<UnlistenFn> {
  return listen<PublishLineEvent>('print:line', (e) => handler(e.payload));
}

export function onPrintExit(handler: (event: PublishExitEvent) => void): Promise<UnlistenFn> {
  return listen<PublishExitEvent>('print:exit', (e) => handler(e.payload));
}

// Develop (src-tauri/src/commands/develop.rs, crates/develop). Settings are the book's `Asset.develop`.

/** What `render_develop_cached` reports: the hash it rendered for and the cache files it wrote. */
export interface DevelopRenderMeta {
  developHash: string;
  /** Upright pixel size of the rendered proxy. */
  width: number;
  height: number;
  /** Absolute path of `thumb-<developHash>.jpg`; load it with `fileUrl`. */
  thumbPath: string;
  /** Absolute path of `proxy-<developHash>.jpg`; load it with `fileUrl`. */
  proxyPath: string;
  /**
   * True when `settings.detail.denoise` is set but its intermediate does not exist yet, so this render used the
   * source; run `runDenoise` and render again (the cached files are then redone). Absent otherwise.
   */
  denoiseStale?: boolean;
  /** True when the look's LUT file is missing, so this render left it out (redone once it is back; plan 18). */
  lutMissing?: boolean;
}

/**
 * A view-only overlay drawn over a preview's developed pixels (plan 53, Cull's *Assist* menu): never a setting, never
 * in the develop hash, a cached render or a full render.
 */
export type PreviewMode = 'focus-peak' | 'zebra';

/**
 * Live preview during a slider drag: JPEG bytes of the proxy rendered with `settings`, or null when a
 * newer `job` superseded this one. Job numbers must increase; `hash` is the source file's content hash.
 * `longEdge` caps the rendered size in pixels (the Rust default when omitted). `outputProfile` is the colour space
 * the JPEG is rendered in and tagged with (the book's, or the other one to proof; sRGB when omitted). `modes` draw
 * preview modes over the result (plan 53; focus peak first; GPU, or the CPU reference under `PHOTOBOOK_FORCE_CPU`).
 */
export function renderDevelopPreview(
  folder: string,
  relPath: string,
  hash: string,
  settings: DevelopSettings,
  job: number,
  longEdge?: number,
  outputProfile?: OutputProfile,
  modes?: readonly PreviewMode[],
): Promise<ArrayBuffer | null> {
  // Rust cannot return null through a raw response: a superseded job comes back as zero bytes.
  return invoke<ArrayBuffer>('render_develop_preview', {
    folder,
    relPath,
    hash,
    settings,
    job,
    longEdge,
    outputProfile,
    modes,
  }).then((bytes) => (bytes.byteLength === 0 ? null : bytes));
}

/**
 * The sharpening mask of the photo's proxy as greyscale JPEG bytes (white = sharpened), for the Alt-drag view on
 * the Sharpening sliders. Only `settings.detail.sharpen` radius and masking (and the geometry) change it.
 */
export function developSharpenMask(
  folder: string,
  relPath: string,
  hash: string,
  settings: DevelopSettings,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('develop_sharpen_mask', { folder, relPath, hash, settings });
}

/**
 * Commit: writes `proxy-<developHash>.jpg` and `thumb-<developHash>.jpg` to the app cache and returns their paths.
 * `keep` lists develop hashes in use by other photos with the same bytes (they share the cache folder); pruning
 * the older renders never deletes those. `outputProfile` is the book's (`Book.outputProfile`; sRGB when omitted):
 * Display P3 renders are tagged so and named `...-<developHash>-p3.jpg`; `developHash` in the result stays the plain hash.
 */
export function renderDevelopCached(
  folder: string,
  relPath: string,
  hash: string,
  settings: DevelopSettings,
  keep?: string[],
  outputProfile?: OutputProfile,
): Promise<DevelopRenderMeta> {
  return invoke<DevelopRenderMeta>('render_develop_cached', { folder, relPath, hash, settings, keep, outputProfile });
}

/** Payload of `develop:progress`, one per item of a `renderDevelopFull` batch. */
export interface DevelopProgressEvent {
  job: number;
  assetId: string;
  done: number;
  total: number;
  /** Absolute path of `<folder>/.photobook-cache/develop/<hash>-<developHash>.jpg` when it succeeded. */
  path?: string;
  error?: string;
}

/** One item of `renderDevelopFull`'s summary; exactly one of `path` and `error` is set. */
export interface DevelopFullResult {
  assetId: string;
  path?: string;
  error?: string;
}

/**
 * Full-resolution renders for publish into `<folder>/.photobook-cache/develop/<hash>-<developHash>.jpg`
 * (existing files are kept). Progress arrives on the `develop:progress` event; a failed item does not stop
 * the batch, and items left after `cancelDevelop(job)` report the error `Cancelled`. With `outputProfile`
 * `display-p3` (the book's) every item is rendered in Display P3 and named per `developRenderName` (`-p3.jpg`).
 */
export function renderDevelopFull(
  folder: string,
  items: { assetId: string; relPath: string; hash: string; settings: DevelopSettings }[],
  job: number,
  outputProfile?: OutputProfile,
): Promise<DevelopFullResult[]> {
  return invoke<DevelopFullResult[]>('render_develop_full', { folder, items, job, outputProfile });
}

export function onDevelopProgress(handler: (event: DevelopProgressEvent) => void): Promise<UnlistenFn> {
  return listen<DevelopProgressEvent>('develop:progress', (e) => handler(e.payload));
}

/** Stop the `renderDevelopFull` batch `job` before its next item. */
export function cancelDevelop(job: number): Promise<void> {
  return invoke('cancel_develop', { job });
}

/** Which of the render file names (`<hash>-<developHash>.jpg`) already exist in the folder's develop cache. */
export function developRendersPresent(folder: string, names: string[]): Promise<string[]> {
  return invoke<string[]>('develop_renders_present', { folder, names });
}

/**
 * Delete full renders in the folder's develop cache that are not in `keep` (render file names), only of the photos in
 * `hashes` (content hashes) when given; returns how many were removed. Call it after a successful publish.
 */
export function pruneDevelopRenders(folder: string, keep: string[], hashes?: string[]): Promise<number> {
  return invoke<number>('prune_develop_renders', { folder, keep, hashes: hashes ?? null });
}

/** What `solveUprightGuides` returns: write `transform` to `upright.transform` and `focal` to `upright.focal`. */
export interface GuidedUprightSolution {
  /** Row-major forward homography in 0..1 coordinates of the oriented frame (`h8 = 1`). */
  transform: number[];
  /** Focal used, long-edge units. */
  focal: number;
  /** Length-weighted RMS angle (degrees) between the warped guides and their axis. */
  residual: number;
  correction: 'level' | 'vertical' | 'full';
}

/**
 * Guided Upright: solve the correction for `guides` (endpoints in fractions of the oriented `frameW × frameH`
 * frame, before Upright and the manual Transform). `focal` (long-edge units) is used when the guides cannot
 * calibrate it; null means the 28 mm default. Pure maths. Rejects with `InvalidGuides: …` for a combination other
 * than 2H, 2V, 2H+2V, 2H+1V, 2V+1H, 1V+1H (or degenerate guides) and `Unstable: …` for a correction that would
 * fold or blow up the frame.
 */
export function solveUprightGuides(
  guides: readonly UprightGuide[],
  frameW: number,
  frameH: number,
  focal: number | null,
): Promise<GuidedUprightSolution> {
  return invoke<GuidedUprightSolution>('solve_upright_guides', { guides, frameW, frameH, focal });
}

/** The automatic Upright modes `analyseGeometry` solves. */
export type AutoUprightMode = 'auto' | 'level' | 'vertical' | 'full';

/** A detected straight line for the "show structure" overlay, in fractions of the oriented frame. */
export interface StructureLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Used by the correction (otherwise rejected). */
  used: boolean;
}

/**
 * What `analyseGeometry` returns. Without a correction ("no structure") `transform`, `focal`, `angle` and
 * `correction` are null and `message` says why (`no straight lines found`, `already level; nothing to correct`, …).
 */
export interface GeometryAnalysis {
  /** Row-major forward homography in 0..1 coordinates of the oriented frame (`h8 = 1`): `upright.transform`. */
  transform: number[] | null;
  /** Focal used, long-edge units: `upright.focal`. */
  focal: number | null;
  /** Rotation the correction applies at the frame centre, degrees clockwise (Level: the straighten angle). */
  angle: number | null;
  /** 0..1. */
  confidence: number;
  /** What was applied; Auto (and Full / Vertical falling back) may differ from the mode asked. */
  correction: 'level' | 'vertical' | 'full' | null;
  message: string | null;
  lines: StructureLine[];
  elapsedMs: number;
}

/**
 * Auto level and automatic Upright: analyse the photo's proxy in the oriented frame (`rotate`, `flipH`, `flipV`
 * applied; before Upright and the manual Transform) and solve `mode`. The analysis is cached per hash and
 * orientation in Rust, so switching modes only re-solves. Rejects with `Unstable: …` for a warp that would fold
 * or blow up the frame; "no structure" resolves with a `message`.
 */
export function analyseGeometry(
  folder: string,
  relPath: string,
  hash: string,
  mode: AutoUprightMode,
  rotate: number,
  flipH: boolean,
  flipV: boolean,
): Promise<GeometryAnalysis> {
  return invoke<GeometryAnalysis>('analyse_geometry', { folder, relPath, hash, mode, rotate, flipH, flipV });
}

// Models (src-tauri/src/commands/models.rs, step D4.2): the pinned ONNX models in crates/develop/models.toml.

export type ModelTask =
  | 'subject'
  | 'subject-fast'
  | 'sky'
  | 'people-detect'
  | 'sam-encoder'
  | 'sam-decoder'
  | 'depth'
  | 'denoise';

/** On-disk state: every file present, nothing, or some bytes (finished files and `.part` files) to resume from. */
export type ModelStatus = { state: 'installed' } | { state: 'missing' } | { state: 'partial'; bytes: number };

export interface ModelInfo {
  name: string;
  title: string;
  version: string;
  task: ModelTask;
  /** Download size in bytes (all files). */
  bytes: number;
  /** SPDX id. */
  licence: string;
  licenceUrl: string;
  homepage: string;
  status: ModelStatus;
  /** Disk used by every version of the model, partial files and the CoreML cache included. */
  installedBytes: number;
  /** False while the manifest has no pinned checksum for it. */
  downloadable: boolean;
  /** Job id of a download in progress (started by this or an earlier view). */
  job?: number;
}

/** Payload of `models:progress`, at most every 100 ms and once at the end. */
export interface ModelProgressEvent {
  job: number;
  name: string;
  received: number;
  total: number;
}

export function listModels(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>('list_models');
}

/** Absolute path of `<appdata>/models`. */
export function modelsDir(): Promise<string> {
  return invoke<string>('models_dir');
}

/**
 * Download (or resume) a model, verifying its SHA-256; resolves with its new state. Progress arrives as
 * `models:progress` tagged with `job`; listen before calling. Rejects with `cancelled`, `offline: …`,
 * a checksum error or an HTTP error.
 */
export function downloadModel(name: string, job: number): Promise<ModelInfo> {
  return invoke<ModelInfo>('download_model', { name, job });
}

/** Stop a download between chunks; the partial file is kept for the next attempt. False when the job is not running. */
export function cancelModelDownload(job: number): Promise<boolean> {
  return invoke<boolean>('cancel_model_download', { job });
}

/** Remove every version of a model with its partial files and CoreML cache. */
export function deleteModel(name: string): Promise<ModelInfo> {
  return invoke<ModelInfo>('delete_model', { name });
}

export function onModelProgress(handler: (event: ModelProgressEvent) => void): Promise<UnlistenFn> {
  return listen<ModelProgressEvent>('models:progress', (e) => handler(e.payload));
}

/** Open a model's licence or home page (from the manifest) in the default browser. */
export function openModelLink(name: string, page: 'licence' | 'homepage'): Promise<void> {
  return invoke('open_model_link', { name, page });
}

/**
 * One mask's composited plane (components, invert, feather, opacity) on the photo's proxy as greyscale JPEG
 * bytes (white = full strength), the size of the developed render, for the Masks panel's overlay. Only
 * `settings.masks` and the geometry change it; disabled masks are drawn too. Rejects when there is no mask `maskId`.
 */
export function developMaskOverlay(
  folder: string,
  relPath: string,
  hash: string,
  settings: DevelopSettings,
  maskId: string,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('develop_mask_overlay', { folder, relPath, hash, settings, maskId });
}

// Lightroom XMP and presets (src-tauri/src/commands/xmp.rs and presets.rs, step D6.3).

/** `Rotation` of `geometry.rotate`: degrees clockwise. */
export type RotateDegrees = 0 | 90 | 180 | 270;

/** One thing in the Lightroom packet that did not (`dropped`) or may not (`unverified`) come across faithfully. */
export interface XmpDroppedItem {
  /** The `crs:` field or group, e.g. `MaskGroupBasedCorrections`. */
  field: string;
  reason: string;
  kind: 'dropped' | 'unverified';
}

/** Mirrors `photobook_develop::xmp::XmpImport`. */
export interface XmpImport {
  settings: DevelopSettings;
  processVersion: string | null;
  dropped: XmpDroppedItem[];
  /** The pixels already carry these settings (an exported JPEG): importing would apply them twice. */
  alreadyApplied: boolean;
  /** `tiff:Orientation` of the packet. */
  orientation: number | null;
  ignored: string[];
}

/** What `read_xmp` returns. */
export interface XmpImportResult {
  /** Null: the photo has neither a sidecar nor an embedded packet. */
  import: XmpImport | null;
  source: 'sidecar' | 'embedded' | null;
  /** `photobook`: our own exact packet; `crs`: Lightroom's fields (slider values, not pixels). */
  format: 'photobook' | 'crs' | null;
  /** Absolute path of the sidecar that was read; null for an embedded packet. */
  sidecarPath: string | null;
  /** Set when the packet records another orientation than the file: the rotation and flip that turn one into the other. */
  orientationChange: { rotate: RotateDegrees; flipH: boolean } | null;
}

/**
 * The Lightroom (or Photobook) settings next to a photo: `<stem>.xmp`, else `<file>.xmp`, else the packet embedded
 * in a JPEG. `fileOrientation` is the file's EXIF orientation (`Asset.orientation`); with it the result says whether
 * the sidecar rotated the photo.
 */
export function readXmp(folder: string, relPath: string, fileOrientation?: number): Promise<XmpImportResult> {
  return invoke<XmpImportResult>('read_xmp', { folder, relPath, fileOrientation: fileOrientation ?? null });
}

/**
 * Write a photo's develop settings to its XMP sidecar (merged into the existing one, which is kept as `.bak`; else a
 * new `<stem>.xmp`) and return the path. `photobook` is lossless and ignored by Lightroom; `crs` is the lossy
 * Lightroom mapping. `orientation` is the file's EXIF orientation, `width` / `height` the upright size the book stores.
 */
export function writeXmpSidecar(
  folder: string,
  relPath: string,
  settings: DevelopSettings,
  orientation: number | undefined,
  width: number | undefined,
  height: number | undefined,
  mode: 'photobook' | 'crs',
): Promise<string> {
  return invoke<string>('write_xmp_sidecar', {
    folder,
    relPath,
    settings,
    orientation: orientation ?? null,
    width: width ?? null,
    height: height ?? null,
    mode,
  });
}

/** A named subset of develop settings. `id` is a ULID for saved presets; the built-in ones have fixed `builtin:` ids. */
export interface DevelopPreset {
  id: string;
  name: string;
  /** Which of `light`, `whiteBalance`, `curve`, `color`, `detail`, `effects` the preset applies. */
  sections: DevelopSectionKey[];
  /** Exactly the keys named in `sections`, each possibly partial. Never geometry or masks. */
  settings: DeepPartial<Pick<DevelopSettings, DevelopSectionKey>>;
  builtIn: boolean;
  /** A look (workflow plan 20): shown in the Looks strip and applied with an Amount. Absent on plain presets. */
  look?: boolean;
}

/** The user's saved presets, by name (the built-in ones are in `lib/develop/presets.ts`). */
export function listPresets(): Promise<DevelopPreset[]> {
  return invoke<DevelopPreset[]>('list_presets');
}

export function savePreset(preset: DevelopPreset): Promise<void> {
  return invoke('save_preset', { preset });
}

export function deletePreset(id: string): Promise<void> {
  return invoke('delete_preset', { id });
}

// Look thumbnails (src-tauri/src/commands/develop/looks.rs, workflow plan 20).

/** One look to render: `settings` is the photo's look-free base with the look applied (`applyLook` at 100). */
export interface LookThumbRequest {
  presetId: string;
  settings: DevelopSettings;
}

/** A rendered (or cached) look thumbnail; exactly one of `path` and `error` is set. */
export interface LookThumbResult {
  presetId: string;
  /** Absolute path of `<appdata>/cache/<hash>/looks/<baseDh>-<presetKey>-<dh16>.jpg`; load it with `fileUrl`. */
  path?: string;
  error?: string;
  cached: boolean;
}

/** Payload of `develop:look-thumb`, one per thumbnail as it is ready. */
export interface LookThumbEvent extends LookThumbResult {
  job: number;
}

/**
 * 240 px thumbnails of the photo with each look, cached per (hash, base develop hash, look). `base` is the photo's
 * settings without its look (`lookBase`); a newer `job` (ids increase) stops an older one between looks.
 */
export function renderLookThumbs(
  folder: string,
  relPath: string,
  hash: string,
  base: DevelopSettings,
  looks: LookThumbRequest[],
  job: number,
): Promise<LookThumbResult[]> {
  return invoke<LookThumbResult[]>('render_look_thumbs', { folder, relPath, hash, base, looks, job });
}

export function onLookThumb(handler: (event: LookThumbEvent) => void): Promise<UnlistenFn> {
  return listen<LookThumbEvent>('develop:look-thumb', (e) => handler(e.payload));
}

// User 3D LUTs (src-tauri/src/commands/luts.rs, workflow plan 18): `<appData>/luts/<sha256>.cube` + `<sha256>.json`.

/** A stored LUT: `id` is the SHA-256 of its `.cube` file (what `look.lut.id` names), `size` its lattice points per side. */
export interface LutInfo {
  id: string;
  name: string;
  size: number;
  /** Set for a LUT made by Match camera JPEG (workflow plan 22). */
  fitted?: LutFit;
}

/** Import a `.cube` or HALD CLUT `.png` picked in the open dialog (1D LUTs and sizes outside 2–129 are refused). */
export function importLut(path: string): Promise<LutInfo> {
  return invoke<LutInfo>('import_lut', { path });
}

/** The stored LUTs, by name. */
export function listLuts(): Promise<LutInfo[]> {
  return invoke<LutInfo[]>('list_luts');
}

export function deleteLut(id: string): Promise<void> {
  return invoke('delete_lut', { id });
}

/** Whether the LUT file `id` is on this machine (renders skip a missing one). */
export function lutPresent(id: string): Promise<boolean> {
  return invoke<boolean>('lut_present', { id });
}

// Match camera JPEG (src-tauri/src/commands/luts.rs, workflow plan 22): a LUT fitted from RAW + camera JPEG pairs.

/** How a LUT was fitted (its sidecar's `fitted`). */
export interface LutFit {
  /** The camera's film simulation tag, e.g. `Classic Chrome`. */
  simulation?: string;
  /** E.g. `Fujifilm X-T5`. */
  camera?: string;
  /** Pairs the fit used. */
  pairs: number;
  /** Mean CIE76 ΔE of the fitted LUT on those pairs. */
  meanDeltaE: number;
}

/** A RAW and the JPEG the camera wrote next to it, relative to the folder. */
export interface FitPair {
  raw: string;
  jpeg: string;
}

/** One pair's part in a fit (`raw`, `jpeg` relative to the folder): used (`samples`, `score`, `meanDeltaE`) or left out (`error`). */
export interface FitPairReport {
  raw: string;
  jpeg: string;
  samples: number;
  score?: number;
  meanDeltaE?: number;
  error?: string;
}

export interface FitLutResult {
  lut: LutInfo;
  pairs: FitPairReport[];
  meanDeltaE: number;
  /** Share of the LUT's lattice the pairs reached. */
  coverage: number;
  /** Final relative residual of the least-squares solve, and whether it converged. */
  residual: number;
  converged: boolean;
}

/** The film simulation a Fujifilm file records, and the camera (`Fujifilm X-T5`). */
export interface FilmTag {
  simulation: string;
  camera?: string;
}

export interface FitProgressEvent {
  job: number;
  done: number;
  total: number;
  detail: string;
}

/**
 * Fit a 33³ LUT from `pairs` in `folder` and store it in `<appData>/luts` (named `name`, or after the film simulation
 * when blank). Progress on `lut:fit-progress` tagged with `job`; `cancelDevelop(job)` stops it (rejects `Cancelled`).
 */
export function fitLut(folder: string, pairs: FitPair[], name: string, job: number): Promise<FitLutResult> {
  return invoke<FitLutResult>('fit_lut', { folder, pairs, name, job });
}

export function onFitLutProgress(handler: (event: FitProgressEvent) => void): Promise<UnlistenFn> {
  return listen<FitProgressEvent>('lut:fit-progress', (e) => handler(e.payload));
}

/** The Fujifilm film simulation a RAF or JPEG records (`Classic Chrome`, `Acros + R`) and its camera, or null. */
export function filmSimulation(folder: string, relPath: string): Promise<FilmTag | null> {
  return invoke<FilmTag | null>('film_simulation', { folder, relPath });
}

// AI masks (src-tauri/src/commands/develop.rs, crates/develop/src/ai/segment.rs, step D4.3).

/** Stage of an AI mask job, in order. */
export type AiMaskStage = 'loading' | 'running' | 'refining';

/** Payload of `develop:ai-progress`. */
export interface AiMaskProgressEvent {
  job: number;
  stage: AiMaskStage;
}

/** A model an AI mask needs that is not installed: what the download prompt shows. */
export interface AiModelInfo {
  name: string;
  title: string;
  version: string;
  /** Download size in bytes (all files). */
  bytes: number;
  licence: string;
  licenceUrl: string;
  status: ModelStatus;
}

/** What `generateAiMask` and `samRefineMask` return. */
export interface AiMaskResult {
  /** The raster's cache key (`<appdata>/cache/<hash>/develop/masks/<componentHash>.png`). */
  componentHash: string;
  /** The PNG written (a depth component's depth map); null when a model is missing. */
  path: string | null;
  /** Raster size in pixels (the proxy's); 0 when a model is missing. */
  width: number;
  height: number;
  modelVersion: string;
  /** The component with `model` and `modelVersion` set to what generated it: store this one in the settings. */
  component: DevelopMaskComponent;
  /** Models to download first; empty when the mask was generated. */
  missingModels: AiModelInfo[];
  /** People: the boxes found, as box prompts in the transformed frame (fractions), highest score first. */
  people: [DevelopPoint, DevelopPoint][];
  /** Share of the raster at or above 0.5, 0..1. */
  coverage: number;
  elapsedMs: number;
}

/**
 * Run an AI component's models (subject, background, sky, people, depth) on the photo's proxy, turned as
 * `geometry.rotate`/`flipH`/`flipV` say, and cache the refined raster. Renders pick it up on their own. When a model is
 * not installed it resolves at once with `missingModels` and no `path`. Progress arrives on `develop:ai-progress`.
 */
export function generateAiMask(
  folder: string,
  relPath: string,
  hash: string,
  geometry: DevelopGeometry,
  component: DevelopMaskComponent,
  job: number,
): Promise<AiMaskResult> {
  return invoke<AiMaskResult>('generate_ai_mask', { folder, relPath, hash, geometry, component, job });
}

/**
 * Click-to-refine: a component with `prompts` (points and boxes in transformed-frame fractions) through SAM 2.1,
 * reusing the photo's cached image encoding. Rejects when the component has no prompt.
 */
export function samRefineMask(
  folder: string,
  relPath: string,
  hash: string,
  geometry: DevelopGeometry,
  component: DevelopMaskComponent,
  job: number,
): Promise<AiMaskResult> {
  return invoke<AiMaskResult>('sam_refine_mask', { folder, relPath, hash, geometry, component, job });
}

/** For each component, whether its AI raster (a depth component: its depth map) is cached for the photo `hash`. */
export function aiMaskStatus(hash: string, components: DevelopMaskComponent[]): Promise<boolean[]> {
  return invoke<boolean[]>('ai_mask_status', { hash, components });
}

/** Drop the loaded mask models and the SAM encoding (call when leaving Develop). */
export function releaseAiMasks(): Promise<void> {
  return invoke('release_ai_masks');
}

export function onAiMaskProgress(handler: (event: AiMaskProgressEvent) => void): Promise<UnlistenFn> {
  return listen<AiMaskProgressEvent>('develop:ai-progress', (event) => handler(event.payload));
}

// AI denoise (src-tauri/src/commands/develop.rs, crates/develop/src/ai/denoise.rs, step D5.1). The full run writes
// a 16-bit intermediate per photo and settings key; while `settings.detail.denoise` is set and that intermediate
// exists, every render of the photo starts from it instead of the source.

/** What `denoiseStatus` reports for a photo and its settings. */
export interface DenoiseStatus {
  /** Cache key of the intermediate; null when denoise is off or its model is not in the manifest. */
  key: string | null;
  /** The intermediate for `key` is on disk (renders use it). */
  ready: boolean;
  /** Bytes of the intermediate files (full size and 1600 px copy, with sidecars); 0 when not ready. */
  bytes: number;
  /** The model `settings.detail.denoise.model` maps to, with its install state; null when off or unknown. */
  model: AiModelInfo | null;
}

/** A finished `runDenoise`. */
export interface DenoiseResult {
  key: string;
  /** Absolute path of `<appdata>/cache/<hash>/develop/denoise-<key>.png`. */
  path: string;
  width: number;
  height: number;
  /** 0 when the intermediate already existed. */
  elapsedMs: number;
  /** Execution provider summary, e.g. `CoreML (1 partition, 812/812 nodes)`; empty when nothing ran. */
  engine: string;
  tiles: number;
}

export type DenoiseOutcome =
  | ({ status: 'done' } & DenoiseResult)
  | { status: 'missingModel'; model: AiModelInfo }
  | { status: 'cancelled' };

/** Payload of `develop:denoise-progress`: tiles done of total (`0 / 0` once the model is loaded and the source decoded). */
export interface DenoiseProgressEvent {
  job: number;
  done: number;
  total: number;
}

/** The denoise intermediate's key and state for `settings` (no folder needed: the app cache is keyed by `hash`). */
export function denoiseStatus(hash: string, settings: DevelopSettings): Promise<DenoiseStatus> {
  return invoke<DenoiseStatus>('denoise_status', { hash, settings });
}

/**
 * Denoise the photo at full resolution with `settings.detail.denoise` (rejects when it is null) and write the
 * intermediate. Progress arrives on `develop:denoise-progress` tagged with `job`; `cancelDenoise(job)` stops it
 * between tiles. Resolves `missingModel` at once when the model is not downloaded (offer `downloadModel`).
 */
export function runDenoise(
  folder: string,
  relPath: string,
  hash: string,
  settings: DevelopSettings,
  job: number,
  /** Run again even when the intermediate is on disk (workflow plan 27, Shift + Denoise selected). */
  force?: boolean,
): Promise<DenoiseOutcome> {
  return invoke<DenoiseOutcome>('run_denoise', { folder, relPath, hash, settings, job, ...(force ? { force } : {}) });
}

/** Stop the `runDenoise` job `job` before its next tile; false when it is not running. */
export function cancelDenoise(job: number): Promise<boolean> {
  return invoke<boolean>('cancel_denoise', { job });
}

export function onDenoiseProgress(handler: (event: DenoiseProgressEvent) => void): Promise<UnlistenFn> {
  return listen<DenoiseProgressEvent>('develop:denoise-progress', (event) => handler(event.payload));
}

/**
 * Tuning preview: JPEG bytes of a 512 × 512 crop at 100 % of the upright source around `center` (fractions of that
 * frame), denoised with `settings.detail.denoise`, or the same crop untouched with `before`. Both are rendered with
 * default develop settings so they compare like for like. Rejects with `missingModel: <name>` when the model is
 * not installed.
 */
export function previewDenoiseCrop(
  folder: string,
  relPath: string,
  hash: string,
  settings: DevelopSettings,
  center: [number, number],
  before = false,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('preview_denoise_crop', { folder, relPath, hash, settings, center, before });
}

// AI captions (workflow plan 32, src-tauri/src/commands/ai.rs). The key stays in `<appdata>/ai.env` and never comes
// back; requests are made from Rust with the cached proxies, so only refs and text cross the bridge. Plans 33–35 build
// on these shapes: keep them.

export type AiProvider = 'anthropic';
export type AiEffort = 'low' | 'medium' | 'high';

/** Settings → AI as Rust reports it: whether a key is stored and its last four characters, never the key. */
export interface AiSettings {
  provider: AiProvider;
  /** Default model for captions. */
  model: AiModel;
  /** Default model for the photo index. */
  indexModel: AiModel;
  hasKey: boolean;
  /** `…` plus the key's last four characters. */
  keyHint: string | null;
}

/** A change to the AI settings; absent fields are kept, `key: ''` removes the key. */
export interface AiSettingsUpdate {
  provider?: AiProvider;
  model?: AiModel;
  indexModel?: AiModel;
  key?: string;
}

/**
 * An image a request sends, by reference. `id` comes back on the answer and is never sent. A photo is its cached
 * proxy (`proxy-<developHash>.jpg` when that render exists, else `proxy.jpg`); a file is a page render inside an
 * imported folder or app data. `label` is the text placed before the image (captions only; describe sends `Photo N`).
 */
export type AiImageRef =
  | { id: string; kind: 'photo'; hash: string; developHash?: string | null; label?: string }
  | { id: string; kind: 'file'; path: string; label?: string };

export interface AiRequestOptions {
  /** The settings' default for the command when absent. */
  model?: AiModel;
  /** `low` for describe, `medium` for captions when absent. */
  effort?: AiEffort;
  /** Long edge of the images sent, 256 to 1600 (768 when absent). */
  maxEdge?: number;
  /** Plan 35: output limit of a caption request (thinking included), 1,024 to 16,000 (16,000 when absent). */
  maxTokens?: number;
}

export type AiTimeOfDay = 'dawn' | 'morning' | 'midday' | 'afternoon' | 'evening' | 'night' | 'unknown';

/** What one photo shows (plan 33 stores it as `photos[hash].ai`, adding `model` and `at`). */
export interface AiDescribeEntry {
  /** The ref's id. */
  id: string;
  /** Two short lines. */
  description: string;
  /** People clearly visible. */
  people: number;
  setting: string;
  timeOfDay: AiTimeOfDay;
  /** One word. */
  mood: string;
}

/** One caption: `target` is one of the request's targets (several may share one: variants). */
export interface AiCaption {
  target: string;
  text: string;
  alt: string;
}

/** Who answered and what it cost; on every answer and refusal. */
export interface AiReplyMeta {
  /** The model the request asked for. */
  model: string;
  /** The model that produced the answer: `model`, or a fallback model after a decline. */
  servedBy: string;
  /** A server-side fallback ran (show "answered by <servedBy>"). */
  fellBack: boolean;
  /** Every attempt summed: what the request is billed for. */
  usage: AiUsage;
  /** Per attempt and model, for pricing (`attemptsCost`). */
  attempts: AiAttempt[];
}

/**
 * The answer of an AI request. A refusal is an answer (`message` is "The model declined this page: <reason>"), not an
 * error; network, key and format problems reject with a readable message.
 */
export type AiOutcome<T> =
  | ({ status: 'ok' } & AiReplyMeta & T)
  | ({ status: 'refused'; message: string; reason: string; category: string | null } & AiReplyMeta)
  | { status: 'cancelled' };

export interface AiDescribed {
  /** In ref order; a photo the model skipped is absent. */
  entries: AiDescribeEntry[];
  /** Ids of refs with no cached proxy yet (not sent). */
  missing: string[];
}

export interface AiCaptions {
  captions: AiCaption[];
}

/** One caption request: `system` (style sheet, brief, photo index) is cached for an hour, `prompt` is per request. */
export interface AiCaptionRequest {
  images: AiImageRef[];
  system: string;
  prompt: string;
  /** Allowed `target` values; empty allows any. */
  targets: string[];
  options?: AiRequestOptions;
}

export interface AiTokenCount {
  model: AiModel;
  inputTokens: number;
}

export function readAiSettings(): Promise<AiSettings> {
  return invoke<AiSettings>('read_ai_settings');
}

export function writeAiSettings(update: AiSettingsUpdate): Promise<AiSettings> {
  return invoke<AiSettings>('write_ai_settings', { update });
}

/** Counts a few tokens with the stored key and caption model: proves the key works, costs nothing. */
export function aiTest(): Promise<AiTokenCount> {
  return invoke<AiTokenCount>('ai_test');
}

/** Input tokens of `text` (and `system`) on `model` (the caption model when absent); free. */
export function aiCountTokens(text: string, system?: string, model?: AiModel): Promise<AiTokenCount> {
  return invoke<AiTokenCount>('ai_count_tokens', { text, system: system ?? null, model: model ?? null });
}

/** Describe up to 20 photos (send 8) in one request; `aiCancel(job)` stops it. */
export function aiDescribe(
  refs: AiImageRef[],
  options: AiRequestOptions | undefined,
  job: number,
): Promise<AiOutcome<AiDescribed>> {
  return invoke<AiOutcome<AiDescribed>>('ai_describe', { refs, options: options ?? null, job });
}

/** Captions and alt text for a page; `aiCancel(job)` stops it. */
export function aiCaption(request: AiCaptionRequest, job: number): Promise<AiOutcome<AiCaptions>> {
  return invoke<AiOutcome<AiCaptions>>('ai_caption', { request, job });
}

/** Stop the AI request `job` (it resolves `cancelled`); false when it has not started yet (it stops when it does). */
export function aiCancel(job: number): Promise<boolean> {
  return invoke<boolean>('ai_cancel', { job });
}

// Caption brief (workflow plan 34): "Where and when?" pre-filled from the photos' Exif (`captureSummary`).

/** When and where one photo was taken, from its Exif; null fields are unknown. */
export interface PhotoCaptureInfo {
  /** Relative path as given. */
  path: string;
  /** Local capture time `YYYY-MM-DDTHH:MM:SS`. */
  taken: string | null;
  lat: number | null;
  lon: number | null;
}

/** Capture time and GPS position of `paths` (relative to the imported folder `folder`, at most 1000). */
export function photoCaptureInfo(folder: string, paths: string[]): Promise<PhotoCaptureInfo[]> {
  return invoke<PhotoCaptureInfo[]>('photo_capture_info', { folder, paths });
}

// Export from Develop (workflow plan 11, src-tauri/src/commands/export.rs): presets in `<appData>/export-presets/`,
// the export cache in `<folder>/.photobook-cache/export/<presetHash>/`.

/** One photo of `exportPhoto`. */
export interface ExportItem {
  /** The imported folder (absolute). */
  folder: string;
  relPath: string;
  hash: string;
  settings: DevelopSettings;
  /** Absolute destination folder (created when missing). */
  destDir: string;
  /** File name with the format's extension (`fileName` in `@photobook/shared`). */
  name: string;
  /** EXIF orientation and upright size, for the `crs:` part of an Original export's sidecar (plan 12). */
  orientation?: number;
  width?: number;
  height?: number;
}

export interface ExportResult {
  /** The exported file. */
  path: string;
  bytes: number;
  /** Encoded now; false when copied from the export cache or skipped. */
  encoded: boolean;
  /** The destination already held this export (same size and time as the cache entry); nothing was written. */
  skipped: boolean;
}

export interface ExportStatusItem {
  folder: string;
  /** The source, for an Original export (plan 12). */
  relPath?: string;
  hash: string;
  developHash: string;
  destDir: string;
  name: string;
  /** For an Original export: the edit, orientation and size, so the sidecar is compared too (plan 12). */
  settings?: DevelopSettings;
  orientation?: number;
  width?: number;
  height?: number;
}

export interface ExportState {
  /** In the export cache with these options: exporting it is a copy. */
  cached: boolean;
  /** Already at its destination (skipped when *Skip photos already exported* is on). */
  exported: boolean;
  /** A file that is not an export of this photo with these settings is at the destination: exporting replaces it. */
  replaces: boolean;
}

export interface ExportProgressEvent {
  job: number;
  stage: 'decode' | 'render' | 'encode' | 'copy';
}

/**
 * Export one photo with `options` (an `ExportOptions` of `@photobook/shared`): develop at full resolution, fit,
 * sharpen and encode into the export cache (or reuse its entry), then copy to `item.destDir/item.name`. Stages arrive
 * on `export:progress` tagged with `job`; `cancelDevelop(job)` stops it after the decode or the render, writing
 * nothing (it rejects with `Cancelled`). A destination file that is not an export of this photo is replaced only with
 * `replace` (else it rejects); `presetHash` must be the hash of `options` (Rust recomputes it).
 */
export function exportPhoto(
  item: ExportItem,
  options: ExportOptions,
  presetHash: string,
  skipExported: boolean,
  replace: boolean,
  job: number,
): Promise<ExportResult> {
  return invoke<ExportResult>('export_photo', { item, options, presetHash, skipExported, replace, job });
}

/** Which of `items` are in the export cache for `presetHash` and already at their destination, in order. */
export function exportStatus(
  items: ExportStatusItem[],
  presetHash: string,
  format: ExportFormat,
): Promise<ExportState[]> {
  return invoke<ExportState[]>('export_status', { items, presetHash, format });
}

/**
 * Resolve an export destination: inside an imported folder, or picked in the folder dialog this session. Rejects
 * (out of scope) for a remembered folder after a restart: pick it again.
 */
export function checkExportDest(dir: string): Promise<string> {
  return invoke<string>('check_export_dest', { dir });
}

/** Show an exported file in the Finder. */
export function revealExport(path: string): Promise<void> {
  return invoke('reveal_export', { path });
}

/** Plan 52: open Apple Maps at a position (decimal degrees); rejects for a value that is not one. */
export function openMap(lat: number, lon: number): Promise<void> {
  return invoke('open_map', { lat, lon });
}

/** A proxy's histogram (plan 52): 256 bins each for red, green, blue and Rec. 709 luma. */
export interface Histogram {
  r: number[];
  g: number[];
  b: number[];
  l: number[];
}

/**
 * The histogram of a photo's cached proxy (`hash`: its content hash), or of its developed proxy when `renderKey` is
 * given (the develop hash, plus `-p3` for a Display P3 render). Read from the cache after the first call; rejects
 * while the proxy does not exist yet.
 */
export function histogram(hash: string, renderKey?: string): Promise<Histogram> {
  return invoke<Histogram>('histogram', { hash, developHash: renderKey ?? null });
}

/** The saved export presets as stored (parse each with `parseExportPreset`). */
export function listExportPresets(): Promise<unknown[]> {
  return invoke<unknown[]>('list_export_presets');
}

export function saveExportPreset(preset: ExportPreset): Promise<void> {
  return invoke('save_export_preset', { preset });
}

export function deleteExportPreset(id: string): Promise<void> {
  return invoke('delete_export_preset', { id });
}

export function onExportProgress(handler: (event: ExportProgressEvent) => void): Promise<UnlistenFn> {
  return listen<ExportProgressEvent>('export:progress', (event) => handler(event.payload));
}

// Export formats and extras (workflow plan 12).

/** What this machine can export: HEIC needs macOS. */
export function exportCapabilities(): Promise<{ heic: boolean }> {
  return invoke<{ heic: boolean }>('export_capabilities');
}

/** A watermark PNG stored in `<appData>/watermarks/<id>.png` (`id` its SHA-256). */
export interface WatermarkImage {
  id: string;
  name: string;
  width: number;
  height: number;
}

/** Copy a PNG picked in the open dialog to the watermark store. */
export function importWatermark(path: string): Promise<WatermarkImage> {
  return invoke<WatermarkImage>('import_watermark', { path });
}

// Noise profiles (workflow plan 23, src-tauri/src/commands/noise.rs and crates/develop/src/ai/noise_profile.rs).

/** `variance = a·mean + b` for one channel, linear light. */
export interface NoiseChannelFit {
  a: number;
  b: number;
}

/** RAW (sensor data) and processed files (JPEG, HEIC, PNG) are profiled apart. */
export type NoiseSource = 'raw' | 'processed';

/** A photo's own noise measurement on its 1600 px linear decode. */
export interface NoiseFit {
  /** R, G, B. */
  channels: [NoiseChannelFit, NoiseChannelFit, NoiseChannelFit];
  /** σ at mid-grey (linear 0.18), linear units at the analysed size. `σ / 0.18` is what `suggestedAmount` maps. */
  sigma: number;
  /**
   * 0..1 from the number of fitted flat patches, lowered when mid-grey lies outside `range`; 0 (with σ 0) when too
   * few were found (a busy picture, or one bright all over: snow, overcast sky).
   */
  confidence: number;
  patches: number;
  /** Lowest and highest patch mean the fit used. */
  range: [number, number];
  /** Mid-grey lies outside `range`: σ is read off an extrapolated curve. */
  extrapolated: boolean;
  /** Size of the analysed (1600 px) image. */
  width: number;
  height: number;
}

/** A camera's learned curve at one ISO. */
export interface CameraNoiseProfile {
  make: string;
  model: string;
  source: NoiseSource;
  iso: number;
  channels: [NoiseChannelFit, NoiseChannelFit, NoiseChannelFit];
  sigma: number;
  /** Photos learned at exactly this ISO (0 when there is no entry for it). */
  photos: number;
  /** Photos learned at every ISO of this source. */
  totalPhotos: number;
  /** Fits that agree in the entry (or entries) the curve comes from. */
  agreeing: number;
  /** At least 3 fits agree within 2×: only then is the curve blended in (an unestablished one is only reported). */
  established: boolean;
  /** Read off other ISOs (at most two stops away). */
  interpolated: boolean;
  /** Stops to the ISO the curve was read from (0 for this ISO's own entry); confidence halves per stop. */
  distance: number;
  /** ISOs with an entry, ascending. */
  isos: number[];
}

/** What learning a fit did. */
export type NoiseLearnOutcome = 'added' | 'averaged' | 'alreadyKnown' | 'lowConfidence' | 'outlier' | 'invalid';

/**
 * What `noiseProfile` returns: the photo's own fit (`measured`) and its blend with the camera's learned curve.
 * Use `measured.sigma` (stable and cached; quantise it) for anything that keys files or settings on the noise (plans
 * 24, 27); the blended `sigma` moves as other photos are learned and is only for the badge and the suggestion.
 */
export interface NoiseProfile {
  make?: string;
  model?: string;
  iso?: number;
  source: NoiseSource;
  measured: NoiseFit;
  /** Upright size of the source, when `prepare_asset` has recorded it. */
  sourceSize?: [number, number];
  /**
   * Source long edge over the analysed long edge (≥ 1), when known. σ at full size is about `σ × scale` for white
   * noise; for the correlated noise of real files it lies between `σ` and `σ × scale`.
   */
  scale?: number;
  /** The camera's curve at this ISO before this photo was learned (what `measured` is blended with). */
  learned: CameraNoiseProfile | null;
  learn: NoiseLearnOutcome | null;
  /** Photos behind the camera's entry at exactly this ISO now, this one included (0 without camera data). */
  photos: number;
  /** The blend (only an established learned curve is blended in). */
  channels: [NoiseChannelFit, NoiseChannelFit, NoiseChannelFit];
  /** σ at mid-grey of the blend, for the badge and the suggested amount; not stable, never a key. */
  sigma: number;
  confidence: number;
}

/**
 * Measure a photo's noise (cached in `<appdata>/cache/<hash>/noise.json`; a RAW decode takes about a second the
 * first time), learn it into `<appdata>/noise-profiles/<make>-<model>.json` and return the blend.
 */
export function noiseProfile(folder: string, relPath: string, hash: string): Promise<NoiseProfile> {
  return invoke<NoiseProfile>('noise_profile', { folder, relPath, hash });
}

/**
 * A camera's learned curve at `iso` for `source` (RAW and processed files are learned apart), interpolated between
 * known ISOs at most two stops away, or null.
 */
export function cameraProfile(
  make: string,
  model: string,
  iso: number,
  source: NoiseSource,
): Promise<CameraNoiseProfile | null> {
  return invoke<CameraNoiseProfile | null>('camera_profile', { make, model, iso, source });
}

/** Fold a fit into the camera's profile at `iso` (once per photo `hash`, a SHA-256 hex digest; invalid fits are refused). */
export function learnProfile(
  make: string,
  model: string,
  iso: number,
  source: NoiseSource,
  hash: string,
  fit: NoiseFit,
): Promise<{ outcome: NoiseLearnOutcome; profile: CameraNoiseProfile | null }> {
  return invoke('learn_profile', { make, model, iso, source, hash, fit });
}

// Slideshow video (workflow plan 16, src-tauri/src/commands/video.rs) and Settings → Tools (commands/tools.rs).

/**
 * Render every frame of slideshow `output` into run `run`'s own folder (the CLI's `render-slideshow`); lines and exit
 * as `video:line` / `video:exit`.
 */
export function runSlideshowFrames(job: number, project: string, output: string, run: string): Promise<void> {
  return invoke('run_slideshow_frames', { job, project, output, run });
}

/** `video:exit`: `code` is null when a signal ended the CLI; `cancelled` says whether a cancel did. */
export interface VideoExitEvent {
  job: number;
  code: number | null;
  signal: number | null;
  cancelled: boolean;
}

export interface SlideshowPreflightRequest {
  project: string;
  output: string;
  dest: string;
  fileName: string;
  audioPath?: string;
  frames: number;
  width: number;
  height: number;
}

export interface SlideshowPreflight {
  /** The FFmpeg the encode will run. */
  ffmpeg: string;
  /** The video file exists already: ask before replacing it. */
  targetExists: boolean;
  neededBytes: number;
  freeBytes: number | null;
}

/** Everything an export needs, checked before a frame is rendered (FFmpeg and its encoder, audio, destination, disk). */
export function slideshowPreflight(request: SlideshowPreflightRequest): Promise<SlideshowPreflight> {
  return invoke<SlideshowPreflight>('slideshow_preflight', { request });
}

/** Whether `<dest>/<fileName>` exists. */
export function videoTargetExists(dest: string, fileName: string): Promise<boolean> {
  return invoke<boolean>('video_target_exists', { dest, fileName });
}

export interface EncodeSlideshowRequest {
  project: string;
  output: string;
  /** The export's run id (its frame folder). */
  run: string;
  /** Replace an existing video file (the sheet asked). */
  replace?: boolean;
  /** Destination folder (checked like an export's). */
  dest: string;
  /** `<slug>.mp4`. */
  fileName: string;
  /** The imported audio (`importAudio`). */
  audioPath?: string;
  /** Bits per second. */
  bitrate: number;
}

/** Encode the rendered frames with FFmpeg; the video's path, or null when cancelled (nothing is left then). */
export function encodeSlideshow(job: number, request: EncodeSlideshowRequest): Promise<string | null> {
  return invoke<string | null>('encode_slideshow', { job, request });
}

/** Kill a frames or encode job (or keep it from starting). */
export function cancelVideo(job: number): Promise<void> {
  return invoke('cancel_video', { job });
}

/** Delete run `run`'s rendered frames of slideshow `output`. */
export function discardSlideshowFrames(project: string, output: string, run: string): Promise<void> {
  return invoke('discard_slideshow_frames', { project, output, run });
}

export interface VideoProgressEvent {
  job: number;
  frame: number;
  total: number;
}

export function onVideoLine(handler: (event: PublishLineEvent) => void): Promise<UnlistenFn> {
  return listen<PublishLineEvent>('video:line', (e) => handler(e.payload));
}

export function onVideoExit(handler: (event: VideoExitEvent) => void): Promise<UnlistenFn> {
  return listen<VideoExitEvent>('video:exit', (e) => handler(e.payload));
}

export function onVideoProgress(handler: (event: VideoProgressEvent) => void): Promise<UnlistenFn> {
  return listen<VideoProgressEvent>('video:progress', (e) => handler(e.payload));
}

export interface AudioFile {
  /** `<appdata>/audio/<sha256>.<ext>`. */
  path: string;
  /** The name it was picked as. */
  name: string;
}

/** Copy an audio file picked in the dialog into the app data dir. */
export function importAudio(path: string): Promise<AudioFile> {
  return invoke<AudioFile>('import_audio', { path });
}

/** An external tool (FFmpeg) and where it is. */
export interface ToolStatus {
  name: string;
  title: string;
  version: string;
  licence: string;
  licenceUrl: string;
  homepage: string;
  /** Download size for this machine; null when there is no build for it. */
  bytes: number | null;
  installedPath: string | null;
  systemPath: string | null;
  /** The one slideshows run: the downloaded one, else the one on PATH. */
  activePath: string | null;
  job: number | null;
}

export interface ToolCheck {
  path: string;
  version: string;
  /** Whether it has `encoder` (H.264 through VideoToolbox on macOS). */
  h264: boolean;
  encoder: string;
}

export function toolStatus(name: string): Promise<ToolStatus> {
  return invoke<ToolStatus>('tool_status', { name });
}

export function downloadTool(name: string, job: number): Promise<ToolStatus> {
  return invoke<ToolStatus>('download_tool', { name, job });
}

export function cancelToolDownload(job: number): Promise<void> {
  return invoke('cancel_tool_download', { job });
}

export function deleteTool(name: string): Promise<ToolStatus> {
  return invoke<ToolStatus>('delete_tool', { name });
}

export function checkTool(name: string): Promise<ToolCheck> {
  return invoke<ToolCheck>('check_tool', { name });
}

export function onToolProgress(
  handler: (event: { job: number; name: string; received: number; total: number }) => void,
): Promise<UnlistenFn> {
  return listen<{ job: number; name: string; received: number; total: number }>('tools:progress', (e) =>
    handler(e.payload),
  );
}

// Plan 43: the native menu bar (src-tauri/src/menu.rs), installed only behind the VITE_PHOTOBOOK_NATIVE_MENU flag.

/** A native menu item: an app item (emits `native-menu` with its id) or a separator. */
export type NativeMenuItemSpec =
  | { kind: 'separator' }
  | {
      kind: 'item';
      id: string;
      label: string;
      /** Tauri accelerator syntax, e.g. `CmdOrCtrl+Shift+Z`. */
      accelerator?: string;
      /** The system Edit item that stands in for this one while a text field has focus. */
      textEdit?: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';
    };

export interface NativeMenuSpec {
  submenus: { title: string; items: NativeMenuItemSpec[] }[];
}

export function installNativeMenu(spec: NativeMenuSpec): Promise<void> {
  return invoke('install_native_menu', { spec });
}

/** Tell the menu whether a text field has focus (its Edit items then act on the field). */
export function setTextFocus(focused: boolean): Promise<void> {
  return invoke('set_text_focus', { focused });
}

/** A native menu item was chosen (by click or by its accelerator). */
export function onNativeMenu(handler: (id: string) => void): Promise<UnlistenFn> {
  return listen<string>('native-menu', (e) => handler(e.payload));
}

// ---- Plan 46: haptics (src-tauri/src/commands/haptic.rs) ----

/** The three `NSHapticFeedbackPattern`s. */
export type HapticKind = 'alignment' | 'levelChange' | 'generic';

/** One haptic tick on a Force Touch trackpad; a no-op without one and off macOS. Call `tick` in `lib/haptic.ts`. */
export function haptic(kind: HapticKind): Promise<void> {
  return invoke('haptic', { kind });
}

// ---- Plan 42: rejects to the Trash (src-tauri/src/commands/photos.rs) ----

/** What happened to one file of `trashPhotos`. */
export interface TrashResult {
  /** The relative path as given. */
  path: string;
  /** The photo is in the Trash. */
  ok: boolean;
  /** Why the photo was skipped (`ok: false`), or why a sidecar stayed (`ok: true`). */
  error?: string;
  /** Sidecars (`.xmp`) moved along, relative to the folder. */
  sidecars: string[];
}

/**
 * Move photos of imported folder `folder` (relative paths) to the system Trash, each with its `<file>.xmp` and, once no
 * other photo of the same stem stays, its `<stem>.xmp`. One result per path; a refused or failed file never stops the
 * rest. Rejects only when `folder` is not an imported root. The reject pile is the only caller (no key reaches it).
 */
export function trashPhotos(folder: string, relPaths: string[]): Promise<TrashResult[]> {
  return invoke<TrashResult[]>('trash_photos', { folder, relPaths });
}
