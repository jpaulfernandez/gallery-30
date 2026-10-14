import type { DevelopSettings } from '@photobook/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { PRESET_SECTION_LABELS, type Preset } from '../../lib/develop/presets';
import { DEVELOP_SECTION_KEYS, type DevelopSectionKey, isSectionDefault } from '../../lib/develop/sections';
import { devLog } from '../../lib/log';
import { basename } from '../../lib/path';
import { deletePreset, writeXmpSidecar } from '../../lib/tauri';
import { usePhotoFile } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { assetFolder } from '../../store/library';
import { buttonClass } from '../ui/Button';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { usePresets } from './usePresets';

/** What the Lightroom export warns about; shown next to its choice. */
export const CRS_EXPORT_WARNING =
  'Lightroom renders these settings with its own maths, so the photo will look different from the preview here. Masks, AI denoise and settings without a Lightroom counterpart are not written. Lightroom settings already in the sidecar are replaced (a copy is kept as .bak).';

interface PresetsMenuProps {
  assetId: string;
  settings: DevelopSettings;
}

type Dialog = 'save' | 'export' | null;

/**
 * The Develop header's Presets menu: the built-in presets ("Black & white", "Faded", the equivalents of the page
 * element filters) and the saved ones apply to this photo; "Save current as preset…" stores sections of the photo's
 * settings in the app data dir; "Export settings as XMP sidecar…" writes them next to the photo. Presets are read
 * when the menu opens.
 */
export function PresetsMenu({ assetId, settings }: PresetsMenuProps) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { presets, saved, error, reload } = usePresets(open);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node | null)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    setConfirming(null);
    setFailure(null);
  };

  const apply = (preset: Preset) => {
    const changed = useBookStore.getState().applyDevelopPreset([assetId], preset);
    devLog('develop', 'applied preset', { id: preset.id, changed });
    close();
  };

  const remove = async (preset: Preset) => {
    try {
      await deletePreset(preset.id);
      setConfirming(null);
      setFailure(null);
      await reload();
    } catch (err) {
      setFailure(String(err));
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      rootRef.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const item =
    'block w-full truncate px-3 py-1 text-left text-xs text-fg outline-none hover:bg-line focus-visible:bg-line disabled:text-fg-muted';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        title="Apply a preset, save one, or export these settings"
        className={buttonClass({ variant: 'ghost', size: 'sm', pressed: open })}
      >
        Presets
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Presets"
          data-no-step
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          className="absolute top-full right-0 z-30 mt-1 w-60 rounded-md border border-line bg-panel py-1 shadow-float"
        >
          <p className="section-title px-3 pt-1 pb-0.5">Built in</p>
          {presets
            .filter((p) => p.builtIn)
            .map((p) => (
              <button key={p.id} type="button" role="menuitem" onClick={() => apply(p)} className={item}>
                {p.name}
              </button>
            ))}
          <hr className="my-1 border-line" />
          <p className="section-title px-3 pt-1 pb-0.5">Your presets</p>
          {saved.length === 0 && <p className="px-3 py-1 text-[11px] text-fg-muted">{error ?? 'None saved yet'}</p>}
          {saved.map((p) =>
            confirming === p.id ? (
              <div key={p.id} className="flex items-center gap-1.5 px-3 py-1 text-[11px]">
                <span className="mr-auto truncate">Delete “{p.name}”?</span>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void remove(p)}
                  className="rounded px-1.5 text-fg outline-none hover:bg-line focus-visible:bg-line"
                >
                  Delete
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => setConfirming(null)}
                  className="rounded px-1.5 text-fg-muted outline-none hover:bg-line focus-visible:bg-line"
                >
                  Keep
                </button>
              </div>
            ) : (
              <div key={p.id} className="flex items-center">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => apply(p)}
                  title={p.sections.map((s) => PRESET_SECTION_LABELS[s]).join(', ')}
                  className={`${item} min-w-0 flex-1`}
                >
                  {p.name}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label={`Delete preset ${p.name}`}
                  title="Delete this preset"
                  onClick={() => setConfirming(p.id)}
                  className="mr-1 rounded px-1.5 py-1 text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:bg-line"
                >
                  ×
                </button>
              </div>
            ),
          )}
          {failure && (
            <p role="alert" className="px-3 py-1 text-[11px] text-danger">
              {failure}
            </p>
          )}
          <hr className="my-1 border-line" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setDialog('save');
            }}
            className={item}
          >
            Save current as preset…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setDialog('export');
            }}
            className={item}
          >
            Export settings as XMP sidecar…
          </button>
        </div>
      )}
      {dialog === 'save' && <SavePresetDialog assetId={assetId} settings={settings} onClose={() => setDialog(null)} />}
      {dialog === 'export' && <ExportXmpDialog assetId={assetId} settings={settings} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** Name and section checklist; the sections that differ from the defaults start checked (all, when none do). */
function SavePresetDialog({
  assetId,
  settings,
  onClose,
}: {
  assetId: string;
  settings: DevelopSettings;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [sections, setSections] = useState<DevelopSectionKey[]>(() => {
    const edited = DEVELOP_SECTION_KEYS.filter((key) => !isSectionDefault(settings, key));
    return edited.length > 0 ? edited : [...DEVELOP_SECTION_KEYS];
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canSave = name.trim() !== '' && sections.length > 0 && !busy;

  const toggle = (key: DevelopSectionKey) =>
    setSections((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    try {
      const preset = await useBookStore.getState().savePresetFromAsset(assetId, name, sections);
      devLog('develop', 'saved preset from photo', { id: preset.id });
      onClose();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setBusy(false);
    }
  };

  return (
    <DialogShell title="Save as preset" onClose={onClose} widthClass="w-96">
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <DialogBody>
          <label className="block space-y-1">
            <span className="text-fg-muted">Name</span>
            <input
              data-autofocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              spellCheck={false}
              className="w-full rounded-md border border-line bg-panel-2 px-2 py-1 text-fg outline-none focus:border-accent"
            />
          </label>
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-fg-muted">Settings to include</legend>
            {DEVELOP_SECTION_KEYS.map((key) => (
              <label key={key} className="flex items-center gap-2">
                <input type="checkbox" checked={sections.includes(key)} onChange={() => toggle(key)} />
                {PRESET_SECTION_LABELS[key]}
              </label>
            ))}
          </fieldset>
          <p className="text-[11px] text-fg-muted">
            Crop, rotation, Upright, Transform and masks belong to the photo and are never part of a preset.
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
            Save preset
          </DialogButton>
        </DialogFooter>
      </form>
    </DialogShell>
  );
}

/** Photobook (lossless) or Lightroom (lossy) sidecar next to the photo. */
function ExportXmpDialog({
  assetId,
  settings,
  onClose,
}: {
  assetId: string;
  settings: DevelopSettings;
  onClose: () => void;
}) {
  const folder = useBookStore((s) => assetFolder(s, assetId));
  // The project's record of the photo, else its library file (the same fields: path, orientation, size).
  const recorded = useBookStore((s) => s.book?.assets[assetId]);
  const file = usePhotoFile(assetId);
  const asset = recorded ?? (file ? { ...file, path: file.relPath } : undefined);
  const [mode, setMode] = useState<'photobook' | 'crs'>('photobook');
  const [written, setWritten] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const exportNow = async () => {
    if (!folder || !asset) return;
    setBusy(true);
    setError(null);
    try {
      const path = await writeXmpSidecar(
        folder,
        asset.path,
        settings,
        asset.orientation,
        asset.width,
        asset.height,
        mode,
      );
      devLog('develop', 'wrote xmp sidecar', { mode });
      setWritten(path);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell title="Export settings as XMP sidecar" onClose={onClose} widthClass="w-[30rem]">
      <DialogBody>
        <p className="text-fg-muted">
          Writes <span className="text-fg">{basename(asset?.path ?? '')}</span>’s develop settings to an .xmp file next
          to the photo, merged into the sidecar that is already there.
        </p>
        <fieldset className="space-y-2" disabled={busy || written !== null}>
          <legend className="sr-only">Format</legend>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="xmp-mode"
              checked={mode === 'photobook'}
              onChange={() => setMode('photobook')}
              className="mt-0.5"
            />
            <span>
              <span className="text-fg">Photobook (lossless)</span>
              <span className="block text-fg-muted">
                Every setting, masks included, in Photobook’s own namespace. Lightroom ignores it; Photobook reads it
                back exactly.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="xmp-mode"
              checked={mode === 'crs'}
              onChange={() => setMode('crs')}
              className="mt-0.5"
            />
            <span>
              <span className="text-fg">Lightroom (crs, lossy)</span>
              <span className="block text-fg-muted">Slider values in Lightroom’s Camera Raw fields.</span>
            </span>
          </label>
        </fieldset>
        {mode === 'crs' && (
          <p role="note" className="rounded-md border border-line bg-panel-2 px-3 py-2 text-fg-muted">
            {CRS_EXPORT_WARNING}
          </p>
        )}
        {written && (
          <p role="status" className="break-all text-fg">
            Wrote {written}
          </p>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        {written ? (
          <DialogButton primary onClick={onClose}>
            Done
          </DialogButton>
        ) : (
          <>
            <DialogButton onClick={onClose}>Cancel</DialogButton>
            <DialogButton primary onClick={() => void exportNow()} disabled={busy || !folder || !asset}>
              Export
            </DialogButton>
          </>
        )}
      </DialogFooter>
    </DialogShell>
  );
}
