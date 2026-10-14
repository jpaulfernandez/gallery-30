import { DEVELOP_DEFAULTS, DevelopSchema, type DevelopSettings } from '@photobook/shared';
import { useEffect, useMemo, useState } from 'react';
import { type DiffRow, diffDevelop, importedDevelop, type OrientationChange } from '../../lib/develop/xmpImport';
import { devLog } from '../../lib/log';
import { basename } from '../../lib/path';
import { readXmp, type XmpImport, type XmpImportResult } from '../../lib/tauri';
import { useBookStore } from '../../store/book';
import { assetDevelop, assetFolder, photoMeta } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';

/** Reads running at once when importing for several photos. */
const CONCURRENCY = 4;

/** What reading one photo's XMP gave. */
type Loaded =
  | { assetId: string; name: string; state: 'none' }
  | { assetId: string; name: string; state: 'error'; message: string }
  | {
      assetId: string;
      name: string;
      state: 'ready';
      result: XmpImportResult & { import: XmpImport };
      /** `import.settings` after the schema (defaults filled in); null when it did not validate. */
      settings: DevelopSettings | null;
    };

/**
 * Import Lightroom settings (step D6.3): reads the photo's `.xmp` sidecar (or the packet embedded in a JPEG), shows
 * what would change as a table (current to imported), what Lightroom had that did not come across, and applies on
 * confirmation. For several photos (the filmstrip's Import button) it lists what each one has and applies the ones
 * with settings in one undo step. Matches slider values, not pixels: Lightroom's rendering maths differs.
 */
export function XmpImportDialog() {
  const dialog = useUiStore((s) => s.xmpImportDialog);
  if (!dialog) return null;
  return <XmpImportBody assetIds={dialog.assetIds} />;
}

function XmpImportBody({ assetIds }: { assetIds: string[] }) {
  const close = useUiStore((s) => s.closeXmpImport);
  const current = useBookStore((s) => assetDevelop(s, assetIds[0] ?? ''));
  const [loaded, setLoaded] = useState<Loaded[] | null>(null);
  const [applyOrientation, setApplyOrientation] = useState(true);
  const [done, setDone] = useState<{ applied: number } | null>(null);
  const many = assetIds.length > 1;

  // Read every photo's packet once, a few at a time.
  useEffect(() => {
    let cancelled = false;
    const state = useBookStore.getState();
    const nameOf = (id: string) => basename(photoMeta(state, id)?.path ?? id);
    const results: Loaded[] = new Array(assetIds.length);
    let next = 0;
    const worker = async () => {
      while (!cancelled) {
        const at = next++;
        const assetId = assetIds[at];
        if (assetId === undefined) return;
        const asset = photoMeta(state, assetId);
        const name = nameOf(assetId);
        const folder = assetFolder(useBookStore.getState(), assetId);
        if (!asset || !folder) {
          results[at] = { assetId, name, state: 'error', message: 'This photo is not in the project' };
          continue;
        }
        try {
          const result = await readXmp(folder, asset.path, asset.orientation);
          if (!result.import) {
            results[at] = { assetId, name, state: 'none' };
            continue;
          }
          const parsed = DevelopSchema.safeParse(result.import.settings);
          results[at] = {
            assetId,
            name,
            state: 'ready',
            result: { ...result, import: result.import },
            settings: parsed.success ? parsed.data : null,
          };
        } catch (err) {
          results[at] = { assetId, name, state: 'error', message: String(err) };
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, assetIds.length) }, worker)).then(() => {
      if (!cancelled) setLoaded(results);
    });
    return () => {
      cancelled = true;
    };
  }, [assetIds]);

  const ready = useMemo(
    () => (loaded ?? []).filter((l): l is Extract<Loaded, { state: 'ready' }> => l.state === 'ready'),
    [loaded],
  );
  const usable = ready.filter((l) => l.settings !== null && (!many || !l.result.import.alreadyApplied));
  const change = (l: Extract<Loaded, { state: 'ready' }>): OrientationChange | null => l.result.orientationChange;
  const anyRotated = usable.some((l) => change(l) !== null);

  const apply = () => {
    const store = useBookStore.getState();
    const items = usable.map((l) => ({
      assetId: l.assetId,
      imported: { ...l.result.import, settings: l.settings as DevelopSettings },
      orientationChange: change(l),
    }));
    const applied = store.importXmpMany(items, { applyOrientation });
    devLog('develop', 'imported xmp settings', { photos: items.length, changed: applied });
    if (many) setDone({ applied });
    else close();
  };

  const title = many ? `Import Lightroom settings for ${assetIds.length} photos` : 'Import Lightroom settings';

  return (
    <DialogShell title={title} onClose={close} widthClass={many ? 'w-[40rem]' : 'w-[36rem]'}>
      <DialogBody>
        {loaded === null ? (
          <p role="status" className="py-6 text-center text-fg-muted">
            Reading {many ? `${assetIds.length} photos` : 'the sidecar'}…
          </p>
        ) : many ? (
          <BatchSummary loaded={loaded} usable={usable.length} done={done} />
        ) : (
          <SingleImport loaded={loaded[0]} current={current} applyOrientation={applyOrientation} />
        )}
        {anyRotated && !done && (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={applyOrientation}
              onChange={(e) => setApplyOrientation(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Also apply the sidecar’s rotation
              <span className="block text-[11px] text-fg-muted">
                {many
                  ? 'Lightroom turned some of these photos after the file was written. '
                  : `${describeRotation(change(usable[0] as (typeof usable)[number]))}. `}
                Its crop and perspective were recorded in that orientation; without this their geometry is left as it
                is.
              </span>
            </span>
          </label>
        )}
      </DialogBody>
      <DialogFooter
        note={
          loaded !== null && !done ? (
            <span className="text-[11px]">Matches slider values, not pixels: Lightroom’s maths differs.</span>
          ) : undefined
        }
      >
        {done ? (
          <DialogButton primary onClick={close}>
            Close
          </DialogButton>
        ) : (
          <>
            <DialogButton onClick={close}>Cancel</DialogButton>
            <DialogButton primary onClick={apply} disabled={usable.length === 0}>
              {many
                ? `Import for ${usable.length} ${usable.length === 1 ? 'photo' : 'photos'}`
                : usable[0]?.result.import.alreadyApplied
                  ? 'Apply anyway'
                  : 'Apply'}
            </DialogButton>
          </>
        )}
      </DialogFooter>
    </DialogShell>
  );
}

function describeRotation(change: OrientationChange | null): string {
  if (!change) return '';
  const parts = [change.rotate ? `turns it ${change.rotate}° clockwise` : '', change.flipH ? 'mirrors it' : ''].filter(
    Boolean,
  );
  return `The sidecar ${parts.join(' and ') || 'records another orientation'}`;
}

function SingleImport({
  loaded,
  current,
  applyOrientation,
}: {
  loaded: Loaded | undefined;
  current: DevelopSettings | undefined;
  applyOrientation: boolean;
}) {
  if (!loaded || loaded.state === 'none') {
    return (
      <div className="space-y-1 py-4 text-center">
        <p className="text-fg">No Lightroom settings found for {loaded?.name ?? 'this photo'}.</p>
        <p className="text-fg-muted">
          Looked for a .xmp sidecar next to the photo (IMG.xmp or IMG.jpg.xmp) and, in a JPEG, an embedded XMP packet.
        </p>
      </div>
    );
  }
  if (loaded.state === 'error') {
    return (
      <p role="alert" className="py-4 text-center text-danger">
        {loaded.message}
      </p>
    );
  }
  const { result, settings } = loaded;
  const imp = result.import;
  if (!settings) {
    return (
      <p role="alert" className="py-4 text-center text-danger">
        The settings in this packet are not valid, so nothing can be imported.
      </p>
    );
  }
  return (
    <ImportPreview
      name={loaded.name}
      result={result}
      imp={imp}
      settings={settings}
      current={current}
      applyOrientation={applyOrientation}
    />
  );
}

function ImportPreview({
  name,
  result,
  imp,
  settings,
  current,
  applyOrientation,
}: {
  name: string;
  result: XmpImportResult;
  imp: XmpImport;
  settings: DevelopSettings;
  current: DevelopSettings | undefined;
  applyOrientation: boolean;
}) {
  const rows = useMemo(
    () =>
      diffDevelop(
        current ?? DEVELOP_DEFAULTS,
        importedDevelop(current, settings, result.orientationChange, applyOrientation),
      ),
    [current, settings, result.orientationChange, applyOrientation],
  );
  const where =
    result.source === 'embedded' ? 'the XMP packet embedded in the JPEG' : basename(result.sidecarPath ?? '');
  const dropped = imp.dropped.filter((d) => d.kind === 'dropped');
  const unverified = imp.dropped.filter((d) => d.kind === 'unverified');
  return (
    <>
      <p className="text-fg-muted">
        <span className="text-fg">{name}</span> from {where}
        {result.format === 'photobook'
          ? ' (Photobook settings, exact)'
          : imp.processVersion
            ? ` (Lightroom process version ${imp.processVersion})`
            : ''}
        .
      </p>
      {imp.alreadyApplied && (
        <p role="note" className="rounded-md border border-line bg-panel-2 px-3 py-2">
          This file already has these settings applied to its pixels (it looks like a Lightroom export). Importing them
          would adjust it a second time.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="py-2 text-fg-muted">Nothing would change: the photo already has these settings.</p>
      ) : (
        <DiffTable rows={rows} />
      )}
      {dropped.length > 0 && (
        <ItemList title="Not imported" items={dropped.map((d) => ({ field: d.field, reason: d.reason }))} />
      )}
      {unverified.length > 0 && (
        <ItemList
          title="Imported, but unverified"
          items={unverified.map((d) => ({ field: d.field, reason: d.reason }))}
        />
      )}
    </>
  );
}

function DiffTable({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="max-h-64 scrollbar overflow-x-hidden overflow-y-auto rounded-md border border-line">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Settings the import changes</caption>
        <thead className="sticky top-0 bg-panel text-fg-muted">
          <tr>
            <th scope="col" className="px-2 py-1 font-normal">
              Setting
            </th>
            <th scope="col" className="px-2 py-1 font-normal">
              Now
            </th>
            <th scope="col" className="px-2 py-1 font-normal">
              Imported
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.path} className="border-line border-t">
              <td className="px-2 py-1">
                {row.label === row.group ? (
                  <span>{row.label}</span>
                ) : (
                  <>
                    <span className="text-fg-muted">{row.group} › </span>
                    <span>{row.label}</span>
                  </>
                )}
              </td>
              <td className="px-2 py-1 text-fg-muted tabular-nums">{row.from}</td>
              <td className="px-2 py-1 tabular-nums">{row.to}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ItemList({ title, items }: { title: string; items: { field: string; reason: string }[] }) {
  return (
    <div className="space-y-1">
      <h3 className="section-title">{title}</h3>
      <ul className="space-y-0.5 text-fg-muted">
        {items.map((item) => (
          <li key={`${item.field}:${item.reason}`}>
            <span className="text-fg">{item.field}</span>: {item.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BatchSummary({
  loaded,
  usable,
  done,
}: {
  loaded: Loaded[];
  usable: number;
  done: { applied: number } | null;
}) {
  const none = loaded.filter((l) => l.state === 'none').length;
  const errors = loaded.filter((l) => l.state === 'error');
  const applied = loaded.filter((l) => l.state === 'ready' && l.result.import.alreadyApplied).length;
  const droppedFields = new Map<string, number>();
  for (const l of loaded) {
    if (l.state !== 'ready') continue;
    for (const d of l.result.import.dropped) {
      if (d.kind === 'dropped') droppedFields.set(d.field, (droppedFields.get(d.field) ?? 0) + 1);
    }
  }
  const statusOf = (l: Loaded): string => {
    if (l.state === 'none') return 'No settings found';
    if (l.state === 'error') return l.message;
    if (l.settings === null) return 'Settings not valid';
    if (l.result.import.alreadyApplied) return 'Already applied to the pixels (skipped)';
    return l.result.format === 'photobook' ? 'Photobook settings' : 'Lightroom settings';
  };
  return (
    <>
      <p role="status" className="text-fg">
        {done
          ? `Imported settings for ${done.applied} ${done.applied === 1 ? 'photo' : 'photos'}.`
          : `${usable} of ${loaded.length} photos have settings to import.`}
        <span className="text-fg-muted">
          {' '}
          {none > 0 && `${none} without a sidecar. `}
          {applied > 0 && `${applied} already applied (skipped). `}
          {errors.length > 0 && `${errors.length} could not be read.`}
        </span>
      </p>
      {!done && (
        <p className="text-fg-muted">
          Each imported photo’s develop settings are replaced by its Lightroom ones. One undo step brings them all back.
        </p>
      )}
      <ul
        className="max-h-56 scrollbar overflow-x-hidden overflow-y-auto rounded-md border border-line"
        aria-label="Photos"
      >
        {loaded.map((l) => (
          <li key={l.assetId} className="flex gap-3 border-line border-t px-2 py-1 first:border-t-0">
            <span className="min-w-0 flex-1 truncate">{l.name}</span>
            <span className={`truncate ${l.state === 'ready' && l.settings ? 'text-fg' : 'text-fg-muted'}`}>
              {statusOf(l)}
            </span>
          </li>
        ))}
      </ul>
      {droppedFields.size > 0 && (
        <ItemList
          title="Not imported"
          items={[...droppedFields].map(([field, count]) => ({
            field,
            reason: `${count} ${count === 1 ? 'photo' : 'photos'} use it and it does not come across`,
          }))}
        />
      )}
    </>
  );
}
