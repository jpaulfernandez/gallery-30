import { PHOTO_SORT_LABELS, PHOTO_SORTS } from '@photobook/shared';
import { type ReactNode, useMemo } from 'react';
import { useBookStore } from '../../store/book';
import { useCullStore } from '../../store/cull';
import { decideProgress, openDecide } from '../../store/decide';
import {
  CULL_COLUMNS_MAX,
  CULL_COLUMNS_MIN,
  type CullZoom,
  DEFAULT_FILMSTRIP,
  type FilmstripSort,
  type FlagFilter,
  useUiStore,
} from '../../store/ui';
import { CullFilters } from '../cull/CullFilters';
import { openCompare } from '../cull/openViews';
import { ZOOM_STOPS } from '../cull/viewport';
import { Button, IconButton } from '../ui/Button';
import { Input, Select } from '../ui/Field';
import { Segmented } from '../ui/Segmented';

/** ISO thresholds offered once some photo's ISO is known (plan 23 reads it). */
const ISO_STEPS = [400, 800, 1600, 3200, 6400, 12800];

/**
 * Search, the Cull progress and *Decide*, the selection and photo counts, the scan progress and the clear-filters chip
 * of the Cull and Develop stages and the Design stage's Library tab. `scope` picks the filters: the library's
 * (`libraryView`, where *Hide in project* hides what the open project holds) or the open project's (`filmstrip`,
 * shared with the Design stage's Project tab, where *Hide used* hides photos already on a page).
 *
 * Plan 51: with `filtersInSidebar` (the Cull stages) the filters themselves (`LibraryFilters` and Cull's `CullFilters`
 * fragment) are the sidebar's Filters section and the bar keeps search, the progress fraction, *Decide* and the clear
 * chip (ODDHALLS_LAYOUT_PLAN 3); plan 52 adds the view switch and the zoom (`CullViewBar`). Without it (Develop,
 * the Design stage's Library tab, which have no sidebar) the filters stay in the bar. `isoKnown` and `rejectsHidden`
 * are the filters'.
 */
export function LibraryFilterBar({
  count,
  progress,
  projectOpen,
  scope = 'library',
  selected = 0,
  isoKnown = false,
  rejectsHidden = false,
  filtersInSidebar = false,
  children,
}: {
  count: number;
  progress: string | null;
  projectOpen: boolean;
  scope?: 'library' | 'project';
  /** Photos selected in the grid. */
  selected?: number;
  isoKnown?: boolean;
  rejectsHidden?: boolean;
  /** The filters are in the sidebar's Filters section (the Cull stages). */
  filtersInSidebar?: boolean;
  children?: ReactNode;
}) {
  const view = useUiStore((s) => (scope === 'project' ? s.filmstrip : s.libraryView));
  const set = useUiStore((s) => (scope === 'project' ? s.setFilmstrip : s.setLibraryView));
  const narrowed =
    view.query.trim() !== '' ||
    view.flag !== 'all' ||
    view.minRating > 0 ||
    view.hideUsed ||
    view.edited ||
    view.minIso > 0 ||
    view.lens !== 'none';
  return (
    // Plan 45: docked, without a border (ODDHALLS_UI_PLAN 3); the controls are the primitives.
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-xs">
      {filtersInSidebar && <PanesToggle />}
      <Input
        type="search"
        value={view.query}
        onChange={(e) => set({ query: e.target.value })}
        placeholder="Search photos"
        aria-label="Search photos by file name"
        spellCheck={false}
        className="w-40"
      />
      {filtersInSidebar ? (
        <>
          <CullViewBar />
          <DecideBar />
        </>
      ) : (
        <>
          <LibraryFilters scope={scope} projectOpen={projectOpen} isoKnown={isoKnown} rejectsHidden={rejectsHidden} />
          <CullFilters scope={scope} />
        </>
      )}
      {children}
      <span role="status" className="ml-auto flex items-center gap-2 text-[11px] text-fg-muted tabular-nums">
        {progress && <span>Preparing {progress}</span>}
        {selected > 0 && <span className="text-fg">{selected} selected</span>}
        <span>
          {count} photo{count === 1 ? '' : 's'}
        </span>
        {narrowed && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              set({
                query: DEFAULT_FILMSTRIP.query,
                hideUsed: DEFAULT_FILMSTRIP.hideUsed,
                flag: DEFAULT_FILMSTRIP.flag,
                minRating: DEFAULT_FILMSTRIP.minRating,
                edited: DEFAULT_FILMSTRIP.edited,
                minIso: DEFAULT_FILMSTRIP.minIso,
                lens: DEFAULT_FILMSTRIP.lens,
              })
            }
          >
            Clear filters
          </Button>
        )}
      </span>
    </div>
  );
}

/**
 * Sort, flag, rating, *Edited*, *ISO ≥* (only when `isoKnown`, or while set) and *Hide used* / *Hide in project* over
 * the `scope`'s view: in the filter bar, or (plan 51, `pane`) in the sidebar's Filters section, two fields a row.
 * `rejectsHidden` (the Develop stage, `developFilter`) labels *All flags* as what it shows there.
 */
export function LibraryFilters({
  scope = 'library',
  projectOpen,
  isoKnown = false,
  rejectsHidden = false,
  pane = false,
}: {
  scope?: 'library' | 'project';
  projectOpen: boolean;
  isoKnown?: boolean;
  rejectsHidden?: boolean;
  pane?: boolean;
}) {
  const view = useUiStore((s) => (scope === 'project' ? s.filmstrip : s.libraryView));
  const set = useUiStore((s) => (scope === 'project' ? s.setFilmstrip : s.setLibraryView));
  const field = pane ? 'min-w-[88px] flex-1' : '';
  return (
    <>
      <Select
        value={view.flag}
        onChange={(e) => set({ flag: e.target.value as FlagFilter })}
        aria-label="Filter by flag"
        className={field}
      >
        <option value="all">{rejectsHidden ? 'All but rejects' : 'All flags'}</option>
        <option value="no-rejects">Hide rejects</option>
        <option value="picks">Kept only</option>
        <option value="undecided">Undecided</option>
        <option value="rejects">Rejects only</option>
      </Select>
      <Select
        value={view.minRating}
        onChange={(e) => set({ minRating: Number(e.target.value) })}
        aria-label="Filter by minimum star rating"
        className={field}
      >
        <option value={0}>Any rating</option>
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>
            {'★'.repeat(n)}
            {n < 5 ? ' & up' : ''}
          </option>
        ))}
      </Select>
      <Button
        variant="toggle"
        size="sm"
        pressed={view.edited}
        onClick={() => set({ edited: !view.edited })}
        title="Only photos edited in Develop"
      >
        Edited
      </Button>
      {(isoKnown || view.minIso > 0) && (
        <Select
          value={view.minIso}
          onChange={(e) => set({ minIso: Number(e.target.value) })}
          aria-label="Filter by minimum ISO"
          className={field}
        >
          <option value={0}>Any ISO</option>
          {ISO_STEPS.map((iso) => (
            <option key={iso} value={iso}>
              ISO ≥ {iso}
            </option>
          ))}
        </Select>
      )}
      {scope === 'project' ? (
        <Button
          variant="toggle"
          size="sm"
          pressed={view.hideUsed}
          onClick={() => set({ hideUsed: !view.hideUsed })}
          title="Hide photos already on a page"
        >
          Hide used
        </Button>
      ) : (
        projectOpen && (
          <Button
            variant="toggle"
            size="sm"
            pressed={view.hideUsed}
            onClick={() => set({ hideUsed: !view.hideUsed })}
            title="Hide photos already in the open project"
          >
            Hide in project
          </Button>
        )
      )}
      <Select
        value={view.sort}
        onChange={(e) => set({ sort: e.target.value as FilmstripSort })}
        aria-label="Sort photos"
        className={field}
      >
        {/* Plan 56: the storytelling sorts too (view state; the photos without the fact come last). */}
        {PHOTO_SORTS.map((sort) => (
          <option key={sort} value={sort}>
            {PHOTO_SORT_LABELS[sort]}
          </option>
        ))}
      </Select>
    </>
  );
}

/**
 * Plan 51: the bar's progress fraction (decided / photos of the Cull list) and *Decide* (Enter on the grid), read from
 * the same store values as `CullFilters`' copies (which stay until plan 47 removes them). Only while a Cull stage is
 * mounted, as the fragment.
 */
function DecideBar() {
  const ids = useUiStore((s) => s.review?.ids);
  const onCull = useCullStore((s) => s.stages > 0);
  const deciding = useUiStore((s) => s.cull.view === 'decide');
  const libraries = useBookStore((s) => s.libraries);
  const book = useBookStore((s) => s.book);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `libraries` and `book` stand for the flags read through the store
  const progress = useMemo(() => (ids ? decideProgress(ids) : null), [ids, libraries, book]);
  if (!onCull || !progress) return null;
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="font-mono text-[11px] text-fg-muted"
        title={`${progress.kept} kept, ${progress.rejected} rejected`}
      >
        {progress.decided}/{progress.total} decided
      </span>
      <Button
        variant="toggle"
        size="sm"
        pressed={deciding}
        onClick={() => openDecide()}
        title="Keep or reject the undecided photos one at a time, a burst as one decision (Enter)"
      >
        Decide
      </Button>
    </span>
  );
}

/**
 * Plan 49: the side panes' visible toggle on the Cull stages (plan 51's Tab, as a button): hides the Library sidebar
 * and the Photo pane when either shows, else shows both. Tab from the page or the grid does the same; this button is
 * the pointer's way, and a keyboard focus on it keeps Tab for moving on.
 */
function PanesToggle() {
  const shown = useUiStore((s) => s.panes.cull.left || s.panes.cull.right);
  return (
    <IconButton
      size="sm"
      label={shown ? 'Hide the side panes' : 'Show the side panes'}
      shortcut="Tab"
      onClick={() => useUiStore.getState().togglePanes('cull', 'panes')}
      icon={
        <svg
          viewBox="0 0 16 16"
          className="size-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.3}
          aria-hidden="true"
        >
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <path d="M5.5 2.5v11M10.5 2.5v11" />
        </svg>
      }
    />
  );
}

/** The views of Cull's switch (ODDHALLS_LAYOUT_PLAN 3): One is `ReviewMode` in place, Two is Compare. */
type SwitchView = 'grid' | 'review' | 'compare';

/**
 * Plan 52: Cull's view switch (Grid · One · Two, on `ui.cull.view`; Survey and Decide are passes, not in it) and the
 * one zoom: in Grid a slider over the column count (J / K; wider cells to the right), in One and Two Fit · 1× · 2× ·
 * 4× (`ui.cull.zoom`, the linked viewport). Two opens Compare as C does (`openCompare`: the selection, else the focused
 * photo and the next) and is off with fewer than two photos. Only while a Cull stage is mounted.
 */
export function CullViewBar() {
  const onCull = useCullStore((s) => s.stages > 0);
  const view = useUiStore((s) => s.cull.view);
  const columns = useUiStore((s) => s.cull.columns);
  const zoom = useUiStore((s) => s.cull.zoom);
  const count = useUiStore((s) => s.review?.ids.length ?? 0);
  if (!onCull || count === 0) return null;
  const choose = (next: SwitchView) => {
    const { setCull } = useUiStore.getState();
    if (next === 'compare') openCompare();
    else setCull({ view: next });
  };
  const looking = view === 'review' || view === 'compare';
  return (
    <span className="flex items-center gap-1.5">
      <Segmented<SwitchView>
        label="View"
        // Survey and Decide (passes) leave no item pressed.
        value={view as SwitchView}
        onChange={choose}
        items={[
          { value: 'grid', label: 'Grid', title: 'Every photo (Esc)' },
          { value: 'review', label: 'One', title: 'One photo large (Space, or double-click a photo)' },
          {
            value: 'compare',
            label: 'Two',
            disabled: count < 2,
            title: 'Two side by side: the selection, else this photo and the next (C)',
          },
        ]}
      />
      {looking ? (
        <Segmented<CullZoom>
          label="Zoom"
          value={zoom}
          onChange={(next) => useUiStore.getState().setCull({ zoom: next })}
          items={ZOOM_STOPS.map((stop) => ({
            value: stop,
            label: stop === 'fit' ? 'Fit' : `${stop}×`,
            title: stop === 'fit' ? 'Fit (Shift+F)' : `${stop}× the preview's pixels (double-click: 1× at the point)`,
          }))}
        />
      ) : (
        <input
          type="range"
          aria-label="Zoom: grid columns"
          title="Cell size (J / K)"
          min={CULL_COLUMNS_MIN}
          max={CULL_COLUMNS_MAX}
          step={1}
          value={CULL_COLUMNS_MAX + CULL_COLUMNS_MIN - columns}
          onChange={(e) =>
            useUiStore.getState().setCull({ columns: CULL_COLUMNS_MAX + CULL_COLUMNS_MIN - Number(e.target.value) })
          }
          className="h-1 w-24 cursor-pointer accent-fg"
        />
      )}
    </span>
  );
}
