import { defaultExportDir, findOutput, postSlug, printFileName } from '@photobook/shared';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { enqueuePrintExport, planPrintExport } from '../../lib/jobs/printExport';
import { checkExportDest, printTargetExists } from '../../lib/tauri';
import { flush } from '../../store/autosave';
import { useBookStore } from '../../store/book';
import { libraryBook } from '../../store/library';
import { inputClass } from '../editor/inspectorUi';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { trackPrintExport } from './PrintExportToast';

/** The last destination and choices, per machine (a convenience; a folder outside the imported ones is checked again). */
const PREFS_KEY = 'photobook:print-export';

interface Prefs {
  dest?: string;
  reveal?: boolean;
}

function readPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Prefs;
  } catch {
    return {};
  }
}

function writePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable: the sheet opens on the defaults next time.
  }
}

/**
 * The Export PDF… sheet of a print (workflow plan 15): destination (default `<primary folder>/Exports/Print`, or a
 * folder picked in the dialog, checked like a photo export's) and "Show in Finder when done". Export saves the project,
 * then queues the job (`enqueuePrintExport`): the PDF lands at `<destination>/<print slug>.pdf`.
 */
export function PrintExportSheet({ outputId, onClose }: { outputId: string; onClose: () => void }) {
  const book = useBookStore((s) => s.book);
  const folder = useBookStore((s) => s.folder);
  const projectId = useBookStore((s) => s.projectId);
  const output = book ? findOutput(book, outputId) : undefined;
  const print = output?.kind === 'print' ? output : undefined;
  const [prefs] = useState(readPrefs);
  const [dest, setDest] = useState(prefs.dest ?? (folder ? defaultExportDir(folder, 'Print') : ''));
  const [reveal, setReveal] = useState(prefs.reveal ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An existing PDF of the same name is replaced only when ticked (as a photo export asks).
  const [exists, setExists] = useState(false);
  const [replace, setReplace] = useState(false);
  const fileName = print ? printFileName(postSlug(print.name)) : '';
  useEffect(() => {
    let live = true;
    setExists(false);
    setReplace(false);
    if (!dest || !fileName) return;
    printTargetExists(dest, fileName).then(
      (found) => live && setExists(found),
      () => live && setExists(false),
    );
    return () => {
      live = false;
    };
  }, [dest, fileName]);

  if (!print || !book || !folder || !projectId) return null;
  let plan: ReturnType<typeof planPrintExport> | null = null;
  let planError: string | null = null;
  try {
    plan = planPrintExport(book, projectId, outputId, { dest: dest || '/' });
  } catch (err) {
    planError = errorMessage(err);
  }
  const file = fileName;

  const chooseFolder = async () => {
    const dir = await open({ directory: true, multiple: false, title: 'Save PDF to', defaultPath: dest || undefined });
    if (typeof dir !== 'string') return;
    try {
      setDest(await checkExportDest(dir));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const resolved = await checkExportDest(dest);
      // The CLI reads the saved project file.
      await flush();
      const saved = libraryBook(useBookStore.getState());
      if (!saved) throw new Error('The project is not open');
      const next = planPrintExport(saved, projectId, outputId, { dest: resolved, replace: exists && replace });
      writePrefs({ dest: resolved, reveal });
      trackPrintExport(enqueuePrintExport({ plan: next, book: saved, folder, reveal }));
      onClose();
    } catch (err) {
      const message = errorMessage(err);
      setError(
        /scope|not allowed/i.test(message)
          ? 'Choose the destination folder again: outside your imported folders Photobook writes only to a folder picked since it started.'
          : message,
      );
      setBusy(false);
    }
  };

  return (
    <DialogShell title={`Export “${print.name}” as PDF`} onClose={onClose} widthClass="w-[30rem]">
      <DialogBody>
        {plan && (
          <p className="text-fg-muted">
            {plan.pages === 1 ? '1 page' : `${plan.pages} pages`} on{' '}
            {plan.sheets === 1 ? '1 PDF page' : `${plan.sheets} PDF pages`}: {plan.summary}
            {print.marks ? ', crop marks' : ''}, photos at {print.dpi} dpi. Edited photos are rendered at full size
            first.
          </p>
        )}
        <div className="space-y-1">
          <span className="section-title">Destination</span>
          <div className="flex items-center gap-2">
            <input
              value={dest}
              readOnly
              aria-label="Destination folder"
              title={dest}
              className={`${inputClass} min-w-0 flex-1 truncate`}
            />
            <DialogButton onClick={() => void chooseFolder()}>Choose…</DialogButton>
          </div>
          <p className="truncate text-[11px] text-fg-muted" title={`${dest}/${file}`}>
            Writes {file}
          </p>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
          Show in Finder when done
        </label>
        {exists && (
          <label className="flex items-center gap-2 text-warn">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            Replace the existing {file}
          </label>
        )}
        {(error ?? planError) && (
          <p role="alert" className="text-danger">
            {error ?? planError}
          </p>
        )}
      </DialogBody>
      <DialogFooter note="The PDF needs Playwright's Chromium, as page images do. Colours are sRGB.">
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton primary disabled={busy || !plan || !dest || (exists && !replace)} onClick={() => void run()}>
          Export PDF
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}
