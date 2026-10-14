#!/usr/bin/env -S tsx --conditions=source
import { parseArgs } from 'node:util';
import { loadConfig, requireR2 } from '../src/config.js';
import { parseFrameList, renderFrames } from '../src/frames.js';
import { createReporter } from '../src/log.js';
import { renderPrint } from '../src/print.js';
import { createStore, publish, UploadError } from '../src/publish.js';
import { renderSlideshow } from '../src/slideshow.js';
import { clearSitePassword, unpublish } from '../src/unpublish.js';

const USAGE = `Usage:
  photobook publish <project.json> [--dry-run] [--prune] [--skip-pages] [--no-record] [--ignore-library]
  photobook unpublish <project.json>
  photobook render-frames <project.json> --output <id> --out <dir> [--frames 1,2] [--format jpeg|png]
                          [--quality 92] [--caption] [--prepare] [--clean]
  photobook print <project.json> --output <id> --out <file.pdf> [--png] [--dpi 300]
  photobook render-slideshow <project.json> --output <id> [--out <dir>]
  photobook password clear      Remove the old site-wide password (passwords are per book now)
  photobook looks [--json]      List the built-in looks (id, name, starting Amount, description)
  photobook stats <folder> [--json]
                                Print the capture time, camera, lens, hash and stats of a folder's photos
                                (from its .photobook/index.json; debug)
  photobook doctor

Options:
  --dry-run     Print the publish plan without uploading anything
  --prune       Delete objects under the book's image prefix that the new manifest no longer references
  --skip-pages  Do not render page images (no Instagram share PNGs; thumbnails use the first photo).
                Rendering needs Chromium: pnpm --filter @photobook/publish exec playwright install chromium
  --no-record   Do not write publish.lastPublishedAt into the project file (the editor records it itself)
  --ignore-library
                Publish even when a folder's .photobook/library.json (and its .bak) cannot be read; its ratings
                and edits are then left out (the default is to stop)
  render-frames writes a social post's frames as <dir>/01.jpg … NN.jpg at the network's size (Chromium, as
  page images); --caption also writes <dir>/caption.txt (with --frames "" only that), --prepare only processes
  the post's photos into the publish cache, --clean first removes earlier frames it will not write (and temp files).
  print writes a print output as a PDF at its paper size plus bleed (and crop marks when on), photos at its dpi
  from the full-size renders; --png writes one proof PNG per sheet into the --out folder instead.

  render-slideshow writes every frame of a slideshow as <dir>/000001.jpg … (default
  <project dir>/.photobook-publish/slideshow/<id>/) and frames.json, for the editor to encode with FFmpeg.

  --env <file>  Settings file (default: $PHOTOBOOK_ENV or the editor's app data dir, see docs/PUBLISHING.md)
  --json        One JSON object per line instead of human output (used by the editor)
  -h, --help    Show this help`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      prune: { type: 'boolean', default: false },
      'skip-pages': { type: 'boolean', default: false },
      'no-record': { type: 'boolean', default: false },
      'ignore-library': { type: 'boolean', default: false },
      env: { type: 'string' },
      output: { type: 'string' },
      out: { type: 'string' },
      frames: { type: 'string' },
      format: { type: 'string' },
      quality: { type: 'string' },
      caption: { type: 'boolean', default: false },
      prepare: { type: 'boolean', default: false },
      clean: { type: 'boolean', default: false },
      png: { type: 'boolean', default: false },
      dpi: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const reporter = createReporter(values.json ? 'json' : 'human');
  const [command, arg] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  // Plan 21: the built-in looks are data in @photobook/shared; listing them needs no settings.
  if (command === 'looks') {
    const { BUILT_IN_LOOK_DEFS, formatLookList } = await import('@photobook/shared');
    console.log(values.json ? JSON.stringify(BUILT_IN_LOOK_DEFS, null, 2) : formatLookList());
    return 0;
  }
  // Plan 38: reads the folder's index only; needs no settings either.
  if (command === 'stats') {
    if (!arg) throw new Error(USAGE);
    const { formatFolderStats, readFolderStats } = await import('../src/stats.js');
    const photos = await readFolderStats(arg);
    console.log(values.json ? JSON.stringify(photos, null, 2) : formatFolderStats(photos));
    return 0;
  }
  const config = await loadConfig({ envPath: values.env });

  try {
    switch (command) {
      case 'publish': {
        if (!arg) throw new Error(USAGE);
        await publish({
          projectPath: arg,
          config,
          reporter,
          dryRun: values['dry-run'],
          prune: values.prune,
          skipPages: values['skip-pages'],
          record: !values['no-record'],
          ignoreLibrary: values['ignore-library'],
        });
        return 0;
      }
      case 'render-frames': {
        if (!arg || !values.output) throw new Error(USAGE);
        const format = values.format ?? 'jpeg';
        if (format !== 'jpeg' && format !== 'png') throw new Error(`--format must be jpeg or png, got "${format}"`);
        const quality = values.quality === undefined ? undefined : Number(values.quality);
        if (quality !== undefined && !(Number.isInteger(quality) && quality >= 1 && quality <= 100)) {
          throw new Error(`--quality must be 1 to 100, got "${values.quality}"`);
        }
        const { files, caption } = await renderFrames({
          projectPath: arg,
          outputId: values.output,
          outDir: values.out,
          frames: values.frames === undefined ? undefined : parseFrameList(values.frames),
          format,
          quality,
          caption: values.caption,
          prepare: values.prepare,
          clean: values.clean,
          config,
          reporter,
        });
        reporter.info(
          values.prepare ? 'Photos ready' : `Wrote ${files.length} frame(s)${caption ? ' and the caption' : ''}`,
        );
        return 0;
      }
      case 'print': {
        if (!arg || !values.output || !values.out) throw new Error(USAGE);
        const dpi = values.dpi === undefined ? undefined : Number(values.dpi);
        if (dpi !== undefined && !(Number.isInteger(dpi) && dpi >= 72 && dpi <= 600)) {
          throw new Error(`--dpi must be 72 to 600, got "${values.dpi}"`);
        }
        const { files, sheets } = await renderPrint({
          projectPath: arg,
          outputId: values.output,
          out: values.out,
          png: values.png,
          dpi,
          config,
          reporter,
        });
        reporter.info(values.png ? `Wrote ${files.length} proof sheet(s)` : `Wrote ${files[0]} (${sheets} sheet(s))`);
        return 0;
      }
      case 'render-slideshow': {
        if (!arg || !values.output) throw new Error(USAGE);
        const { dir, manifest, rendered } = await renderSlideshow({
          projectPath: arg,
          outputId: values.output,
          outDir: values.out,
          config,
          reporter,
        });
        reporter.info(`Wrote ${manifest.frames} frame(s) (${rendered} drawn) of ${manifest.slides} slide(s) to ${dir}`);
        return 0;
      }
      case 'unpublish': {
        if (!arg) throw new Error(USAGE);
        const { loadBook } = await import('@photobook/shared');
        const { readFile } = await import('node:fs/promises');
        const book = loadBook(JSON.parse(await readFile(arg, 'utf8')));
        const r2 = requireR2(config);
        const { deleted } = await unpublish({
          slug: book.publish.slug,
          store: createStore(config),
          reporter,
          projectPath: arg,
          bucket: r2.bucket,
        });
        reporter.info(`Unpublished ${book.publish.slug}: ${deleted} object(s) deleted`);
        return 0;
      }
      case 'password': {
        if (arg !== 'clear') throw new Error(USAGE);
        await clearSitePassword({ store: createStore(config), reporter, apiUrl: config.social.apiUrl });
        return 0;
      }
      case 'doctor': {
        const r2 = requireR2(config);
        const store = createStore(config);
        reporter.info(`Settings from ${config.source}`);
        reporter.info(`Bucket ${r2.bucket} via ${r2.transport}, public URL ${r2.publicUrl}`);
        // The wrangler transport cannot HEAD, so read the file instead (also proves the login works).
        const exists =
          r2.transport === 'wrangler' ? (await store.get('site.json')) !== null : await store.exists('site.json');
        reporter.info(
          exists
            ? 'site.json found: the bucket is reachable'
            : 'Reached the bucket; no site.json yet (first publish creates it)',
        );
        return 0;
      }
      default:
        console.log(USAGE);
        return 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter.emit({ type: 'error', message, keys: err instanceof UploadError ? err.keys : undefined });
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
