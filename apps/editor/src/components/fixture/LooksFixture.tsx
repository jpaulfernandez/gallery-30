import { createDevelop, type DevelopSettings } from '@photobook/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { applyLook, BUILT_IN_LOOKS, builtInLookDef, lookDefaultAmount, NO_LOOK } from '../../lib/develop/looks';
import type { Preset } from '../../lib/develop/presets';
import { errorMessage } from '../../lib/errors';
import { devError, devLog } from '../../lib/log';
import { renderDevelopPreview } from '../../lib/tauri';
import { useFoldersStore } from '../../store/folders';
import { useLibraryStore } from '../../store/library';
import { nextPreviewJob } from '../develop/usePreview';
import { Button } from '../ui/Button';

/**
 * The Looks tab of `/fixture` (workflow plan 21): every built-in look on three photos at proxy size through the real
 * render (`render_develop_preview`, the photo's cached 1600 px working image), with the look's name and description, a
 * Before toggle (each cell shows the photo without a look) and the Amount the look starts at or 100 %.
 *
 * The photos come from the imported folders (renders need an imported root): each slot lists every hashed photo of
 * every folder whose index is known; the defaults are the review fixtures by file name (`IMG_01.jpg` and `IMG_11.jpg`
 * of `fixtures/lisbon-demo`, `portrait-01.jpg` of `fixtures/portrait`), else the first photos found. Renders run one
 * at a time (the preview command keeps only the newest job).
 */

interface FixturePhoto {
  key: string;
  label: string;
  folder: string;
  relPath: string;
  hash: string;
}

type AmountMode = 'start' | 'full';

const PREFERRED = ['IMG_01.jpg', 'IMG_11.jpg', 'portrait-01.jpg'];
const SLOT_NAMES = ['Photo 1', 'Photo 2', 'Photo 3'];
/** Tries per cell when the preview command drops a render for a newer job. */
const MAX_ATTEMPTS = 3;
const SLOTS = SLOT_NAMES.length;
const SLOT_STORE = 'photobook:fixture-looks';

const LOOKS: { id: string; look: Preset | null }[] = [
  { id: NO_LOOK, look: null },
  ...BUILT_IN_LOOKS.map((look) => ({ id: look.id, look })),
];

function settingsFor(look: Preset | null, mode: AmountMode): DevelopSettings {
  if (!look) return createDevelop();
  return applyLook(createDevelop(), look, mode === 'full' ? 100 : lookDefaultAmount(look));
}

/** Cache key of one cell: the photo, the look and the Amount mode (None has one render per photo). */
const cellKey = (photo: FixturePhoto, id: string, mode: AmountMode): string =>
  `${photo.key}|${id}|${id === NO_LOOK ? 'none' : mode}`;

function readSlots(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(SLOT_STORE) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeSlots(slots: string[]): void {
  try {
    localStorage.setItem(SLOT_STORE, JSON.stringify(slots));
  } catch {
    // Remembering the choice is a convenience.
  }
}

/** Every hashed photo of the loaded folders, by `folderId/relPath`. */
function usePhotos(): FixturePhoto[] {
  const folders = useLibraryStore((s) => s.folders);
  const names = useFoldersStore((s) => s.folders);
  return useMemo(() => {
    const out: FixturePhoto[] = [];
    for (const folder of Object.values(folders)) {
      const name = names.find((f) => f.id === folder.id)?.name ?? folder.path;
      for (const photo of Object.values(folder.photos)) {
        if (!photo.hash) continue;
        out.push({
          key: `${folder.id}/${photo.relPath}`,
          label: `${name}/${photo.relPath}`,
          folder: folder.path,
          relPath: photo.relPath,
          hash: photo.hash,
        });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [folders, names]);
}

function defaultSlots(photos: FixturePhoto[], saved: string[]): string[] {
  const keys = new Set(photos.map((p) => p.key));
  const slots = saved.filter((k) => keys.has(k)).slice(0, SLOTS);
  for (const name of PREFERRED) {
    if (slots.length >= SLOTS) break;
    const hit = photos.find((p) => p.relPath.split('/').pop() === name && !slots.includes(p.key));
    if (hit) slots.push(hit.key);
  }
  for (const p of photos) {
    if (slots.length >= SLOTS) break;
    if (!slots.includes(p.key)) slots.push(p.key);
  }
  return slots;
}

export function LooksFixture() {
  const photos = usePhotos();
  const libraryFolders = useLibraryStore((s) => s.folders);
  const unscanned = Object.values(libraryFolders).filter((f) => !Object.values(f.photos).some((p) => p.hash));
  const [slots, setSlots] = useState<string[]>([]);
  const [before, setBefore] = useState(false);
  const [mode, setMode] = useState<AmountMode>('start');
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string | null>('Loading folders…');
  const made = useRef<string[]>([]);

  // Imported folders and their indexes (no scan: a folder without an index is scanned on request).
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const folders = await useFoldersStore.getState().load();
        const library = useLibraryStore.getState();
        for (const f of folders) library.addFolder(f.id, f.path);
        await Promise.all(folders.map((f) => useLibraryStore.getState().loadIndex(f.id)));
        if (live) setLoading(null);
      } catch (err) {
        devError('fixture', 'could not load folders', err);
        if (live) setLoading(`Could not load the imported folders: ${errorMessage(err)}`);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Slots: the saved choice, else the review fixtures, else the first photos.
  useEffect(() => {
    if (slots.length === 0 && photos.length > 0) setSlots(defaultSlots(photos, readSlots()));
  }, [photos, slots.length]);

  useEffect(
    () => () => {
      for (const url of made.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const chosen = slots.map((key) => photos.find((p) => p.key === key)).filter((p): p is FixturePhoto => !!p);
  const wanted = chosen.flatMap((photo) =>
    LOOKS.map(({ id, look }) => ({ photo, id, look, key: cellKey(photo, id, mode) })),
  );
  const missing = wanted.filter((w) => !urls[w.key] && !errors[w.key]);

  // A slot or the Amount mode changed: drop (and revoke) the renders no cell shows any more.
  const wantedKeys = wanted.map((w) => w.key).join('\n');
  useEffect(() => {
    const keep = new Set(wantedKeys.split('\n'));
    setUrls((s) => {
      const stale = Object.keys(s).filter((k) => !keep.has(k));
      if (stale.length === 0) return s;
      const next = { ...s };
      for (const k of stale) {
        URL.revokeObjectURL(next[k] ?? '');
        delete next[k];
      }
      return next;
    });
    setErrors((s) =>
      Object.keys(s).every((k) => keep.has(k)) ? s : Object.fromEntries(Object.entries(s).filter(([k]) => keep.has(k))),
    );
  }, [wantedKeys]);
  const latest = useRef(missing);
  latest.current = missing;
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Render the missing cells one at a time, in order (None first, so the Before toggle works early); one runner.
  const missingCount = missing.length;
  useEffect(() => {
    if (missingCount === 0 || busy.current) return;
    busy.current = true;
    (async () => {
      const start = performance.now();
      let rendered = 0;
      const tried = new Set<string>();
      const attempts = new Map<string, number>();
      for (;;) {
        const next = latest.current.find((w) => !tried.has(w.key));
        if (!next || !alive.current) break;
        tried.add(next.key);
        try {
          const bytes = await renderDevelopPreview(
            next.photo.folder,
            next.photo.relPath,
            next.photo.hash,
            settingsFor(next.look, next.key.endsWith('|full') ? 'full' : 'start'),
            nextPreviewJob(),
          );
          if (!alive.current) break;
          if (!bytes) {
            // Superseded by a newer preview job (another view rendering): try again, then give up on this cell.
            const n = (attempts.get(next.key) ?? 0) + 1;
            attempts.set(next.key, n);
            if (n < MAX_ATTEMPTS) tried.delete(next.key);
            else setErrors((s) => ({ ...s, [next.key]: 'Skipped: a newer render replaced it' }));
            continue;
          }
          const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
          made.current.push(url);
          rendered++;
          setUrls((s) => ({ ...s, [next.key]: url }));
        } catch (err) {
          if (alive.current) setErrors((s) => ({ ...s, [next.key]: errorMessage(err) }));
        }
      }
      busy.current = false;
      devLog('fixture', 'looks rendered', { rendered, ms: Math.round(performance.now() - start) });
    })();
  }, [missingCount]);

  const pick = (i: number, key: string) => {
    const next = [...slots];
    next[i] = key;
    setSlots(next);
    writeSlots(next);
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-4 text-xs text-fg">
        {SLOT_NAMES.map((slot, i) => (
          <label key={slot} className="flex items-center gap-1.5">
            <span className="text-fg-muted">{slot}</span>
            <select
              className="max-w-64 rounded-sm border border-line bg-panel px-1.5 py-1"
              value={slots[i] ?? ''}
              onChange={(e) => pick(i, e.target.value)}
            >
              <option value="" disabled>
                Choose…
              </option>
              {photos.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={before} onChange={(e) => setBefore(e.target.checked)} />
          Before
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-fg-muted">Amount</span>
          <select
            className="rounded-sm border border-line bg-panel px-1.5 py-1"
            value={mode}
            onChange={(e) => setMode(e.target.value as AmountMode)}
          >
            <option value="start">Each look's starting Amount</option>
            <option value="full">100%</option>
          </select>
        </label>
        {unscanned.length > 0 && (
          <Button
            size="sm"
            onClick={() => {
              for (const f of unscanned) void useLibraryStore.getState().scan(f.id);
            }}
          >
            Scan {unscanned.length} folder{unscanned.length === 1 ? '' : 's'} without an index
          </Button>
        )}
      </div>
      {loading && <p className="text-fg-muted text-xs">{loading}</p>}
      {!loading && photos.length === 0 && (
        <p className="text-fg-muted text-xs">
          No hashed photos in the imported folders. Import <code>fixtures/lisbon-demo</code> and{' '}
          <code>fixtures/portrait</code> in the Library, then come back.
        </p>
      )}
      {chosen.map((photo) => (
        <section key={photo.key} className="mb-8">
          <h2 className="mb-2 font-mono text-[11px] text-fg-muted">{photo.label}</h2>
          <div className="flex flex-wrap gap-4">
            {LOOKS.map(({ id, look }) => {
              const key = cellKey(photo, before ? NO_LOOK : id, mode);
              const def = builtInLookDef(id);
              const amount = look ? (mode === 'full' ? 100 : lookDefaultAmount(look)) : null;
              return (
                <figure key={id} className="m-0 w-72" data-look-id={id}>
                  <div className="flex aspect-[3/2] items-center justify-center bg-stage/30">
                    {urls[key] ? (
                      <img
                        src={urls[key]}
                        alt={before && look ? `${look.name}, before` : (look?.name ?? 'None')}
                        className="max-h-full max-w-full"
                      />
                    ) : (
                      <span className="text-[11px] text-fg-muted">{errors[key] ?? 'Rendering…'}</span>
                    )}
                  </div>
                  <figcaption className="mt-1 text-[11px] text-fg">
                    <span className="font-medium">{look?.name ?? 'None'}</span>
                    {amount !== null && <span className="text-fg-muted"> · {amount}%</span>}
                    {before && id !== NO_LOOK && <span className="text-fg-muted"> · before</span>}
                    {def && <span className="block text-fg-muted">{def.about}</span>}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
