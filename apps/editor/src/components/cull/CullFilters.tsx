import { type GroupSpacing, LENS_CAVEATS, LENS_KINDS, LENS_LABELS, type Lens, type LensKind } from '@photobook/shared';
import { useMemo } from 'react';
import { canMerge, canSplit, mergeSelected, splitGroup, ungroup, useCullStore, useGroups } from '../../store/cull';
import { useLensReading } from '../../store/lenses';
import { useUiStore } from '../../store/ui';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { MenuSeparator } from '../ui/Menu';
import { PopoverButton } from '../ui/Popover';
import { Segmented } from '../ui/Segmented';
import { GroupBySelect } from './CullGrid';

/** The Group options' actions: full-width ghost rows (plan 47). */
const ACTION = 'w-full justify-start';

const SPACINGS: readonly { value: GroupSpacing; label: string }[] = [
  { value: 'tighter', label: 'Tighter' },
  { value: 'normal', label: 'Normal' },
  { value: 'looser', label: 'Looser' },
];

/**
 * The Cull stage's own filter controls (implementation plan 38–56, "Filter controls as one fragment"): plan 40's
 * *Stars* toggle (`ui.cull.showStars`), then the one *Group by* select (plan 49 folded plan 39's Group toggle into plan
 * 53's select: Bursts is its default option) and plan 39's Group options ▾ (Grouping tighter / normal / looser, Merge
 * selected, Split group, Ungroup) when the list has groups, then plan 41's *Lens* select (None, Soft, Blown, Dark) and, while a lens is on,
 * its one-line caveat on a line of its own. Plan 51 moved the fragment into the sidebar's Filters section, and *Decide*
 * with the decided / total fraction into the filter bar (`LibraryFilterBar`), so plan 47 took them out of here.
 * Self-contained: it reads `ui.cull`, the Cull list (`ui.review`) and the selection, and renders nothing outside Cull
 * (no `CullStage` mounted: `useCullStageMark`). `scope` is the filter bar's: which view holds the lens (the library's
 * `libraryView` or the project's `filmstrip`). Counts elsewhere stay photo counts. Plan 47: the controls are the
 * primitives (`toggle` Buttons, `Select`, a `Popover` with a `Segmented`); the fragment makes no assumption about its
 * parent beyond laying its pieces out in a row or a stack.
 */
export function CullFilters({ scope = 'library' }: { scope?: 'library' | 'project' }) {
  const ids = useUiStore((s) => s.review?.ids);
  const onCull = useCullStore((s) => s.stages > 0);
  if (!onCull) return null;
  return (
    <>
      <StarsToggle />
      {/* Plan 49: one *Group by* control (Bursts, the default; no grouping; plan 53's dividers), then the groups' ▾. */}
      <GroupBySelect />
      {ids && <GroupControls ids={ids} />}
      {/* The lens stays when it leaves no photo (no list), so it can be turned off. */}
      <LensControls ids={ids ?? NO_IDS} scope={scope} />
    </>
  );
}

const NO_IDS: readonly string[] = [];

/**
 * Plan 41: the *Lens* select. With no lens on, each choice counts the list's photos in it; with one on, the list is
 * that lens. The caveat line says what the lens measures and that it never flags (Cmd+A, X rejects what it shows); on
 * Blown it counts the RAW sources (*RAW headroom*). Changing the lens writes nothing but the view.
 */
function LensControls({ ids, scope }: { ids: readonly string[]; scope: 'library' | 'project' }) {
  const lens = useUiStore((s) => (scope === 'project' ? s.filmstrip.lens : s.libraryView.lens));
  const reading = useLensReading();
  const counts = useMemo(() => {
    const out: Record<LensKind, number> = { soft: 0, blown: 0, dark: 0 };
    let raw = 0;
    for (const id of ids) {
      const r = reading(id);
      if (!r) continue;
      if (r.verdict.soft) out.soft += 1;
      if (r.verdict.blown) out.blown += 1;
      if (r.verdict.dark) out.dark += 1;
      if (r.verdict.rawHeadroom) raw += 1;
    }
    return { ...out, raw };
  }, [ids, reading]);
  const set = (next: Lens) => {
    const ui = useUiStore.getState();
    if (scope === 'project') ui.setFilmstrip({ lens: next });
    else ui.setLibraryView({ lens: next });
  };
  const caveat = lens === 'soft' || lens === 'blown' || lens === 'dark' ? LENS_CAVEATS[lens] : null;
  return (
    <>
      <Select
        value={lens}
        onChange={(e) => set(e.target.value as Lens)}
        aria-label="Lens"
        title="Technical lenses rank and explain; they never flag a photo"
      >
        <option value="none">No lens</option>
        {LENS_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {LENS_LABELS[kind]}
            {lens === 'none' ? ` · ${counts[kind]}` : lens === kind ? ` · ${ids.length}` : ''}
          </option>
        ))}
        {lens === 'any' && <option value="any">Any lens · {ids.length}</option>}
      </Select>
      {caveat && (
        <p role="note" className="order-last w-full text-[11px] text-fg-muted">
          {caveat}
          {lens === 'blown' && counts.raw > 0
            ? `. RAW headroom: ${counts.raw} of them ${counts.raw === 1 ? 'is a RAW' : 'are RAWs'}, which often recover`
            : ''}
          . A lens never flags: ⌘A then X rejects what it shows.
        </p>
      )}
    </>
  );
}

/** *Stars* (`ui.cull.showStars`): star ratings in the grid. */
function StarsToggle() {
  const showStars = useUiStore((s) => s.cull.showStars);
  return (
    <Button
      variant="toggle"
      size="sm"
      pressed={showStars}
      onClick={() => useUiStore.getState().setCull({ showStars: !showStars })}
      title="Show star ratings in the grid"
    >
      Stars
    </Button>
  );
}

/** Plan 39's Group options ▾ (the toggle is *Group by*'s Bursts since plan 49); nothing when the list has no groups. */
function GroupControls({ ids }: { ids: string[] }) {
  const index = useUiStore((s) => s.review?.index ?? 0);
  const selection = useUiStore((s) => s.selection.keys);
  const spacing = useCullStore((s) => s.spacing);
  const groups = useGroups(ids);
  if (groups.groups.length === 0) return null;

  const focused = ids[index];
  const focusedGroup = focused === undefined ? undefined : groups.byPhoto.get(focused);
  const mergeable = canMerge(selection, groups);
  const splittable = focused !== undefined && canSplit(focused, groups);

  return (
    <span className="flex items-center gap-0.5">
      <PopoverButton
        label="▾"
        ariaLabel="Group options"
        title={`Group options: ${groups.groups.length} group${groups.groups.length === 1 ? '' : 's'}`}
        panelLabel="Group options"
        width={240}
      >
        {(close) => (
          <div className="flex flex-col gap-0.5 p-1">
            <p className="section-title px-2 pt-1">Grouping</p>
            <Segmented
              label="Grouping"
              items={SPACINGS}
              value={spacing}
              onChange={(value) => useCullStore.getState().setSpacing(value)}
              className="mx-1 flex"
            />
            <MenuSeparator />
            <Button
              variant="ghost"
              size="sm"
              className={ACTION}
              disabled={!mergeable}
              onClick={() => {
                close();
                mergeSelected(selection, groups);
              }}
            >
              Merge selected
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={ACTION}
              disabled={!splittable}
              title="Split the focused photo's group before it"
              onClick={() => {
                close();
                if (focused !== undefined) splitGroup(focused, groups);
              }}
            >
              Split group
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={ACTION}
              disabled={!focusedGroup}
              onClick={() => {
                close();
                if (focusedGroup) ungroup(focusedGroup);
              }}
            >
              Ungroup
            </Button>
            <p className="px-2 pt-1 pb-0.5 text-[11px] text-fg-muted leading-snug">
              Same camera and lens, seconds apart, alike. A camera that writes no subsecond time can split a burst at a
              second; two cameras never share a group.
            </p>
          </div>
        )}
      </PopoverButton>
    </span>
  );
}
