import type { SavedCollection } from '@photobook/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import type { Folder, ProjectSummary } from '../../lib/tauri';
import { useBookStore } from '../../store/book';
import {
  availableCollections,
  type CollectionId,
  collectionCount,
  isoKnown,
  noiseSignature,
  sourceItems,
  usableSignature,
  useCollectionsStore,
} from '../../store/collections';
import { useDenoisePrefs } from '../../store/denoisePrefs';
import { useFoldersStore } from '../../store/folders';
import { useLibraryStore } from '../../store/library';
import { useProjectsStore } from '../../store/projects';
import { useUiStore } from '../../store/ui';
import { CulledMark } from '../cull/CulledMark';
import { CullFilters } from '../cull/CullFilters';
import { ExportSourceMenu, type ExportSourceMenuState } from '../export/ExportSourceMenu';
import { exportLibrarySource } from '../export/entryPoints';
import { Button, buttonClass } from '../ui/Button';
import { Input } from '../ui/Field';
import { Menu, MenuItem, useContextMenu } from '../ui/Menu';
import { LibraryFilters } from './LibraryFilterBar';
import { RowCount, sidebarRowClass } from './SidebarRow';
import { useLibraryFolders } from './useLibraryFolders';

/** What the main area shows, so the sidebar can mark it. */
export type SidebarCurrent =
  | { kind: 'folder'; id: string }
  | { kind: 'collection'; id: CollectionId }
  | { kind: 'saved'; id: string }
  | { kind: 'project'; id: string }
  | null;

/** How long the libraries must stay unchanged before the collection counts follow them, ms. */
const COUNT_DELAY_MS = 250;

/** `value`, following its changes once they stop for `delay` ms (the first value at once). */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, settled, delay]);
  return settled;
}

/** A row (plan 45): 26 px, the current one with the accent bar (`SidebarRow.tsx`). */
const itemClass = sidebarRowClass;

/** The rename field that replaces a row. */
const renameClass = 'h-[26px] shrink-0';

/**
 * The Library sidebar (workflow plan 05, WORKFLOW_PLAN 14.1): Folders (imported once, with their photo counts; double-click
 * a name to rename it), Collections (built-in filters over every folder: Kept, Edited, and Needs denoise once ISO is
 * known; then the saved ones of plan 06, with Rename and Delete in a right-click menu), on Cull the Filters (plan 51:
 * `LibraryFilters` and Cull's `CullFilters` fragment, over the project's view on a project's Cull) and Projects. Folders and
 * projects have a right-click menu too (plan 43). A folder or collection opens in the current library stage (Cull unless Develop is showing); a
 * project opens in Design.
 */
export function Sidebar({ current, stage }: { current: SidebarCurrent; stage: 'cull' | 'develop' }) {
  const folders = useLibraryFolders();
  // Counts follow the scans (a signature of each folder's hashed photos) and the libraries, not every thumbnail; a burst
  // of ratings (a key held down, a batch) recounts once it settles.
  const signature = useLibraryStore((s) => usableSignature(Object.values(s.folders)));
  const libraries = useSettled(
    useBookStore((s) => s.libraries),
    COUNT_DELAY_MS,
  );
  const saved = useCollectionsStore((s) => s.saved);
  // Plan 27: the Needs denoise count follows Settings → Models' thresholds and the noise measured since the scan.
  const denoiseThresholdKey = useDenoisePrefs((s) => `${s.iso}:${s.amount}`);
  const noiseKey = useLibraryStore((s) => noiseSignature(Object.values(s.folders)));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature`, `noiseKey` and `denoiseThresholdKey` stand for the stores read below
  const counts = useMemo(() => {
    const { folders: known } = useLibraryStore.getState();
    const perFolder: Record<string, number> = {};
    for (const [id, folder] of Object.entries(known)) perFolder[id] = Object.keys(folder.photos).length;
    const collections = availableCollections(known).map((c) => ({
      ...c,
      count: collectionCount(c.id, known, libraries),
    }));
    const perSaved: Record<string, number> = {};
    for (const c of saved) {
      perSaved[c.id] = sourceItems({ kind: 'saved', id: c.id, filter: c.filter }, known, libraries).length;
    }
    return { perFolder, collections, perSaved };
  }, [signature, libraries, saved, noiseKey, denoiseThresholdKey]);
  const projects = useProjectsStore((s) => s.projects);
  const openProject = useBookStore((s) => s.projectId);
  const [error, setError] = useState<string | null>(null);
  // Workflow plan 11: right-click a built-in collection to export its photos (a folder has its own menu, plan 43).
  const exportMenu = useContextMenu<ExportSourceMenuState | null>();

  useEffect(() => {
    void useProjectsStore
      .getState()
      .load()
      .catch((err) => devLog('projects', 'not listed', { error: errorMessage(err) }));
    void useCollectionsStore.getState().load();
  }, []);

  const importFolder = async () => {
    setError(null);
    try {
      const folder = await useFoldersStore.getState().import();
      if (folder) await useProjectsStore.getState().load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <nav
      aria-label="Library"
      className="flex min-h-0 flex-col gap-4 scrollbar overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] bg-panel p-2"
    >
      <Section
        title="Folders"
        action={
          <Button variant="ghost" size="sm" onClick={() => void importFolder()} title="Import a photo folder">
            Import…
          </Button>
        }
      >
        {folders.length === 0 && <p className="px-2 text-fg-muted text-xs">No folders yet.</p>}
        {folders.map((folder) => (
          <FolderItem
            key={folder.id}
            folder={folder}
            stage={stage}
            active={current?.kind === 'folder' && current.id === folder.id}
            count={counts.perFolder[folder.id] ?? null}
            onError={setError}
          />
        ))}
        {error && (
          <p role="alert" className="px-2 text-[11px] text-danger">
            {error}
          </p>
        )}
      </Section>

      <Section title="Collections">
        {counts.collections.map((c) => (
          <Link
            key={c.id}
            to={
              stage === 'develop'
                ? '/library/collection/$collectionId/develop'
                : '/library/collection/$collectionId/cull'
            }
            params={{ collectionId: c.id }}
            aria-current={current?.kind === 'collection' && current.id === c.id ? 'page' : undefined}
            onContextMenu={(e) =>
              exportMenu.onContextMenu(e, { x: 0, y: 0, source: { kind: 'collection', id: c.id }, name: c.name })
            }
            className={itemClass(current?.kind === 'collection' && current.id === c.id)}
          >
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <RowCount value={c.count} id={`collection:${c.id}`} />
          </Link>
        ))}
        {saved.map((c) => (
          <SavedCollectionItem
            key={c.id}
            collection={c}
            stage={stage}
            active={current?.kind === 'saved' && current.id === c.id}
            count={counts.perSaved[c.id] ?? 0}
            onError={setError}
          />
        ))}
      </Section>

      {stage === 'cull' && <FiltersSection scope={current?.kind === 'project' ? 'project' : 'library'} />}

      <Section
        title="Projects"
        action={
          <Link to="/" title="All projects, New project…" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
            Home
          </Link>
        }
      >
        {projects.length === 0 && <p className="px-2 text-fg-muted text-xs">No projects yet.</p>}
        {projects.map((project) => (
          <ProjectItem
            key={project.id}
            project={project}
            active={current?.kind === 'project' && current.id === project.id}
            open={project.id === openProject}
            onError={setError}
          />
        ))}
      </Section>
      {exportMenu.menu?.data && (
        <ExportSourceMenu menu={{ ...exportMenu.menu.data, ...exportMenu.at }} onClose={exportMenu.close} />
      )}
    </nav>
  );
}

/**
 * Plan 51 (ODDHALLS_LAYOUT_PLAN 3): the filter bar's filters, between Collections and Projects: flag, stars, Edited,
 * ISO ≥, Hide in project / Hide used and Sort, then Cull's fragment (Decide and its fraction, Stars, Group, Lens).
 */
function FiltersSection({ scope }: { scope: 'library' | 'project' }) {
  const projectOpen = useBookStore((s) => s.book !== null);
  const iso = useLibraryStore((s) => scope === 'library' && isoKnown(s.folders));
  return (
    <Section title="Filters">
      <div className="flex flex-wrap items-center gap-1.5 px-2 text-xs">
        <LibraryFilters scope={scope} projectOpen={projectOpen} isoKnown={iso} pane />
        <CullFilters scope={scope} />
      </div>
    </Section>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-0.5">
      <div className="flex h-6 items-center justify-between pr-0.5 pl-2">
        <h2 className="section-title m-0">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function FolderItem({
  folder,
  stage,
  active,
  count,
  onError,
}: {
  folder: Folder;
  stage: 'cull' | 'develop';
  active: boolean;
  count: number | null;
  onError: (message: string | null) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  // Plan 43: right-click for Rename and Export (Export alone before); plan 45: on `Menu.Context`.
  const menu = useContextMenu();
  const commit = async () => {
    const name = renaming?.trim();
    setRenaming(null);
    if (!name || name === folder.name) return;
    try {
      await useFoldersStore.getState().rename(folder.id, name);
    } catch (err) {
      onError(errorMessage(err));
    }
  };
  if (renaming !== null) {
    return (
      <Input
        autoFocus
        aria-label={`Rename ${folder.name}`}
        value={renaming}
        onChange={(e) => setRenaming(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setRenaming(null);
          }
        }}
        className={renameClass}
      />
    );
  }
  if (folder.missing) {
    return (
      <span className={`${itemClass(false)} opacity-50`} title={`${folder.path} is not on disk right now`}>
        <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        <span className="text-[10px] text-danger">Missing</span>
      </span>
    );
  }
  return (
    <>
      <Link
        to={stage === 'develop' ? '/library/$folderId/develop' : '/library/$folderId/cull'}
        params={{ folderId: folder.id }}
        title={`${folder.path}\nDouble-click to rename, right-click to rename or export`}
        aria-current={active ? 'page' : undefined}
        onDoubleClick={(e) => {
          e.preventDefault();
          setRenaming(folder.name);
        }}
        onContextMenu={(e) => menu.onContextMenu(e, undefined)}
        className={itemClass(active)}
      >
        <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        <CulledMark folderId={folder.id} />
        {count !== null && <RowCount value={count} id={`folder:${folder.id}`} />}
      </Link>
      {menu.at && (
        <RowMenu
          name={folder.name}
          at={menu.at}
          onClose={menu.close}
          items={[
            { label: 'Rename…', onSelect: () => setRenaming(folder.name) },
            {
              label: `Export “${folder.name}”…`,
              onSelect: () =>
                void exportLibrarySource({ kind: 'folder', id: folder.id }, folder.name, folder.path).catch((err) =>
                  onError(errorMessage(err)),
                ),
            },
          ]}
        />
      )}
    </>
  );
}

/**
 * A project: opens in Design; right-click (plan 43) for Rename and Reveal in Finder. Renaming the open project goes
 * through the book store (the projects store does that), so undo and autosave see it.
 */
function ProjectItem({
  project,
  active,
  open,
  onError,
}: {
  project: ProjectSummary;
  active: boolean;
  /** The project open in the editor. */
  open: boolean;
  onError: (message: string | null) => void;
}) {
  const menu = useContextMenu();
  const [renaming, setRenaming] = useState<string | null>(null);
  const commit = async () => {
    const title = renaming?.trim();
    setRenaming(null);
    if (!title || title === project.title) return;
    try {
      await useProjectsStore.getState().rename(project.id, title);
    } catch (err) {
      onError(errorMessage(err));
    }
  };
  if (renaming !== null) {
    return (
      <Input
        autoFocus
        aria-label={`Rename ${project.title || 'Untitled'}`}
        value={renaming}
        onChange={(e) => setRenaming(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setRenaming(null);
          }
        }}
        className={renameClass}
      />
    );
  }
  return (
    <>
      <Link
        to="/project/$id/design"
        params={{ id: project.id }}
        disabled={project.error !== null}
        title={project.error ?? project.path}
        aria-current={active ? 'page' : undefined}
        onContextMenu={(e) => {
          if (project.error === null) menu.onContextMenu(e, undefined);
          else e.preventDefault();
        }}
        className={itemClass(active)}
      >
        <span className="min-w-0 flex-1 truncate">{project.title || 'Untitled'}</span>
        {open && <span className="size-1.5 shrink-0 rounded-full bg-accent" title="Open" />}
      </Link>
      {menu.at && (
        <RowMenu
          name={project.title || 'Untitled'}
          at={menu.at}
          onClose={menu.close}
          items={[
            { label: 'Rename…', onSelect: () => setRenaming(project.title) },
            {
              label: 'Reveal in Finder',
              onSelect: () =>
                void useProjectsStore
                  .getState()
                  .reveal(project.id)
                  .catch((err) => onError(errorMessage(err))),
            },
          ]}
        />
      )}
    </>
  );
}

/**
 * A saved collection: opens in the stage showing; right-click (or the context-menu key) for Rename and Delete. Deleting
 * the collection on screen goes back to the folder Cull or Develop showed last (Home without one). Deleting removes
 * the filter only, never a photo.
 */
function SavedCollectionItem({
  collection,
  stage,
  active,
  count,
  onError,
}: {
  collection: SavedCollection;
  stage: 'cull' | 'develop';
  active: boolean;
  count: number;
  onError: (message: string | null) => void;
}) {
  const navigate = useNavigate();
  const menu = useContextMenu();
  const [renaming, setRenaming] = useState<string | null>(null);
  /** A rename is being written (Enter then blur must not write twice). */
  const saving = useRef(false);
  const commit = async () => {
    const name = renaming?.trim();
    if (saving.current) return;
    if (!name || name === collection.name) {
      setRenaming(null);
      return;
    }
    // The field stays (with what was typed) until the write lands, and after a failed one.
    saving.current = true;
    try {
      await useCollectionsStore.getState().rename(collection.id, name);
      setRenaming(null);
      onError(null);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      saving.current = false;
    }
  };
  const remove = async () => {
    try {
      await useCollectionsStore.getState().remove(collection.id);
    } catch (err) {
      onError(errorMessage(err));
      return;
    }
    if (!active) return;
    const folderId = useUiStore.getState().libraryFolder;
    if (!folderId) void navigate({ to: '/' });
    else if (stage === 'develop') void navigate({ to: '/library/$folderId/develop', params: { folderId } });
    else void navigate({ to: '/library/$folderId/cull', params: { folderId } });
  };
  if (renaming !== null) {
    return (
      <Input
        autoFocus
        aria-label={`Rename ${collection.name}`}
        value={renaming}
        maxLength={80}
        onChange={(e) => setRenaming(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') {
            e.stopPropagation();
            setRenaming(null);
          }
        }}
        className={renameClass}
      />
    );
  }
  return (
    <>
      <Link
        to={
          stage === 'develop' ? '/library/collection/$collectionId/develop' : '/library/collection/$collectionId/cull'
        }
        params={{ collectionId: collection.id }}
        title={`${collection.name}\nRight-click to rename, export or delete`}
        aria-current={active ? 'page' : undefined}
        onContextMenu={(e) => menu.onContextMenu(e, undefined)}
        className={itemClass(active)}
      >
        <span className="min-w-0 flex-1 truncate">{collection.name}</span>
        <RowCount value={count} id={`saved:${collection.id}`} />
      </Link>
      {menu.at && (
        <RowMenu
          name={collection.name}
          at={menu.at}
          onClose={menu.close}
          items={[
            { label: 'Rename…', onSelect: () => setRenaming(collection.name) },
            {
              // Export… (workflow plan 11): the collection's photos.
              label: 'Export…',
              onSelect: () =>
                void exportLibrarySource(
                  { kind: 'saved', id: collection.id, filter: collection.filter },
                  collection.name,
                ).catch((err) => onError(errorMessage(err))),
            },
            { label: 'Delete', onSelect: () => void remove(), danger: true },
          ]}
        />
      )}
    </>
  );
}

interface RowMenuItem {
  label: string;
  onSelect: () => void;
  /** Drawn in red (Delete). */
  danger?: boolean;
}

/** A sidebar row's right-click menu at the pointer: folders, saved collections and projects (plan 43, on `Menu.Context`). */
function RowMenu({
  name,
  at,
  onClose,
  items,
}: {
  name: string;
  at: { x: number; y: number };
  onClose: () => void;
  items: RowMenuItem[];
}) {
  return (
    <Menu.Context at={at} label={name} onClose={onClose} width={180}>
      {items.map((entry) => (
        <MenuItem key={entry.label} danger={entry.danger} onSelect={entry.onSelect}>
          {entry.label}
        </MenuItem>
      ))}
    </Menu.Context>
  );
}
