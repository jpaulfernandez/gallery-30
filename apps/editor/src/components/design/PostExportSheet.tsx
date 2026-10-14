import {
  CAPTION_FILE,
  captionLength,
  defaultExportDir,
  findOutput,
  frameFileName,
  postSlug,
  type SocialFormat,
  socialTemplate,
} from '@photobook/shared';
import { open } from '@tauri-apps/plugin-dialog';
import { useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { enqueueSocialExport, planSocialExport } from '../../lib/jobs/socialExport';
import { checkExportDest } from '../../lib/tauri';
import { flush } from '../../store/autosave';
import { useBookStore } from '../../store/book';
import { libraryBook } from '../../store/library';
import { inputClass } from '../editor/inspectorUi';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { trackPostExport } from './PostExportToast';

/** The last destination and choices, per machine (a convenience; a folder outside the imported ones is checked again). */
const PREFS_KEY = 'photobook:post-export';

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
 * The Export… sheet of a social post (workflow plan 14): destination (default `<primary folder>/Exports/Posts`, or a
 * folder picked in the dialog, checked like a photo export's), format (the network's, JPEG or PNG) and "Open folder when
 * done". Export saves the project, then queues the jobs (`enqueueSocialExport`): the files land in
 * `<destination>/<post slug>/01.jpg … NN.jpg` with `caption.txt`.
 */
export function PostExportSheet({ outputId, onClose }: { outputId: string; onClose: () => void }) {
  const book = useBookStore((s) => s.book);
  const folder = useBookStore((s) => s.folder);
  const projectId = useBookStore((s) => s.projectId);
  const output = book ? findOutput(book, outputId) : undefined;
  const post = output?.kind === 'social' ? output : undefined;
  const template = socialTemplate(post?.network);
  const [prefs] = useState(readPrefs);
  const [dest, setDest] = useState(prefs.dest ?? (folder ? defaultExportDir(folder, 'Posts') : ''));
  const [format, setFormat] = useState<SocialFormat>(template.format);
  const [reveal, setReveal] = useState(prefs.reveal ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!post || !folder || !projectId) return null;
  const count = post.frames.length;
  const slug = postSlug(post.name);
  const last = frameFileName(Math.max(count - 1, 0), format);
  const captionOver = captionLength(post.caption) - template.captionLimit;

  const chooseFolder = async () => {
    const dir = await open({
      directory: true,
      multiple: false,
      title: 'Export post to',
      defaultPath: dest || undefined,
    });
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
      const plan = planSocialExport(saved, projectId, outputId, { dest: resolved, format });
      writePrefs({ dest: resolved, reveal });
      trackPostExport(enqueueSocialExport({ plan, book: saved, folder, reveal }));
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
    <DialogShell title={`Export “${post.name}”`} onClose={onClose} widthClass="w-[30rem]">
      <DialogBody>
        <p className="text-fg-muted">
          {count === 1 ? '1 frame' : `${count} frames`} at {template.width} × {template.height} px for {template.label},
          rendered as the book's page images are.
        </p>
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
          <p className="truncate text-[11px] text-fg-muted" title={`${dest}/${slug}`}>
            Writes {slug}/{frameFileName(0, format)}
            {count > 1 ? ` … ${last}` : ''} and {CAPTION_FILE}
          </p>
        </div>
        <label className="flex items-center justify-between gap-3">
          <span className="section-title">Format</span>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value as SocialFormat)}
            aria-label="Format"
            className={inputClass}
          >
            <option value="jpeg">JPEG{template.format === 'jpeg' ? ` (${template.service})` : ''}</option>
            <option value="png">PNG (lossless){template.format === 'png' ? ` (${template.service})` : ''}</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
          Open folder when done
        </label>
        {captionOver > 0 && (
          <p className="text-warn">
            The caption is {captionOver} characters over {template.service}'s limit of {template.captionLimit}; it is
            exported as it is.
          </p>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter note="Nothing is posted: the files are ready for your phone or a scheduler.">
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton primary disabled={busy || count === 0 || !dest} onClick={() => void run()}>
          Export
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}
