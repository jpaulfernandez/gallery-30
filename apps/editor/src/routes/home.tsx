import {
  BOOK_TEMPLATES,
  type BookTemplateName,
  DEFAULT_TEMPLATE,
  type Library,
  type ResolveImage,
} from '@photobook/shared';
import { Link, useLoaderData, useNavigate } from '@tanstack/react-router';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { MoreIcon } from '../components/editor/icons';
import { type CoverSnapshot, ProjectCover, sharedCacheRoot, useProjectCover } from '../components/home/ProjectCover';
import { ensureLibrary } from '../components/shell/useLibraryFolders';
import { Button, buttonClass, focusRing } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Select } from '../components/ui/Field';
import { Menu, MenuItem, MenuSeparator, useContextMenu } from '../components/ui/Menu';
import { Tag } from '../components/ui/Tag';
import { errorMessage } from '../lib/errors';
import { devError } from '../lib/log';
import type { Folder, ProjectSummary } from '../lib/tauri';
import { type AddChoice, addFolderPhotos } from '../store/assets';
import { useBookStore } from '../store/book';
import { folderCulled, folderUndecided } from '../store/decide';
import { useFoldersStore } from '../store/folders';
import { type LibraryFolder, useLibraryStore } from '../store/library';
import { useProjectsStore } from '../store/projects';

/**
 * Home (workflow plans 04, 05; laid out by plan 50, ODDHALLS_LAYOUT_PLAN 1): a top bar with the wordmark (the window
 * drags from it), then the Start row (Open a folder…, New project…, Open project file…), the recent projects as cover
 * cards and the recent folders as rows with their cull state. With neither, one serif line says where to start. A
 * folder opens in Cull or Develop (no project needed); a project opens in Design.
 */
export function HomeRoute() {
  const { error: launchError } = useLoaderData({ from: '/' });
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(launchError);
  const [creating, setCreating] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const folders = useFoldersStore((s) => s.folders);
  // Kept ready like the sidebar's (index read, library loaded), so the rows can count and show the cull state.
  useFolderIndexes(folders);
  const projects = useProjectsStore((s) => s.projects);
  const culls = useFolderCulls(folders);

  // A project route that could not open its project redirects here with the reason.
  useEffect(() => {
    if (launchError) setError(launchError);
  }, [launchError]);

  useEffect(() => {
    // Folders first: a folder imported elsewhere may have brought a legacy book in as a project.
    void (async () => {
      try {
        await useFoldersStore.getState().load();
        await useProjectsStore.getState().load();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  /** Run an action, showing its error; the busy flag disables every button meanwhile. */
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const openProject = (id: string) => run(() => navigate({ to: '/project/$id/design', params: { id } }));

  async function openFolder(folder: Folder, stage: FolderStage) {
    await run(() =>
      stage === 'develop'
        ? navigate({ to: '/library/$folderId/develop', params: { folderId: folder.id } })
        : navigate({ to: '/library/$folderId/cull', params: { folderId: folder.id } }),
    );
  }

  async function importFolder() {
    await run(async () => {
      const folder = await useFoldersStore.getState().import();
      // Importing turns a legacy book.photobook.json in the folder into a project.
      if (folder) await useProjectsStore.getState().load();
    });
  }

  /** Open a folder…: import the picked folder (or find it imported) and show it in Cull. */
  async function openNewFolder() {
    await run(async () => {
      const folder = await useFoldersStore.getState().import();
      if (!folder) return;
      await useProjectsStore.getState().load();
      await navigate({ to: '/library/$folderId/cull', params: { folderId: folder.id } });
    });
  }

  async function openProjectFile() {
    const path = await open({
      multiple: false,
      directory: false,
      title: 'Open a project file',
      filters: [{ name: 'Photobook project', extensions: ['json'] }],
    });
    if (typeof path !== 'string') return;
    await run(async () => {
      const project = await useProjectsStore.getState().openFile(path);
      await navigate({ to: '/project/$id/design', params: { id: project.id } });
    });
  }

  async function deleteProject(project: ProjectSummary) {
    const where = project.external ? project.path : 'the app';
    const confirmed = await ask(
      `Move “${project.title || 'Untitled'}” to the Trash?\n\nThe project file (from ${where}) goes to the Trash, where you can restore it. Photos, edits and the published book are not touched.`,
      { title: 'Delete project', kind: 'warning', okLabel: 'Move to Trash', cancelLabel: 'Cancel' },
    );
    if (confirmed) await run(() => useProjectsStore.getState().remove(project.id));
  }

  const empty = loaded && projects.length === 0 && folders.length === 0;

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* Plan 50: a real bar (plan 43's strip painted over scrolled content); the window drags from anywhere in it
          except its controls, and the traffic lights sit in the 78 px inset. */}
      <header
        data-tauri-drag-region="deep"
        className="flex h-11 shrink-0 items-center justify-between gap-4 border-hairline border-b bg-panel-2 pr-3 pl-[78px]"
      >
        <span className="font-['Instrument_Serif'] text-fg text-xl italic leading-none tracking-tight">oddhalls</span>
        <Link to="/settings" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
          Settings
        </Link>
      </header>

      <main className="scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-10 px-8 py-8">
          <StartRow
            disabled={busy}
            onOpenFolder={() => void openNewFolder()}
            onNew={() => setCreating(true)}
            onOpenFile={() => void openProjectFile()}
          />

          {error && (
            <p role="alert" className="whitespace-pre-wrap text-danger text-xs">
              {error}
            </p>
          )}

          {empty && <EmptyLine />}

          {projects.length > 0 && (
            <ProjectCards
              projects={projects}
              disabled={busy}
              onOpen={(p) => openProject(p.id)}
              onRename={(p, title) => run(() => useProjectsStore.getState().rename(p.id, title))}
              onReveal={(p) => run(() => useProjectsStore.getState().reveal(p.id))}
              onDelete={(p) => void deleteProject(p)}
            />
          )}

          {folders.length > 0 && (
            <FolderRows
              folders={folders}
              culls={culls}
              disabled={busy}
              onOpen={(folder, stage) => void openFolder(folder, stage)}
              onRemove={(folder) => run(() => useFoldersStore.getState().remove(folder.id))}
            />
          )}
        </div>
      </main>

      {creating && (
        <NewProjectDialog
          folders={folders}
          onImport={importFolder}
          onCancel={() => setCreating(false)}
          onCreate={({ add, ...project }) =>
            run(async () => {
              const id = await useBookStore.getState().createProject(project);
              setCreating(false);
              // The folder's photos join once it is scanned (the Design stage scans it too; the scans are one).
              void addFolderPhotos(project.folderId, add).catch((err) =>
                devError('assets', `photos of the new project not added (${add})`, err),
              );
              await navigate({ to: '/project/$id/design', params: { id } });
            })
          }
          disabled={busy}
        />
      )}
    </div>
  );
}

/** How many projects and folders show before *See all*. */
export const RECENT = 4;

/** The three ways in: a folder for Cull and Develop (the primary one), a project for Design. */
export function StartRow({
  disabled,
  onOpenFolder,
  onNew,
  onOpenFile,
}: {
  disabled: boolean;
  onOpenFolder: () => void;
  onNew: () => void;
  onOpenFile: () => void;
}) {
  return (
    <section aria-labelledby="start-heading" className="flex flex-col gap-3">
      <h2 id="start-heading" className="section-title">
        Start
      </h2>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={disabled} onClick={onOpenFolder}>
          Open a folder…
        </Button>
        <Button disabled={disabled} onClick={onNew}>
          New project…
        </Button>
        <Button disabled={disabled} onClick={onOpenFile}>
          Open project file…
        </Button>
      </div>
    </section>
  );
}

/** Home with no project and no folder: the Start row and this one line. */
export function EmptyLine() {
  return (
    <EmptyState className="items-start text-left">
      Open a folder to start culling, or make a project to design.
    </EmptyState>
  );
}

/** A section's heading row with *See all* / *Show fewer* when it holds more than `RECENT`. */
function SectionHead({
  id,
  title,
  count,
  all,
  onToggle,
}: {
  id: string;
  title: string;
  count: number;
  all: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex h-6 items-center justify-between gap-2">
      <h2 id={id} className="section-title">
        {title}
      </h2>
      {count > RECENT && (
        <Button variant="ghost" size="sm" aria-expanded={all} onClick={onToggle}>
          {all ? 'Show fewer' : `See all ${count}`}
        </Button>
      )}
    </div>
  );
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. Empty for an unknown time. */
export function editedAgo(ms: number, now = Date.now()): string {
  if (!ms) return '';
  const s = Math.max(0, now - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
  return dateFormat.format(ms);
}

/** "24 pages · edited 2 d ago" (the page count once the cover is read). */
function projectMeta(project: ProjectSummary, snapshot: CoverSnapshot | null | undefined): string {
  const parts: string[] = [];
  if (snapshot) parts.push(`${snapshot.pageCount} ${snapshot.pageCount === 1 ? 'page' : 'pages'}`);
  const ago = editedAgo(project.updatedAt);
  if (ago) parts.push(`edited ${ago}`);
  return parts.join(' · ');
}

interface ProjectActions {
  disabled: boolean;
  onOpen: (project: ProjectSummary) => void;
  onRename: (project: ProjectSummary, title: string) => void;
  onReveal: (project: ProjectSummary) => void;
  onDelete: (project: ProjectSummary) => void;
}

/**
 * Recent projects as cover cards, last opened first: four, *See all* expands in place. `covers` and `resolve` draw
 * given covers instead of reading the projects (the kitchen sink).
 */
export function ProjectCards({
  projects,
  covers,
  resolve,
  ...actions
}: ProjectActions & {
  projects: ProjectSummary[];
  covers?: Record<string, CoverSnapshot | null>;
  resolve?: ResolveImage;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? projects : projects.slice(0, RECENT);
  // Every project's thumbnails live in the one `<appdata>/cache`: a project whose cover photo has none yet still finds it.
  const root = useMemo(() => sharedCacheRoot(projects), [projects]);
  return (
    <section aria-labelledby="projects-heading" className="flex flex-col gap-3">
      <SectionHead
        id="projects-heading"
        title="Recent projects"
        count={projects.length}
        all={all}
        onToggle={() => setAll((a) => !a)}
      />
      <ul className="grid grid-cols-[repeat(auto-fill,10rem)] gap-x-6 gap-y-6">
        {shown.map((project) =>
          covers ? (
            <ProjectCard
              key={project.id}
              project={project}
              snapshot={covers[project.id]}
              resolve={resolve}
              {...actions}
            />
          ) : (
            <LiveProjectCard key={project.id} project={project} root={root} {...actions} />
          ),
        )}
      </ul>
    </section>
  );
}

/** A card whose cover is read from the project file (cached per id + modified time). */
function LiveProjectCard({
  project,
  root,
  ...actions
}: ProjectActions & { project: ProjectSummary; root: string | null }) {
  const snapshot = useProjectCover(project, root);
  return <ProjectCard project={project} snapshot={snapshot} {...actions} />;
}

/**
 * One cover card: the cover opens the project in Design (the focus ring on the card chrome, never on the photo); title,
 * page count and when it was edited under it; the ⋯ menu holds Rename, Reveal in Finder and Delete. A project that
 * cannot be read says why and can only be revealed or deleted.
 */
function ProjectCard({
  project,
  snapshot,
  resolve,
  disabled,
  onOpen,
  onRename,
  onReveal,
  onDelete,
}: ProjectActions & {
  project: ProjectSummary;
  snapshot: CoverSnapshot | null | undefined;
  resolve?: ResolveImage;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const title = project.title || 'Untitled';
  const commit = () => {
    const next = renaming?.trim();
    if (next && next !== project.title) onRename(project, next);
    setRenaming(null);
  };
  return (
    <li className="flex w-40 min-w-0 flex-col gap-2">
      <button
        type="button"
        disabled={disabled || project.error !== null}
        onClick={() => onOpen(project)}
        aria-label={`Open ${title}`}
        title={project.error ?? project.path}
        className={`rounded-md transition-[translate,box-shadow] duration-fast ease-out hover:-translate-y-0.5 hover:shadow-raised disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none ${focusRing} focus-visible:ring-offset-canvas`}
      >
        <ProjectCover snapshot={snapshot} resolve={resolve} />
      </button>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex h-6 min-w-0 items-center gap-1">
          {renaming !== null ? (
            <Input
              autoFocus
              aria-label="Project title"
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setRenaming(null);
              }}
              className="min-w-0 flex-1"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{title}</span>
          )}
          <Menu
            label={<MoreIcon />}
            ariaLabel={`More actions for ${title}`}
            menuLabel={title}
            disabled={disabled}
            alignEnd
            width={200}
          >
            <MenuItem disabled={project.error !== null} onSelect={() => setRenaming(project.title)}>
              Rename…
            </MenuItem>
            <MenuItem onSelect={() => onReveal(project)}>Reveal in Finder</MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={() => onDelete(project)} title="Move the project to the Trash">
              Delete…
            </MenuItem>
          </Menu>
        </div>
        <span
          className={`block truncate text-[11px] tabular-nums ${project.error ? 'text-danger' : 'text-fg-muted'}`}
          title={project.error ?? undefined}
        >
          {project.error ?? projectMeta(project, snapshot)}
        </span>
      </div>
    </li>
  );
}

export type FolderStage = 'cull' | 'develop';

/** A folder row's count and cull state (plan 40): photos, kept, undecided, culled ✓. */
export interface FolderCull {
  photos: number;
  kept: number;
  undecided: number;
  culled: boolean;
}

/**
 * The cull state of a folder known to the library store (its index read) from its library: null until its photos and
 * its library are known (so a row never shows every photo undecided while the library loads). Kept are the picks; culled is plan 40's `culledAt` with no undecided photo left (`folderCulled`).
 */
export function folderCull(
  folder: LibraryFolder | undefined,
  libraries: Readonly<Record<string, Library>>,
): FolderCull | null {
  if (!folder) return null;
  const photos = Object.keys(folder.photos).length;
  if (photos === 0) return null;
  const library = libraries[folder.path];
  if (!library) return null;
  let kept = 0;
  for (const photo of Object.values(folder.photos)) {
    if (photo.hash !== undefined && Object.hasOwn(library.photos, photo.hash)) {
      if (library.photos[photo.hash]?.flag === 'pick') kept += 1;
    }
  }
  return {
    photos,
    kept,
    undecided: folderUndecided(folder, library).undecided,
    culled: folderCulled(folder, libraries),
  };
}

/**
 * Each folder on disk known to the library store with its index read and its library loaded, as the sidebar's
 * `useLibraryFolders` does; Home reads the registry itself (before the projects), so it is not read twice.
 */
function useFolderIndexes(folders: Folder[]): void {
  const loadedLibraries = useBookStore((s) => Object.keys(s.libraries).sort().join('\n'));
  // biome-ignore lint/correctness/useExhaustiveDependencies: a library dropped from the store (project switch) loads again
  useEffect(() => {
    const library = useLibraryStore.getState();
    for (const folder of folders) {
      if (folder.missing) continue;
      library.addFolder(folder.id, folder.path);
      void library.loadIndex(folder.id);
      ensureLibrary(folder.path);
    }
  }, [folders, loadedLibraries]);
}

/** Every listed folder's cull state, following the index reads and the loaded libraries. */
function useFolderCulls(folders: Folder[]): Record<string, FolderCull | null> {
  const known = useLibraryStore((s) => s.folders);
  const libraries = useBookStore((s) => s.libraries);
  return useMemo(() => {
    const out: Record<string, FolderCull | null> = {};
    for (const f of folders) out[f.id] = f.missing ? null : folderCull(known[f.id], libraries);
    return out;
  }, [folders, known, libraries]);
}

/** Recent first: last seen on disk, then last imported (a missing folder sinks). */
export function recentFolders(folders: Folder[]): Folder[] {
  return [...folders].sort((a, b) => b.lastSeen - a.lastSeen || b.addedAt - a.addedAt);
}

function CullLine({ cull }: { cull: FolderCull | null }) {
  // An empty cell keeps the row's columns while the index is read (or for a folder with no photos).
  if (!cull) return <span />;
  const parts = [`${cull.photos} ${cull.photos === 1 ? 'photo' : 'photos'}`];
  if (cull.kept > 0) parts.push(`${cull.kept} kept`);
  if (!cull.culled && cull.undecided > 0) parts.push(`${cull.undecided} undecided`);
  return (
    <span className="truncate text-fg-muted text-xs tabular-nums">
      {parts.join(' · ')}
      {cull.culled && (
        <>
          {' · '}
          <span className="text-ok" title="Culled: every photo kept or rejected">
            culled ✓
          </span>
        </>
      )}
    </span>
  );
}

/**
 * Recent folders as rows (a folder has no cover): name, count and cull state, then Cull and Develop. A missing folder
 * shows the red *Missing* and no buttons. Right-click a row to remove it from the list (its files stay on disk).
 */
export function FolderRows({
  folders,
  culls,
  disabled,
  onOpen,
  onRemove,
}: {
  folders: Folder[];
  culls: Record<string, FolderCull | null>;
  disabled: boolean;
  onOpen: (folder: Folder, stage: FolderStage) => void;
  onRemove: (folder: Folder) => void;
}) {
  const [all, setAll] = useState(false);
  const menu = useContextMenu<Folder>();
  const sorted = recentFolders(folders);
  const shown = all ? sorted : sorted.slice(0, RECENT);
  return (
    <section aria-labelledby="folders-heading" className="flex flex-col gap-2">
      <SectionHead
        id="folders-heading"
        title="Recent folders"
        count={folders.length}
        all={all}
        onToggle={() => setAll((a) => !a)}
      />
      <ul className="flex flex-col">
        {shown.map((folder) => (
          <li
            key={folder.id}
            data-folder={folder.id}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focus lets the context-menu key (or Shift+F10) open Remove from the list without a pointer
            tabIndex={0}
            aria-label={folder.missing ? `${folder.name}, missing` : folder.name}
            onContextMenu={(e) => menu.onContextMenu(e, folder)}
            title={folder.missing ? `${folder.path} is not on disk right now` : folder.path}
            className={`grid h-10 grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto] items-center gap-4 rounded-sm border-hairline border-b px-1 last:border-b-0 ${focusRing} focus-visible:ring-offset-canvas`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <FolderGlyph />
              <span className={`truncate text-[13px] ${folder.missing ? 'text-fg-muted' : 'text-fg'}`}>
                {folder.name}
              </span>
            </span>
            {folder.missing ? (
              <span>
                <Tag tone="danger">Missing</Tag>
              </span>
            ) : (
              <CullLine cull={culls[folder.id] ?? null} />
            )}
            {folder.missing ? (
              <span />
            ) : (
              <span className="flex gap-1">
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => onOpen(folder, 'cull')}
                  aria-label={`Cull ${folder.name}`}
                >
                  Cull
                </Button>
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => onOpen(folder, 'develop')}
                  aria-label={`Develop ${folder.name}`}
                >
                  Develop
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <Menu.Context at={menu.at} label={menu.menu?.data.name ?? 'Folder'} onClose={menu.close} width={200}>
        <MenuItem
          disabled={disabled}
          title="Its files and edits stay on disk"
          onSelect={() => {
            if (menu.menu) onRemove(menu.menu.data);
          }}
        >
          Remove from the list
        </MenuItem>
      </Menu.Context>
    </section>
  );
}

function FolderGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-fg-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3A1 1 0 0 0 2 4.5Z" />
    </svg>
  );
}

/** What the New project dialog offers to add from its folder. */
const ADD_CHOICES: Array<{ value: AddChoice; label: string; hint: string }> = [
  { value: 'all', label: 'All photos', hint: 'Every photo of the folder' },
  { value: 'picks', label: 'Picks only', hint: 'The photos flagged pick in Cull' },
  { value: 'none', label: 'Nothing', hint: 'Add photos later from the Library tab' },
];

/**
 * New project…: title, page size, the imported folder its photos come from (or Import folder…), and what to add from
 * it: all photos, the picks, or nothing (the Design stage's Library tab adds more later, from any folder).
 */
export function NewProjectDialog({
  folders,
  disabled,
  onImport,
  onCancel,
  onCreate,
}: {
  folders: Folder[];
  disabled: boolean;
  onImport: () => Promise<void>;
  onCancel: () => void;
  onCreate: (project: { title: string; template: BookTemplateName; folderId: string; add: AddChoice }) => void;
}) {
  const available = folders.filter((f) => !f.missing);
  const [folderId, setFolderId] = useState<string>(available[0]?.id ?? '');
  const [title, setTitle] = useState<string>('');
  const [template, setTemplate] = useState<BookTemplateName>(DEFAULT_TEMPLATE);
  const [add, setAdd] = useState<AddChoice>('all');
  const titleId = useId();
  const folderSelectId = useId();
  const folder = available.find((f) => f.id === folderId) ?? available[0];

  // A folder imported from here becomes the selection.
  const known = useRef(new Set(folders.map((f) => f.id)));
  useEffect(() => {
    const added = folders.find((f) => !known.current.has(f.id) && !f.missing);
    if (added) setFolderId(added.id);
    known.current = new Set(folders.map((f) => f.id));
  }, [folders]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!folder) return;
    onCreate({ title: title.trim() || folder.name, template, folderId: folder.id, add });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-stage/60 p-6">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${titleId}-heading`}
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        className="flex max-h-full w-[44rem] max-w-full flex-col gap-4 scrollbar overflow-x-hidden overflow-y-auto rounded-lg border border-hairline bg-panel-2 p-5 shadow-float"
      >
        <h2 id={`${titleId}-heading`} className="m-0 font-medium text-[15px]">
          New project
        </h2>

        <label className="flex flex-col gap-1 text-xs" htmlFor={titleId}>
          <span className="section-title">Title</span>
          <Input
            id={titleId}
            autoFocus
            value={title}
            placeholder={folder?.name ?? 'Untitled'}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <div className="flex flex-col gap-1 text-xs">
          <label className="section-title" htmlFor={folderSelectId}>
            Photos from
          </label>
          <div className="flex gap-1.5">
            <Select
              id={folderSelectId}
              value={folder?.id ?? ''}
              onChange={(e) => setFolderId(e.target.value)}
              disabled={available.length === 0}
              className="flex-1"
            >
              {available.length === 0 && <option value="">Import a folder first</option>}
              {available.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} — {f.path}
                </option>
              ))}
            </Select>
            <Button size="sm" disabled={disabled} onClick={() => void onImport()}>
              Import folder…
            </Button>
          </div>
          <span className="text-fg-muted">Ratings and edits live with the folder, shared by every project on it.</span>
        </div>

        <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0 text-xs" disabled={disabled}>
          <legend className="section-title mb-1 p-0">Add to the project</legend>
          <div className="flex flex-wrap gap-3">
            {ADD_CHOICES.map((choice) => (
              <label key={choice.value} className="flex cursor-pointer items-center gap-1.5" title={choice.hint}>
                <input
                  type="radio"
                  name="add"
                  value={choice.value}
                  checked={add === choice.value}
                  onChange={() => setAdd(choice.value)}
                  className="accent-accent"
                />
                {choice.label}
              </label>
            ))}
          </div>
        </fieldset>

        <TemplatePicker value={template} onChange={setTemplate} disabled={disabled} />

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={disabled || !folder}>
            {disabled ? 'Creating…' : 'Create project'}
          </Button>
        </div>
      </form>
    </div>
  );
}

const TEMPLATES = Object.values(BOOK_TEMPLATES).filter((t) => !t.comingSoon);
const SWATCH = 34;

/** Page size for a new project. */
function TemplatePicker({
  value,
  onChange,
  disabled,
}: {
  value: BookTemplateName;
  onChange: (name: BookTemplateName) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={disabled}>
      <legend className="section-title mb-1 p-0">Page size</legend>
      <div className="flex flex-wrap gap-2">
        {TEMPLATES.map((t) => {
          const selected = t.name === value;
          const w = SWATCH * Math.min(1, t.width / t.height);
          const h = SWATCH * Math.min(1, t.height / t.width);
          return (
            <label
              key={t.name}
              className={`flex w-36 cursor-pointer flex-col items-center gap-1.5 rounded-lg border bg-panel p-3 text-center has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                selected ? 'border-accent' : 'border-line hover:border-fg-muted'
              }`}
            >
              <input
                type="radio"
                name="template"
                value={t.name}
                checked={selected}
                onChange={() => onChange(t.name)}
                className="sr-only"
              />
              <span className="flex items-center justify-center" style={{ width: SWATCH, height: SWATCH }}>
                <span
                  aria-hidden="true"
                  className={`block rounded-[2px] ${selected ? 'bg-accent' : 'bg-fg-muted/60'}`}
                  style={{ width: w, height: h }}
                />
              </span>
              <span className="font-medium text-fg text-xs">{t.label}</span>
              <span className="text-[11px] text-fg-muted tabular-nums">{t.ratio}</span>
              <span className="text-[11px] text-fg-muted leading-snug">{t.description}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
