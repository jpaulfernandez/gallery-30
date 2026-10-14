import { type Book, type Library, serializeBook, serializeLibrary } from '@photobook/shared';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { errorMessage } from '../lib/errors';
import { devLog } from '../lib/log';
import { writeLibrary, writeProject } from '../lib/tauri';
import { flushIdleGestures, loadedFromDisk, setLibrarySaveFlusher, setSaveFlusher, useBookStore } from './book';
import { bookForDisk, isLibraryFromDisk, isLibraryWritable, setLibraryWriteFailed } from './library';
import { type SaveStatus, useUiStore } from './ui';

/**
 * Basic autosave (the full version with .bak is step 1.8): every change to `book` (by reference)
 * restarts a debounce; when it fires the book is serialized and written through `write_project` for the open
 * project id (temp file + rename, `.bak`). What is written is `bookForDisk`: hashed photos without the rating, flag and
 * develop mirror their folder's library holds, so the libraries' pending changes are written first. A freshly loaded
 * book is the saved state. Writes never overlap, and a book that is already on disk (same reference) is never written
 * again. `flush()` writes a pending change now and resolves once every write so far has settled; `close()` and
 * `loadProject()` await it (before another project opens), and so does closing the window (`installCloseFlush`).
 *
 * Status goes to `useUiStore.saveStatus`: dirty -> saving -> saved | error.
 */

export const AUTOSAVE_DELAY_MS = 500;

export interface AutosaveOptions {
  delayMs?: number;
  /** Book autosave: `(projectId, json)`; library autosave: `(folder, json)`. */
  write?: (target: string, json: string) => Promise<void>;
}

let activeFlush: (() => Promise<void>) | null = null;
/** Book autosave: treat the open book as unsaved and schedule a write (a library write recovered, see below). */
let activeMarkDirty: (() => void) | null = null;
let activeLibraryFlush: (() => Promise<void>) | null = null;

/** The book autosave's own status, and a library write failure that overrides it until a library write succeeds. */
let bookStatus: [SaveStatus, string | null] = ['saved', null];
let libraryError: string | null = null;

function showStatus(): void {
  const [status, error] = bookStatus;
  if (libraryError !== null && status !== 'error') useUiStore.getState().setSaveStatus('error', libraryError);
  else useUiStore.getState().setSaveStatus(status, error);
}

function setBookStatus(status: SaveStatus, error: string | null = null): void {
  bookStatus = [status, error];
  showStatus();
}

function setLibraryError(error: string | null): void {
  if (libraryError === error) return;
  libraryError = error;
  showStatus();
}

/** Write the open book and its library now if they have unsaved changes; resolves when all writes so far settled. */
export async function flush(): Promise<void> {
  await (activeFlush?.() ?? Promise.resolve());
  await (activeLibraryFlush?.() ?? Promise.resolve());
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

export function startAutosave({ delayMs = AUTOSAVE_DELAY_MS, write = writeProject }: AutosaveOptions = {}): () => void {
  const initial = useBookStore.getState();
  /** The open project's id: what is written to. */
  let project = initial.projectId;
  /** The book reference known to be on disk. */
  let saved: Book | null = initial.book;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  const status = setBookStatus;

  const save = (target: string, book: Book): Promise<void> => {
    writing = writing.then(async () => {
      if (book === saved) return;
      // The libraries first: the file below leaves out the edits they hold (and keeps them when a write failed).
      await (activeLibraryFlush?.() ?? Promise.resolve());
      const state = useBookStore.getState();
      const json = serializeBook(bookForDisk(state, book, state.projectId === target ? state.folder : null));
      const current = () => useBookStore.getState();
      if (current().projectId === target) status('saving');
      try {
        await write(target, json);
        if (current().projectId === target) saved = book;
        devLog('autosave', 'written', { bytes: json.length });
        if (current().projectId === target && current().book === book) status('saved');
      } catch (err) {
        devLog('autosave', 'failed', { error: errorMessage(err) });
        if (current().projectId === target) status('error', errorMessage(err));
      }
    });
    return writing;
  };

  const flushNow = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    const { book, projectId: current } = useBookStore.getState();
    if (book && project && current === project && book !== saved) void save(project, book);
    return writing;
  };
  activeFlush = flushNow;
  setSaveFlusher(flushNow);

  /** The file on disk may differ from `bookForDisk` of the same book now: write it again after the usual debounce. */
  const markDirty = () => {
    const { book, projectId: current } = useBookStore.getState();
    if (!book || !project || current !== project) return;
    saved = null;
    status('dirty');
    if (timer) clearTimeout(timer);
    const target = project;
    timer = setTimeout(() => {
      timer = null;
      const now = useBookStore.getState().book;
      if (now && useBookStore.getState().projectId === target) void save(target, now);
    }, delayMs);
  };
  activeMarkDirty = markDirty;

  const unsubscribe = useBookStore.subscribe((state, prev) => {
    if (state.projectId !== project) {
      // Flush the previous book's pending change, then adopt what is on disk for the new book as saved: a book the
      // library changed on open but that could not be rewritten is then still written.
      if (timer) {
        clearTimeout(timer);
        timer = null;
        if (project && prev.book && prev.book !== saved) void save(project, prev.book);
      }
      project = state.projectId;
      const disk = loadedFromDisk(state.projectId);
      saved = disk ? disk.book : state.book;
      if (!state.book || !project || state.book === saved) {
        status('saved');
        return;
      }
    } else if (state.book === prev.book || !state.book || !project) {
      return;
    } else if (state.book === saved) {
      if (timer) clearTimeout(timer);
      timer = null;
      status('saved');
      return;
    }
    status('dirty');
    if (timer) clearTimeout(timer);
    const target = project;
    timer = setTimeout(() => {
      timer = null;
      const book = useBookStore.getState().book;
      if (book && useBookStore.getState().projectId === target) void save(target, book);
    }, delayMs);
  });

  return () => {
    if (activeFlush === flushNow) {
      activeFlush = null;
      setSaveFlusher(null);
    }
    if (activeMarkDirty === markDirty) activeMarkDirty = null;
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/**
 * The library's autosave (workflow plan 02), the same pattern as `startAutosave`: every change to a folder's entry
 * in `libraries` (by reference) restarts that folder's debounce; when it fires the library is serialized and written
 * through `write_library` (temp file + rename, `.bak`). Libraries loaded with the project count as saved, writes never
 * overlap, and a library that could not be parsed (`isLibraryWritable`) is never written. `flush()` and switching or
 * closing the project write pending changes first. A failure shows in `saveStatus` as an error until a library write
 * succeeds (book saves do not clear it), and the next change or flush writes again.
 */
export function startLibraryAutosave({
  delayMs = AUTOSAVE_DELAY_MS,
  write = writeLibrary,
}: AutosaveOptions = {}): () => void {
  /** The library reference known to be on disk, per folder. */
  let saved: Record<string, Library> = { ...useBookStore.getState().libraries };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let writing: Promise<void> = Promise.resolve();

  const save = (folder: string, library: Library): Promise<void> => {
    writing = writing.then(async () => {
      if (saved[folder] === library || !isLibraryWritable(folder)) return;
      const json = serializeLibrary(library);
      try {
        await write(folder, json);
        saved[folder] = library;
        // After a failed write the book file kept the mirror of this folder's photos: save it again to leave it out.
        if (setLibraryWriteFailed(folder, false)) activeMarkDirty?.();
        devLog('library', 'written', { photos: Object.keys(library.photos).length, bytes: json.length });
        if (folder in useBookStore.getState().libraries) setLibraryError(null);
      } catch (err) {
        // `saved` keeps the old reference, so the next change (or flush) writes again. Until then the book keeps its mirror.
        setLibraryWriteFailed(folder, true);
        devLog('library', 'write failed', { error: errorMessage(err) });
        if (folder in useBookStore.getState().libraries) setLibraryError(`Library not saved: ${errorMessage(err)}`);
      }
    });
    return writing;
  };

  const flushNow = (): Promise<void> => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const [folder, library] of Object.entries(useBookStore.getState().libraries)) {
      if (library !== saved[folder]) void save(folder, library);
    }
    return writing;
  };
  activeLibraryFlush = flushNow;
  setLibrarySaveFlusher(flushNow);

  const unsubscribe = useBookStore.subscribe((state, prev) => {
    const switched = state.projectId !== prev.projectId;
    if (switched) {
      // Write what the previous book left pending, then adopt the newly loaded libraries as saved.
      for (const [folder, timer] of timers) {
        clearTimeout(timer);
        const library = prev.libraries[folder];
        if (library && library !== saved[folder]) void save(folder, library);
      }
      timers.clear();
      setLibraryError(null);
      // Adopt what is on disk as saved: a library that gained lifted fields on open is then written below.
      saved = { ...saved, ...state.libraries };
      const disk = loadedFromDisk(state.projectId);
      if (disk) Object.assign(saved, disk.libraries);
    } else if (state.libraries === prev.libraries) {
      return;
    }
    for (const [folder, library] of Object.entries(state.libraries)) {
      if (!switched && library === prev.libraries[folder]) continue;
      const pending = timers.get(folder);
      if (pending) clearTimeout(pending);
      timers.delete(folder);
      if (library === saved[folder]) continue;
      // A library just read (`loadLibrary`, e.g. a folder a relink moved a photo into) is what is on disk already.
      if (isLibraryFromDisk(library)) {
        saved[folder] = library;
        continue;
      }
      timers.set(
        folder,
        setTimeout(() => {
          timers.delete(folder);
          const now = useBookStore.getState().libraries[folder];
          if (now) void save(folder, now);
        }, delayMs),
      );
    }
  });

  return () => {
    if (activeLibraryFlush === flushNow) {
      activeLibraryFlush = null;
      setLibrarySaveFlusher(null);
    }
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
