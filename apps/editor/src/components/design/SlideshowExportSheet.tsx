import { defaultExportDir, findOutput, formatDuration, SLIDESHOW_FPS, videoFileName } from '@photobook/shared';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import {
  activeSlideshowExport,
  enqueueSlideshowExport,
  planSlideshowExport,
  preflightSlideshowExport,
} from '../../lib/jobs/slideshowExport';
import { checkExportDest, type ToolStatus, toolStatus } from '../../lib/tauri';
import { flush } from '../../store/autosave';
import { useBookStore } from '../../store/book';
import { assetFlag, libraryBook } from '../../store/library';
import { inputClass } from '../editor/inspectorUi';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { trackSlideshowExport } from './SlideshowExportToast';

/** The last destination and choices, per machine (a convenience; a folder outside the imported ones is checked again). */
const PREFS_KEY = 'photobook:slideshow-export';

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

/** Whether asset `id` of the open project is a pick (the folder library's flag). */
export function isPickNow(id: string): boolean {
  return assetFlag(useBookStore.getState(), id) === 'pick';
}

/**
 * The Export video… sheet of a slideshow (workflow plan 16): destination (default `<primary folder>/Exports/Videos`,
 * or a folder picked in the dialog, checked like a photo export's) and "Show in Finder when done". Export saves the
 * project, then queues the frames and encode jobs (`enqueueSlideshowExport`): the video lands at
 * `<destination>/<slideshow slug>.mp4`. Without FFmpeg it points to Settings → Tools.
 */
export function SlideshowExportSheet({ outputId, onClose }: { outputId: string; onClose: () => void }) {
  const book = useBookStore((s) => s.book);
  const folder = useBookStore((s) => s.folder);
  const projectId = useBookStore((s) => s.projectId);
  const output = book ? findOutput(book, outputId) : undefined;
  const slideshow = output?.kind === 'slideshow' ? output : undefined;
  const [prefs] = useState(readPrefs);
  const [dest, setDest] = useState(prefs.dest ?? (folder ? defaultExportDir(folder, 'Videos') : ''));
  const [reveal, setReveal] = useState(prefs.reveal ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ffmpeg, setFfmpeg] = useState<ToolStatus | null>(null);
  // Export stays off until FFmpeg's status is known, and off when it could not be read.
  const [toolError, setToolError] = useState<string | null>(null);
  useEffect(() => {
    toolStatus('ffmpeg').then(setFfmpeg, (err) =>
      setToolError(`FFmpeg's status could not be read: ${errorMessage(err)}`),
    );
  }, []);

  if (!slideshow || !book || !folder || !projectId) return null;
  let plan: ReturnType<typeof planSlideshowExport> | null = null;
  let planError: string | null = null;
  try {
    plan = planSlideshowExport(book, projectId, outputId, { dest: dest || '/', isPick: isPickNow });
  } catch (err) {
    planError = errorMessage(err);
  }
  const file = videoFileName(slideshow.name);
  const noEncoder = ffmpeg !== null && !ffmpeg.activePath;
  // One export per slideshow at a time: a second would write the same file.
  const running = activeSlideshowExport(projectId, outputId) !== undefined;

  const chooseFolder = async () => {
    const dir = await open({
      directory: true,
      multiple: false,
      title: 'Save video to',
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
      const next = planSlideshowExport(saved, projectId, outputId, { dest: resolved, isPick: isPickNow });
      // FFmpeg and its encoder, the audio, the destination and the disk, before any frame is rendered.
      const { targetExists } = await preflightSlideshowExport(next);
      if (targetExists) {
        const replace = await ask(`${next.fileName} already exists in ${resolved}. Replace it?`, {
          title: 'Replace video',
          kind: 'warning',
          okLabel: 'Replace',
          cancelLabel: 'Cancel',
        });
        if (!replace) {
          setBusy(false);
          return;
        }
      }
      writePrefs({ dest: resolved, reveal });
      trackSlideshowExport(enqueueSlideshowExport({ plan: next, book: saved, folder, reveal, replace: targetExists }));
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
    <DialogShell title={`Export “${slideshow.name}” as a video`} onClose={onClose} widthClass="w-[30rem]">
      <DialogBody>
        {plan && (
          <p className="text-fg-muted">
            {plan.slides === 1 ? '1 slide' : `${plan.slides} slides`}, {formatDuration(plan.timing.seconds)} at{' '}
            {plan.size.width} × {plan.size.height}, {SLIDESHOW_FPS} fps ({plan.timing.totalFrames} frames)
            {slideshow.audioName ? `, with ${slideshow.audioName}` : ', no audio'}. Every frame is rendered as the
            book's page images are, then encoded to H.264.
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
        {running && (
          <p role="status" className="text-fg-muted">
            This slideshow is being exported now; see the jobs list.
          </p>
        )}
        {toolError && (
          <p role="alert" className="text-danger">
            {toolError}
          </p>
        )}
        {noEncoder && (
          <p role="alert" className="text-warn">
            FFmpeg is needed to make the video: download it in Settings → Tools (about 10 MB), or install it with
            Homebrew.
          </p>
        )}
        {(error ?? planError) && (
          <p role="alert" className="text-danger">
            {error ?? planError}
          </p>
        )}
      </DialogBody>
      <DialogFooter note="The frames need Playwright's Chromium, as page images do; they are deleted after the encode.">
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton
          primary
          disabled={busy || !plan || !dest || noEncoder || ffmpeg === null || running}
          onClick={() => void run()}
        >
          Export video
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}
