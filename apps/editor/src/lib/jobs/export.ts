import {
  createDevelop,
  type DevelopSettings,
  defaultExportDir,
  developHash,
  type ExportOptions,
  type ExportPreset,
  exportExtension,
  fileName,
  presetHash,
  stemOf,
  uniqueFileNames,
} from '@photobook/shared';
import { useBookStore } from '../../store/book';
import { cancelJob, enqueue, JobCancelled, type JobHandle } from '../../store/jobs';
import {
  assetDevelop,
  assetRating,
  isPhotoKey,
  libraryFolderAt,
  photoMeta,
  useLibraryStore,
} from '../../store/library';
import { nextDenoiseJob } from '../denoise';
import { errorMessage } from '../errors';
import { devLog } from '../log';
import { basename } from '../path';
import {
  cancelDevelop,
  type ExportItem,
  type ExportResult,
  type ExportState,
  exportPhoto,
  exportStatus,
  onExportProgress,
} from '../tauri';
import { enqueueDenoise } from './denoise';

/**
 * Export from Develop (workflow plan 11): photo ids (project asset ids or library keys) become export items, one
 * `export` job per photo (the export lane runs two at a time), each calling `export_photo`. A photo whose denoise is
 * on waits for its denoise job first (joined when one is already queued), so the export never caches a render without
 * it. The run's results feed the completion toast (`store/exports.ts`).
 */

/** A photo ready to export: what `export_photo` and the naming tokens need. */
export interface ExportPhoto {
  id: string;
  /** The file name, for the jobs list. */
  label: string;
  /** Absolute imported folder. */
  folder: string;
  relPath: string;
  hash: string;
  settings: DevelopSettings;
  rating: number;
  /** Capture time (the file time until EXIF dates are read), epoch ms. */
  date: number | null;
  /** The open project, for a project asset (closing it cancels the job). */
  project: string | null;
  /** EXIF orientation and upright size (an Original export's sidecar records them for Lightroom). */
  orientation?: number;
  width?: number;
  height?: number;
}

/** One photo of an export with its destination and name. */
export interface PlannedExport {
  photo: ExportPhoto;
  item: ExportItem;
  developHash: string;
}

/** Folders whose library is not loaded yet are read first, so a library photo exports with its edit. */
async function loadLibraries(folders: Iterable<string>): Promise<void> {
  const book = useBookStore.getState();
  for (const folder of new Set(folders)) {
    if (Object.hasOwn(useBookStore.getState().libraries, folder)) continue;
    try {
      await book.loadLibrary(folder);
    } catch (err) {
      devLog('export', 'library not read', { folder, error: errorMessage(err) });
    }
  }
}

/**
 * The photos of `ids` that can be exported (known, hashed, in an imported folder), in order, with the edit each shows
 * (Develop's version choice for the photo it shows); `missing` counts the rest.
 */
export async function resolveExportPhotos(ids: readonly string[]): Promise<{ photos: ExportPhoto[]; missing: number }> {
  const metas = ids.map((id) => ({ id, meta: photoMeta(useBookStore.getState(), id) }));
  await loadLibraries(metas.flatMap(({ meta }) => (meta?.folder ? [meta.folder] : [])));
  const view = useBookStore.getState();
  const photos: ExportPhoto[] = [];
  let missing = 0;
  for (const { id, meta } of metas) {
    if (!meta?.hash || !meta.folder) {
      missing += 1;
      continue;
    }
    const asset = view.book?.assets[id];
    const file = libraryFolderAt(useLibraryStore.getState(), meta.folder)?.photos[meta.path];
    photos.push({
      id,
      label: basename(meta.path),
      folder: meta.folder,
      relPath: meta.path,
      hash: meta.hash,
      settings: assetDevelop(view, id) ?? createDevelop(),
      rating: assetRating(view, id) ?? 0,
      date: asset?.mtime ?? file?.mtime ?? null,
      project: !isPhotoKey(id) && asset ? view.projectId : null,
      ...(meta.orientation !== undefined ? { orientation: meta.orientation } : {}),
      ...(meta.width ? { width: meta.width } : {}),
      ...(meta.height ? { height: meta.height } : {}),
    });
  }
  return { photos, missing };
}

/** Where each photo goes and under which name (`{seq}` follows the order given; names are unique per folder). */
export async function planExport(photos: readonly ExportPhoto[], preset: ExportPreset): Promise<PlannedExport[]> {
  const format = preset.options.format;
  const dests = photos.map((p) => preset.destination ?? defaultExportDir(p.folder, preset.name));
  const names = photos.map((p, i) =>
    fileName(preset.naming, {
      name: stemOf(p.relPath),
      seq: i + 1,
      total: photos.length,
      date: p.date,
      rating: p.rating,
      format,
      sourceExt: exportExtension('original', p.relPath),
    }),
  );
  // Unique within each destination folder, in order.
  const byDest = new Map<string, number[]>();
  dests.forEach((dest, i) => {
    byDest.set(dest, [...(byDest.get(dest) ?? []), i]);
  });
  for (const indexes of byDest.values()) {
    // An Original export writes `<stem>.xmp` beside each copy: stems must be unique too.
    const unique = uniqueFileNames(
      indexes.map((i) => names[i] ?? ''),
      { byStem: format === 'original' },
    );
    indexes.forEach((i, k) => {
      names[i] = unique[k] ?? names[i] ?? '';
    });
  }
  const hashes = await Promise.all(photos.map((p) => developHash(p.settings)));
  return photos.map((photo, i) => ({
    photo,
    developHash: hashes[i] ?? '',
    item: {
      folder: photo.folder,
      relPath: photo.relPath,
      hash: photo.hash,
      settings: photo.settings,
      destDir: dests[i] ?? '',
      name: names[i] ?? '',
      ...(photo.orientation !== undefined ? { orientation: photo.orientation } : {}),
      ...(photo.width !== undefined ? { width: photo.width } : {}),
      ...(photo.height !== undefined ? { height: photo.height } : {}),
    },
  }));
}

/**
 * The dialog's count: how many photos, how many are cached, how many already sit at their destination, and how many
 * destination files are something else (another photo, an unrelated file) that the export would replace.
 */
export interface ExportCounts {
  total: number;
  cached: number;
  exported: number;
  replaces: number;
}

export async function exportCounts(planned: readonly PlannedExport[], preset: ExportPreset): Promise<ExportCounts> {
  if (planned.length === 0) return { total: 0, cached: 0, exported: 0, replaces: 0 };
  let states: ExportState[] = [];
  try {
    states = await exportStatus(
      planned.map(({ item, developHash: dh }) => ({
        folder: item.folder,
        relPath: item.relPath,
        hash: item.hash,
        developHash: dh,
        destDir: item.destDir,
        name: item.name,
        ...(preset.options.format === 'original'
          ? { settings: item.settings, orientation: item.orientation, width: item.width, height: item.height }
          : {}),
      })),
      await presetHash(preset.options),
      preset.options.format,
    );
  } catch (err) {
    devLog('export', 'status unavailable', { error: errorMessage(err) });
  }
  return {
    total: planned.length,
    cached: states.filter((s) => s.cached).length,
    exported: states.filter((s) => s.exported).length,
    replaces: states.filter((s) => s.replaces).length,
  };
}

const STAGES = { decode: 1, render: 2, encode: 3, copy: 3 } as const;
const STAGE_TEXT = { decode: 'decoding', render: 'developing', encode: 'encoding', copy: 'copying from the cache' };

/** The key under which equal exports share one job: the same cache entry to the same destination file. */
export const exportJobKey = (hash: string, planned: PlannedExport): string =>
  `export:${hash}:${planned.item.hash}-${planned.developHash}:${planned.item.destDir}/${planned.item.name}`;

/**
 * Queue the export of one photo as an `export` job: progress from `export:progress` (decode, develop, encode),
 * Cancel through `cancelDevelop` (nothing is written). With denoise on it first waits for the photo's denoise job.
 * An equal export already queued or running (`exportJobKey`: a second click on Export) is joined, not queued again.
 * `replace` lets it overwrite a destination file that is not an export of this photo (confirmed in the dialog).
 */
export function enqueueExport(options: {
  planned: PlannedExport;
  exportOptions: ExportOptions;
  presetHash: string;
  skipExported: boolean;
  replace?: boolean;
}): JobHandle<ExportResult> {
  const { planned, exportOptions, presetHash: hash, skipExported, replace = false } = options;
  const { photo, item } = planned;
  return enqueue({
    kind: 'export',
    label: photo.label,
    ref: photo.id,
    project: photo.project,
    dedupe: exportJobKey(hash, planned),
    run: async (ctx) => {
      // An Original export copies the source: nothing is developed, so nothing waits for denoise.
      if (photo.settings.detail.denoise && exportOptions.format !== 'original') {
        ctx.progress(0, 0, 'waiting for denoise');
        const denoise = enqueueDenoise({
          folder: photo.folder,
          relPath: photo.relPath,
          hash: photo.hash,
          settings: photo.settings,
          label: photo.label,
          ref: photo.id,
          project: photo.project,
        });
        // Cancelling the export stops a denoise it started (one it joined goes on for whoever asked first).
        ctx.onCancel(() => {
          if (denoise.created) cancelJob(denoise.id);
        });
        const outcome = await denoise.result;
        if (ctx.cancelled) throw new JobCancelled();
        if (outcome.state === 'failed') throw outcome.cause instanceof Error ? outcome.cause : new Error(outcome.error);
        if (outcome.state === 'cancelled') throw new Error('Its denoise was cancelled');
      }
      const job = nextDenoiseJob();
      ctx.progress(0, 3, 'starting');
      const unlisten = await onExportProgress((e) => {
        if (e.job === job) ctx.progress(STAGES[e.stage] - 1, 3, STAGE_TEXT[e.stage]);
      });
      ctx.onCancel(() => cancelDevelop(job));
      try {
        if (ctx.cancelled) throw new JobCancelled();
        return await exportPhoto(item, exportOptions, hash, skipExported, replace, job);
      } catch (err) {
        if (errorMessage(err) === 'Cancelled') throw new JobCancelled();
        throw err;
      } finally {
        unlisten();
      }
    },
  });
}
