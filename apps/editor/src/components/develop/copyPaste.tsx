import { isTauri } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { create } from 'zustand';
import { type DecodedClip, type DevelopClip, decodeClip, encode, previousOf } from '../../lib/develop/clipboard';
import type { DevelopCopySection } from '../../lib/develop/sync';
import { devError, devLog } from '../../lib/log';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { BatchButton } from './BatchBar';
import { type BatchContext, registerBatchSlot } from './batchSlots';

/**
 * Develop copy and paste (workflow plan 10). Copy writes the payload (`lib/develop/clipboard.ts`) to the system
 * clipboard as text and keeps it typed in memory; paste uses the memory copy, and with none (after a restart) reads the
 * system clipboard, ignoring text that is not a payload (and saying so, `PasteNotice`, for one marked as ours that this
 * build cannot read). Develop, the Cull grid and its menu, and the batch bar's Paste (registered here) all go through
 * these. Every paste is one undo step (`pasteDevelop`).
 */
interface ClipState {
  /** The last copy, or the payload read from the system clipboard. */
  clip: DevelopClip | null;
  /** The system clipboard held no payload when last read; reset when the window regains focus (it may now). */
  systemEmpty: boolean;
  /** Why the last paste found nothing it could use, when that is worth saying; cleared after `NOTICE_MS`. */
  notice: string | null;
}

/** How long a paste notice shows. */
export const NOTICE_MS = 6000;

const useClipStore = create<ClipState>(() => ({ clip: null, systemEmpty: false, notice: null }));

const UNREADABLE: Record<Extract<DecodedClip, { kind: 'unreadable' }>['reason'], string> = {
  version:
    'The clipboard holds develop settings from another version of Photobook that this one cannot read. Copy them again here.',
  size: 'The develop settings on the clipboard are too large to paste (too many masks or brush points).',
  invalid: 'The develop settings on the clipboard are damaged and cannot be pasted.',
};

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function showNotice(notice: string | null): void {
  clearTimeout(noticeTimer);
  useClipStore.setState({ notice });
  if (notice) noticeTimer = setTimeout(() => useClipStore.setState({ notice: null }), NOTICE_MS);
}

/** The last paste's notice (a short line), or nothing. */
export function PasteNotice({ className = '' }: { className?: string }) {
  const notice = useClipStore((s) => s.notice);
  if (!notice) return null;
  return (
    <span role="status" className={`text-warn ${className}`}>
      {notice}
    </span>
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    if (useClipStore.getState().systemEmpty) useClipStore.setState({ systemEmpty: false });
  });
}

/** True when a paste may find something: a copy in memory, or (in the app) the system clipboard not yet found empty. */
export const useCanPaste = (): boolean => useClipStore((s) => s.clip !== null || (isTauri() && !s.systemEmpty));

/** The copy in memory (tests and the menus). */
export const developClip = (): DevelopClip | null => useClipStore.getState().clip;

/** Forget the copy in memory (tests). */
export function clearDevelopClipboard(): void {
  clearTimeout(noticeTimer);
  useClipStore.setState({ clip: null, systemEmpty: false, notice: null });
}

/**
 * Copy `sections` (default: the remembered choice, `ui.copySections`) of a photo's settings, the version it shows.
 * Returns false for a photo the develop actions cannot read.
 */
export function copySettings(id: string, sections: readonly DevelopCopySection[] = useUiStore.getState().copySections) {
  const clip = useBookStore.getState().copyDevelop(id, sections);
  if (!clip) return false;
  useClipStore.setState({ clip, systemEmpty: false });
  showNotice(null);
  devLog('develop', 'copied settings', { photo: id, sections: clip.sections });
  if (isTauri()) {
    writeText(encode(clip.settings, clip.sections)).catch((err) =>
      devError('develop', 'could not write the clipboard', err),
    );
  }
  return true;
}

/** The payload on the system clipboard (adopted as the memory copy), or null. */
async function readSystemClip(): Promise<DevelopClip | null> {
  if (!isTauri()) return null;
  let decoded: DecodedClip = { kind: 'foreign' };
  try {
    decoded = decodeClip(await readText());
  } catch (err) {
    // An empty clipboard or one holding an image rejects; that is "nothing to paste".
    devError('develop', 'no text on the clipboard', err);
  }
  // A copy made while the read was pending wins.
  if (useClipStore.getState().clip) return useClipStore.getState().clip;
  const clip = decoded.kind === 'clip' ? decoded.clip : null;
  useClipStore.setState(clip ? { clip, systemEmpty: false } : { systemEmpty: true });
  if (decoded.kind === 'unreadable') {
    devLog('develop', 'unreadable settings on the clipboard', { reason: decoded.reason });
    showNotice(UNREADABLE[decoded.reason]);
  }
  return clip;
}

/**
 * Paste the copied settings onto `ids` in one undo step. With a copy in memory the paste happens before this returns
 * (synchronously); otherwise after reading the system clipboard. Resolves to how many photos changed.
 */
export async function pasteSettings(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const clip = useClipStore.getState().clip ?? (await readSystemClip());
  if (!clip) {
    devLog('develop', 'nothing to paste', { photos: ids.length });
    return 0;
  }
  showNotice(null);
  const changed = useBookStore.getState().pasteDevelop(ids, clip);
  devLog('develop', 'pasted settings', { photos: ids.length, changed, sections: clip.sections });
  return changed;
}

/**
 * Paste from previous (Cmd+Alt+V): the remembered sections of the photo before `current` in `refs` (the list as
 * shown) onto `ids`, in one undo step; the clipboard is left alone. Returns how many photos changed.
 */
export function pastePrevious(refs: readonly string[], current: string, ids: readonly string[]): number {
  const from = previousOf(refs, current);
  if (!from) return 0;
  const clip = useBookStore.getState().copyDevelop(from, useUiStore.getState().copySections);
  if (!clip) return 0;
  // `pasteDevelop` skips the photo copied from.
  const changed = useBookStore.getState().pasteDevelop(ids, clip);
  devLog('develop', 'pasted settings from the previous photo', { from, photos: ids.length, changed });
  return changed;
}

/** The batch bar's Paste (order 30): the copied settings onto the selection, after the last paste's notice if any. */
function PasteSlot({ ids }: BatchContext) {
  const canPaste = useCanPaste();
  return (
    <>
      <PasteNotice className="max-w-80 truncate" />
      <BatchButton
        disabled={ids.length === 0 || !canPaste}
        onClick={() => void pasteSettings(ids)}
        title="Paste the copied settings onto the selected photos (Cmd+Shift+V, one undo step)"
      >
        Paste to selected
      </BatchButton>
    </>
  );
}

registerBatchSlot({ id: 'paste', order: 30, render: (ctx) => <PasteSlot {...ctx} /> });
