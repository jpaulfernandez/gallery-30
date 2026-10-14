import { useRef, useState } from 'react';
import { type Preset, presetSections } from '../../lib/develop/presets';
import {
  DEFAULT_SYNC_SECTIONS,
  type DevelopSyncSection,
  SYNC_SECTION_LABELS,
  SYNC_SECTIONS,
  SYNC_WARNINGS,
} from '../../lib/develop/sync';
import { devLog } from '../../lib/log';
import { basename } from '../../lib/path';
import { currentDeveloped, usePhotoLookup } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { filmstripOrder } from '../filmstrip/visible';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { SectionChecklist } from './SectionChecklist';
import { usePresets } from './usePresets';

/** `''` in the "What to apply" select: sections copied from the source photo; otherwise a preset id. */
const FROM_PHOTO = '';

/**
 * Sync (step D6.3): copy chosen sections of this photo's settings onto other photos, or apply a preset to them. The
 * targets are picked from a thumbnail grid of the photos the filmstrip shows (the Develop view's list while it is
 * open); the batch bar (workflow plan 08) opens it with the selection checked. Basic, Curve, Color and Detail are on by default; Transform and Upright
 * and Masks are per photo and start off, and the crop is never synced. One undo step for all photos.
 */
export function SyncDialog() {
  const dialog = useUiStore((s) => s.syncDialog);
  if (!dialog) return null;
  return <SyncDialogBody sourceId={dialog.sourceId} targets={dialog.targets} />;
}

function SyncDialogBody({ sourceId, targets: initial }: { sourceId: string; targets?: readonly string[] }) {
  const close = useUiStore((s) => s.closeSyncDialog);
  const lookup = usePhotoLookup();
  const profile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const { presets } = usePresets(true);
  const [sections, setSections] = useState<DevelopSyncSection[]>([...DEFAULT_SYNC_SECTIONS]);
  const [what, setWhat] = useState(FROM_PHOTO);
  // The batch bar opens it with the selection checked.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(initial ?? []));
  const lastClicked = useRef<number | null>(null);

  const preset: Preset | undefined = what === FROM_PHOTO ? undefined : presets.find((p) => p.id === what);
  const sourceName = basename(lookup.path(sourceId));

  // The photos the Develop view steps through, else what the filmstrip shows. Fixed when the dialog opens.
  const [candidates] = useState<string[]>(() => {
    const session = useUiStore.getState().develop;
    const ids = session ? session.ids : filmstripOrder();
    return ids.includes(sourceId) ? ids : [sourceId, ...ids];
  });
  // Copying settings onto the photo they come from is a no-op; a preset can go on any photo.
  const targets = preset ? candidates : candidates.filter((id) => id !== sourceId);
  const chosen = targets.filter((id) => picked.has(id));

  const click = (id: string, index: number, shift: boolean) => {
    // Read before the updater runs: it may run after `lastClicked` has moved on.
    const anchor = lastClicked.current;
    setPicked((prev) => {
      const next = new Set(prev);
      if (shift && anchor !== null) {
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
        const on = !prev.has(id);
        for (const other of targets.slice(from, to + 1)) {
          if (on) next.add(other);
          else next.delete(other);
        }
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClicked.current = index;
  };

  const canApply = chosen.length > 0 && (preset ? presetSections(preset).length > 0 : sections.length > 0);
  const apply = () => {
    const store = useBookStore.getState();
    const changed = preset ? store.applyDevelopPreset(chosen, preset) : store.syncDevelop(sourceId, chosen, sections);
    devLog('develop', preset ? 'applied preset to photos' : 'synced settings', {
      targets: chosen.length,
      changed,
      sections: preset ? undefined : sections,
    });
    close();
  };

  return (
    <DialogShell title={`Sync settings from ${sourceName}`} onClose={close} widthClass="w-[44rem]">
      <DialogBody>
        <label className="flex items-center gap-2">
          <span className="text-fg-muted">Apply</span>
          <select
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            aria-label="What to apply"
            className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 py-1 text-fg outline-none focus:border-accent"
          >
            <option value={FROM_PHOTO}>Settings of this photo</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                Preset: {p.name}
              </option>
            ))}
          </select>
        </label>

        {preset ? (
          <p className="text-fg-muted">
            Applies {presetSections(preset).length === 1 ? 'its one section' : 'its sections'} (
            {presetSections(preset).join(', ')}) to the photos below; their crop, rotation and masks stay.
          </p>
        ) : (
          <SectionChecklist
            legend="Sections to copy"
            sections={SYNC_SECTIONS}
            labels={SYNC_SECTION_LABELS}
            warnings={SYNC_WARNINGS}
            checked={sections}
            onChange={setSections}
            footnote="The crop, rotation and flips are never synced."
          />
        )}

        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="mr-auto text-fg-muted">Photos to change</span>
            <span className="tabular-nums text-fg-muted" role="status">
              {chosen.length} selected
            </span>
            <button
              type="button"
              onClick={() => setPicked(new Set(targets))}
              className="rounded px-1.5 py-0.5 text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setPicked(new Set())}
              className="rounded px-1.5 py-0.5 text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
            >
              Select none
            </button>
          </div>
          {targets.length === 0 ? (
            <p className="py-4 text-center text-fg-muted">There are no other photos in the filmstrip to sync to.</p>
          ) : (
            <ul
              aria-label="Photos"
              className="grid max-h-72 grid-cols-6 gap-1 scrollbar overflow-x-hidden overflow-y-auto rounded-md border border-line p-1"
            >
              {targets.map((id, index) => {
                const file = lookup.file(id);
                const name = basename(lookup.path(id) || id);
                const on = picked.has(id);
                const thumb = file
                  ? (currentDeveloped(file, lookup.fields(id)?.develop, profile)?.thumbUrl ?? file.thumbUrl)
                  : undefined;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      aria-label={name}
                      title={name}
                      onClick={(e) => click(id, index, e.shiftKey)}
                      className={`relative block aspect-square w-full overflow-hidden rounded-sm bg-line outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                        on ? 'ring-2 ring-accent' : 'opacity-70 hover:opacity-100'
                      }`}
                    >
                      {thumb && (
                        <img
                          src={thumb}
                          alt=""
                          loading="lazy"
                          draggable={false}
                          className="h-full w-full object-cover"
                        />
                      )}
                      {on && (
                        <span
                          aria-hidden="true"
                          className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-accent text-[10px] text-accent-ink"
                        >
                          ✓
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-[11px] text-fg-muted">Shift-click selects a range.</p>
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogButton onClick={close}>Cancel</DialogButton>
        <DialogButton primary onClick={apply} disabled={!canApply}>
          {preset ? 'Apply preset' : 'Sync'} to {chosen.length} {chosen.length === 1 ? 'photo' : 'photos'}
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}
