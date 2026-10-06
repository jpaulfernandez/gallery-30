import { type Book, serializeBook } from '@photobook/shared';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { errorMessage } from '../lib/errors';
import { devLog } from '../lib/log';
import { writeBook } from '../lib/tauri';
import { flushIdleGestures, setSaveFlusher, useBookStore } from './book';
import { useUiStore } from './ui';

/**
 * Basic autosave (the full version with .bak is step 1.8): every change to `book` (by reference)
 * restarts a debounce; when it fires the book is serialized and written through `write_book`
 * (temp file + rename). A freshly loaded book is the saved state. Writes never overlap, and a
 * book that is already on disk (same reference) is never written again. `flush()` writes a pending
 * change now and resolves once every write so far has settled; `close()` and `loadFromFolder()`
 * await it (before open_book moves the Rust scope), and so does closing the window
 * (`installCloseFlush`).
 *
 * Status goes to `useUiStore.saveStatus`: dirty -> saving -> saved | error.
 */

export const AUTOSAVE_DELAY_MS = 500;

export interface AutosaveOptions {
  delayMs?: number;
  write?: (folder: string, json: string) => Promise<void>;
}

let activeFlush: (() => Promise<void>) | null = null;

/** Write the open book now if it has unsaved changes; resolves when all writes so far settled. */
export function flush(): Promise<void> {
  return activeFlush?.() ?? Promise.resolve();
}

/**
 * Save before the window closes. The Tauri API destroys the window once the async handler returns
 * (needs `core:window:allow-destroy`). No-op outside Tauri (plain browser dev, tests).
 */
export async function installCloseFlush(): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().onCloseRequested(async () => {
    flushIdleGestures();
    await flush();
  });
}

export function startAutosave({ delayMs = AUTOSAVE_DELAY_MS, write = writeBook }: AutosaveOptions = {}): () => void {
  const initial = useBookStore.getState();
  let folder = initial.folder;
  /** The book reference known to be on disk. */
  let saved: Book | null = initial.book;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  const status = useUiStore.getState().setSaveStatus;

  const save = (target: string, book: Book): Promise<void> => {
    writing = writing.then(async () => {
      if (book === saved) return;
      const json = serializeBook(book);
      const current = () => useBookStore.getState();
      if (current().folder === target) status('saving');
      try {
        await write(target, json);
        if (current().folder === target) saved = book;
        devLog('autosave', 'written', { bytes: json.length });
        if (current().folder === target && current().book === book) status('saved');
      } catch (err) {
        devLog('autosave', 'failed', { error: errorMessage(err) });
        if (current().folder === target) status('error', errorMessage(err));
      }
    });
    return writing;
  };

  const flushNow = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    const { book, folder: current } = useBookStore.getState();
    if (book && folder && current === folder && book !== saved) void save(folder, book);
    return writing;
  };
  activeFlush = flushNow;
  setSaveFlusher(flushNow);

  const unsubscribe = useBookStore.subscribe((state, prev) => {
    if (state.folder !== folder) {
      // Flush the previous book's pending change, then adopt the new book as saved.
      if (timer) {
        clearTimeout(timer);
        timer = null;
        if (folder && prev.book && prev.book !== saved) void save(folder, prev.book);
      }
      folder = state.folder;
      saved = state.book;
      status('saved');
      return;
    }
    if (state.book === prev.book || !state.book || !folder) return;
    if (state.book === saved) {
      if (timer) clearTimeout(timer);
      timer = null;
      status('saved');
      return;
    }
    status('dirty');
    if (timer) clearTimeout(timer);
    const target = folder;
    timer = setTimeout(() => {
      timer = null;
      const book = useBookStore.getState().book;
      if (book && useBookStore.getState().folder === target) void save(target, book);
    }, delayMs);
  });

  return () => {
    if (activeFlush === flushNow) {
      activeFlush = null;
      setSaveFlusher(null);
    }
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
