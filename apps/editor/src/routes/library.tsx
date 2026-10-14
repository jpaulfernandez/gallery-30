import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { CullStage, keepSelectionWithin } from '../components/cull/CullView';
import { PhotoPane } from '../components/cull/PhotoPane';
import { CopySettingsDialog } from '../components/develop/CopySettingsDialog';
import { DevelopMode } from '../components/develop/DevelopMode';
import { SyncDialog } from '../components/develop/SyncDialog';
import { XmpImportDialog } from '../components/develop/XmpImportDialog';
import { RedoIcon, UndoIcon } from '../components/editor/icons';
import { LibraryFilterBar } from '../components/shell/LibraryFilterBar';
import { PaneShell, useCullPaneKeys } from '../components/shell/Panes';
import { ProjectMenu } from '../components/shell/ProjectMenu';
import { SaveCollectionButton } from '../components/shell/SaveCollectionButton';
import { SaveIndicator } from '../components/shell/SaveIndicator';
import { Sidebar, type SidebarCurrent } from '../components/shell/Sidebar';
import { type Stage, StageTabs } from '../components/shell/StageTabs';
import { useLibraryFolders } from '../components/shell/useLibraryFolders';
import { buttonClass, IconButton } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { errorMessage } from '../lib/errors';
import { devLog } from '../lib/log';
import { addToProject } from '../store/assets';
import { redo, undo, useBookStore, useHistoryAvailability } from '../store/book';
import {
  COLLECTIONS,
  isCollectionId,
  isoKnown,
  type LibrarySource,
  libraryKeys,
  noiseSignature,
  projectPaths,
  sourceFolders,
  usableSignature,
  useCollectionsStore,
} from '../store/collections';
import { useDenoisePrefs } from '../store/denoisePrefs';
import { parsePhotoKey, useLibraryStore } from '../store/library';
import { developFilter, useUiStore } from '../store/ui';

/** The Cull stage over a folder or a collection (`/library/$folderId/cull`, `/library/collection/$collectionId/cull`). */
export function LibraryCullRoute() {
  return <LibraryStage stage="cull" />;
}

/** The Develop stage over a folder or a collection, no project needed. */
export function LibraryDevelopRoute() {
  return <LibraryStage stage="develop" />;
}

/**
 * The source in the URL: a folder id, a built-in collection id or a saved collection's id (the route guards checked
 * them; a saved collection deleted meanwhile matches nothing).
 */
function useSource(): LibrarySource {
  const params = useParams({ strict: false }) as { folderId?: string; collectionId?: string };
  const collection = params.collectionId;
  const saved = useCollectionsStore((s) =>
    collection !== undefined ? s.saved.find((c) => c.id === collection) : undefined,
  );
  if (collection !== undefined && isCollectionId(collection)) return { kind: 'collection', id: collection };
  if (collection !== undefined) {
    return {
      kind: 'saved',
      id: collection,
      filter: saved?.filter ?? { folders: [''], flag: 'all', minRating: 0, query: '' },
    };
  }
  return { kind: 'folder', id: params.folderId ?? '' };
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Cull or Develop over the library (workflow plan 05): the Library sidebar, the top bar with the stage tabs, the
 * library filters, and the Cull grid and Review (workflow plan 06, `CullView`) or the Develop view rendered in place
 * over the source's photos (library keys). The selection (`ui.selection`) stays within the list shown; with a project
 * open the filter bar offers *Add N to project* for it, and *Save as collection…* saves what is shown. The source's folders are scanned (the index makes a known folder instant) and their libraries loaded; ratings,
 * flags and edits go to the folder libraries, so a project made later finds them. The photo list is fixed while the
 * filters and the set of scanned photos stay the same, so rating a photo out of a filter does not reshuffle it.
 */
function LibraryStage({ stage }: { stage: 'cull' | 'develop' }) {
  const source = useSource();
  const sourceKey = `${source.kind}:${source.id}:${source.kind === 'saved' ? JSON.stringify(source.filter) : ''}`;
  const selected = useUiStore((s) => s.selection.keys.length);
  const iso = useLibraryStore((s) => isoKnown(s.folders));
  const navigate = useNavigate();
  const registry = useLibraryFolders();
  const view = useUiStore((s) => s.libraryView);
  const loaded = useBookStore((s) => Object.keys(s.libraries).sort().join('\n'));
  const projectOpen = useBookStore((s) => s.book !== null);
  // What "in the project" means for Hide in project, as a string: the list must not follow every edit of the project.
  const inProject = useBookStore((s) =>
    view.hideUsed && s.book ? [...projectPaths(s.book, s.folder)].sort().join('\n') : '',
  );
  const signature = useLibraryStore((s) => usableSignature(sourceFolders(source, s.folders)));
  // Plan 27: Needs denoise follows Settings → Models' thresholds and new noise measurements.
  const denoiseThresholds = useDenoisePrefs((s) => `${s.iso}:${s.amount}`);
  const needsDenoiseKey = useLibraryStore((s) =>
    source.kind === 'collection' && source.id === 'needs-denoise'
      ? `${noiseSignature(sourceFolders(source, s.folders))}|${denoiseThresholds}`
      : '',
  );
  const progress = useLibraryStore((s) => {
    let busy = false;
    let done = 0;
    let total = 0;
    for (const f of sourceFolders(source, s.folders)) {
      busy ||= f.busy;
      done += f.progress.prepared;
      total += f.progress.total;
    }
    return busy ? `${done}/${total}` : null;
  });
  const session = useUiStore((s) => (stage === 'cull' ? s.review : s.develop));
  const hasSession = session !== null;
  // Plan 51: Tab / Shift+Tab hide Cull's panes (the Develop view has its own keys and panes).
  useCullPaneKeys(stage === 'cull');

  // A folder is scanned (the index makes a known one instant). A collection scans nothing: its members come from the
  // folder indexes, and only they get thumbnails (below), so opening Kept never hashes every imported folder.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the source, not its object
  useEffect(() => {
    if (source.kind !== 'folder') return;
    const library = useLibraryStore.getState();
    if (library.folders[source.id]) void library.scan(source.id).catch(() => {});
    useUiStore.getState().setLibraryPlace(source.id);
  }, [sourceKey, registry]);

  // The photo list: recomputed for a new source, filter, scan result or library load, never for a rating.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature`, `loaded` and `needsDenoiseKey` stand for the store reads below
  const keys = useMemo(() => {
    const { folders } = useLibraryStore.getState();
    const { libraries, book, folder } = useBookStore.getState();
    // Develop hides rejects at *All flags* (`developFilter`).
    const filter = stage === 'develop' ? developFilter(view) : view;
    return libraryKeys(source, folders, libraries, filter, { book, primary: folder });
  }, [sourceKey, signature, loaded, view, inProject, stage, needsDenoiseKey]);

  // A collection's members that only the index knows get their thumbnails, folder by folder.
  useEffect(() => {
    if (source.kind !== 'collection') return;
    const library = useLibraryStore.getState();
    const byFolder = new Map<string, string[]>();
    for (const key of keys) {
      const parsed = parsePhotoKey(key);
      const photo = parsed ? library.folders[parsed.folder]?.photos[parsed.path] : undefined;
      if (!parsed || photo?.status !== 'scanned') continue;
      byFolder.set(parsed.folder, [...(byFolder.get(parsed.folder) ?? []), parsed.path]);
    }
    for (const [id, relPaths] of byFolder) void library.prepare(id, relPaths);
  }, [keys, source.kind]);

  // The selection never reaches a photo the list does not show (another source, a narrower filter).
  useEffect(() => keepSelectionWithin(keys), [keys]);

  // Keep the session on the list, on the photo it shows (or the one the other stage showed last).
  useEffect(() => {
    const ui = useUiStore.getState();
    const now = stage === 'cull' ? ui.review : ui.develop;
    if (keys.length === 0) {
      if (now && stage === 'cull') ui.closeReview();
      else if (now) ui.closeDevelop();
      return;
    }
    if (now && hasSession && sameIds(now.ids, keys)) return;
    const shown = now?.ids[now.index] ?? ui.libraryPhoto;
    const at = Math.max(shown ? keys.indexOf(shown) : 0, 0);
    if (now) ui.updateSessionIds(stage === 'cull' ? 'review' : 'develop', keys, at);
    else if (stage === 'cull') ui.openReview(keys, at);
    else ui.openDevelop(keys, at);
  }, [keys, stage, hasSession]);

  // Remember the photo shown, so the other stage (and coming back) opens on it.
  useEffect(() => {
    const id = session?.ids[session.index];
    if (id) useUiStore.getState().setLibraryPlace(source.kind === 'folder' ? source.id : null, id);
  }, [session, source]);

  // Leaving the stage ends its session (the editor's own Review and Develop open over the project's photos).
  useEffect(
    () => () => {
      const ui = useUiStore.getState();
      if (stage === 'cull') ui.closeReview();
      else ui.closeDevelop();
    },
    [stage],
  );

  const toDevelop = (id: string) => {
    useUiStore.getState().setLibraryPlace(source.kind === 'folder' ? source.id : null, id);
    if (source.kind === 'folder') void navigate({ to: '/library/$folderId/develop', params: { folderId: source.id } });
    else void navigate({ to: '/library/collection/$collectionId/develop', params: { collectionId: source.id } });
  };

  const savedName = useCollectionsStore((s) => s.saved.find((c) => c.id === source.id)?.name);
  const sourceName =
    source.kind === 'folder'
      ? (registry.find((f) => f.id === source.id)?.name ?? 'Folder')
      : source.kind === 'saved'
        ? (savedName ?? 'Collection')
        : (COLLECTIONS.find((c) => c.id === source.id)?.name ?? 'Collection');
  const empty = progress
    ? 'Scanning…'
    : signature.endsWith(':0') || signature === ''
      ? source.kind === 'folder'
        ? 'No photos in this folder'
        : `No photos in ${sourceName} yet`
      : 'No photos match these filters';

  return (
    // Plan 51: Cull's left pane is the Library sidebar with its Filters; Develop's (Looks, History) is the Develop view's.
    <>
      <PaneShell
        stage={stage}
        top={<LibraryTopBar stage={stage} source={source} />}
        left={stage === 'cull' ? <Sidebar current={sidebarCurrent(source)} stage={stage} /> : undefined}
        right={stage === 'cull' ? <PhotoPane /> : undefined}
      >
        <main aria-label={`${stage === 'cull' ? 'Cull' : 'Develop'}: ${sourceName}`} className="flex min-h-0 flex-col">
          <LibraryFilterBar
            count={keys.length}
            progress={progress}
            projectOpen={projectOpen}
            selected={selected}
            isoKnown={iso}
            rejectsHidden={stage === 'develop'}
            filtersInSidebar={stage === 'cull'}
          >
            <SaveCollectionButton source={source} stage={stage} />
            {projectOpen && selected > 0 && <AddSelectedButton count={selected} />}
          </LibraryFilterBar>
          <div className="relative min-h-0 flex-1">
            {keys.length === 0 ? (
              progress ? (
                <p className="p-8 text-center text-fg-muted text-xs">{empty}</p>
              ) : (
                <EmptyState className="p-8">{empty}</EmptyState>
              )
            ) : stage === 'cull' ? (
              <CullStage sourceKey={sourceKey} onDevelop={toDevelop} />
            ) : (
              <DevelopMode inline />
            )}
          </div>
        </main>
      </PaneShell>
      {stage === 'develop' && (
        <>
          <SyncDialog />
          <XmpImportDialog />
        </>
      )}
      {/* Both stages copy settings (Shift+Cmd+Alt+C, the Cull grid's menu). */}
      <CopySettingsDialog />
    </>
  );
}

/** *Add N to project*: the selected library photos join the open project (`addToProject`; ones in it keep their asset). */
export function AddSelectedButton({ count }: { count: number }) {
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const ids = await addToProject(useUiStore.getState().selection.keys);
      devLog('assets', 'selection added to project', { photos: ids.filter(Boolean).length });
    } catch (err) {
      useUiStore.getState().setSaveStatus('error', `Not added: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void add()}
      title="Add the selected photos to the open project"
      className="rounded-md border border-accent bg-accent/15 px-1.5 py-1 text-fg outline-none hover:bg-accent/25 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
    >
      {busy ? 'Adding…' : `Add ${count} to project`}
    </button>
  );
}

/**
 * The library stages' top bar: Project ▾, the stage tabs, undo and redo, Settings. The project's Cull passes
 * `projectId` so its Cull tab stays on the project.
 */
export function LibraryTopBar({
  stage,
  source,
  projectId,
}: {
  stage: Stage;
  source?: LibrarySource;
  projectId?: string;
}) {
  const title = useBookStore((s) => s.book?.title);
  const { canUndo, canRedo } = useHistoryAvailability();
  return (
    // Plan 43: the window drags from anywhere in the bar except its controls (buttons, links and fields block the
    // drag); the traffic lights sit in the 78 px inset.
    <header
      data-tauri-drag-region="deep"
      className="col-span-2 grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-hairline border-b bg-panel-2 pr-3 pl-[78px]"
    >
      <div className="flex min-w-0 items-center gap-1 text-xs">
        <ProjectMenu />
        {title !== undefined && <span className="truncate text-fg-muted">{title || 'Untitled'}</span>}
      </div>
      <StageTabs stage={stage} source={source} projectCull={projectId} />
      <div className="flex items-center justify-end gap-1 text-xs">
        <IconButton icon={<UndoIcon />} label="Undo" shortcut="⌘Z" onClick={undo} disabled={!canUndo} />
        <IconButton icon={<RedoIcon />} label="Redo" shortcut="⇧⌘Z" onClick={redo} disabled={!canRedo} />
        {/* Plan 45: "Saved" fades in after a write; a failed one stays as "Not saved", the reason on hover. */}
        <SaveIndicator className="ml-2" />
        <Link to="/settings" className={`${buttonClass({ variant: 'ghost', size: 'sm' })} ml-1`}>
          Settings
        </Link>
      </div>
    </header>
  );
}

/** The sidebar item a source marks. */
function sidebarCurrent(source: LibrarySource): SidebarCurrent {
  return source.kind === 'saved' ? { kind: 'saved', id: source.id } : source;
}
