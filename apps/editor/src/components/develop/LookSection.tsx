import type { DevelopSettings, LutRef } from '@photobook/shared';
import { ask, open as openDialog } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { suggestedFittedLut } from '../../lib/develop/cameraPairs';
import { isSectionDefault } from '../../lib/develop/sections';
import { errorMessage } from '../../lib/errors';
import { devError } from '../../lib/log';
import type { FilmTag, LutInfo } from '../../lib/tauri';
import { useBookStore } from '../../store/book';
import { assetFolder, photoMeta } from '../../store/library';
import { filmSimulationOf, useLutsStore } from '../../store/luts';
import { Button } from '../ui/Button';
import { MatchCameraDialog } from './MatchCameraDialog';
import { Slider } from './Slider';

const LUT_FILTERS = [{ name: 'LUTs (.cube, HALD .png)', extensions: ['cube', 'png'] }];
const NONE = '';
const percent = (v: number) => `${v}%`;

interface LookSectionProps {
  assetId: string;
  settings: DevelopSettings;
}

/**
 * Pick a `.cube` or HALD `.png` in the open dialog and import it into `<appData>/luts` (null when cancelled). Rejects
 * with the reason an import failed (1D LUT, bad size, ...).
 */
export async function pickLutFile(): Promise<LutInfo | null> {
  const picked = await openDialog({ multiple: false, directory: false, filters: LUT_FILTERS });
  if (typeof picked !== 'string') return null;
  return useLutsStore.getState().importFile(picked);
}

/**
 * The Look section of plan 18 (a 3D LUT from `<appData>/luts`, its strength, "LUT missing: name" with Locate…). The
 * Develop panel now shows these controls inside the Looks section (`LooksSection`, plan 20) as `LutControls`; this
 * standalone section stays for anything that wants the LUT on its own.
 */
export function LookSection({ assetId, settings }: LookSectionProps) {
  const lut = settings.look.lut;
  const [open, setOpen] = useState(lut !== null);
  const present = useLutsStore((s) => (lut ? s.present[lut.id] : undefined));
  const missing = lut !== null && present === false;
  const isDefault = isSectionDefault(settings, 'look');

  // Presence while a LUT is set (the list is asked for once the controls open).
  const lutId = lut?.id;
  useEffect(() => {
    if (lutId) void useLutsStore.getState().checkPresent(lutId);
  }, [lutId]);

  return (
    <section className="border-line border-b" aria-label="Look">
      <div className="flex items-center pr-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-1.5 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
        >
          <svg
            viewBox="0 0 16 16"
            className={`size-3 text-fg-muted transition-transform ${open ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="section-title">Look</span>
          {!open && lut && (
            <span className={`ml-auto truncate text-[11px] ${missing ? 'text-danger' : 'text-fg-muted'}`}>
              {missing ? `LUT missing: ${lut.name}` : lut.name}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => useBookStore.getState().resetDevelopSection(assetId, 'look')}
          disabled={isDefault}
          aria-label="Reset Look"
          title="Reset Look"
          className="rounded-md px-1.5 py-0.5 text-[11px] text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-0"
        >
          Reset
        </button>
      </div>
      {open && <LutControls assetId={assetId} settings={settings} />}
    </section>
  );
}

interface LutControlsProps extends LookSectionProps {
  /** Show plan 22's suggestion row and Match camera JPEG… entry here (the Looks section shows them itself). */
  cameraMatch?: boolean;
}

/**
 * The LUT picker (plan 18): None or a stored LUT, Import…, "LUT missing: name" with Locate…, Strength and Delete LUT
 * file…. Lists the stored LUTs when it mounts. Presence is checked by the section around it.
 */
export function LutControls({ assetId, settings, cameraMatch = true }: LutControlsProps) {
  const lut = settings.look.lut;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const luts = useLutsStore((s) => s.luts);
  const loaded = useLutsStore((s) => s.loaded);
  const present = useLutsStore((s) => (lut ? s.present[lut.id] : undefined));
  const missing = lut !== null && present === false;

  // A LUT chosen by hand is no longer the look's (plan 20): `applied` is cleared.
  const setLut = (next: LutRef | null) =>
    useBookStore.getState().setAssetDevelop(assetId, { look: { lut: next, applied: null } });

  useEffect(() => {
    if (!loaded) void useLutsStore.getState().load();
  }, [loaded]);

  async function pickAndImport(): Promise<void> {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const info = await pickLutFile();
      if (!info) return;
      // Locate keeps the strength; a new LUT starts at full strength.
      setLut({ id: info.id, name: info.name, strength: lut?.strength ?? 100 });
    } catch (err) {
      setError(errorMessage(err));
      devError('develop', 'LUT import failed', err);
    } finally {
      setBusy(false);
    }
  }

  async function deleteFile(id: string, name: string): Promise<void> {
    const confirmed = await ask(
      `Delete the LUT “${name}” from this Mac?\n\nPhotos that use it will show it as missing until you import it again.`,
      { title: 'Delete LUT', kind: 'warning', okLabel: 'Delete', cancelLabel: 'Cancel' },
    );
    if (!confirmed) return;
    try {
      await useLutsStore.getState().remove(id);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const choose = (id: string) => {
    if (id === NONE) return setLut(null);
    const info = luts.find((l) => l.id === id);
    if (info) setLut({ id: info.id, name: info.name, strength: lut?.strength ?? 100 });
  };

  const listed = lut !== null && luts.some((l) => l.id === lut.id);

  return (
    <div className="space-y-3 px-3 pt-1 pb-4">
      <div className="flex items-center gap-2">
        <select
          aria-label="LUT"
          value={lut?.id ?? NONE}
          onChange={(e) => choose(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <option value={NONE}>None</option>
          {luts.map((l) => (
            <option key={l.id} value={l.id}>
              {l.size > 0 ? `${l.name} (${l.size}³)` : l.name}
            </option>
          ))}
          {lut && !listed && <option value={lut.id}>{missing ? `${lut.name} (missing)` : lut.name}</option>}
        </select>
        <Button size="sm" onClick={() => void pickAndImport()} disabled={busy}>
          {busy ? 'Importing…' : 'Import…'}
        </Button>
      </div>
      {/* Workflow plan 22: Match camera JPEG and its suggestion (the Looks section shows both itself, plan 20). */}
      {cameraMatch && (
        <>
          <FittedSuggestion assetId={assetId} current={lut} />
          <MatchCameraEntry assetId={assetId} />
        </>
      )}
      {missing && lut && (
        <div className="flex items-center gap-2 text-[12px]" role="status">
          <span className="min-w-0 flex-1 truncate text-danger" title={lut.id}>
            LUT missing: {lut.name}
          </span>
          <button
            type="button"
            onClick={() => void pickAndImport()}
            disabled={busy}
            className="rounded-md px-1.5 py-0.5 text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
          >
            Locate…
          </button>
        </div>
      )}
      {lut && (
        <Slider
          label="Strength"
          value={lut.strength}
          min={0}
          max={100}
          defaultValue={100}
          format={percent}
          onChange={(strength) =>
            useBookStore.getState().setAssetDevelop(assetId, { look: { lut: { strength }, applied: null } })
          }
        />
      )}
      {lut && listed && !missing && (
        <button
          type="button"
          onClick={() => void deleteFile(lut.id, lut.name)}
          className="text-[11px] text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
        >
          Delete LUT file…
        </button>
      )}
      {error && (
        <p className="text-[11px] text-danger" role="alert">
          {error}
        </p>
      )}
      {!lut && luts.length === 0 && loaded && (
        <p className="text-[11px] text-fg-muted">Import a .cube file or a HALD CLUT to use it as a look.</p>
      )}
    </div>
  );
}

// ---------- Workflow plan 22: Match camera JPEG ----------
// The entry that opens the fit dialog and the "Suggested: Classic Chrome (fitted)" row. Plan 20 (Looks UI) moves both
// into the Looks strip and its menu.

/** "Match camera JPEG…": fit a look from the folder's RAW + camera JPEG pairs (`MatchCameraDialog`). */
export function MatchCameraEntry({ assetId }: { assetId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
      >
        Match camera JPEG…
      </button>
      {open && <MatchCameraDialog assetId={assetId} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * For a photo whose file records a film simulation (Fujifilm RAF or JPEG), the fitted look with that tag (and camera,
 * when both are known), when one exists and is not already the photo's LUT.
 */
export function FittedSuggestion({ assetId, current }: { assetId: string; current: LutRef | null }) {
  const folder = useBookStore((s) => assetFolder(s, assetId));
  const path = useBookStore((s) => photoMeta(s, assetId)?.path ?? null);
  const luts = useLutsStore((s) => s.luts);
  const [tag, setTag] = useState<FilmTag | null>(null);
  useEffect(() => {
    setTag(null);
    if (!folder || !path) return;
    let live = true;
    void filmSimulationOf(folder, path).then((read) => {
      if (live) setTag(read);
    });
    return () => {
      live = false;
    };
  }, [folder, path]);
  const suggested = suggestedFittedLut(luts, tag);
  const simulation = tag?.simulation;
  if (!suggested || !simulation || current?.id === suggested.id) return null;
  return (
    <div className="flex items-center gap-2 text-[12px]" role="status">
      <span className="min-w-0 flex-1 truncate text-fg-muted" title={suggested.name}>
        Suggested: {simulation} (fitted)
      </span>
      <button
        type="button"
        onClick={() =>
          useBookStore.getState().setAssetDevelop(assetId, {
            // Plan 20: a LUT applied here is not a look's, so `applied` is cleared.
            look: {
              lut: { id: suggested.id, name: suggested.name, strength: current?.strength ?? 100 },
              applied: null,
            },
          })
        }
        className="rounded-md px-1.5 py-0.5 text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
      >
        Apply
      </button>
    </div>
  );
}
