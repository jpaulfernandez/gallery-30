import type { DevelopSettings } from '@photobook/shared';
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import {
  applyLook,
  builtInLookDef,
  chosenLookId,
  clampAmount,
  LOOK_OPTIONAL_SECTIONS,
  lookAmountOf,
  lookBase,
  lookDefaultAmount,
  makeLook,
  makeLutLook,
  NO_LOOK,
} from '../../lib/develop/looks';
import { PRESET_SECTION_LABELS, type Preset } from '../../lib/develop/presets';
import { type DevelopSectionKey, isSectionDefault } from '../../lib/develop/sections';
import { errorMessage } from '../../lib/errors';
import { devError, devLog } from '../../lib/log';
import { fileUrl, type LookThumbResult, onLookThumb, renderLookThumbs } from '../../lib/tauri';
import { usePhotoFile } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { assetFolder, photoMeta } from '../../store/library';
import { applyLookTo, findLook, useAllLooks, useLooksStore } from '../../store/looks';
import { useLutsStore } from '../../store/luts';
import { buttonClass } from '../ui/Button';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { Tooltip } from '../ui/Tooltip';
import { BatchButton } from './BatchBar';
import { type BatchContext, registerBatchSlot } from './batchSlots';
import { FittedSuggestion, LutControls, pickLutFile } from './LookSection';
import { MatchCameraDialog } from './MatchCameraDialog';
import { MoreIcon, PanelCard } from './PanelCard';
import { RenderDot, useRenderProgress, useRenderSlow } from './renderProgress';
import { Slider } from './Slider';

/**
 * The Looks section at the top of the Develop panel (workflow plan 20): a strip of the photo rendered with each look
 * (None first; the chosen one ringed; `[` / `]` step through them, see `DevelopMode`), the Amount of the chosen look,
 * a ⋯ menu (Save current as look…, Import LUT…, Match camera JPEG… of plan 22, Manage looks…), plan 22's fitted
 * suggestion, and the LUT picker of plan 18 (`LutControls`) under "LUT". The batch bar's Apply look… is registered here.
 */
interface LooksSectionProps {
  assetId: string;
  settings: DevelopSettings;
}

const percent = (v: number) => `${v}%`;
/** Thumbnails are asked for this long after the photo's settings stop changing. */
export const LOOK_THUMBS_DELAY_MS = 350;

type Dialog = 'save' | 'manage' | 'match' | null;

export function LooksSection({ assetId, settings }: LooksSectionProps) {
  const [open, setOpen] = useState(true);
  const [lutOpen, setLutOpen] = useState(settings.look.lut !== null);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const looks = useAllLooks();
  const loaded = useLooksStore((s) => s.loaded);
  const lutEpoch = useLutsStore((s) => s.epoch);
  const lut = settings.look.lut;
  const present = useLutsStore((s) => (lut ? s.present[lut.id] : undefined));
  const lutMissing = lut !== null && present === false;
  const applied = settings.look.applied;
  const chosen = chosenLookId(settings);
  const chosenLook = applied ? looks.find((l) => l.id === applied.presetId) : undefined;
  const isDefault = isSectionDefault(settings, 'look') && isSectionDefault(settings, 'effects');

  useEffect(() => {
    if (!loaded) void useLooksStore.getState().load();
  }, [loaded]);
  // The stored LUTs, for plan 22's fitted suggestion (and the LUT picker).
  const lutsLoaded = useLutsStore((s) => s.loaded);
  useEffect(() => {
    if (open && !lutsLoaded) void useLutsStore.getState().load();
  }, [open, lutsLoaded]);
  // A fitted LUT (plan 22) saves its look in the background: list again when a LUT arrives.
  const firstEpoch = useRef(lutEpoch);
  useEffect(() => {
    if (lutEpoch !== firstEpoch.current) void useLooksStore.getState().load();
  }, [lutEpoch]);
  const lutId = lut?.id;
  useEffect(() => {
    if (lutId) void useLutsStore.getState().checkPresent(lutId);
  }, [lutId]);

  const thumbs = useLookThumbs(assetId, settings, looks, open);

  // Plan 46: the tile that asked for the render carries the pulsing dot while the preview is late (none under 300 ms).
  const [asked, setAsked] = useState<string | null>(null);
  const pending = useRenderProgress((s) => s.pending);
  const rendering = useRenderSlow();
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) setAsked(null);
    wasPending.current = pending;
  }, [pending]);
  // None always runs: it also clears hand-set effects when no look is applied (nothing changed is no undo step).
  const choose = (id: string) => {
    // The chosen look again starts it over when it was edited since (its Amount is then locked).
    if (id === chosen && id !== NO_LOOK && (!chosenLook || lookAmountOf(settings, chosenLook) !== null)) return;
    // A built-in look starts at its own Amount (plan 21); a saved look at 100.
    setAsked(id);
    applyLookTo([assetId], id);
  };
  const lutsList = useLutsStore((s) => s.luts);
  const lutPresence = useLutsStore((s) => s.present);
  /** A look whose LUT is not on this Mac: its thumbnail shows the photo without the LUT, so the cell says so. */
  const lookLutMissing = (look: Preset): boolean => {
    const id = lookLutId(look);
    if (!id) return false;
    return lutPresence[id] === false || (lutsLoaded && !lutsList.some((l) => l.id === id));
  };
  const ids = [NO_LOOK, ...looks.map((l) => l.id)];
  const focusIndex = Math.max(0, chosen === null ? 0 : ids.indexOf(chosen));
  const stripRef = useRef<HTMLDivElement>(null);
  // Left / Right move the choice within the strip (one tab stop: the chosen cell).
  const onStripKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : null;
    if (dir === 0 && to === null) return;
    e.preventDefault();
    e.stopPropagation();
    const at = ids.indexOf((document.activeElement as HTMLElement | null)?.dataset.lookId ?? '');
    const next = to ?? Math.min(ids.length - 1, Math.max(0, (at < 0 ? focusIndex : at) + dir));
    const id = ids[next];
    if (!id) return;
    choose(id);
    stripRef.current?.querySelector<HTMLElement>(`[data-look-id="${CSS.escape(id)}"]`)?.focus();
  };

  async function importLut(): Promise<void> {
    setError(null);
    try {
      const info = await pickLutFile();
      if (!info) return;
      // The LUT becomes a look (unless one already is this LUT) and the photo takes it.
      // Only a look that is just this LUT counts (one with effects or a curve is another look).
      const existing = looks.find(
        (l) => l.sections.length === 1 && l.sections[0] === 'look' && lookLutId(l) === info.id,
      );
      const look = existing ?? makeLutLook(info.name, info);
      if (!existing) await useLooksStore.getState().save(look);
      applyLookTo([assetId], look.id, 100);
    } catch (err) {
      setError(errorMessage(err));
      devError('develop', 'LUT import failed', err);
    }
  }

  const summary = chosenLook?.name ?? (applied ? 'Look not found' : lut ? lut.name : null);

  return (
    <>
      <PanelCard
        title="Looks"
        open={open}
        onToggle={() => setOpen((o) => !o)}
        meta={!open && summary && <span className="ml-auto truncate pr-1 text-[11px] text-fg-muted">{summary}</span>}
        actions={
          <LooksMenu
            open={menu}
            onOpen={setMenu}
            onSave={() => setDialog('save')}
            onImport={() => void importLut()}
            onMatch={() => setDialog('match')}
            onManage={() => setDialog('manage')}
          />
        }
        onReset={() => applyLookTo([assetId], NO_LOOK)}
        resetDisabled={isDefault && !applied}
        resetTitle="Remove the look (its sections back to the defaults)"
        bodyClassName="space-y-3"
      >
        <div
          ref={stripRef}
          role="listbox"
          aria-label="Looks"
          aria-orientation="horizontal"
          data-no-step
          onKeyDown={onStripKeyDown}
          className="scrollbar flex gap-2 overflow-x-auto px-3 py-1"
        >
          <LookCell
            id={NO_LOOK}
            name="None"
            url={thumbs[NO_LOOK]}
            selected={chosen === NO_LOOK}
            working={rendering && asked === NO_LOOK}
            tabbable={focusIndex === 0}
            onPick={choose}
          />
          {looks.map((look, i) => (
            <LookCell
              key={look.id}
              id={look.id}
              name={look.name}
              about={builtInLookDef(look.id)?.about}
              url={thumbs[look.id]}
              selected={chosen === look.id}
              working={rendering && asked === look.id}
              tabbable={focusIndex === i + 1}
              lutMissing={lookLutMissing(look)}
              onPick={choose}
            />
          ))}
        </div>
        {loaded && looks.length === 0 && (
          <p className="px-3 text-[11px] text-fg-muted">
            No looks yet: save the current settings as a look, or import a LUT, from the ⋯ menu.
          </p>
        )}
        <div className="space-y-3 px-3">
          <FittedSuggestion assetId={assetId} current={lut} />
          {applied && <AmountSlider assetId={assetId} look={chosenLook} amount={applied.amount} settings={settings} />}
          {applied && !chosenLook && loaded && (
            <p className="text-[11px] text-fg-muted" role="status">
              The look applied to this photo is not on this Mac, so its Amount is locked.
            </p>
          )}
          {applied && chosenLook && lookAmountOf(settings, chosenLook) === null && (
            <p className="text-[11px] text-fg-muted" role="status">
              Changed since the look was applied, so its Amount is locked (choose the look again to start over).
            </p>
          )}
          {error && (
            <p className="text-[11px] text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
        <div>
          <button
            type="button"
            aria-expanded={lutOpen}
            onClick={() => setLutOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
          >
            <svg
              viewBox="0 0 16 16"
              className={`size-2.5 transition-transform ${lutOpen ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            LUT
            {lut && !lutOpen && (
              <span className={`ml-auto truncate ${lutMissing ? 'text-danger' : ''}`}>
                {lutMissing ? `LUT missing: ${lut.name}` : `${lut.name} · ${lut.strength}%`}
              </span>
            )}
          </button>
          {lutOpen && <LutControls assetId={assetId} settings={settings} cameraMatch={false} />}
        </div>
      </PanelCard>
      {dialog === 'save' && <SaveLookDialog assetId={assetId} settings={settings} onClose={() => setDialog(null)} />}
      {dialog === 'manage' && <ManageLooksDialog onClose={() => setDialog(null)} />}
      {dialog === 'match' && <MatchCameraDialog assetId={assetId} onClose={() => setDialog(null)} />}
    </>
  );
}

function LookCell({
  id,
  name,
  about,
  url,
  selected,
  working = false,
  tabbable,
  lutMissing = false,
  onPick,
}: {
  id: string;
  name: string;
  /** A built-in look's description (plan 21), shown in the tooltip. */
  about?: string;
  url: string | undefined;
  selected: boolean;
  /** Plan 46: the photo is rendering with this look (the pulsing accent dot). */
  working?: boolean;
  /** The strip's one tab stop (the chosen cell, else None). */
  tabbable: boolean;
  /** The look's LUT file is not on this Mac (the thumbnail lacks it). */
  lutMissing?: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      title={lutMissing ? `${name} (LUT missing on this Mac)` : about ? `${name}: ${about}` : name}
      data-look-id={id}
      data-lut-missing={lutMissing || undefined}
      onClick={() => onPick(id)}
      className="group flex w-16 shrink-0 flex-col items-center gap-1 rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span
        className={`relative block size-16 overflow-hidden rounded-xs bg-fg/6 transition-shadow duration-fast ${
          selected
            ? 'ring-2 ring-accent ring-offset-1 ring-offset-panel-2'
            : 'group-hover:ring-1 group-hover:ring-fg/25'
        }`}
      >
        {url ? (
          <img
            src={url}
            alt=""
            draggable={false}
            className={`h-full w-full object-cover ${lutMissing ? 'opacity-40' : ''}`}
          />
        ) : null}
        {lutMissing && (
          <span
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 bg-stage/70 text-center text-[9px] text-danger leading-3"
          >
            LUT missing
          </span>
        )}
        {working && <RenderDot className="absolute top-1 right-1 ring-1 ring-stage/60" label={`Rendering ${name}`} />}
      </span>
      <span className={`w-full truncate text-center text-[11px] ${selected ? 'text-fg' : 'text-fg-2'}`}>{name}</span>
    </button>
  );
}

/** Amount of the applied look: re-scales its sections from the defaults; locked when the look is not on this Mac. */
function AmountSlider({
  assetId,
  look,
  amount,
  settings,
}: {
  assetId: string;
  look: Preset | undefined;
  amount: number;
  settings: DevelopSettings;
}) {
  // Null once a section of the look was edited by hand: the slider then stays put (it would wipe the edit).
  const current = look ? lookAmountOf(settings, look) : null;
  const shown = current ?? amount;
  return (
    <Slider
      label="Amount"
      value={shown}
      min={0}
      max={100}
      defaultValue={lookDefaultAmount(look)}
      format={percent}
      disabled={!look || current === null}
      onChange={(v) => {
        if (!look || current === null) return;
        useBookStore.getState().setAssetDevelop(assetId, (prev) => applyLook(prev, look, clampAmount(v)));
      }}
    />
  );
}

/** The ⋯ menu of the Looks section. */
function LooksMenu({
  open,
  onOpen,
  onSave,
  onImport,
  onMatch,
  onManage,
}: {
  open: boolean;
  onOpen: (open: boolean) => void;
  onSave: () => void;
  onImport: () => void;
  onMatch: () => void;
  onManage: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node | null)) onOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open, onOpen]);

  const pick = (action: () => void) => () => {
    onOpen(false);
    action();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onOpen(false);
      rootRef.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };
  const item =
    'block w-full truncate px-3 py-1 text-left text-xs text-fg outline-none hover:bg-line focus-visible:bg-line';

  return (
    <div ref={rootRef} className="relative">
      <Tooltip label="Save, import and manage looks">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Looks menu"
          onClick={() => onOpen(!open)}
          className={buttonClass({ variant: 'ghost', size: 'sm', iconOnly: true })}
        >
          <MoreIcon />
        </button>
      </Tooltip>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Looks"
          data-no-step
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="absolute top-full right-0 z-30 mt-1 w-56 rounded-md border border-line bg-panel py-1 shadow-float"
        >
          <button type="button" role="menuitem" onClick={pick(onSave)} className={item}>
            Save current as look…
          </button>
          <button type="button" role="menuitem" onClick={pick(onImport)} className={item}>
            Import LUT…
          </button>
          <button type="button" role="menuitem" onClick={pick(onMatch)} className={item}>
            Match camera JPEG…
          </button>
          <hr className="my-1 border-line" />
          <button type="button" role="menuitem" onClick={pick(onManage)} className={item}>
            Manage looks…
          </button>
        </div>
      )}
    </div>
  );
}

/** Name and the optional sections; the effects and the LUT are always part of a look. */
function SaveLookDialog({
  assetId,
  settings,
  onClose,
}: {
  assetId: string;
  settings: DevelopSettings;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [extra, setExtra] = useState<DevelopSectionKey[]>(() =>
    (['curve', 'color'] as const).filter((key) => !isSectionDefault(settings, key)),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canSave = name.trim() !== '' && !busy;
  const toggle = (key: DevelopSectionKey) =>
    setExtra((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    try {
      const look = makeLook(name, settings, extra);
      await useLooksStore.getState().save(look);
      // The photo already has these values: only record that the new look wrote them.
      useBookStore.getState().setAssetDevelop(assetId, { look: { applied: { presetId: look.id, amount: 100 } } });
      devLog('develop', 'saved look from photo', { id: look.id, sections: look.sections });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <DialogShell title="Save as look" onClose={onClose} widthClass="w-96">
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <DialogBody>
          <label className="block space-y-1">
            <span className="text-fg-muted">Name</span>
            <input
              data-autofocus
              aria-label="Look name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              spellCheck={false}
              className="w-full rounded-md border border-line bg-panel-2 px-2 py-1 text-fg outline-none focus:border-accent"
            />
          </label>
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-fg-muted">Also include</legend>
            {LOOK_OPTIONAL_SECTIONS.map((key) => (
              <label key={key} className="flex items-center gap-2">
                <input type="checkbox" checked={extra.includes(key)} onChange={() => toggle(key)} />
                {PRESET_SECTION_LABELS[key]}
              </label>
            ))}
          </fieldset>
          <p className="text-[11px] text-fg-muted">
            Effects and the LUT are always part of a look. Crop, Transform and masks belong to the photo.
          </p>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogButton onClick={onClose}>Cancel</DialogButton>
          <DialogButton type="submit" primary disabled={!canSave}>
            Save look
          </DialogButton>
        </DialogFooter>
      </form>
    </DialogShell>
  );
}

/** Rename or delete saved looks (built-in ones are read-only). */
function ManageLooksDialog({ onClose }: { onClose: () => void }) {
  const saved = useLooksStore((s) => s.saved);
  const looks = useAllLooks();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const rename = async (look: Preset) => {
    const name = (names[look.id] ?? look.name).trim();
    if (!name || name === look.name) return;
    try {
      await useLooksStore.getState().save({ ...look, name });
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const remove = async (id: string) => {
    try {
      await useLooksStore.getState().remove(id);
      setConfirming(null);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <DialogShell title="Manage looks" onClose={onClose} widthClass="w-[28rem]">
      <DialogBody>
        {looks.length === 0 && <p className="text-fg-muted">No looks saved yet.</p>}
        <ul className="space-y-1.5">
          {looks.map((look) => {
            const own = saved.some((l) => l.id === look.id);
            return (
              <li key={look.id} className="flex items-center gap-2">
                {own ? (
                  <input
                    aria-label={`Name of ${look.name}`}
                    value={names[look.id] ?? look.name}
                    onChange={(e) => setNames((n) => ({ ...n, [look.id]: e.target.value }))}
                    onBlur={() => void rename(look)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename(look);
                    }}
                    maxLength={80}
                    className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 py-1 text-fg outline-none focus:border-accent"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate px-2 text-fg-muted">{look.name} (built in)</span>
                )}
                <span className="shrink-0 text-[11px] text-fg-muted">
                  {look.sections.map((s) => PRESET_SECTION_LABELS[s]).join(', ')}
                </span>
                {own &&
                  (confirming === look.id ? (
                    <>
                      <DialogButton onClick={() => void remove(look.id)}>Delete</DialogButton>
                      <DialogButton onClick={() => setConfirming(null)}>Keep</DialogButton>
                    </>
                  ) : (
                    <DialogButton onClick={() => setConfirming(look.id)} title={`Delete ${look.name}`}>
                      ×
                    </DialogButton>
                  ))}
              </li>
            );
          })}
        </ul>
        <p className="text-[11px] text-fg-muted">
          Deleting a look leaves the photos that use it as they are; their Amount is then locked.
        </p>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogButton primary onClick={onClose}>
          Done
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}

// ---------- Thumbnails ----------

let lastLookJob = 0;
function nextLookJob(): number {
  lastLookJob = Math.max(lastLookJob + 1, Date.now());
  return lastLookJob;
}

/** At most this many thumbnails per request (None included; `render_look_thumbs` refuses more). */
export const MAX_LOOK_THUMBS = 256;

/**
 * The strip's thumbnails (presetId → URL) for the photo shown, rendered by `render_look_thumbs` over `lookBase` a
 * moment after the settings stop changing (the request is built then, not on every slider tick, and skipped when it is
 * the one asked last). Each arrives on its own event; earlier thumbnails stay until replaced.
 */
function useLookThumbs(
  assetId: string,
  settings: DevelopSettings,
  looks: readonly Preset[],
  active: boolean,
): Record<string, string> {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const folder = useBookStore((s) => assetFolder(s, assetId));
  // Primitives only: `photoMeta` builds a new object on every call.
  const metaPath = useBookStore((s) => photoMeta(s, assetId)?.path);
  const metaHash = useBookStore((s) => photoMeta(s, assetId)?.hash);
  const file = usePhotoFile(assetId);
  const relPath = metaPath ?? file?.relPath;
  const hash = metaHash ?? file?.hash;
  const lutEpoch = useLutsStore((s) => s.epoch);
  const latest = useRef({ settings, looks });
  latest.current = { settings, looks };
  const asked = useRef<string | null>(null);

  // Another photo starts empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `assetId` is the trigger
  useEffect(() => {
    setThumbs({});
    asked.current = null;
  }, [assetId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `settings` and `looks` re-arm the timer (read through `latest`); the epoch re-renders LUT looks
  useEffect(() => {
    if (!active || !folder || !relPath || !hash) return;
    let live = true;
    let unlisten: (() => void) | undefined;
    const timer = setTimeout(async () => {
      const { settings: now, looks: all } = latest.current;
      const base = lookBase(now, findLook);
      const items = [
        { presetId: NO_LOOK, settings: base },
        ...all
          .slice(0, MAX_LOOK_THUMBS - 1)
          .map((look) => ({ presetId: look.id, settings: applyLook(base, look, lookDefaultAmount(look)) })),
      ];
      const key = `${folder}\n${relPath}\n${hash}\n${lutEpoch}\n${JSON.stringify(items)}`;
      if (key === asked.current) return;
      const job = nextLookJob();
      const take = (t: LookThumbResult) => {
        if (live && t.path) setThumbs((s) => ({ ...s, [t.presetId]: fileUrl(t.path ?? '') }));
      };
      const start = performance.now();
      try {
        const stop = await Promise.resolve().then(() =>
          onLookThumb((e) => {
            if (e.job === job) take(e);
          }),
        );
        if (!live) {
          stop();
          return;
        }
        unlisten = stop;
        const result = await renderLookThumbs(folder, relPath, hash, base, items, job);
        result.forEach(take);
        if (live && result.length === items.length) asked.current = key;
        if (live) {
          devLog('develop', 'look thumbs', {
            looks: result.length,
            cached: result.filter((t) => t.cached).length,
            ms: Math.round(performance.now() - start),
          });
        }
      } catch (err) {
        if (live) devLog('develop', 'look thumbnails unavailable', { error: errorMessage(err) });
      }
    }, LOOK_THUMBS_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      unlisten?.();
    };
  }, [active, folder, relPath, hash, settings, looks, lutEpoch]);

  return thumbs;
}

// ---------- Batch bar: Apply look… (order 40) ----------

/**
 * The look and Amount chosen for the batch, kept for the next time the dialog opens. `amount` is null when the slider
 * was not moved: the Amount is then the chosen look's starting Amount (plan 21). A remembered Amount belongs to the
 * remembered look; choosing another look without moving the slider goes back to that look's starting Amount.
 */
const lastBatch: { id: string; amount: number | null } = { id: NO_LOOK, amount: null };

function ApplyLookDialog({ ids, onClose }: { ids: readonly string[]; onClose: () => void }) {
  const looks = useAllLooks();
  const loaded = useLooksStore((s) => s.loaded);
  const [id, setId] = useState(() =>
    looks.some((l) => l.id === lastBatch.id) ? lastBatch.id : (looks[0]?.id ?? NO_LOOK),
  );
  // Null: no Amount set by hand for this look, so the Amount is the chosen look's starting Amount.
  const [touched, setTouched] = useState<number | null>(() => (id === lastBatch.id ? lastBatch.amount : null));
  const moved = useRef(false);
  const chooseLook = (next: string) => {
    setId(next);
    if (!moved.current) setTouched(null);
  };
  const setAmount = (v: number) => {
    moved.current = true;
    setTouched(v);
  };
  const startAmount = lookDefaultAmount(looks.find((l) => l.id === id));
  const amount = touched ?? startAmount;
  useEffect(() => {
    if (!loaded) void useLooksStore.getState().load();
  }, [loaded]);
  const apply = () => {
    lastBatch.id = id;
    lastBatch.amount = touched;
    applyLookTo(ids, id, amount);
    onClose();
  };
  const n = ids.length;
  return (
    <DialogShell title="Apply look" onClose={onClose} widthClass="w-96">
      <DialogBody>
        <label className="block space-y-1">
          <span className="text-fg-muted">Look</span>
          <select
            data-autofocus
            aria-label="Look"
            value={id}
            onChange={(e) => chooseLook(e.target.value)}
            className="w-full rounded-md border border-line bg-panel-2 px-2 py-1 text-fg outline-none focus:border-accent"
          >
            <option value={NO_LOOK}>None (remove the look)</option>
            {looks.map((look) => (
              <option key={look.id} value={look.id}>
                {look.name}
              </option>
            ))}
          </select>
        </label>
        {id !== NO_LOOK && (
          <Slider
            label="Amount"
            value={amount}
            min={0}
            max={100}
            defaultValue={startAmount}
            format={percent}
            onChange={setAmount}
          />
        )}
        <p className="text-[11px] text-fg-muted">
          One undo step for all {n} photo{n === 1 ? '' : 's'}. A look applied before is replaced.
        </p>
      </DialogBody>
      <DialogFooter>
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton primary onClick={apply} disabled={n === 0}>
          Apply to {n} photo{n === 1 ? '' : 's'}
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}

/** Apply look…: the selection, or the photo shown when nothing is selected. */
function ApplyLookSlot({ ids, current }: BatchContext) {
  const [open, setOpen] = useState(false);
  const targets = ids.length > 0 ? ids : current ? [current] : [];
  return (
    <>
      <BatchButton
        disabled={targets.length === 0}
        onClick={() => setOpen(true)}
        title={`Apply a look to ${ids.length > 0 ? 'the selected photos' : 'this photo'} (one undo step)`}
      >
        Apply look…
      </BatchButton>
      {open && <ApplyLookDialog ids={targets} onClose={() => setOpen(false)} />}
    </>
  );
}

registerBatchSlot({ id: 'look', order: 40, render: (ctx) => <ApplyLookSlot {...ctx} /> });

/** The LUT id a look's `look` section names, if any. */
function lookLutId(look: Preset): string | undefined {
  return (look.settings.look as { lut?: { id?: string } | null } | undefined)?.lut?.id;
}
