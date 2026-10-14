import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { defaultFitName, fittedPresetName, pairCameraFiles, pairOf, pairProblem } from '../../lib/develop/cameraPairs';
import { errorMessage } from '../../lib/errors';
import { devError } from '../../lib/log';
import { basename } from '../../lib/path';
import { type FilmTag, type FitLutResult, type FitPair, scanFolder } from '../../lib/tauri';
import { useBookStore } from '../../store/book';
import { useJobsStore } from '../../store/jobs';
import { assetFolder, photoMeta, useLibraryStore } from '../../store/library';
import { enqueueLutFit, filmSimulationOf } from '../../store/luts';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';

/** Most pairs one fit takes (as `MAX_FIT_PAIRS` in `commands/luts.rs`). */
export const MAX_FIT_PAIRS = 24;
/** Pairs ticked when the dialog opens. */
const DEFAULT_PICK = 8;

const keyOf = (p: FitPair) => `${p.raw}\u0000${p.jpeg}`;

interface MatchCameraDialogProps {
  assetId: string;
  onClose: () => void;
}

/** The photo's folder files: the library's scan of it when there is one, else a fresh scan. */
async function folderFiles(folder: string): Promise<string[]> {
  const known = Object.values(useLibraryStore.getState().folders).find((f) => f.path === folder);
  const paths = known ? Object.values(known.photos).map((p) => p.relPath) : [];
  if (paths.length > 0) return paths;
  return (await scanFolder(folder)).map((f) => f.relPath);
}

/** A pair's film tags, RAW and JPEG. */
interface PairTags {
  raw: FilmTag | null;
  jpeg: FilmTag | null;
}

/** Up to `count` pairs nearest to `around` (a pair, or a path placed among them) in path order, nearest first. */
function nearest(pairs: readonly FitPair[], around: FitPair | string | null | undefined, count: number): FitPair[] {
  if (pairs.length === 0) return [];
  const at =
    typeof around === 'string'
      ? Math.max(
          0,
          pairs.findIndex((p) => p.raw >= around),
        )
      : around
        ? pairs.indexOf(around)
        : 0;
  const centre = at < 0 ? 0 : at;
  return pairs
    .map((p, i) => ({ p, d: Math.abs(i - centre) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map(({ p }) => p);
}

/**
 * Match camera JPEG (workflow plan 22): the RAW + JPEG pairs of the photo's folder (paired by base name, with each
 * pair's film simulation), a name, and Fit, which runs as a job (it carries on if the dialog is closed). When it is
 * done the dialog lists each pair's mean ΔE and offers to apply the look to this photo; the LUT and its look preset
 * (`<name> (fitted)`) are saved either way.
 */
export function MatchCameraDialog({ assetId, onClose }: MatchCameraDialogProps) {
  const folder = useBookStore((s) => assetFolder(s, assetId));
  const current = useBookStore((s) => photoMeta(s, assetId)?.path ?? null);
  const [pairs, setPairs] = useState<FitPair[] | null>(null);
  // Film tags, read on demand: the current photo's pair and the pairs ticked (never the whole folder).
  const [tags, setTags] = useState<Record<string, PairTags | 'loading'>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<FitLutResult | null>(null);
  const job = useJobsStore((s) => (jobId ? s.jobs[jobId] : undefined));
  const running = job !== undefined && (job.state === 'queued' || job.state === 'running');

  const readTags = useCallback(
    async (p: FitPair): Promise<PairTags | null> => {
      if (!folder) return null;
      setTags((t) => (t[keyOf(p)] ? t : { ...t, [keyOf(p)]: 'loading' }));
      const [raw, jpeg] = await Promise.all([filmSimulationOf(folder, p.raw), filmSimulationOf(folder, p.jpeg)]);
      const read = { raw, jpeg };
      setTags((t) => ({ ...t, [keyOf(p)]: read }));
      return read;
    },
    [folder],
  );

  // The folder's pairs; the first pick is the current photo's pair and its neighbours that share its film tag (the
  // photo's own tag when it has no pair).
  useEffect(() => {
    if (!folder) return;
    let live = true;
    void (async () => {
      try {
        const found = pairCameraFiles(await folderFiles(folder));
        if (!live) return;
        setPairs(found);
        const own = current ? pairOf(found, current) : undefined;
        const ownTag = own
          ? await readTags(own).then((t) => t?.raw ?? t?.jpeg ?? null)
          : current
            ? await filmSimulationOf(folder, current)
            : null;
        const candidates = nearest(found, own ?? current, DEFAULT_PICK);
        const read = await Promise.all(candidates.map((p) => readTags(p)));
        if (!live) return;
        const keep = candidates.filter((_, i) => {
          const t = read[i];
          if (!t || pairProblem(t.raw, t.jpeg)) return false;
          return !ownTag || (t.raw ?? t.jpeg)?.simulation === ownTag.simulation;
        });
        setPicked(new Set(keep.map(keyOf)));
      } catch (err) {
        if (live) setError(errorMessage(err));
        devError('develop', 'Match camera JPEG: could not list the folder', err);
      }
    })();
    return () => {
      live = false;
    };
  }, [folder, current, readTags]);

  const tagsOf = (p: FitPair): PairTags | undefined => {
    const t = tags[keyOf(p)];
    return t === 'loading' ? undefined : t;
  };
  const simulationOf = (p: FitPair) => {
    const t = tagsOf(p);
    return (t?.raw ?? t?.jpeg)?.simulation ?? null;
  };
  const problemOf = (p: FitPair) => {
    const t = tagsOf(p);
    return t ? pairProblem(t.raw, t.jpeg) : undefined;
  };
  const chosen = (pairs ?? []).filter((p) => picked.has(keyOf(p)) && !problemOf(p));
  const suggestedName = defaultFitName(chosen.map(simulationOf));
  const shownName = named ? name : suggestedName;
  const canFit = folder !== null && chosen.length > 0 && chosen.length <= MAX_FIT_PAIRS && !running;

  const toggle = (p: FitPair) => {
    const ticking = !picked.has(keyOf(p));
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(keyOf(p))) next.delete(keyOf(p));
      else next.add(keyOf(p));
      return next;
    });
    if (ticking && !tags[keyOf(p)]) void readTags(p);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canFit || !folder) return;
    setError(null);
    setResult(null);
    const project = useBookStore.getState().projectId;
    const handle = enqueueLutFit({ folder, pairs: chosen, name: shownName.trim(), project });
    setJobId(handle.id);
    void handle.result.then((outcome) => {
      if (outcome.state === 'done') setResult(outcome.value);
      else if (outcome.state === 'failed') setError(outcome.error);
    });
  };

  const apply = () => {
    if (!result) return;
    const { id, name: lutName } = result.lut;
    useBookStore.getState().setAssetDevelop(assetId, { look: { lut: { id, name: lutName, strength: 100 } } });
    onClose();
  };

  // Reports name each pair by its path relative to the folder, like the pairs sent.
  const reportFor = (p: FitPair) => result?.pairs.find((r) => r.raw === p.raw && r.jpeg === p.jpeg);
  const percent = job && job.total > 0 ? Math.round((100 * job.done) / job.total) : 0;

  return (
    <DialogShell title="Match camera JPEG" onClose={onClose}>
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <DialogBody>
          <p className="text-fg-muted">
            Fits a look from RAW files and the JPEGs your camera saved with them, so the camera’s picture style (a film
            simulation) applies to any photo. Choose pairs shot with the same style; several varied scenes work best.
          </p>
          {pairs === null && !error && <p className="text-fg-muted">Looking for RAW + JPEG pairs…</p>}
          {pairs !== null && pairs.length === 0 && (
            <p className="text-fg-muted">
              This folder has no RAW file with a JPEG of the same name (for example DSCF0001.RAF and DSCF0001.JPG).
            </p>
          )}
          {pairs !== null && pairs.length > 0 && (
            <fieldset className="space-y-1">
              <legend className="mb-1 text-fg-muted">
                Pairs ({chosen.length} of {pairs.length} chosen
                {chosen.length > MAX_FIT_PAIRS ? `, at most ${MAX_FIT_PAIRS}` : ''})
              </legend>
              <ul
                className="max-h-56 space-y-0.5 scrollbar overflow-x-hidden overflow-y-auto rounded-md border border-line p-1.5"
                aria-label="Pairs"
              >
                {pairs.map((p) => {
                  const report = reportFor(p);
                  const problem = problemOf(p);
                  const simulation = simulationOf(p);
                  return (
                    <li key={keyOf(p)}>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={picked.has(keyOf(p)) && !problem}
                          disabled={running || problem !== undefined}
                          onChange={() => toggle(p)}
                        />
                        <span className="min-w-0 flex-1 truncate" title={`${p.raw} + ${p.jpeg}`}>
                          {basename(p.raw)} + {basename(p.jpeg)}
                        </span>
                        {report?.meanDeltaE !== undefined && (
                          <span className="text-fg-muted">ΔE {report.meanDeltaE.toFixed(1)}</span>
                        )}
                        {report?.error && (
                          <span className="truncate text-danger" title={report.error}>
                            left out
                          </span>
                        )}
                        {!report && problem && (
                          <span className="truncate text-danger" title={problem}>
                            edited export?
                          </span>
                        )}
                        {!report && !problem && simulation && <span className="text-fg-muted">{simulation}</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          )}
          <label className="block space-y-1">
            <span className="text-fg-muted">Look name</span>
            <input
              data-autofocus
              value={shownName}
              onChange={(e) => {
                setNamed(true);
                setName(e.target.value);
              }}
              maxLength={80}
              spellCheck={false}
              disabled={running}
              className="w-full rounded-md border border-line bg-panel-2 px-2 py-1 text-fg outline-none focus:border-accent"
            />
          </label>
          {running && job && (
            <div className="space-y-1">
              <div
                className="h-1.5 overflow-hidden rounded bg-line"
                role="progressbar"
                aria-label="Fit progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
              </div>
              <p className="text-fg-muted">
                {job.state === 'queued' ? 'Waiting for other renders…' : (job.detail ?? 'Fitting…')}
              </p>
            </div>
          )}
          {result && (
            <p role="status">
              Saved “{result.lut.name}” and the preset “{fittedPresetName(result.lut.name)}”: mean ΔE{' '}
              {result.meanDeltaE.toFixed(1)} over {result.pairs.filter((r) => !r.error).length} pair(s); the pairs cover{' '}
              {Math.round(result.coverage * 100)} % of the colour cube (the rest is filled in smoothly)
              {result.meanDeltaE > 4 ? '. That is far from the JPEGs: check the pairs share one film simulation.' : '.'}
            </p>
          )}
          {result?.pairs.some((r) => r.error) && (
            <ul className="space-y-0.5 text-danger">
              {result.pairs
                .filter((r) => r.error)
                .map((r) => (
                  <li key={`${r.raw}+${r.jpeg}`}>
                    {r.raw}: {r.error}
                  </li>
                ))}
            </ul>
          )}
          {job?.state === 'cancelled' && <p className="text-fg-muted">Cancelled.</p>}
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter note={running ? 'You can close this; the fit carries on in the background.' : undefined}>
          {running && jobId ? (
            <DialogButton onClick={() => useJobsStore.getState().cancel(jobId)}>Cancel fit</DialogButton>
          ) : (
            <DialogButton onClick={onClose}>{result ? 'Close' : 'Cancel'}</DialogButton>
          )}
          {result ? (
            <DialogButton primary onClick={apply}>
              Apply to this photo
            </DialogButton>
          ) : (
            <DialogButton type="submit" primary disabled={!canFit}>
              {running ? 'Fitting…' : 'Fit look'}
            </DialogButton>
          )}
        </DialogFooter>
      </form>
    </DialogShell>
  );
}
