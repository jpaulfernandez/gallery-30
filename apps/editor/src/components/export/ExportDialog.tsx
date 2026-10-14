import {
  defaultExportDir,
  EXPORT_FORMAT_LABELS,
  EXPORT_MAX_EDGE,
  EXPORT_MIN_EDGE,
  EXPORT_NAMING_MAX,
  EXPORT_PRESET_NAME_MAX,
  type ExportMetadata,
  type ExportOptions,
  type ExportPreset,
  formatHasMetadata,
  formatHasQuality,
  formatsFor,
  isRawPath,
  NAMING_TOKENS,
  type OutputProfile,
  type OutputSharpen,
  sameExportSettings,
  watermarkProblem,
} from '@photobook/shared';
import { open } from '@tauri-apps/plugin-dialog';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { type ExportCounts, exportCounts, planExport, resolveExportPhotos } from '../../lib/jobs/export';
import { devLog } from '../../lib/log';
import { missingLutMessage } from '../../lib/lutPreflight';
import { checkExportDest } from '../../lib/tauri';
import { useBookStore } from '../../store/book';
import {
  allExportPresets,
  type ExportDialogTarget,
  presetFromDraft,
  startExport,
  useExportsStore,
} from '../../store/exports';
import { Button } from '../ui/Button';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { BorderGroup, Group, WatermarkGroup } from './ExportExtras';

/**
 * The Export dialog (workflow plan 11; Cmd+Shift+E, the Develop batch bar, the Cull grid's menu, a folder or collection
 * in the sidebar): a preset list (the built-ins and the user's, with Save and Delete), the common options, a count of
 * what the export will do ("12 photos, 3 already exported") and Export, which queues one job per photo and closes.
 * Opens on the last preset used.
 */
export function ExportDialog() {
  const dialog = useExportsStore((s) => s.dialog);
  if (!dialog) return null;
  return <ExportDialogBody key={dialog.ids.join('\n')} target={dialog} />;
}

const SHARPEN_LABELS: Record<OutputSharpen, string> = { off: 'Off', low: 'Low', standard: 'Standard', high: 'High' };
const METADATA_LABELS: Record<ExportMetadata, string> = {
  all: 'All (camera, date, location)',
  copyright: 'Copyright and artist only',
  none: 'None',
};
/** The long edge offered when Resize is switched on. */
const DEFAULT_EDGE = 2048;

/** The quality a lossy format starts at when it is picked (plan 12: each format has its own scale). */
export const DEFAULT_QUALITY: Partial<Record<ExportOptions['format'], number>> = {
  jpeg: 90,
  webp: 85,
  avif: 70,
  heic: 85,
};

const COLOUR_LABELS: Record<OutputProfile, string> = { srgb: 'sRGB', 'display-p3': 'Display P3' };

/** HEIF-family files (iPhone photos are usually Display P3). */
const HEIF = /\.(heic|heif|hif)$/i;

/** Whether a photo's source can hold colours outside sRGB: a camera RAW or a HEIC (Display P3 then keeps them). */
export const wideSource = (relPath: string): boolean => isRawPath(relPath) || HEIF.test(relPath);

const field =
  'rounded-md border border-line bg-panel-2 px-2 py-1 text-fg outline-none focus:border-accent disabled:opacity-40';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-fg-muted">{label}</span>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** "12 photos, 3 already exported": what Export will do. */
export function countLine(counts: (ExportCounts & { missing: number }) | null, skip: boolean): string {
  if (!counts) return 'Counting…';
  const parts = [counts.total === 1 ? '1 photo' : `${counts.total} photos`];
  if (counts.exported > 0) parts.push(`${counts.exported} already exported${skip ? ' (skipped)' : ''}`);
  const fromCache = counts.cached - (skip ? counts.exported : 0);
  if (fromCache > 0) parts.push(`${fromCache} from the cache`);
  if (counts.missing > 0) parts.push(`${counts.missing} not ready (not hashed yet)`);
  if (counts.replaces > 0) {
    parts.push(
      counts.replaces === 1 ? '1 existing file will be replaced' : `${counts.replaces} existing files will be replaced`,
    );
  }
  return parts.join(', ');
}

function ExportDialogBody({ target }: { target: ExportDialogTarget }) {
  const store = useExportsStore;
  const saved = store((s) => s.saved);
  const loaded = store((s) => s.loaded);
  const caps = store((s) => s.caps);
  const presets = useMemo(() => allExportPresets(saved, caps), [saved, caps]);
  const bookProfile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  /** Some photo of the export has a wide-gamut source: Display P3 is offered. */
  const [wide, setWide] = useState(false);
  const [presetId, setPresetId] = useState(() => store.getState().lastPresetId);
  const base = presets.find((p) => p.id === presetId) ?? presets[0];
  const [draft, setDraft] = useState<ExportPreset | null>(base ?? null);
  const [counts, setCounts] = useState<(ExportCounts & { missing: number }) | null>(null);
  const [example, setExample] = useState<{ name: string; dest: string } | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Replacing files that are not exports of these photos was confirmed (asked again when the settings change). */
  const [replace, setReplace] = useState(false);

  useEffect(() => {
    if (!loaded) void useExportsStore.getState().load();
  }, [loaded]);

  // The saved presets arrive after the dialog opened on one of them.
  useEffect(() => {
    if (!draft && base) setDraft(base);
  }, [draft, base]);

  // The built-ins change once the machine's formats are known (Full quality becomes HEIC on macOS): a draft that
  // is still the preset as it was follows it.
  const shownBase = useRef(base);
  useEffect(() => {
    const before = shownBase.current;
    shownBase.current = base;
    if (base && before && before !== base && before.id === base.id && draft && sameExportSettings(draft, before)) {
      setDraft(base);
    }
  }, [base, draft]);

  // What the export would do, recounted when the settings change.
  useEffect(() => {
    if (!draft) return;
    let live = true;
    setCounts(null);
    setReplace(false);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const { photos, missing } = await resolveExportPhotos(target.ids);
          const planned = await planExport(photos, draft);
          const c = await exportCounts(planned, draft);
          if (!live) return;
          setCounts({ ...c, missing });
          setWide(photos.some((p) => wideSource(p.relPath)));
          const first = planned[0]?.item;
          setExample(first ? { name: first.name, dest: first.destDir } : null);
        } catch (err) {
          if (live) setError(errorMessage(err));
        }
      })();
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [target.ids, draft]);

  const close = () => store.getState().closeDialog();
  if (!draft || !base) return null;

  const modified = !sameExportSettings(draft, base);
  /** An incomplete watermark (no image, no text): Export waits for it (plan 12). */
  const incomplete = draft.options.format === 'original' ? null : watermarkProblem(draft.options.watermark);
  const o = draft.options;
  const setOptions = (patch: Partial<ExportOptions>) => setDraft({ ...draft, options: { ...o, ...patch } });
  const pick = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setPresetId(id);
    setDraft(preset);
    setError(null);
  };

  const saveAs = async () => {
    const name = naming?.trim();
    if (!name) return;
    try {
      const stored = await store.getState().save(presetFromDraft(draft, name));
      setNaming(null);
      setPresetId(stored.id);
      setDraft(stored);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const update = async () => {
    try {
      const stored = await store.getState().save({ ...draft, id: base.id, name: base.name });
      setDraft(stored);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const remove = async () => {
    try {
      await store.getState().remove(base.id);
      const first = presets[0];
      if (first) pick(first.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const chooseFolder = async () => {
    const dir = await open({
      directory: true,
      multiple: false,
      title: 'Export to',
      defaultPath: draft.destination ?? undefined,
    });
    if (typeof dir !== 'string') return;
    try {
      const resolved = await checkExportDest(dir);
      setDraft({ ...draft, destination: resolved });
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const run = async () => {
    if (incomplete) {
      setError(incomplete);
      return;
    }
    setBusy(true);
    setError(null);
    if (draft.destination) {
      try {
        await checkExportDest(draft.destination);
      } catch {
        setBusy(false);
        setError(
          'Choose the destination folder again: outside your imported folders Photobook writes only to a folder picked since it started.',
        );
        return;
      }
    }
    // Workflow plan 18: name the photos whose LUT file is missing here, instead of one failed job each.
    if (draft.options.format !== 'original') {
      try {
        const { photos } = await resolveExportPhotos(target.ids);
        const lutError = await missingLutMessage(photos);
        if (lutError) {
          setBusy(false);
          setError(lutError);
          return;
        }
      } catch (err) {
        devLog('export', 'LUT check failed', { error: errorMessage(err) });
      }
    }
    store.getState().setLastPreset(base.id);
    close();
    try {
      await startExport(target.ids, draft, { replace });
    } catch (err) {
      devLog('export', 'failed to start', { error: errorMessage(err) });
    }
  };

  const destLabel = draft.destination ?? (example ? example.dest : defaultExportDir('<photo folder>', draft.name));

  return (
    <DialogShell title={`Export ${target.title}`} onClose={close} widthClass="w-[46rem]">
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Export presets" className="flex w-44 shrink-0 flex-col gap-0.5 border-line border-r p-2">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-current={p.id === base.id ? 'true' : undefined}
              onClick={() => pick(p.id)}
              className={`truncate rounded-md px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                p.id === base.id ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:bg-fg/5 hover:text-fg'
              }`}
            >
              {p.name}
              {p.id === base.id && modified ? ' (modified)' : ''}
            </button>
          ))}
          <div className="mt-auto space-y-1 pt-2">
            {naming === null ? (
              <Button
                size="sm"
                onClick={() => setNaming(base.builtIn ? `${base.name} copy` : base.name)}
                className="w-full justify-center"
              >
                Save as preset…
              </Button>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveAs();
                }}
                className="space-y-1"
              >
                <input
                  // biome-ignore lint/a11y/noAutofocus: the field appears because the user asked to name a preset
                  autoFocus
                  aria-label="Preset name"
                  value={naming}
                  maxLength={EXPORT_PRESET_NAME_MAX}
                  onChange={(e) => setNaming(e.target.value)}
                  className={`w-full ${field}`}
                />
                <div className="flex gap-1">
                  <DialogButton type="submit" primary disabled={!naming.trim()}>
                    Save
                  </DialogButton>
                  <DialogButton onClick={() => setNaming(null)}>Cancel</DialogButton>
                </div>
              </form>
            )}
            {!base.builtIn && modified && (
              <Button size="sm" onClick={() => void update()} className="w-full justify-center">
                <span className="truncate">Update “{base.name}”</span>
              </Button>
            )}
            {!base.builtIn && (
              <button
                type="button"
                onClick={() => void remove()}
                className="w-full rounded-md px-2 py-1 text-danger outline-none hover:bg-fg/5 focus-visible:ring-2 focus-visible:ring-accent"
              >
                Delete preset
              </button>
            )}
          </div>
        </nav>

        <DialogBody>
          <Row label="Format">
            <select
              aria-label="Format"
              value={o.format}
              onChange={(e) => {
                const format = e.target.value as ExportOptions['format'];
                const quality = DEFAULT_QUALITY[format];
                // Each lossy format has its own scale: start at its default unless the quality was changed by hand
                // (only a lossy format's quality can be; PNG, TIFF and Original keep whatever was there).
                const before = DEFAULT_QUALITY[o.format];
                const keep = before !== undefined && before !== o.quality;
                setOptions({
                  format,
                  ...(quality !== undefined && !keep ? { quality } : {}),
                  // AVIF is written in sRGB only (ravif cannot signal other primaries).
                  ...(format === 'avif' ? { colour: 'srgb' as const } : {}),
                });
              }}
              className={field}
            >
              {formatsFor(caps)
                .concat(o.format === 'heic' && !caps.heic ? ['heic'] : [])
                .map((f) => (
                  <option key={f} value={f}>
                    {EXPORT_FORMAT_LABELS[f]}
                  </option>
                ))}
            </select>
            {formatHasQuality(o.format) && (
              <>
                <span className="text-fg-muted">Quality</span>
                <input
                  type="range"
                  aria-label="Quality"
                  min={1}
                  max={100}
                  value={o.quality}
                  onChange={(e) => setOptions({ quality: Number(e.target.value) })}
                  className="min-w-0 flex-1 accent-accent"
                />
                <span className="w-7 text-right tabular-nums">{o.quality}</span>
              </>
            )}
            {(o.format === 'png' || o.format === 'tiff') && <span className="text-fg-muted">Lossless</span>}
          </Row>
          {o.format === 'heic' && !caps.heic && (
            <p role="alert" className="pl-[8rem] text-warn">
              HEIC can only be written on macOS; choose another format.
            </p>
          )}
          {o.format === 'original' ? (
            <p className="pl-[8rem] text-fg-muted">
              Copies each source file as it is and writes an XMP sidecar next to it with the edit: Photobook reads it
              back exactly, Lightroom and Camera Raw read the tone and colour sliders.
            </p>
          ) : (
            <>
              <Row label="Size">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={o.longEdge !== null}
                    onChange={(e) => setOptions({ longEdge: e.target.checked ? DEFAULT_EDGE : null })}
                  />
                  Resize to fit
                </label>
                {o.longEdge !== null ? (
                  <>
                    <input
                      type="number"
                      aria-label="Long edge in pixels"
                      min={EXPORT_MIN_EDGE}
                      max={EXPORT_MAX_EDGE}
                      value={o.longEdge}
                      onChange={(e) => {
                        const v = Math.round(Number(e.target.value));
                        if (Number.isFinite(v))
                          setOptions({ longEdge: Math.min(EXPORT_MAX_EDGE, Math.max(EXPORT_MIN_EDGE, v)) });
                      }}
                      className={`w-24 ${field}`}
                    />
                    <span className="text-fg-muted">px long edge (never enlarged)</span>
                  </>
                ) : (
                  <span className="text-fg-muted">Developed size</span>
                )}
              </Row>
              <Row label="Sharpen for screen">
                <select
                  aria-label="Sharpen for screen"
                  value={o.sharpen}
                  onChange={(e) => setOptions({ sharpen: e.target.value as OutputSharpen })}
                  className={field}
                >
                  {(Object.keys(SHARPEN_LABELS) as OutputSharpen[]).map((s) => (
                    <option key={s} value={s}>
                      {SHARPEN_LABELS[s]}
                    </option>
                  ))}
                </select>
              </Row>
              <Group
                title="Colour"
                summary={`${COLOUR_LABELS[o.colour]}${
                  o.format === 'tiff' || o.format === 'heic' ? `, ${o.format === 'tiff' ? '16' : '10'}-bit` : ''
                }`}
              >
                {o.format === 'avif' ? (
                  <p className="text-fg-muted">sRGB: AVIF is written in sRGB only.</p>
                ) : wide || bookProfile === 'display-p3' || o.colour === 'display-p3' ? (
                  <select
                    aria-label="Colour space"
                    value={o.colour}
                    onChange={(e) => setOptions({ colour: e.target.value as OutputProfile })}
                    className={field}
                  >
                    <option value="srgb">sRGB (every screen and browser)</option>
                    <option value="display-p3">Display P3 (wide gamut: keeps the source's saturated colours)</option>
                  </select>
                ) : (
                  <p className="text-fg-muted">
                    sRGB. Display P3 is offered when a photo is a camera RAW or a HEIC, or the book is set to Display
                    P3.
                  </p>
                )}
              </Group>
              <Group
                title="Metadata"
                summary={formatHasMetadata(o.format) ? METADATA_LABELS[o.metadata] : 'Colour profile only'}
              >
                {formatHasMetadata(o.format) ? (
                  <select
                    aria-label="Metadata"
                    value={o.metadata}
                    onChange={(e) => setOptions({ metadata: e.target.value as ExportMetadata })}
                    className={field}
                  >
                    {(Object.keys(METADATA_LABELS) as ExportMetadata[]).map((m) => (
                      <option key={m} value={m}>
                        {METADATA_LABELS[m]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-fg-muted">
                    None ({EXPORT_FORMAT_LABELS[o.format]} carries the colour profile only)
                  </p>
                )}
              </Group>
              <WatermarkGroup value={o.watermark} onChange={(watermark) => setOptions({ watermark })} />
              <BorderGroup value={o.border} onChange={(border) => setOptions({ border })} />
            </>
          )}
          <Row label="Destination">
            <span className="min-w-0 flex-1 truncate" title={destLabel}>
              {draft.destination ? destLabel : `Next to each photo, in Exports/${draft.name}`}
            </span>
            <DialogButton onClick={() => void chooseFolder()}>Choose…</DialogButton>
            {draft.destination && (
              <DialogButton onClick={() => setDraft({ ...draft, destination: null })}>Reset</DialogButton>
            )}
          </Row>
          <Row label="File names">
            <input
              aria-label="File name pattern"
              value={draft.naming}
              maxLength={EXPORT_NAMING_MAX}
              onChange={(e) => setDraft({ ...draft, naming: e.target.value })}
              className={`min-w-0 flex-1 ${field}`}
            />
            {NAMING_TOKENS.map((token) => (
              <button
                key={token}
                type="button"
                title={`Add ${token}`}
                onClick={() => setDraft({ ...draft, naming: `${draft.naming}${token}` })}
                className="rounded border border-line px-1 font-mono text-[10px] text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
              >
                {token}
              </button>
            ))}
          </Row>
          {example && <p className="pl-[8rem] text-fg-muted">For example {example.name}</p>}
          <label className="flex items-center gap-2 pl-[8rem]">
            <input
              type="checkbox"
              checked={draft.skipExported}
              onChange={(e) => setDraft({ ...draft, skipExported: e.target.checked })}
            />
            Skip photos already exported with these settings
          </label>
          {counts && counts.replaces > 0 && (
            <label className="flex items-center gap-2 pl-[8rem] text-warn">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              Replace {counts.replaces === 1 ? 'the existing file' : `the ${counts.replaces} existing files`} at the
              destination that {counts.replaces === 1 ? 'is not an export' : 'are not exports'} of these photos
            </label>
          )}
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          {incomplete && <p className="pl-[8rem] text-warn">{incomplete}</p>}
        </DialogBody>
      </div>
      <DialogFooter note={<span role="status">{countLine(counts, draft.skipExported)}</span>}>
        <DialogButton onClick={close}>Cancel</DialogButton>
        <DialogButton
          primary
          onClick={() => void run()}
          disabled={busy || !counts || counts.total === 0 || (counts.replaces > 0 && !replace) || incomplete !== null}
          title={
            incomplete ??
            (counts && counts.replaces > 0 && !replace ? 'Tick Replace to overwrite the existing files' : undefined)
          }
        >
          Export
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}
