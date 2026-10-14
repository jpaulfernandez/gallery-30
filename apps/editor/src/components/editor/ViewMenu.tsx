import { useDesignBook } from '../../store/design';
import { type UiPrefs, useUiStore } from '../../store/ui';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { clearPageGuides } from './pageGuides';

type BooleanPref = { [K in keyof UiPrefs]: UiPrefs[K] extends boolean ? K : never }[keyof UiPrefs];

const ENTRIES: Array<{ pref: BooleanPref; label: string; hint?: string }> = [
  { pref: 'showGrid', label: 'Show grid' },
  { pref: 'showMargins', label: 'Show safe area / margins' },
  { pref: 'showRulers', label: 'Show rulers and guides', hint: 'Drag from a ruler onto the page for a guide' },
  {
    pref: 'snapEnabled',
    label: 'Snap to guides',
    hint: 'Hold Cmd while dragging to skip. Ruler guides snap only while rulers are shown',
  },
  {
    pref: 'showGuidesWhileDragging',
    label: 'Show guides while dragging',
    hint: 'Draw snap lines and distances during a drag (snapping works either way)',
  },
];

/**
 * The View ▾ menu of the Design stage's top bar (workflow plan 31): the canvas view prefs (grid, margins, rulers and
 * ruler guides, snapping, the guides drawn while dragging), stored per machine like every UI pref, and removing the
 * current page's ruler guides (one undo step). Plan 45: on `Menu`; the prefs are check items that keep it open.
 */
export function ViewMenu() {
  const book = useDesignBook();
  const pageIndex = useUiStore((s) => s.pageIndex);
  const page = book?.pages[pageIndex];
  const guideCount = page?.guides.length ?? 0;
  return (
    <Menu
      label={
        <>
          View <span aria-hidden="true">▾</span>
        </>
      }
      title="Canvas view: grid, margins, rulers, snapping"
      menuLabel="View"
      width={260}
      alignEnd
      className="mr-2"
    >
      {ENTRIES.map((e) => (
        <PrefCheck key={e.pref} {...e} />
      ))}
      <MenuSeparator />
      <MenuItem
        disabled={!page || guideCount === 0}
        onSelect={() => {
          if (page) clearPageGuides(page.id);
        }}
      >
        Remove this page's guides{guideCount > 0 ? ` (${guideCount})` : ''}
      </MenuItem>
    </Menu>
  );
}

function PrefCheck({ pref, label, hint }: { pref: BooleanPref; label: string; hint?: string }) {
  const on = useUiStore((s) => s[pref]);
  return (
    <MenuItem checked={on} hint={hint} onSelect={() => useUiStore.getState().setPref(pref, !on)}>
      {label}
    </MenuItem>
  );
}
