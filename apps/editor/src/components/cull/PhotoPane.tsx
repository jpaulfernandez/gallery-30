import { LENS_CAVEATS, type OutputProfile, outputProfileSuffix } from '@photobook/shared';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { basename } from '../../lib/path';
import { type Histogram, histogram, openMap, type PhotoFacts } from '../../lib/tauri';
import { type AssetFile, currentDeveloped, usePhotoLookup } from '../../store/assets';
import { type ReviewPatch, useBookStore } from '../../store/book';
import { photoMeta } from '../../store/library';
import { useProjectsStore } from '../../store/projects';
import { useUiStore } from '../../store/ui';
import { openExport } from '../export/entryPoints';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { useGroupSharpness } from './AssistOverlays';
import { placedInProjects, sizeLabel } from './rejectPile';

const NO_IDS: readonly string[] = [];

/**
 * Plan 52 (ODDHALLS_LAYOUT_PLAN 3, *Right pane: Photo*): Cull's right pane, mounted as `PaneShell`'s `right` by the two
 * Cull routes (Tab hides it, plan 51). For the photo the keys act on (the one selected, else the focused one) it shows
 * sentence-case cards: **Histogram** (RGB over luminance, 80 px, `histogram` from the cached proxy of its develop hash,
 * read asynchronously), **File** (name, pixel size, file size, format, Keep / Reject and the stars, editable: the
 * store's `reviewAssets`, never an undo step), **Camera** (make and model, lens, focal length, shutter, aperture, ISO,
 * taken, and the coordinates with *map ▸*, which opens Apple Maps through `open_map`), **Signals** (only with stats:
 * sharpest tile, blown share, median luminance; the lens caveats in a tooltip) and **In projects** (each a link). With
 * several selected it shows the count, what they share (camera, date range) and the batch actions; with no photo,
 * "Select a photo".
 */
export function PhotoPane() {
  const list = useUiStore((s) => s.review?.ids) ?? NO_IDS;
  const focused = useUiStore((s) => s.review?.ids[s.review.index]);
  const selection = useUiStore((s) => s.selection.keys);
  const shown = useMemo(() => {
    const inList = new Set(list);
    return selection.filter((id) => inList.has(id));
  }, [list, selection]);
  const id = shown.length === 1 ? shown[0] : shown.length === 0 ? focused : undefined;
  return (
    <aside
      aria-label="Photo"
      className="scrollbar flex min-h-0 flex-col gap-4 overflow-y-auto border-hairline border-l bg-panel p-3 text-xs"
    >
      {shown.length > 1 ? (
        <SelectionSummary ids={shown} />
      ) : id ? (
        <PhotoCards key={id} id={id} />
      ) : (
        <p className="py-8 text-center text-fg-muted">Select a photo</p>
      )}
    </aside>
  );
}

function Card({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5">
      <h3 className="section-title m-0 flex items-center gap-1.5">
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="w-20 shrink-0 text-fg-muted">{label}</span>
      <span className="selectable min-w-0 flex-1 break-words text-fg tabular-nums">{children}</span>
    </div>
  );
}

/** "1/250 s", "0.5 s", "30 s". */
export function shutterLabel(seconds: number): string {
  if (seconds < 0.3) return `1/${Math.round(1 / seconds)} s`;
  return `${Math.round(seconds * 10) / 10} s`;
}

/** "f/2.8", "f/8". */
export const apertureLabel = (f: number): string => `f/${Math.round(f * 10) / 10}`;

/** The camera clock as it showed (`taken` is read as UTC): "2026-09-14 18:42". */
export const takenLabel = (taken: number): string => new Date(taken).toISOString().slice(0, 16).replace('T', ' ');

const dayOf = (taken: number): string => new Date(taken).toISOString().slice(0, 10);

/** "38.71000, −9.14000". */
export const placeLabel = ({ lat, lon }: { lat: number; lon: number }): string =>
  `${lat.toFixed(5)}, ${lon.toFixed(5)}`.replace(/-/g, '−');

const cameraOf = (f: PhotoFacts): string | undefined =>
  f.make && f.model ? `${f.make} ${f.model}` : (f.make ?? f.model);

const pct = (share: number) => `${Math.round(share * 1000) / 10} %`;

/** The format of a file: "JPEG", "PNG", "HEIC", "RAW (ARW)". */
function formatOf(file: AssetFile): string {
  if (file.kind !== 'raw') return file.kind.toUpperCase();
  const ext = file.relPath.split('.').pop();
  return ext ? `RAW (${ext.toUpperCase()})` : 'RAW';
}

function PhotoCards({ id }: { id: string }) {
  const lookup = usePhotoLookup();
  const profile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const file = lookup.file(id);
  const fields = lookup.fields(id);
  const name = basename(file?.relPath ?? lookup.path(id)) || id;
  const set = (patch: ReviewPatch) => {
    const path = lookup.path(id);
    if (path) useBookStore.getState().reviewAssets([{ assetId: id, path }], patch);
  };
  const flag = fields?.flag;
  const rating = fields?.rating;
  const camera = file ? cameraOf(file) : undefined;
  const stats = file?.stats;
  return (
    <>
      <Card title="Histogram">
        <HistogramView file={file} develop={fields?.develop} profile={profile} />
      </Card>
      <Card title="File">
        <p className="selectable m-0 truncate font-medium text-fg" title={file?.relPath}>
          {name}
        </p>
        {file?.width && file.height ? (
          <Row label="Size">
            {file.width} × {file.height} · {sizeLabel(file.size)}
          </Row>
        ) : null}
        {file && <Row label="Format">{formatOf(file)}</Row>}
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <Button
            variant="toggle"
            size="sm"
            pressed={flag === 'pick'}
            title="Keep (P); again for undecided"
            onClick={() => set({ flag: flag === 'pick' ? null : 'pick' })}
          >
            Keep
          </Button>
          <Button
            variant="toggle"
            size="sm"
            pressed={flag === 'reject'}
            title="Reject (X); again for undecided"
            onClick={() => set({ flag: flag === 'reject' ? null : 'reject' })}
          >
            Reject
          </Button>
          <fieldset className="ml-auto flex items-center">
            <legend className="sr-only">Rating</legend>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`${n} star${n === 1 ? '' : 's'}`}
                aria-pressed={rating === n}
                title={rating === n ? 'Clear the rating (0)' : `Rate ${n} (${n})`}
                onClick={() => set({ rating: rating === n ? null : n })}
                className={`rounded-xs px-0.5 text-sm leading-none outline-none transition-colors duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent ${
                  rating !== undefined && n <= rating ? 'text-fg' : 'text-fg-muted/50 hover:text-fg-muted'
                }`}
              >
                ★
              </button>
            ))}
          </fieldset>
        </div>
      </Card>
      {file && (camera || file.lens || file.taken !== undefined || file.iso || file.gps) && (
        <Card title="Camera">
          {camera && <Row label="Camera">{camera}</Row>}
          {file.lens && <Row label="Lens">{file.lens}</Row>}
          {(file.focal || file.shutter || file.aperture || file.iso) && (
            <Row label="Exposure">
              {[
                file.focal ? `${Math.round(file.focal)} mm` : null,
                file.shutter ? shutterLabel(file.shutter) : null,
                file.aperture ? apertureLabel(file.aperture) : null,
                file.iso ? `ISO ${file.iso}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Row>
          )}
          {file.taken !== undefined && <Row label="Taken">{takenLabel(file.taken)}</Row>}
          {file.gps && <PlaceRow gps={file.gps} />}
        </Card>
      )}
      {stats && (
        <Card
          title="Signals"
          aside={
            <Tooltip label={Object.values(LENS_CAVEATS).join('. ')}>
              <Button variant="ghost" size="sm" aria-label="What these measure" className="normal-case">
                ⓘ
              </Button>
            </Tooltip>
          }
        >
          <Row label="Sharpest tile">{Math.round(stats.sharpnessMax)}</Row>
          <GroupSharpnessRow id={id} />
          <Row label="Blown">{pct(stats.clipHigh)}</Row>
          <Row label="Median">{pct(stats.medianLum)} brightness</Row>
        </Card>
      )}
      <InProjects id={id} />
    </>
  );
}

/** Plan 53: the photo's sharpness within its burst (`groupSharpness`, as Two's bars and Decide's strip show it). */
function GroupSharpnessRow({ id }: { id: string }) {
  const reading = useGroupSharpness(id);
  if (!reading?.inGroup) return null;
  return (
    <Row label="In its group">
      {reading.sharpest ? 'sharpest ●' : `${reading.relative.toFixed(2)} of the sharpest ●`}
    </Row>
  );
}

function PlaceRow({ gps }: { gps: { lat: number; lon: number } }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className="w-20 shrink-0 text-fg-muted">Place</span>
      <span className="selectable min-w-0 flex-1 break-words text-fg tabular-nums">{placeLabel(gps)}</span>
      <Button
        variant="ghost"
        size="sm"
        title="Open in Apple Maps"
        onClick={() =>
          openMap(gps.lat, gps.lon).catch((err) => devLog('cull', 'map not opened', { error: errorMessage(err) }))
        }
      >
        map ▸
      </Button>
    </div>
  );
}

/** Histograms read this session, by `hash:renderKey` (the command caches them on disk too). */
const histograms = new Map<string, Histogram>();
const HISTOGRAMS_KEPT = 64;

/**
 * The render key of the proxy a photo shows: its developed proxy's develop hash (with `-p3` for a Display P3 render)
 * when one matches its edits, else none (the plain `proxy.jpg`).
 */
export function renderKeyOf(
  file: AssetFile | undefined,
  develop: Parameters<typeof currentDeveloped>[1],
  profile: OutputProfile,
): string | undefined {
  const developed = currentDeveloped(file, develop, profile);
  return developed ? `${developed.developHash}${outputProfileSuffix(profile)}` : undefined;
}

function HistogramView({
  file,
  develop,
  profile,
}: {
  file: AssetFile | undefined;
  develop: Parameters<typeof currentDeveloped>[1];
  profile: OutputProfile;
}) {
  const hash = file?.hash;
  const ready = Boolean(file?.proxyUrl);
  const renderKey = renderKeyOf(file, develop, profile);
  const key = hash ? `${hash}:${renderKey ?? ''}` : null;
  const [state, setState] = useState<{ key: string; data: Histogram | null } | null>(null);
  useEffect(() => {
    if (!key || !hash || !ready) return;
    const known = histograms.get(key);
    if (known) {
      setState({ key, data: known });
      return;
    }
    let live = true;
    histogram(hash, renderKey)
      .then((data) => {
        histograms.set(key, data);
        if (histograms.size > HISTOGRAMS_KEPT) histograms.delete(histograms.keys().next().value as string);
        if (live) setState({ key, data });
      })
      .catch((err) => {
        devLog('cull', 'no histogram', { error: errorMessage(err) });
        if (live) setState({ key, data: null });
      });
    return () => {
      live = false;
    };
  }, [key, hash, renderKey, ready]);
  const data = state?.key === key ? state.data : undefined;
  // While it loads: the empty panel (no spinner, ODDHALLS_LAYOUT_PLAN 6); a photo without a proxy has none.
  return (
    <div className="relative h-20 overflow-hidden rounded-xs bg-stage" data-histogram={data ? 'ready' : 'empty'}>
      {data && <HistogramSvg data={data} />}
      {data === null && (
        <span className="absolute inset-0 flex items-center justify-center text-fg-muted">No histogram yet</span>
      )}
    </div>
  );
}

/** The area under 256 bins in a 256 × 100 box, scaled to `peak`. */
function areaPath(bins: readonly number[], peak: number): string {
  let d = 'M0,100';
  bins.forEach((n, i) => {
    d += `L${i},${(100 - Math.min(1, n / peak) * 100).toFixed(1)}L${i + 1},${(100 - Math.min(1, n / peak) * 100).toFixed(1)}`;
  });
  return `${d}L256,100Z`;
}

/**
 * RGB over luminance (Lightroom's): luminance as a soft `fg` area under the three channels, which are drawn with the
 * screen blend so where they overlap reads white. Scaled to the tallest bin away from the two ends, so a clipped
 * spike does not flatten the rest.
 */
export function HistogramSvg({ data }: { data: Histogram }) {
  const peak = Math.max(1, ...[data.r, data.g, data.b, data.l].flatMap((bins) => bins.slice(1, 255)));
  return (
    <svg viewBox="0 0 256 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
      <path d={areaPath(data.l, peak)} className="fill-fg/25" />
      <g style={{ mixBlendMode: 'screen' }} opacity={0.7}>
        <path d={areaPath(data.r, peak)} className="fill-danger" />
        <path d={areaPath(data.g, peak)} className="fill-ok" />
        <path d={areaPath(data.b, peak)} className="fill-guide" />
      </g>
    </svg>
  );
}

/** The projects that hold this photo (the open one from memory, the others from their files), each a link. */
function InProjects({ id }: { id: string }) {
  const projects = useProjectsStore((s) => s.projects);
  // Nothing to check before the sidebar listed the projects and with no project open (the kitchen sink: no `invoke`).
  const any = useBookStore((s) => s.book !== null) || projects.length > 0;
  const [found, setFound] = useState<{ id: string; ids: string[]; titles: string[] } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `projects` stands for the files read
  useEffect(() => {
    const meta = photoMeta(useBookStore.getState(), id);
    if (!any || !meta?.folder) return;
    const entry = { key: id, folderId: '', folderPath: meta.folder.replace(/\/+$/, ''), relPath: meta.path, size: 0 };
    let live = true;
    // Arrowing through a folder reads no project file for the photos passed over.
    const timer = setTimeout(() => {
      placedInProjects([entry])
        .then((p) => live && setFound({ id, ids: p.ids, titles: p.titles }))
        .catch((err) => devLog('cull', 'projects not read for the pane', { error: errorMessage(err) }));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, projects, any]);
  if (!found || found.id !== id || found.ids.length === 0) return null;
  return (
    <Card title="In projects">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {found.ids.map((project, i) => (
          <li key={project}>
            <Link
              to="/project/$id/design"
              params={{ id: project }}
              className="text-fg underline decoration-fg/30 underline-offset-2 hover:decoration-fg"
            >
              {found.titles[i]}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Several selected: the count, what they share, and the batch actions. */
function SelectionSummary({ ids }: { ids: readonly string[] }) {
  const lookup = usePhotoLookup();
  const files = ids.map((id) => lookup.file(id));
  const kept = ids.filter((id) => lookup.fields(id)?.flag === 'pick').length;
  const rejected = ids.filter((id) => lookup.fields(id)?.flag === 'reject').length;
  const cameras = new Set(files.flatMap((f) => (f && cameraOf(f) ? [cameraOf(f)] : [])));
  const taken = files.flatMap((f) => (f?.taken !== undefined ? [f.taken] : []));
  const first = taken.length > 0 ? dayOf(Math.min(...taken)) : null;
  const last = taken.length > 0 ? dayOf(Math.max(...taken)) : null;
  const flag = (patch: ReviewPatch) => {
    const targets = ids.flatMap((assetId) => {
      const path = lookup.path(assetId);
      return path ? [{ assetId, path }] : [];
    });
    if (targets.length > 0) useBookStore.getState().reviewAssets(targets, patch);
  };
  return (
    <Card title={`${ids.length} selected`}>
      <Row label="Decided">
        {kept} kept · {rejected} rejected
      </Row>
      {cameras.size > 0 && <Row label="Camera">{cameras.size === 1 ? [...cameras][0] : `${cameras.size} cameras`}</Row>}
      {first && <Row label="Taken">{first === last ? first : `${first} – ${last}`}</Row>}
      <div className="flex flex-wrap gap-1 pt-1">
        <Button size="sm" title="Keep them all (P)" onClick={() => flag({ flag: 'pick' })}>
          Keep
        </Button>
        <Button size="sm" title="Reject them all (X)" onClick={() => flag({ flag: 'reject' })}>
          Reject
        </Button>
        <Button size="sm" title="Export them as new files" onClick={() => openExport(ids)}>
          Export…
        </Button>
        <Button variant="ghost" size="sm" onClick={() => useUiStore.getState().clearSelection()}>
          Clear
        </Button>
      </div>
    </Card>
  );
}
