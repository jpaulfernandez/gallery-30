import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { basename } from '../../lib/path';
import { withViewTransition } from '../../lib/viewTransition';
import { usePhotoLookup } from '../../store/assets';
import { type ReviewPatch, useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { roleProps, urlsOf } from '../review/ReviewMode';
import { Button } from '../ui/Button';
import { reviewPhotos } from './CullGrid';
import { cullKeyAction, isEditableTarget } from './keys';
import { dimClass, FlagStamp, SelectCheck, tileRings } from './marks';
import { SURVEY_GAP, surveyColumns } from './surveyLayout';

/**
 * The Cull stage's Survey view (workflow plan 07): the photos picked for it (`ui.cull.survey`) tiled as large as the
 * window allows, the 1600 px proxies of `ReviewMode`. X rejects the focused photo (or the marked ones: Shift+click a
 * tile) and takes it off the view, until one is left (the last tile refuses X); the rating keys act on the same
 * photos. Escape ends the survey with the survivors selected in the grid. Plan 47: a removed tile shrinks to nothing
 * and the others move to their new places through a view transition (`withViewTransition`; a cut where the browser
 * has none); marked tiles carry the white ring and check, the focused one the `accent` ring outside its edge.
 */
export function SurveyView({ onDevelop }: { onDevelop?: (id: string) => void }) {
  const review = useUiStore((s) => s.review);
  const survey = useUiStore((s) => s.cull.survey);
  const ids = useMemo(() => {
    const shown = new Set(review?.ids);
    return (survey?.ids ?? []).filter((id) => shown.has(id));
  }, [review?.ids, survey?.ids]);
  const stale = ids.length === 0;
  // The list changed under the view (a filter): no photo of it is left, so the grid is where Survey ends.
  useEffect(() => {
    if (stale) useUiStore.getState().setCull({ view: 'grid', survey: undefined });
  }, [stale]);
  if (stale) return null;
  return <Survey ids={ids} onDevelop={onDevelop} />;
}

/** A tile's view-transition name: unique per photo for the session, and a valid CSS identifier whatever the id. */
const tileNames = new Map<string, string>();
const tileName = (id: string): string => {
  let name = tileNames.get(id);
  if (!name) {
    name = `survey-tile-${tileNames.size}`;
    tileNames.set(id, name);
  }
  return name;
};

/** Leave Survey: the survivors are the selection and the grid's focus is on the one the survey ended on. */
export function endSurvey(survivors: readonly string[], focus: string | undefined): void {
  const ui = useUiStore.getState();
  const at = ui.review?.ids.indexOf(focus && survivors.includes(focus) ? focus : (survivors[0] ?? '')) ?? -1;
  ui.setSelection(survivors, survivors[0] ?? null);
  if (at >= 0) ui.setReviewIndex(at);
  ui.setCull({ view: 'grid', survey: undefined });
}

function Survey({ ids, onDevelop }: { ids: string[]; onDevelop?: (id: string) => void }) {
  const lookup = usePhotoLookup();
  const profile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const autoAdvance = useUiStore((s) => s.reviewAutoAdvance);
  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [focus, setFocus] = useState(ids[0] ?? '');
  const [marked, setMarked] = useState<readonly string[]>([]);
  const state = useRef({ ids, focus, marked });
  state.current = { ids, focus, marked };
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;
  const developRef = useRef(onDevelop);
  developRef.current = onDevelop;

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setArea({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const columns = surveyColumns(ids.length, area.w, area.h);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  // A focus or mark on a photo that left the view (a filter) moves to one that is still there.
  useEffect(() => {
    if (!ids.includes(focus)) setFocus(ids[0] ?? '');
    if (marked.some((id) => !ids.includes(id))) setMarked(marked.filter((id) => ids.includes(id)));
  }, [ids, focus, marked]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => previous?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const ui = useUiStore.getState;
    /** What a rating, flag or X acts on: the marked photos, else the focused one. */
    const targets = () => {
      const { ids, focus, marked } = state.current;
      return marked.length > 0 ? ids.filter((id) => marked.includes(id)) : ids.includes(focus) ? [focus] : [];
    };
    const remove = (gone: readonly string[]) => {
      const { ids, focus } = state.current;
      const left = ids.filter((id) => !gone.includes(id));
      // The last photo stays: a survey ends with one chosen, not with none.
      if (left.length === 0 || left.length === ids.length) return;
      const next = left.includes(focus)
        ? focus
        : (left.find((id) => ids.indexOf(id) > ids.indexOf(focus)) ?? left.at(-1));
      // The next key sees the survey without them at once, even while the transition has not run its update yet.
      state.current = { ids: left, focus: next ?? focus, marked: [] };
      // Every store write stays inside the transition: the survey list is what removes the tiles (outside it React
      // would draw the removal before the old snapshot, and nothing would shrink), and a flag written outside would
      // re-render the view before the update and put the old list back into `state` for the next key.
      withViewTransition(() => {
        reviewPhotos(lookupRef.current, gone, { flag: 'reject' });
        ui().setCull({ survey: { ids: left } });
        setMarked([]);
        if (next) setFocus(next);
      });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.target instanceof Element && e.target.closest('[role="menu"], [role="dialog"]')) return;
      const action = cullKeyAction(e);
      if (!action) return;
      const { ids, focus } = state.current;
      const at = ids.indexOf(focus);
      let handled = true;
      switch (action.type) {
        case 'move': {
          const cols = columnsRef.current;
          const step = { left: -1, right: 1, up: -cols, down: cols, home: 0, end: 0 }[action.to];
          const to = action.to === 'home' ? 0 : action.to === 'end' ? ids.length - 1 : at + step;
          const id = ids[Math.min(Math.max(to, 0), ids.length - 1)];
          if (id) setFocus(id);
          break;
        }
        case 'flag':
        case 'rate': {
          if (action.type === 'flag' && action.flag === 'reject') {
            remove(targets());
            break;
          }
          const patch: ReviewPatch = action.type === 'rate' ? { rating: action.rating } : { flag: action.flag };
          const acted = targets();
          reviewPhotos(lookupRef.current, acted, patch);
          // One photo: auto-advance like Review (Shift inverts); marked photos stay put.
          const id = ids[at + 1];
          if (
            acted.length === 1 &&
            state.current.marked.length === 0 &&
            ui().reviewAutoAdvance !== action.shift &&
            id
          ) {
            setFocus(id);
          }
          break;
        }
        case 'develop':
          if (focus) developRef.current?.(focus);
          break;
        case 'clear':
          endSurvey(ids, focus);
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const rows = Math.ceil(ids.length / columns);
  const one = ids.length === 1;

  return (
    <div
      ref={rootRef}
      {...roleProps(true, `Survey: ${ids.length} photos`)}
      tabIndex={-1}
      className="absolute inset-0 flex flex-col bg-stage outline-none"
    >
      <header className="flex h-11 shrink-0 items-center gap-3 border-hairline border-b px-4 text-xs">
        <span className="text-fg">Survey</span>
        <span className="text-fg-muted tabular-nums">
          {one ? 'One photo remains' : `${ids.length} photos`}
          {marked.length > 0 ? ` · ${marked.length} marked` : ''}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => endSurvey(ids, focus)}>
          Done <span className="text-fg-muted">Esc</span>
        </Button>
      </header>
      <div ref={areaRef} className="min-h-0 flex-1 bg-surround p-3">
        <div
          role="listbox"
          aria-label="Survey photos"
          aria-multiselectable="true"
          className="grid h-full w-full"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
            gap: SURVEY_GAP,
          }}
        >
          {ids.map((id) => {
            const fields = lookup.fields(id);
            const file = lookup.file(id);
            const urls = urlsOf(file, fields?.develop, profile);
            return (
              <SurveyTile
                key={id}
                transitionName={tileName(id)}
                name={basename(lookup.path(id) || id)}
                src={urls.proxyUrl}
                fallback={urls.thumbUrl}
                rating={fields?.rating}
                flag={fields?.flag ?? undefined}
                focused={id === focus}
                marked={marked.includes(id)}
                error={file?.status === 'error' ? file.error : undefined}
                onClick={(e) => {
                  if (e.shiftKey) setMarked((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
                  else setFocus(id);
                }}
              />
            );
          })}
        </div>
      </div>
      <p className="shrink-0 px-4 pb-3 text-center text-[11px] text-fg-muted">
        {one ? 'One photo remains · ' : 'X reject and remove · '}1–5 rate · P keep · U undecided · Shift+click mark · ←
        → ↑ ↓ move · D develop · Esc grid with {one ? 'it' : 'the survivors'} selected
        {autoAdvance ? ' · Shift stays' : ' · Shift advances'}
      </p>
    </div>
  );
}

interface SurveyTileProps {
  name: string;
  /** Its `view-transition-name` (`tileName`). */
  transitionName: string;
  src: string | undefined;
  fallback: string | undefined;
  rating: number | undefined;
  flag: 'pick' | 'reject' | undefined;
  focused: boolean;
  marked: boolean;
  error: string | undefined;
  onClick: (e: React.MouseEvent) => void;
}

/** One tile: the proxy contained, check and flag top left, stars bottom left, name bottom right. */
function SurveyTile({
  name,
  transitionName,
  src,
  fallback,
  rating,
  flag,
  focused,
  marked,
  error,
  onClick,
}: SurveyTileProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const shown = src && failed !== src ? src : fallback;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the view's window key handler drives the focus and marks
    <div
      role="option"
      tabIndex={-1}
      aria-selected={marked}
      aria-current={focused}
      aria-label={name}
      onClick={onClick}
      style={{ viewTransitionName: transitionName, viewTransitionClass: 'survey-tile' } as CSSProperties}
      className={`relative min-h-0 min-w-0 cursor-default rounded-xs bg-stage/20 ${tileRings({ selected: marked, focused })}`}
    >
      {shown ? (
        <img
          key={shown}
          src={shown}
          alt=""
          draggable={false}
          onError={() => setFailed(shown)}
          className={`h-full w-full rounded-xs object-contain ${dimClass(flag)}`}
        />
      ) : (
        <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-[11px] text-fg-muted">
          {error ?? 'Preparing preview…'}
        </p>
      )}
      {(marked || flag) && (
        <span className="absolute top-1.5 left-1.5 flex items-center gap-1">
          {marked && <SelectCheck />}
          {flag && <FlagStamp flag={flag} />}
        </span>
      )}
      {rating !== undefined && (
        <span
          role="img"
          aria-label={`${rating} star${rating === 1 ? '' : 's'}`}
          className="absolute bottom-1.5 left-1.5 rounded-xs bg-stage/60 px-0.5 text-[11px] text-fg leading-3 tracking-tighter"
        >
          {'★'.repeat(rating)}
        </span>
      )}
      <span className="pointer-events-none absolute right-1.5 bottom-1.5 max-w-[60%] truncate rounded-xs bg-stage/60 px-1 text-[10px] text-fg">
        {name}
      </span>
    </div>
  );
}
