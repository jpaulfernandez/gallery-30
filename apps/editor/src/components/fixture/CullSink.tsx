import { emptyLibrary } from '@photobook/shared';
import { fixtureResolve } from '@photobook/shared/fixtures';
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useState } from 'react';
import type { AssetFile } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useJobsStore } from '../../store/jobs';
import { type PhotoFile, photoKey, useLibraryStore } from '../../store/library';
import { COMPOSITION_GUIDES, EMPTY_SELECTION, useUiStore } from '../../store/ui';
import { AssistMenu, COMPOSITION_LABELS, CompositionGuides, SharpnessMeter } from '../cull/AssistOverlays';
import { CullCell, type CullCellProps, CullGrid, FocusRing, type LensBadge } from '../cull/CullGrid';
import { HistogramSvg, PhotoPane } from '../cull/PhotoPane';
import { Button } from '../ui/Button';
import { Pill, PillCount, PillDivider } from '../ui/Pill';

/**
 * Plan 47: the Cull page of the kitchen sink. Every cell state drawn by the real `CullCell` (undecided, kept,
 * rejected, selected, focused, selected and focused, stars, edited, lens and denoise badges, collapsed groups, a cell
 * still preparing, an unreadable one, cells of a running batch), the batch pill with its ring, and a live grid (the
 * real `CullGrid` on a synthetic folder, without its keys, so nothing writes a library): the sink's own arrow keys move
 * the focus and slide the one ring, and a click selects. Plan 52: the Photo pane beside it (the live `PhotoPane` on the
 * grid's selection, synthetic facts on the photos; its histogram is drawn from synthetic bins, since the sink's photos
 * have no cached proxy) and a marquee in the live grid. Plan 53: the live grid shows *Group by* camera dividers, and an
 * Assist block draws each composition guide and Two's sharpness bar over a synthetic picture with the live *Assist*
 * menu (focus peak and zebra are preview modes rendered by Rust, so the sink, which never calls `invoke`, lists them
 * in the menu only). No `invoke`: the photos are the renderer fixture's stand-ins. While it shows it holds the library, book, jobs and ui stores; it puts them back on leave.
 */

const FOLDER = 'cull-sink';
const IMAGES = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9'];
const thumb = (i: number) => fixtureResolve(IMAGES[i % IMAGES.length] ?? 'f1', 240)?.src;
const picture = (i: number) => fixtureResolve(IMAGES[i % IMAGES.length] ?? 'f1', 480)?.src;

function file(i: number, extra: Partial<AssetFile> = {}): AssetFile {
  return {
    assetId: `sink-${i}`,
    relPath: `DSC_${String(4100 + i).padStart(4, '0')}.jpg`,
    size: 0,
    mtime: 0,
    kind: 'jpeg',
    status: 'ready',
    width: 1200,
    height: 800,
    thumbUrl: thumb(i),
    ...extra,
  } as AssetFile;
}

const LENSES: readonly LensBadge[] = [
  { kind: 'soft', detail: 'Soft: sharpest tile 0.21', strong: false },
  { kind: 'blown', detail: 'Blown: 7.4 % of the picture', strong: true },
];

const noop = () => {};

/** A plausible evening street scene: luminance low-mid, red and green warm, blue clipped on the right. */
const bell = (centre: number, width: number, scale: number) =>
  Array.from({ length: 256 }, (_, i) => Math.round(scale * Math.exp(-(((i - centre) / width) ** 2))));
const SINK_HISTOGRAM = {
  r: bell(120, 50, 900),
  g: bell(100, 45, 1000),
  b: bell(80, 60, 800).map((n, i) => (i === 255 ? 3000 : n)),
  l: bell(100, 55, 1100),
};

type State = Partial<CullCellProps> & { label: string; focused?: boolean; expanded?: boolean };

const STATES: readonly State[] = [
  { label: 'Undecided' },
  { label: 'Kept', flag: 'pick' },
  { label: 'Rejected (dimmed)', flag: 'reject' },
  { label: 'Selected', selected: true },
  { label: 'Focused', focused: true },
  { label: 'Selected and focused', selected: true, focused: true, flag: 'pick' },
  { label: 'Stars', rating: 4 },
  { label: 'Edited, lens badges', edited: true, lensBadges: LENSES },
  { label: 'Needs denoise', file: file(8, { iso: 12800 } as Partial<AssetFile>) },
  { label: 'Group, collapsed', groupId: 'g1', groupSize: 6, kept: 1, rejected: 2 },
  { label: 'Group, all decided', groupId: 'g2', groupSize: 3, kept: 1, rejected: 2 },
  { label: 'Preparing', file: file(0, { thumbUrl: undefined, status: 'scanned' } as Partial<AssetFile>) },
  { label: 'Unreadable', file: file(0, { status: 'error', error: 'Unsupported file' } as Partial<AssetFile>) },
  { label: 'In a batch (underline)', photo: 'sink-batch-1' },
];

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="section-title m-0">{title}</h2>
      {children}
    </section>
  );
}

/** One state: the real cell at a fixed size, with the focus ring drawn over it when the state is focused. */
function StateCell({ state, index }: { state: State; index: number }) {
  const { label, focused, ...props } = state;
  const f = props.file ?? file(index);
  return (
    <figure className="m-0 flex flex-col gap-2">
      <div className="relative size-32" style={{ '--i': 0 } as CSSProperties}>
        <div className="absolute inset-0 grid">
          <CullCell
            id={`sink-cell-${index}`}
            index={index}
            photo={props.photo ?? `sink-${index}`}
            file={f}
            name={f.relPath}
            rating={props.rating}
            showStars
            flag={props.flag}
            edited={props.edited ?? false}
            denoiseOn={false}
            lensBadges={props.lensBadges}
            thumbUrl={undefined}
            selected={props.selected ?? false}
            groupId={props.groupId}
            groupSize={props.groupSize}
            kept={props.kept}
            rejected={props.rejected}
            onClick={noop}
            onOpen={noop}
            onMenu={noop}
            onExpand={noop}
          />
        </div>
        {focused && <FocusRing x={0} y={0} width={128} height={128} />}
      </div>
      <figcaption className="text-[11px] text-fg-2">{label}</figcaption>
    </figure>
  );
}

/** The live grid's folder: 40 photos, a few kept, rejected and rated. */
function seedLiveGrid(): void {
  const photos: Record<string, PhotoFile> = {};
  const library = emptyLibrary();
  for (let i = 0; i < 40; i++) {
    const name = `DSC_${String(5000 + i).padStart(4, '0')}.jpg`;
    photos[name] = {
      relPath: name,
      size: 1,
      mtime: i,
      kind: 'jpeg',
      hash: `sink-h${i}`,
      width: 1200,
      height: 800,
      status: 'ready',
      thumbUrl: thumb(i),
      // Plan 52: what the Photo pane shows (synthetic Exif and stats).
      ...(i % 3 === 0
        ? {
            make: 'Fujifilm',
            model: 'X-T5',
            lens: 'XF23mmF1.4 R LM WR',
            focal: 23,
            shutter: 1 / (125 * (1 + (i % 4))),
            aperture: 1.4 + (i % 5) * 0.6,
            iso: 200 * (1 + (i % 6)),
            taken: Date.UTC(2026, 8, 14, 18, i),
            ...(i % 2 === 0 ? { gps: { lat: 38.7139 + i / 1e4, lon: -9.1394 } } : {}),
            stats: {
              sharpness: 120 + i,
              sharpnessMax: 400 + i * 20,
              sharpestTile: i % 64,
              motion: 0.1,
              clipHigh: (i % 4) / 100,
              clipLow: 0,
              medianLum: 0.3 + (i % 5) / 20,
            },
          }
        : {}),
    } as PhotoFile;
    if (i % 7 === 2) library.photos[`sink-h${i}`] = { flag: 'pick', versions: {} };
    if (i % 9 === 4) library.photos[`sink-h${i}`] = { flag: 'reject', versions: {} };
    if (i % 5 === 1) library.photos[`sink-h${i}`] = { ...library.photos[`sink-h${i}`], rating: 3, versions: {} };
  }
  useLibraryStore.setState({
    folders: {
      [FOLDER]: {
        id: FOLDER,
        path: '/cull-sink',
        photos,
        progress: { hashed: 0, prepared: 0, total: 0 },
        busy: false,
        error: null,
        scanned: true,
      },
    },
  } as never);
  useBookStore.setState({ book: null, folder: null, libraries: { '/cull-sink': library } });
  const keys = Object.keys(photos).map((path) => photoKey({ folder: FOLDER, path }));
  const ui = useUiStore.getState();
  ui.setCull({
    view: 'grid',
    columns: 8,
    scrollTop: 0,
    grouped: false,
    expanded: null,
    showStars: true,
    compare: undefined,
    survey: undefined,
    decide: undefined,
  });
  // Plan 53: camera dividers (set on the store directly, so the sink never writes the per-machine preference).
  useUiStore.setState((s) => ({ cull: { ...s.cull, groupBy: 'camera' } }));
  ui.openReview(keys, 9);
  ui.setSelection(
    [keys[3], keys[4], keys[12]].filter((k): k is string => k !== undefined),
    keys[3] ?? null,
  );
}

/** The live grid's arrows: the focus only (the grid's own keys are off, so no rating or flag key writes a library). */
function useSinkArrows(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { review, cull, setReviewIndex } = useUiStore.getState();
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cull.columns, ArrowDown: cull.columns }[e.key];
      if (!review || step === undefined || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.target instanceof HTMLElement && e.target.closest('input, select, textarea, [role="menu"]')) return;
      e.preventDefault();
      setReviewIndex(Math.min(Math.max(review.index + step, 0), review.ids.length - 1));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** A running batch over two of the state cells, so their underline shows (one half done, one finished). */
function seedBatch(): void {
  const now = Date.now();
  const base = { kind: 'export' as const, label: 'Export', queuedAt: now, startedAt: now };
  useJobsStore.setState({
    jobs: {
      'sink-j1': { ...base, id: 'sink-j1', ref: 'sink-batch-1', done: 1, total: 2, state: 'running' },
      'sink-j2': { ...base, id: 'sink-j2', ref: 'sink-1', done: 1, total: 1, state: 'done', endedAt: now },
    },
  } as never);
}

export function CullSink() {
  const [ready, setReady] = useState(false);
  useSinkArrows();

  useLayoutEffect(() => {
    const before = {
      library: useLibraryStore.getState().folders,
      book: useBookStore.getState(),
      jobs: useJobsStore.getState().jobs,
      ui: useUiStore.getState(),
    };
    seedLiveGrid();
    seedBatch();
    setReady(true);
    return () => {
      useLibraryStore.setState({ folders: before.library });
      useBookStore.setState({ book: before.book.book, folder: before.book.folder, libraries: before.book.libraries });
      useJobsStore.setState({ jobs: before.jobs });
      useUiStore.setState({
        review: before.ui.review,
        selection: before.ui.selection ?? EMPTY_SELECTION,
        cull: before.ui.cull,
      });
    };
  }, []);

  if (!ready) return null;
  return (
    <div data-testid="cull-sink" className="flex flex-col gap-8">
      <Block title="Cells">
        <div className="flex flex-wrap gap-5 bg-surround p-4">
          {STATES.map((state, i) => (
            <StateCell key={state.label} state={state} index={i} />
          ))}
        </div>
        <p className="m-0 text-[11px] text-fg-muted">
          Selected is the white ring and check; focused (what the keys act on) is the one brass ring outside the cell.
          Neither puts the accent on the photo.
        </p>
      </Block>
      <Block title="Batch pill">
        <div className="relative h-16 rounded-md bg-surround">
          <Pill shown label="Batch actions (sink)">
            <PillCount count={12} progress={{ done: 23, total: 58 }} />
            <PillDivider />
            <Button size="sm">Export 12…</Button>
            <Button size="sm">Denoise…</Button>
            <Button variant="ghost" size="sm" aria-label="More actions">
              ⋯
            </Button>
            <PillDivider />
            <Button variant="ghost" size="sm">
              Clear
            </Button>
          </Pill>
        </div>
      </Block>
      <Block title="Live grid and the Photo pane (arrows slide the focus ring; click, Shift+click, Cmd+click and a drag select)">
        <div className="flex h-[480px] overflow-hidden rounded-md">
          <div className="relative min-w-0 flex-1">
            <CullGrid keys={false} />
          </div>
          <div className="grid w-[300px] shrink-0 grid-rows-[minmax(0,1fr)]">
            <PhotoPane />
          </div>
        </div>
      </Block>
      <Block title="Assist overlays (composition guides and Two's sharpness bar on a synthetic picture)">
        <div className="flex flex-wrap items-start gap-5 bg-surround p-4">
          {COMPOSITION_GUIDES.map((guide, i) => (
            <figure key={guide} className="m-0 flex w-[240px] flex-col gap-1.5">
              <div className="relative h-[160px] overflow-hidden rounded-xs bg-stage">
                <img src={picture(i)} alt="" className="absolute inset-0 h-full w-full object-cover" />
                <CompositionGuides guide={guide} at={{ left: 0, top: 0, width: 240, height: 160 }} />
              </div>
              <SharpnessMeter relative={1 - i * 0.18} sharpest={i === 0} inGroup />
              <figcaption className="text-[11px] text-fg-2">{COMPOSITION_LABELS[guide]}</figcaption>
            </figure>
          ))}
          <div className="flex flex-col gap-1.5">
            <AssistMenu />
            <p className="m-0 w-[200px] text-[11px] text-fg-muted">
              F focus peak and Z zebra are drawn by Rust over the developed preview; O cycles the guides.
            </p>
          </div>
        </div>
      </Block>
      <Block title="Histogram (RGB over luminance, synthetic bins)">
        <div className="relative h-20 w-[276px] overflow-hidden rounded-xs bg-stage">
          <HistogramSvg data={SINK_HISTOGRAM} />
        </div>
      </Block>
    </div>
  );
}
