import {
  type CullTarget,
  createDevelop,
  type DevelopSettings,
  groupSharpness,
  LENS_LABELS,
  lensDetail,
  lensesIn,
  type OutputProfile,
} from '@photobook/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { deepEqual } from '../../lib/develop/merge';
import { basename } from '../../lib/path';
import { type AssetFile, type PhotoLookup, usePhotoLookup } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { type CullUnit, cullUnits, useGroups } from '../../store/cull';
import {
  decideCompare,
  decideFrame,
  decideKeep,
  decideProgress,
  decideReject,
  decideStep,
  decideUndo,
  dismissPause,
  listFolder,
  markCulled,
  PAUSE_AFTER_MS,
  pauseDue,
  setCullTarget,
  targetCount,
  unitFrames,
} from '../../store/decide';
import { useLensReading } from '../../store/lenses';
import { isPhotoKey } from '../../store/library';
import { type CullDecide, useUiStore } from '../../store/ui';
import { roleProps, urlsOf } from '../review/ReviewMode';
import { Button } from '../ui/Button';
import { dialogOpen } from '../ui/DialogShell';
import { Input, Select } from '../ui/Field';
import { PopoverButton } from '../ui/Popover';
import { Tag } from '../ui/Tag';
import { Tooltip } from '../ui/Tooltip';
import { AssistMenu, AssistOverlays, useAssistKeys } from './AssistOverlays';
import { type DecideAction, decideKeyAction, isEditableTarget } from './keys';
import { dimClass, FlagStamp } from './marks';
import { INITIAL_VIEWPORT, type Placement, placement, proxySize, type Size, type ViewportState } from './viewport';

/** Tiles per side of the grid `stats.sharpestTile` indexes (plan 38: `row * 8 + column`). */
const STAT_TILES = 8;

/** The centre of the sharpest tile, as fractions of the picture; the centre of the picture without one. */
export function tileCentre(tile: number | undefined): { cx: number; cy: number } {
  if (tile === undefined || !Number.isInteger(tile) || tile < 0 || tile >= STAT_TILES * STAT_TILES) {
    return { cx: 0.5, cy: 0.5 };
  }
  return { cx: ((tile % STAT_TILES) + 0.5) / STAT_TILES, cy: (Math.floor(tile / STAT_TILES) + 0.5) / STAT_TILES };
}

const DEFAULT_GEOMETRY = createDevelop().geometry;

/**
 * Where Space zooms: the sharpest tile, measured on the upright proxy before develop, while the photo's geometry
 * (crop, straighten, rotate, flip, Upright, Transform) is untouched; the centre once an edit moves the pixels, since
 * the picture shown is then the developed proxy and the tile no longer lines up.
 */
export function zoomCentre(develop: DevelopSettings | undefined, tile: number | undefined): { cx: number; cy: number } {
  if (develop && !deepEqual(develop.geometry, DEFAULT_GEOMETRY)) return { cx: 0.5, cy: 0.5 };
  return tileCentre(tile);
}

export interface DecideViewProps {
  /** D: develop this photo (the Cull stage switches to Develop). */
  onDevelop?: (id: string) => void;
  /**
   * The end state's *Review rejects…* (CULL 4.5; plan 42 hands in the reject pile). Without it the list is filtered to
   * its rejects on the grid.
   */
  onReviewRejects?: () => void;
}

/**
 * The Decide pass (plan 40, CULL_PLAN 4.3): a view of the Cull stage, beside Compare and Survey, that walks the
 * undecided photos of the Cull list one unit at a time (a photo, or a group's frames: `cullUnits`) with Keep (P) and
 * Reject (X). The header is the progress (decided / total of the list, kept / the folder's target); a group shows its
 * frames in a strip under the picture; Space looks at the sharpest tile at 100 % of the proxy; C compares the shown
 * frame with the group's suggested best. When no photo is undecided the view says so (Culled: N kept, M rejected) and
 * stamps the folders' `culledAt`. After 45 minutes or 300 decisions a one-line "Good place to stop?" shows above the
 * key hint; it never takes the focus. Keys: `decideKeyAction`; the work is in `store/decide.ts`.
 */
export function DecideView({ onDevelop, onReviewRejects }: DecideViewProps) {
  const review = useUiStore((s) => s.review);
  const pass = useUiStore((s) => s.cull.decide);
  if (!review) return null;
  return (
    <Decide ids={review.ids} index={review.index} pass={pass} onDevelop={onDevelop} onReviewRejects={onReviewRejects} />
  );
}

function Decide({
  ids,
  index,
  pass,
  onDevelop,
  onReviewRejects,
}: {
  ids: string[];
  index: number;
  pass: CullDecide | undefined;
  onDevelop?: (id: string) => void;
  onReviewRejects?: () => void;
}) {
  const lookup = usePhotoLookup();
  const profile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const libraries = useBookStore((s) => s.libraries);
  const grouped = useUiStore((s) => s.cull.grouped);
  const allGroups = useGroups(ids);
  const groups = grouped && allGroups.groups.length > 0 ? allGroups : null;
  const units = useMemo(() => cullUnits(ids, groups), [ids, groups]);
  const current = ids[index] ?? '';
  const unit = useMemo(() => units.find((u) => unitFrames(u).includes(current)), [units, current]);
  const progress = useMemo(() => decideProgress(ids, (id) => lookup.fields(id)?.flag), [ids, lookup]);
  const ended = progress.total > 0 && progress.decided === progress.total;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `libraries` stands for the store read by `listFolder`
  const folder = useMemo(() => listFolder(ids), [ids, libraries]);
  const target = folder ? libraries[folder]?.cull?.target : undefined;
  const targetN = targetCount(target, progress.total);
  const [zoomed, setZoomed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const state = useRef({ ended, onDevelop, current, lookup, profile });
  state.current = { ended, onDevelop, current, lookup, profile };
  // Plan 53: F focus peak, Z zebra, O composition over the picture.
  useAssistKeys();

  // A new photo opens at fit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the photo shown
  useEffect(() => setZoomed(false), [current]);

  // Every photo decided: the folders of the list whose photos are all decided are culled.
  useEffect(() => {
    if (ended) markCulled(ids);
  }, [ended, ids]);

  // Focus the view so keys never reach a focused grid cell or the filter bar; give focus back on leaving.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => previous?.focus({ preventScroll: true });
  }, []);

  // Warm the next photos so a decision shows the next unit at once.
  useEffect(() => {
    for (const near of [ids[index + 1], ids[index + 2]]) {
      const url = near ? urlsOf(lookup.file(near), lookup.fields(near)?.develop, profile).proxyUrl : undefined;
      if (url) new Image().src = url;
    }
  }, [ids, index, lookup, profile]);

  useEffect(() => {
    const run = (action: DecideAction): boolean => {
      const { ended, onDevelop, current, lookup, profile } = state.current;
      switch (action.type) {
        case 'keep':
          return ended ? true : decideKeep(action.stay);
        case 'reject':
          return ended ? true : decideReject(action.all);
        case 'undo':
          decideUndo();
          return true;
        case 'step':
          return ended ? true : decideStep(action.dir);
        case 'frame':
          return decideFrame(action.dir);
        case 'zoom': {
          // 100 % needs the proxy; on the thumbnail alone the picture stays at fit.
          if (urlsOf(lookup.file(current), lookup.fields(current)?.develop, profile).proxyUrl) setZoomed((z) => !z);
          return true;
        }
        case 'compare':
          decideCompare();
          return true;
        case 'develop':
          if (current) onDevelop?.(current);
          return true;
        case 'exit':
          useUiStore.getState().setCull({ view: 'grid' });
          return true;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.target instanceof Element && e.target.closest('[role="menu"], [role="dialog"], [aria-expanded="true"]')) {
        return;
      }
      if (dialogOpen()) return;
      const action = decideKeyAction(e);
      if (!action) return;
      // Space on a focused button (the header, the end state) presses it.
      if (action.type === 'zoom' && e.target instanceof Element && e.target.closest('a, button, select, summary')) {
        return;
      }
      if (run(action)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const name = basename(lookup.path(current));
  const file = lookup.file(current);
  const fields = lookup.fields(current);

  return (
    <div
      ref={rootRef}
      {...roleProps(true, `Decide: ${name}`)}
      tabIndex={-1}
      className="absolute inset-0 flex flex-col bg-stage outline-none"
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-hairline border-b px-4 text-xs">
        <span className="text-fg">Decide</span>
        <span role="status" aria-label="Progress" className="text-fg-muted tabular-nums">
          {progress.decided} / {progress.total} decided · {progress.kept} kept
          {targetN !== undefined ? ` of ~${targetN}` : ''}
        </span>
        {!ended && <LensNotes id={current} />}
        <span className="ml-auto flex items-center gap-1">
          {!ended && <AssistMenu />}
          <TargetButton folder={folder} target={target} total={progress.total} />
          <Button variant="ghost" size="sm" onClick={() => useUiStore.getState().setCull({ view: 'grid' })}>
            Done <span className="text-fg-muted">Esc</span>
          </Button>
        </span>
      </header>
      {ended ? (
        <EndState
          ids={ids}
          lookup={lookup}
          kept={progress.kept}
          rejected={progress.rejected}
          onReviewRejects={onReviewRejects}
        />
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1 bg-surround p-3">
            <DecidePicture
              id={current}
              file={file}
              name={name}
              profile={profile}
              develop={fields?.develop}
              flag={fields?.flag ?? undefined}
              zoomed={zoomed}
            />
          </div>
          {unit?.kind === 'group' && <FrameStrip unit={unit} current={current} lookup={lookup} profile={profile} />}
        </>
      )}
      <PauseNudge pass={pass} />
      <p className="shrink-0 px-4 pb-3 text-center text-[11px] text-fg-muted">
        {ended
          ? 'U brings the last decision back · D develop · Esc grid'
          : unit?.kind === 'group'
            ? 'P keep this one (rejects the rest of the group) · Shift+P keep, stay · X reject · Shift+X reject the group · , . other frame · U undo · ← → skip · Space 100 % · C compare · D develop · Esc grid'
            : 'P keep · Shift+P keep, stay · X reject · U undo · ← → skip · Space 100 % · D develop · Esc grid'}
      </p>
    </div>
  );
}

/** The photo, fit or (Space) at 100 % of the proxy around the sharpest tile (`stats.sharpestTile`, plan 38). */
function DecidePicture({
  id,
  file,
  name,
  profile,
  develop,
  flag,
  zoomed,
}: {
  /** The photo (plan 53's assist overlays). */
  id: string;
  file: AssetFile | undefined;
  name: string;
  profile: OutputProfile;
  develop: Parameters<typeof urlsOf>[1];
  flag: 'pick' | 'reject' | undefined;
  zoomed: boolean;
}) {
  const { proxyUrl, thumbUrl } = urlsOf(file, develop, profile);
  const [failed, setFailed] = useState<string | null>(null);
  const src = proxyUrl && failed !== proxyUrl ? proxyUrl : thumbUrl;
  const boxRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<Size>({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState<{ src: string; size: Size } | null>(null);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setPane({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const picture: Size =
    loaded && loaded.src === src
      ? loaded.size
      : file?.width && file.height
        ? proxySize(file.width, file.height)
        : { w: 1600, h: 1067 };
  const usable = Boolean(proxyUrl) && src === proxyUrl;
  const view: ViewportState =
    zoomed && usable ? { zoom: 1, ...zoomCentre(develop, file?.stats?.sharpestTile) } : INITIAL_VIEWPORT;
  const dpr = (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1;
  const at: Placement | null = pane.w > 0 && pane.h > 0 ? placement(view, pane, picture, dpr) : null;

  return (
    <div
      ref={boxRef}
      data-zoom={view.zoom}
      data-center={`${view.cx.toFixed(3)},${view.cy.toFixed(3)}`}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      {src ? (
        <img
          key={src}
          src={src}
          alt={name}
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
            if (w > 0 && h > 0) setLoaded({ src, size: { w, h } });
          }}
          onError={() => setFailed(src)}
          className={`absolute max-w-none select-none ${dimClass(flag)} ${
            at ? '' : 'inset-0 h-full w-full object-contain'
          }`}
          style={at ? { left: at.left, top: at.top, width: at.width, height: at.height } : undefined}
        />
      ) : (
        <p className="absolute inset-0 flex items-center justify-center text-fg-muted text-xs">
          {file?.status === 'error' ? file.error : 'Preparing preview…'}
        </p>
      )}
      {src && <AssistOverlays id={id} at={at} flag={flag} />}
      {flag && (
        <span className="absolute top-2 left-2">
          <FlagStamp flag={flag} className="size-5" />
        </span>
      )}
    </div>
  );
}

/** A group's frames under the picture: the shown one ringed, kept ones marked, rejected ones dimmed. */
function FrameStrip({
  unit,
  current,
  lookup,
  profile,
}: {
  unit: Extract<CullUnit, { kind: 'group' }>;
  current: string;
  lookup: PhotoLookup;
  profile: OutputProfile;
}) {
  const at = unit.frames.indexOf(current);
  const open = unit.frames.filter((id) => lookup.fields(id)?.flag === undefined).length;
  // Plan 41: each frame's sharpness against the group's sharpest (the within-group rank), the sharpest marked ●.
  const sharpness = groupSharpness(unit.frames.map((id) => ({ id, stats: lookup.file(id)?.stats })));
  const shownSharpness = sharpness.relative.get(current);
  return (
    <div className="flex h-20 shrink-0 items-center gap-3 border-hairline border-t px-4 text-[11px] text-fg-muted">
      <span className="shrink-0 tabular-nums">
        Frame {at + 1} of {unit.frames.length} · {open} undecided
        {sharpness.best !== null && (
          <span data-testid="frame-sharpness">
            {' · '}
            {sharpness.best === current
              ? 'sharpest ●'
              : shownSharpness !== undefined
                ? `${Math.round(shownSharpness * 100)} % of the sharpest ●`
                : 'sharpest ● is another frame'}
          </span>
        )}
      </span>
      <fieldset aria-label="Frames of the group" className="flex min-w-0 gap-1 overflow-hidden">
        {unit.frames.map((id) => {
          const fields = lookup.fields(id);
          const { thumbUrl } = urlsOf(lookup.file(id), fields?.develop, profile);
          return (
            <button
              key={id}
              type="button"
              tabIndex={-1}
              aria-label={`Show ${basename(lookup.path(id) || id)}`}
              aria-current={id === current}
              onClick={() => {
                const { review, setReviewIndex } = useUiStore.getState();
                if (review) setReviewIndex(review.ids.indexOf(id));
              }}
              className={`relative size-14 shrink-0 overflow-hidden rounded-xs bg-panel outline-none transition-opacity duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent ${
                id === current ? 'ring-2 ring-fg' : 'opacity-70 hover:opacity-100'
              }`}
            >
              {thumbUrl && (
                <img
                  src={thumbUrl}
                  alt=""
                  draggable={false}
                  className={`h-full w-full object-cover ${dimClass(fields?.flag)}`}
                />
              )}
              {fields?.flag === 'pick' && <span className="absolute top-0.5 left-0.5 size-1.5 rounded-full bg-pick" />}
              {sharpness.best === id && (
                <span
                  role="img"
                  aria-label="Sharpest"
                  className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-fg shadow-raised"
                />
              )}
              {sharpness.relative.has(id) && (
                <span
                  data-sharpness={Math.round((sharpness.relative.get(id) ?? 0) * 100)}
                  className="absolute inset-x-1 bottom-0.5 h-0.5 overflow-hidden rounded-pill bg-stage/60"
                >
                  <span
                    className="block h-full rounded-pill bg-fg-2"
                    style={{ width: `${(sharpness.relative.get(id) ?? 0) * 100}%` }}
                  />
                </span>
              )}
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}

/**
 * Plan 41: the shown photo's lenses (Soft, Blown, Dark) as dim tags in the header, each with its number in a
 * tooltip. They explain; they never decide.
 */
function LensNotes({ id }: { id: string }) {
  const reading = useLensReading()(id);
  const kinds = lensesIn(reading?.verdict ?? null);
  if (!reading || kinds.length === 0) return null;
  return (
    <span className="flex items-center gap-1" data-testid="lens-notes">
      {kinds.map((kind) => {
        const detail = lensDetail(kind, reading.entry, reading.verdict);
        return (
          <Tooltip key={kind} label={detail}>
            <span className="inline-flex">
              <Tag className="text-fg-muted">
                {LENS_LABELS[kind]}
                {kind === 'blown' && reading.verdict.rawHeadroom ? ' · RAW headroom' : ''}
              </Tag>
            </span>
          </Tooltip>
        );
      })}
    </span>
  );
}

/** Every photo of the list decided: the count, *Review rejects…* and *Rate the keepers* (Survey over the picks). */
function EndState({
  ids,
  lookup,
  kept,
  rejected,
  onReviewRejects,
}: {
  ids: string[];
  lookup: PhotoLookup;
  kept: number;
  rejected: number;
  onReviewRejects?: () => void;
}) {
  const reviewRejects = () => {
    if (onReviewRejects) return onReviewRejects();
    const ui = useUiStore.getState();
    const patch = { flag: 'rejects' as const };
    if (ids[0] !== undefined && isPhotoKey(ids[0])) ui.setLibraryView(patch);
    else ui.setFilmstrip(patch);
    ui.setCull({ view: 'grid' });
  };
  const rateKeepers = () => {
    const ui = useUiStore.getState();
    const picks = ids.filter((id) => lookup.fields(id)?.flag === 'pick');
    if (picks.length >= 2) ui.setCull({ view: 'survey', survey: { ids: picks } });
    else if (picks[0] !== undefined) {
      ui.setReviewIndex(ids.indexOf(picks[0]));
      ui.setCull({ view: 'review' });
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-surround text-sm">
      <p className="text-fg">
        Culled: {kept} kept, {rejected} rejected
      </p>
      <div className="flex gap-2 text-xs">
        <Button disabled={rejected === 0} onClick={reviewRejects}>
          Review rejects…
        </Button>
        <Button disabled={kept === 0} onClick={rateKeepers}>
          Rate the keepers
        </Button>
      </div>
    </div>
  );
}

/** "Good place to stop?" after 45 minutes or 300 decisions; dismissable, never modal, never focused. */
function PauseNudge({ pass }: { pass: CullDecide | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  const startedAt = pass?.startedAt;
  const dismissed = pass?.pauseDismissed ?? false;
  useEffect(() => {
    if (startedAt === undefined || dismissed) return;
    const wait = startedAt + PAUSE_AFTER_MS - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [startedAt, dismissed]);
  if (!pauseDue(pass, Math.max(now, Date.now()))) return null;
  return (
    <p role="status" className="flex shrink-0 items-center justify-center gap-2 px-4 pt-2 text-[11px] text-fg">
      Good place to stop?
      <Button variant="ghost" size="sm" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={dismissPause}>
        Dismiss
      </Button>
    </p>
  );
}

/** The header's *Target*: keep about N photos, or a share of the list, stored per folder (`library.cull.target`). */
function TargetButton({
  folder,
  target,
  total,
}: {
  folder: string | null;
  target: CullTarget | undefined;
  total: number;
}) {
  return (
    <PopoverButton
      label="Target ▾"
      title={folder ? 'Keep about how many photos of this folder' : 'A target is per folder: open one folder to set it'}
      disabled={!folder}
      panelLabel="Cull target"
      width={240}
      alignEnd
    >
      {(close) => <TargetForm folder={folder} target={target} total={total} close={close} />}
    </PopoverButton>
  );
}

function TargetForm({
  folder,
  target,
  total,
  close,
}: {
  folder: string | null;
  target: CullTarget | undefined;
  total: number;
  close: () => void;
}) {
  const [kind, setKind] = useState<'count' | 'share'>(typeof target === 'object' ? 'share' : 'count');
  const [value, setValue] = useState(
    target === undefined ? '' : typeof target === 'number' ? String(target) : String(Math.round(target.share * 100)),
  );
  const n = Number(value);
  const valid =
    value.trim() !== '' && Number.isFinite(n) && n > 0 && (kind === 'count' ? Number.isInteger(n) : n <= 100);
  const save = () => {
    if (!folder || !valid) return;
    setCullTarget(folder, kind === 'count' ? n : { share: n / 100 });
    close();
  };
  return (
    <form
      noValidate
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <p className="text-fg">Keep about…</p>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          aria-label={kind === 'count' ? 'Photos to keep' : 'Share to keep, %'}
          min={1}
          max={kind === 'share' ? 100 : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-20"
        />
        <Select aria-label="Target as" value={kind} onChange={(e) => setKind(e.target.value as 'count' | 'share')}>
          <option value="count">photos</option>
          <option value="share">% of {total}</option>
        </Select>
      </div>
      <div className="flex justify-end gap-1">
        {target !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (folder) setCullTarget(folder, undefined);
              close();
            }}
          >
            Clear
          </Button>
        )}
        <Button type="submit" variant="primary" size="sm" disabled={!valid}>
          Set
        </Button>
      </div>
    </form>
  );
}
