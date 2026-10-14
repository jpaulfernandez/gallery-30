import { parseBook, serializeBook } from '@photobook/shared';
import { create } from 'zustand';
import { devLog } from '../lib/log';
import {
  deleteProject,
  listProjects,
  openProjectFile,
  type ProjectSummary,
  readProject,
  revealProject,
  writeProject,
} from '../lib/tauri';
import { useBookStore } from './book';

/**
 * The projects Home lists (workflow plan 04): `<appData>/projects/<id>/` plus the files remembered in
 * `<appData>/projects.json`, owned by Rust. Not undoable: every action goes to its command, then the list is reloaded
 * or patched. The open project itself lives in the book store; renaming or deleting it goes through there first.
 */
export interface ProjectsState {
  projects: ProjectSummary[];
  /** Read the list (last opened first). */
  load: () => Promise<ProjectSummary[]>;
  /** Set a project's title in its file (the open project's through the book store, so undo and autosave see it). */
  rename: (id: string, title: string) => Promise<void>;
  /** Move a project to the Trash (closing it first when it is open). */
  remove: (id: string) => Promise<void>;
  /** Register a project file picked in the open dialog and return it. */
  openFile: (path: string) => Promise<ProjectSummary>;
  /** Show the project file in the Finder. */
  reveal: (id: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsState>()((set, get) => ({
  projects: [],

  load: async () => {
    const projects = await listProjects();
    set({ projects });
    devLog('projects', 'loaded', { count: projects.length });
    return projects;
  },

  rename: async (id, title) => {
    const next = title.trim();
    if (!next) throw new Error('A project needs a title');
    const book = useBookStore.getState();
    if (book.projectId === id && book.book) {
      book.setTitle(next);
    } else {
      // Parsed (and migrated) like any open, so the file is written back valid; library fields stay for the next open.
      const parsed = parseBook(await readProject(id));
      await writeProject(id, serializeBook({ ...parsed, title: next }));
    }
    set({ projects: get().projects.map((p) => (p.id === id ? { ...p, title: next } : p)) });
    devLog('projects', 'renamed', { id });
  },

  remove: async (id) => {
    if (useBookStore.getState().projectId === id) await useBookStore.getState().close();
    await deleteProject(id);
    set({ projects: get().projects.filter((p) => p.id !== id) });
    devLog('projects', 'moved to the Trash', { id });
  },

  openFile: async (path) => {
    const project = await openProjectFile(path);
    const rest = get().projects.filter((p) => p.id !== project.id);
    set({ projects: [project, ...rest] });
    return project;
  },

  reveal: (id) => revealProject(id),
}));
