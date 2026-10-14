import { markInput, onPaint, type PaintSample } from '../../components/develop/previewTiming';
import { setRawPreviewOverride } from '../../components/develop/rawPreview';
import { router } from '../../router';
import { beginDevelopDrag, endDevelopDrag, useBookStore } from '../../store/book';
import { useLibraryStore } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { devLog } from '../log';

/**
 * Workflow plan 36 (platform budgets): a scripted run of the dev build for `docs/design/PLATFORM_BUDGETS.md`, started
 * by `main.tsx` only when the dev server runs with `VITE_PHOTOBOOK_BENCH=1` (`scripts/measure/README.md`). Nothing here
 * runs in a normal session or a release build.
 *
 * 1. Waits for the reopened project (`recent.json`) and for every imported folder to finish scanning, hashing and
 *    preparing thumbnails and proxies, then holds the Design view for a memory sample (`checkpoint design`).
 * 2. Opens the folder's Cull grid and holds it (`checkpoint cull`).
 * 3. Opens Develop on the first photo and drives the Exposure slider through the store (the slider's own action,
 *    `setAssetDevelop` inside `beginDevelopDrag` / `endDevelopDrag`), once on the JPEG path and once on the raw RGBA
 *    path: single steps with a pause after each (`step`), then a 60 Hz drag (`drag`). Each painted frame logs
 *    `[photobook:develop] slider→paint`; the bench logs the medians. The photo's develop is reset at the end.
 * 4. Holds Develop for a last memory sample (`checkpoint develop`) and logs `done`.
 *
 * Checkpoints hold for `VITE_PHOTOBOOK_BENCH_HOLD_MS` (default 30 s) so `scripts/measure/sample-memory.sh` can read
 * the processes' footprints.
 */

const log = (msg: string, data?: unknown) => devLog('bench', msg, data);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(what: string, test: () => boolean, timeoutMs: number, everyMs = 250): Promise<void> {
  const start = performance.now();
  while (!test()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

function holdMs(): number {
  const v = Number(import.meta.env.VITE_PHOTOBOOK_BENCH_HOLD_MS);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
}

async function checkpoint(name: string, data?: unknown): Promise<void> {
  log(`checkpoint ${name}`, data);
  await sleep(holdMs());
  log(`checkpoint ${name} end`);
}

function stats(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))] : NaN);
  return { n: s.length, min: s[0] ?? NaN, median: at(0.5), p90: at(0.9), max: s[s.length - 1] ?? NaN };
}

function summary(samples: PaintSample[]) {
  return {
    sliderToPaint: stats(samples.map((s) => s.ms)),
    request: stats(samples.map((s) => s.request)).median,
    decode: stats(samples.map((s) => s.decode)).median,
  };
}

function settled(): boolean {
  const folders = Object.values(useLibraryStore.getState().folders);
  return (
    folders.length > 0 &&
    folders.every((f) => f.scanned && !f.busy && f.progress.total > 0 && f.progress.prepared >= f.progress.total)
  );
}

/** Move Exposure through `values`, `gapMs` apart, as one drag; resolves with the frames painted until `tailMs` after. */
async function drive(id: string, values: number[], gapMs: number, waitPaint: boolean): Promise<PaintSample[]> {
  const samples: PaintSample[] = [];
  let next: (() => void) | null = null;
  const off = onPaint((s) => {
    samples.push(s);
    next?.();
  });
  beginDevelopDrag();
  try {
    for (const exposure of values) {
      const before = samples.length;
      markInput();
      useBookStore.getState().setAssetDevelop(id, { light: { exposure } });
      if (waitPaint) {
        await Promise.race([
          new Promise<void>((r) => {
            next = () => {
              if (samples.length > before) r();
            };
          }),
          sleep(2000),
        ]);
        next = null;
      }
      await sleep(gapMs);
    }
    await sleep(1000);
  } finally {
    endDevelopDrag();
    off();
  }
  return samples;
}

export async function runBudgetsBench(): Promise<void> {
  try {
    log('start', { hold: holdMs() });
    await until('a project', () => useBookStore.getState().book !== null, 180_000);
    const book = useBookStore.getState().book;
    const projectId = useBookStore.getState().projectId;
    await until('the folders to settle', settled, 900_000, 1000);
    const folders = useLibraryStore.getState().folders;
    const photos = Object.values(folders).reduce((n, f) => n + f.progress.total, 0);
    await checkpoint('design', {
      projectId,
      pages: book?.pages.length,
      assets: Object.keys(book?.assets ?? {}).length,
      photos,
    });

    const folderId = Object.keys(useLibraryStore.getState().folders)[0];
    if (!folderId) throw new Error('no imported folder');
    await router.navigate({ to: '/library/$folderId/cull', params: { folderId } });
    await checkpoint('cull', { folderId });

    await router.navigate({ to: '/library/$folderId/develop', params: { folderId } });
    await until('a Develop session', () => (useUiStore.getState().develop?.ids.length ?? 0) > 0, 30_000);
    const session = useUiStore.getState().develop;
    const id = session?.ids[session.index];
    if (!id) throw new Error('no photo in Develop');
    const path = id.slice(folderId.length + 1);
    await until(
      'the proxy',
      () => Boolean(useLibraryStore.getState().folders[folderId]?.photos[path]?.proxyUrl),
      60_000,
    );
    log('develop photo', { id });
    await sleep(3000);

    const results: Record<string, unknown> = {};
    for (const raw of [false, true]) {
      const path = raw ? 'raw' : 'jpeg';
      setRawPreviewOverride(raw);
      // Warm-up: the first render decodes the proxy into the cached Developer.
      await drive(id, [0.05], 0, true);
      await sleep(1500);
      const steps = Array.from({ length: 20 }, (_, i) => 0.1 + 0.05 * i);
      const step = await drive(id, steps, 150, true);
      const drag = await drive(
        id,
        Array.from({ length: 90 }, (_, i) => 1.1 - 0.02 * i),
        16,
        false,
      );
      results[path] = { step: summary(step), drag: summary(drag) };
      log(`slider ${path}`, results[path]);
      await sleep(1000);
    }
    setRawPreviewOverride(null);
    useBookStore.getState().resetAssetDevelop(id);
    await sleep(1500);
    log('slider summary', results);

    await checkpoint('develop', { id });
    log('done');
  } catch (err) {
    setRawPreviewOverride(null);
    log('failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
