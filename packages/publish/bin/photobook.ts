#!/usr/bin/env -S tsx --conditions=source
import { parseArgs } from 'node:util';
import { loadConfig, requireR2 } from '../src/config.js';
import { createReporter } from '../src/log.js';
import { createStore, publish, UploadError } from '../src/publish.js';
import { syncPassword, unpublish } from '../src/unpublish.js';

const USAGE = `Usage:
  photobook publish <project.json> [--dry-run] [--prune] [--skip-pages] [--no-record]
  photobook unpublish <project.json>
  photobook password sync | clear
  photobook doctor

Options:
  --dry-run     Print the publish plan without uploading anything
  --prune       Delete objects under the book's image prefix that the new manifest no longer references
  --skip-pages  Do not render page images (no Instagram share PNGs; thumbnails use the first photo).
                Rendering needs Chromium: pnpm --filter @photobook/publish exec playwright install chromium
  --no-record   Do not write publish.lastPublishedAt into the project file (the editor records it itself)
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
      env: { type: 'string' },
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
        });
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
        if (arg !== 'sync' && arg !== 'clear') throw new Error(USAGE);
        await syncPassword({
          store: createStore(config),
          reporter,
          word: config.sitePassword,
          expiresAt: config.sitePasswordExpiresAt,
          clear: arg === 'clear',
          apiUrl: config.social.apiUrl,
        });
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
