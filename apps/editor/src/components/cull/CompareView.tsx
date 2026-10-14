import type { OutputProfile } from '@photobook/shared';
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { basename } from '../../lib/path';
import { STAGE_PICTURE } from '../../lib/viewTransition';
import { type AssetFile, type PhotoLookup, usePhotoLookup } from '../../store/assets';
import { type ReviewPatch, useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { roleProps, urlsOf } from '../review/ReviewMode';
import { AssistMenu, AssistOverlays, SharpnessBar, useAssistKeys } from './AssistOverlays';
import { CullContextMenu, useCullContextMenu } from './CullContextMenu';
import { reviewPhotos } from './CullGrid';
import { type CompareAction, compareKeyAction, isEditableTarget } from './keys';
import { dimClass, FlagStamp } from './marks';
import {
  clampCenter,
  type Placement,
  placement,
  proxySize,
  type Size,
  useLinkedViewport,
  type ViewportState,
  zoomTo,
} from './viewport';

type Side = 'candidate' | 'select';

/** Pixels the pointer may move before a press is a pan, not a click. */
const DRAG_SLOP = 3;

/**
 * The Cull stage's Compare view (workflow plan 07): the candidate (left) beside the select (right), each the 1600 px
 * proxy of `ReviewMode`, never an original. Zoom (Fit, 1×, 2×, 4×) and pan are linked through `useLinkedViewport`; the
 * loupe point is shared, so clicking a detail on one pane puts the same detail under the pointer on both. Plan 47:
 * each pane has a caption under its picture (side, name, size, stars, flag), and the pane that takes the keys carries
 * the `accent` focus ring outside its edge. Plan 52 (the mouse grammar, the one zoom): the zoom stop is
 * `ui.cull.zoom`, shared with One and the filter bar (plan 49 removed Compare's own copy of the control: the bar's is
 * the one; K / J / Shift+F still zoom here); a click focuses a pane, a double-click
 * zooms to 1× at the point and again to fit, a drag pans, and a right-click opens `CullContextMenu` on that photo.
 * Plan 53: the header's *Assist* ▾ menu and keys (F focus peak, Z zebra, O composition; fit moved to Shift+F) draw
 * `AssistOverlays` over both panes, and a sharpness bar sits under each picture.
 */
export function CompareView({ onDevelop }: { onDevelop?: (id: string) => void }) {
  const review = useUiStore((s) => s.review);
  const compare = useUiStore((s) => s.cull.compare);
  const stale = !review || !compare || !review.ids.includes(compare.candidate) || !review.ids.includes(compare.select);
  // The list changed under the view (a filter): the photos are gone, so the grid (or Decide) is where Compare ends.
  const back = compare?.back ?? 'grid';
  useEffect(() => {
    if (stale) useUiStore.getState().setCull({ view: back, compare: undefined });
  }, [stale, back]);
  if (stale) return null;
  return <Compare ids={review.ids} candidate={compare.candidate} select={compare.select} onDevelop={onDevelop} />;
}

/** The nearest photo from `from` in `dir`, not `avoid`; undefined when the list has none. */
function nearest(ids: readonly string[], from: number, dir: 1 | -1, avoid: string): string | undefined {
  for (let i = from + dir; i >= 0 && i < ids.length; i += dir) if (ids[i] !== avoid) return ids[i];
  return undefined;
}

function Compare({
  ids,
  candidate,
  select,
  onDevelop,
}: {
  ids: string[];
  candidate: string;
  select: string;
  onDevelop?: (id: string) => void;
}) {
  const lookup = usePhotoLookup();
  const profile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const { view, setView, setZoom, step } = useLinkedViewport();
  const [focus, setFocus] = useState<Side>('candidate');
  const { menu, onPhotoMenu, close: closeMenu } = useCullContextMenu();
  const rootRef = useRef<HTMLDivElement>(null);
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;
  const developRef = useRef(onDevelop);
  developRef.current = onDevelop;
  // Zoom needs the 1600 px proxy of both photos: until a pane has it, it shows its thumbnail at fit.
  const proxyReady = (id: string) => Boolean(urlsOf(lookup.file(id), lookup.fields(id)?.develop, profile).proxyUrl);
  const canZoom = proxyReady(candidate) && proxyReady(select);
  const viewRef = useRef({ focus, step, setZoom, canZoom });
  viewRef.current = { focus, step, setZoom, canZoom };
  useAssistKeys();

  // Focus the view so keys never reach a focused grid cell or the filter bar; give focus back on leaving.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => previous?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const ui = useUiStore.getState;
    /** Candidate and select are what the store says now (a key can repeat before a render). */
    const photos = () => {
      const { review, cull } = ui();
      return review && cull.compare ? { ids: review.ids, ...cull.compare, compare: cull.compare } : null;
    };
    const setCandidate = (id: string | undefined) => {
      const now = photos();
      if (!now || !id) return;
      ui().setCull({ compare: { ...now.compare, candidate: id } });
      ui().setReviewIndex(now.ids.indexOf(id));
    };
    const stepCandidate = (dir: 1 | -1) => {
      const now = photos();
      if (now) setCandidate(nearest(now.ids, now.ids.indexOf(now.candidate), dir, now.select));
    };
    const run = (action: CompareAction): boolean => {
      const now = photos();
      if (!now) return false;
      const { focus, step, setZoom, canZoom } = viewRef.current;
      const focused = focus === 'candidate' ? now.candidate : now.select;
      switch (action.type) {
        case 'move': {
          if (action.to === 'home') setCandidate(now.ids.find((id) => id !== now.select));
          else if (action.to === 'end') setCandidate([...now.ids].reverse().find((id) => id !== now.select));
          else stepCandidate(action.to === 'left' || action.to === 'up' ? -1 : 1);
          return true;
        }
        case 'rate':
        case 'flag': {
          const patch: ReviewPatch = action.type === 'rate' ? { rating: action.rating } : { flag: action.flag };
          reviewPhotos(lookupRef.current, [focused], patch);
          // Like Review: rating or flagging the candidate moves on to the next one (Shift does the opposite).
          if (focus === 'candidate' && ui().reviewAutoAdvance !== action.shift) stepCandidate(1);
          return true;
        }
        case 'promote': {
          // The next photo that is neither the candidate nor the old select; none ahead (the end of the list) steps
          // back to the nearest one before. With no other photo at all nothing happens.
          const from = now.ids.indexOf(now.candidate);
          const other = (id: string) => id !== now.candidate && id !== now.select;
          const next = now.ids.slice(from + 1).find(other) ?? now.ids.slice(0, from).reverse().find(other);
          if (!next) return true;
          ui().setCull({ compare: { ...now.compare, candidate: next, select: now.candidate } });
          ui().setReviewIndex(now.ids.indexOf(next));
          return true;
        }
        case 'pane':
          setFocus((side) => (side === 'candidate' ? 'select' : 'candidate'));
          return true;
        case 'zoom':
          if (canZoom || action.dir === -1) step(action.dir);
          return true;
        case 'fit':
          setZoom('fit');
          return true;
        case 'develop':
          developRef.current?.(focused);
          return true;
        case 'clear':
          // Back where Compare came from: Decide (C there, plan 40) or the grid.
          ui().setCull({ view: ui().cull.compare?.back ?? 'grid', compare: undefined });
          return true;
        default:
          return false;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.target instanceof Element && e.target.closest('[role="menu"], [role="dialog"]')) return;
      const action = compareKeyAction(e);
      if (!action) return;
      // Tab on a button or link (the filter bar, the sidebar) moves the browser's focus, not the pane.
      if (
        action.type === 'pane' &&
        e.target instanceof Element &&
        e.target.closest('a, button, input, select, summary')
      ) {
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

  const index = ids.indexOf(candidate);
  const candidateName = basename(lookup.path(candidate));
  const selectName = basename(lookup.path(select));

  return (
    <div
      ref={rootRef}
      {...roleProps(true, `Compare: ${candidateName} and ${selectName}`)}
      tabIndex={-1}
      className="absolute inset-0 flex flex-col bg-stage outline-none"
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-hairline border-b px-4 text-xs">
        <span className="text-fg">Compare</span>
        <span className="font-mono text-fg-muted tabular-nums">
          Candidate {index + 1} / {ids.length}
        </span>
        <span className="ml-auto" />
        <AssistMenu />
      </header>
      <div className="flex min-h-0 flex-1 gap-3 bg-surround p-3">
        <ComparePane
          side="candidate"
          label="Candidate"
          id={candidate}
          focused={focus === 'candidate'}
          view={view}
          profile={profile}
          canZoom={canZoom}
          onFocus={() => setFocus('candidate')}
          onView={setView}
          onMenu={onPhotoMenu}
          peer={select}
        />
        <ComparePane
          side="select"
          label="Select"
          id={select}
          focused={focus === 'select'}
          view={view}
          profile={profile}
          canZoom={canZoom}
          onFocus={() => setFocus('select')}
          onView={setView}
          onMenu={onPhotoMenu}
          peer={candidate}
        />
      </div>
      <p className="shrink-0 px-4 pb-3 text-center text-[11px] text-fg-muted">
        ← → step the candidate · Cmd+Enter candidate becomes the select · Tab other pane · 1–5 rate · P / X / U flag · K
        / J zoom · Shift+F fit · double-click 1× · F focus peak · Z zebra · O guides · D develop · Esc grid
      </p>
      {menu && <CullContextMenu menu={menu} onClose={closeMenu} onDevelop={onDevelop} />}
    </div>
  );
}

interface ComparePaneProps {
  side: Side;
  label: string;
  id: string;
  focused: boolean;
  view: ViewportState;
  profile: OutputProfile;
  /** Both photos have their proxy (zoom is linked, so one without it holds both at fit). */
  canZoom: boolean;
  onFocus: () => void;
  onView: (view: ViewportState) => void;
  /** Right-click on the picture (plan 52). */
  onMenu?: (e: ReactMouseEvent<Element>, id: string) => void;
  /** The other pane's photo: the sharpness bar's reference when this one is in no group (plan 53). */
  peer: string;
}

/** One side: the proxy placed by the shared viewport, its caption (name, stars, flag), a ring when it takes the keys. */
function ComparePane({
  side,
  label,
  id,
  focused,
  view,
  profile,
  canZoom,
  onFocus,
  onView,
  onMenu,
  peer,
}: ComparePaneProps) {
  const source = usePictureSource(id, profile);
  const { file, fields, name, src, usable } = source;
  return (
    <section
      aria-label={`${label}: ${name}`}
      data-side={side}
      data-focused={focused || undefined}
      className={`relative flex min-w-0 flex-1 flex-col rounded-xs outline-offset-2 transition-[outline-color] duration-base ease-out ${
        focused ? 'outline-2 outline-accent' : 'outline-2 outline-transparent'
      }`}
    >
      <ViewportPicture
        source={source}
        view={view}
        canZoom={canZoom}
        onFocus={onFocus}
        onView={onView}
        onMenu={onMenu ? (e) => onMenu(e, id) : undefined}
        className="relative min-h-0 flex-1 overflow-hidden rounded-xs bg-stage/20"
        overlay={(at) => <AssistOverlays id={id} at={at} flag={fields?.flag} />}
      />
      <SharpnessBar id={id} peers={[peer]} />
      <div className="flex h-7 shrink-0 items-center gap-2 px-1 text-[11px]">
        <span className="section-title text-[11px]">{label}</span>
        <span className="truncate text-fg">{name}</span>
        {src && !usable && <span className="text-fg-muted">Preparing preview…</span>}
        {file?.width && file.height ? (
          <span className="font-mono text-fg-muted tabular-nums">
            {file.width} × {file.height}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {fields?.rating !== undefined && (
            <span role="img" aria-label={`${fields.rating} stars`} className="text-fg leading-3">
              {'★'.repeat(fields.rating)}
            </span>
          )}
          {fields?.flag && <FlagStamp flag={fields.flag} />}
        </span>
      </div>
    </section>
  );
}

/** What a viewport picture shows of a photo: the proxy (or its thumbnail until the proxy is there or when it fails). */
export interface PictureSource {
  file: AssetFile | undefined;
  fields: ReturnType<PhotoLookup['fields']>;
  name: string;
  /** The proxy URL when it exists. */
  proxyUrl: string | undefined;
  src: string | undefined;
  /** `src` is the proxy (zoom needs it). */
  usable: boolean;
  onError: (src: string) => void;
}

/** The picture source of `id` with the book's output profile (`urlsOf`), falling back to the thumbnail on an error. */
export function usePictureSource(id: string, profile: OutputProfile): PictureSource {
  const lookup = usePhotoLookup();
  const file = lookup.file(id);
  const fields = lookup.fields(id);
  const name = basename(lookup.path(id));
  const { proxyUrl, thumbUrl } = urlsOf(file, fields?.develop, profile);
  const [failed, setFailed] = useState<string | null>(null);
  const src = proxyUrl && failed !== proxyUrl ? proxyUrl : thumbUrl;
  return { file, fields, name, proxyUrl, src, usable: Boolean(proxyUrl) && src === proxyUrl, onError: setFailed };
}

/**
 * A photo placed by a viewport (Compare's panes, plan 52's One): fit or a zoom stop around the loupe point. A click
 * focuses (`onFocus`); a double-click zooms to 1× at the point and again to fit; a drag pans at more than fit (the
 * point stays where the picture fills the box); a right-click calls `onMenu`. Without `canZoom` (a proxy missing) it
 * stays at fit. `overlay` draws over the picture where it is placed (plan 53's `AssistOverlays`).
 */
export function ViewportPicture({
  source,
  view,
  canZoom,
  onFocus,
  onView,
  onMenu,
  className,
  overlay,
  transitionName,
}: {
  source: PictureSource;
  view: ViewportState;
  canZoom: boolean;
  onFocus?: () => void;
  onView: (view: ViewportState) => void;
  onMenu?: (e: ReactMouseEvent<Element>) => void;
  className: string;
  /** Drawn over the picture, given where it is placed (null until the box is measured). */
  overlay?: (at: Placement | null) => ReactNode;
  /** Plan 49: the box's `view-transition-name` (One's picture is `STAGE_PICTURE`, kept across Cull → Develop). */
  transitionName?: string;
}) {
  const { file, fields, name, src, usable, onError } = source;
  const boxRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<Size>({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState<{ src: string; size: Size } | null>(null);
  const picture: Size =
    loaded && loaded.src === src
      ? loaded.size
      : file?.width && file.height
        ? proxySize(file.width, file.height)
        : { w: 1600, h: 1067 };
  const dpr = (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1;
  // Zoom needs the proxy: on its thumbnail alone (the proxy still preparing, or unreadable) the box stays at fit.
  const zoomable = usable && canZoom;
  const shown: ViewportState = zoomable ? view : { ...view, zoom: 'fit' };
  const measured = pane.w > 0 && pane.h > 0;
  const centre = measured ? clampCenter(shown, pane, picture, dpr) : shown;
  const at: Placement | null = measured ? placement(shown, pane, picture, dpr) : null;
  const geo = { view: shown, pane, picture, dpr, at, zoomable };
  const geoRef = useRef(geo);
  geoRef.current = geo;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setPane({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Press and move pans (the point stays where the picture fills the box); a press without a move only focuses.
  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onFocus?.();
    const start = { x: e.clientX, y: e.clientY };
    const first = geoRef.current;
    let last = start;
    let dragged = false;
    let point = first.view.zoom === 'fit' ? first.view : clampCenter(first.view, first.pane, first.picture, first.dpr);
    const onMove = (m: MouseEvent) => {
      if (!dragged && Math.hypot(m.clientX - start.x, m.clientY - start.y) < DRAG_SLOP) return;
      dragged = true;
      const { view, pane, picture, dpr, at, zoomable } = geoRef.current;
      if (zoomable && view.zoom !== 'fit' && at && at.width > 0 && at.height > 0) {
        point = clampCenter(
          { ...point, cx: point.cx - (m.clientX - last.x) / at.width, cy: point.cy - (m.clientY - last.y) / at.height },
          pane,
          picture,
          dpr,
        );
        onView(point);
      }
      last = { x: m.clientX, y: m.clientY };
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Double-click: fit to 1× at that point, zoomed back to fit.
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const { view, pane, picture, dpr, at, zoomable } = geoRef.current;
    if (!zoomable) return;
    if (view.zoom !== 'fit') return onView(zoomTo(view, 'fit'));
    if (!at || at.width <= 0 || at.height <= 0) return onView(zoomTo(view, 1));
    const box = e.currentTarget.getBoundingClientRect();
    const point = { x: (e.clientX - box.left - at.left) / at.width, y: (e.clientY - box.top - at.top) / at.height };
    onView(clampCenter(zoomTo(view, 1, point), pane, picture, dpr));
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the view's window key handler drives it; the mouse only zooms and pans
    <div
      ref={boxRef}
      data-zoom={shown.zoom}
      data-center={`${centre.cx.toFixed(3)},${centre.cy.toFixed(3)}`}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onMenu}
      style={transitionName ? { viewTransitionName: transitionName } : undefined}
      className={`${className} ${!zoomable ? 'cursor-default' : shown.zoom === 'fit' ? 'cursor-zoom-in' : 'cursor-pan'}`}
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
          onError={() => onError(src)}
          className={`absolute max-w-none select-none ${dimClass(fields?.flag)} ${
            at ? '' : 'inset-0 h-full w-full object-contain'
          }`}
          style={at ? { left: at.left, top: at.top, width: at.width, height: at.height } : undefined}
        />
      ) : (
        <p className="absolute inset-0 flex items-center justify-center text-fg-muted text-xs">
          {file?.status === 'error' ? file.error : 'Preparing preview…'}
        </p>
      )}
      {src && overlay?.(at)}
    </div>
  );
}

/**
 * Plan 52: the One view's picture (`ReviewMode` in place): one photo on Cull's linked viewport, so the filter bar's
 * zoom, a double-click and a drag work as in Two; a right-click opens `CullContextMenu` on it. Plan 53: the assist
 * overlays and their keys (F, Z, O) work here too.
 */
export function OnePicture({
  id,
  profile,
  onDevelop,
}: {
  id: string;
  profile: OutputProfile;
  onDevelop?: (id: string) => void;
}) {
  const { view, setView } = useLinkedViewport();
  const source = usePictureSource(id, profile);
  const { menu, onPhotoMenu, close } = useCullContextMenu();
  useAssistKeys();
  return (
    <>
      <ViewportPicture
        source={source}
        view={view}
        canZoom={source.usable}
        onView={setView}
        onMenu={(e) => onPhotoMenu(e, id)}
        className="absolute inset-0 overflow-hidden"
        overlay={(at) => <AssistOverlays id={id} at={at} flag={source.fields?.flag} />}
        transitionName={STAGE_PICTURE}
      />
      {menu && <CullContextMenu menu={menu} onClose={close} onDevelop={onDevelop} />}
    </>
  );
}
