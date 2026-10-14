import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef } from 'react';
import { CullStage, keepSelectionWithin } from '../components/cull/CullView';
import { PhotoPane } from '../components/cull/PhotoPane';
import { CopySettingsDialog } from '../components/develop/CopySettingsDialog';
import { DevelopMode } from '../components/develop/DevelopMode';
import { SyncDialog } from '../components/develop/SyncDialog';
import { XmpImportDialog } from '../components/develop/XmpImportDialog';
import { usedAssetIds, visibleItems } from '../components/filmstrip/visible';
import { LibraryFilterBar } from '../components/shell/LibraryFilterBar';
import { PaneShell, useCullPaneKeys } from '../components/shell/Panes';
import { Sidebar } from '../components/shell/Sidebar';
import { useLibraryFolders } from '../components/shell/useLibraryFolders';
import { EmptyState } from '../components/ui/EmptyState';
import { withViewTransition } from '../lib/viewTransition';
import { useAssetsStore } from '../store/assets';
import { useBookStore } from '../store/book';
import { assetFlag, resolvedAssets } from '../store/library';
import { developFilter, useUiStore } from '../store/ui';
import { LibraryTopBar } from './library';

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * The open project's Cull (`/project/$id/cull`, workflow plan 06): the same grid and Review as the library's Cull over
 * the project's photos (asset ids, so a project version or snapshot applies), with the project's filters (`filmstrip`,
 * shared with the Design stage's Project tab: *Hide used* hides photos already on a page). D opens Develop over it on
 * the same photos (less the rejects at *All flags*, workflow plan 08); closing Develop comes back to the photo it ended on. The list is fixed while the filters and the
 * set of readable files stay the same, so rating a photo out of a filter does not reshuffle it.
 */
export function ProjectCullRoute() {
  const navigate = useNavigate();
  useLibraryFolders();
  const hasBook = useBookStore((s) => s.book !== null);
  const projectId = useBookStore((s) => s.projectId);
  const folder = useBookStore((s) => s.folder);
  const title = useBookStore((s) => s.book?.title);
  const view = useUiStore((s) => s.filmstrip);
  const selected = useUiStore((s) => s.selection.keys.length);
  const developOpen = useUiStore((s) => s.develop !== null);
  const hasSession = useUiStore((s) => s.review !== null);
  // What the list depends on, cheaply (the assets store updates once per prepared photo): how many files there are and
  // how many are readable, and the pages only while *Hide used* reads them.
  const filesKey = useAssetsStore((s) => filesSignature(s.files));
  const usedKey = useBookStore((s) => (view.hideUsed ? s.book?.pages : null));
  const progress = useAssetsStore((s) => (s.busy ? `${s.progress.prepared}/${s.progress.total}` : null));
  /** The photo Review or Develop showed last, where the grid comes back to. */
  const shown = useRef<string | null>(null);
  // Plan 51: Tab / Shift+Tab hide Cull's panes (Develop over it has its own).
  useCullPaneKeys();

  // Attach the project (as Design does): its folders are scanned and its assets relinked and filled in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another project on the same folder scans again
  useEffect(() => {
    if (folder) void useAssetsStore.getState().scan(folder);
  }, [folder, projectId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `filesKey` and `usedKey` stand for the store reads below
  const ids = useMemo(() => {
    const { files } = useAssetsStore.getState();
    const state = useBookStore.getState();
    const used = usedAssetIds(state.book?.pages ?? []);
    return visibleItems(files, {}, resolvedAssets(state) ?? {}, used, view).flatMap((item) =>
      item.kind === 'file' && item.file.status !== 'error' ? [item.file.assetId] : [],
    );
  }, [filesKey, usedKey, view]);

  useEffect(() => keepSelectionWithin(ids), [ids]);

  // Keep the review session on the list (Develop, while open, holds its own session over the same photos).
  useEffect(() => {
    const ui = useUiStore.getState();
    if (developOpen) return;
    if (ids.length === 0) {
      if (ui.review) ui.closeReview();
      return;
    }
    const now = ui.review;
    if (now && hasSession && sameIds(now.ids, ids)) return;
    const current = now?.ids[now.index] ?? shown.current;
    const at = Math.max(current ? ids.indexOf(current) : 0, 0);
    if (now) ui.updateSessionIds('review', ids, at);
    else ui.openReview(ids, at);
  }, [ids, hasSession, developOpen]);

  // Remember the photo shown by Review or Develop.
  useEffect(
    () =>
      useUiStore.subscribe((s) => {
        const session = s.develop ?? s.review;
        const id = session?.ids[session.index];
        if (id) shown.current = id;
      }),
    [],
  );

  // The Project menu's Close project: back Home.
  useEffect(() => {
    if (!hasBook) void navigate({ to: '/' });
  }, [hasBook, navigate]);

  // Leaving the stage ends its sessions.
  useEffect(
    () => () => {
      const ui = useUiStore.getState();
      ui.closeReview();
      ui.closeDevelop();
    },
    [],
  );

  if (!hasBook || !projectId) return null;

  const toDevelop = (id: string) => {
    const ui = useUiStore.getState();
    // Develop hides rejects at *All flags* (`developFilter`), except the photo it opens on.
    const state = useBookStore.getState();
    const hide = developFilter(view).flag !== view.flag;
    const list = (ui.review?.ids ?? ids).filter(
      (other) => !hide || other === id || assetFlag(state, other) !== 'reject',
    );
    // Plan 49: Develop opens over the project's Cull as a stage change (the crossfade, the picture kept).
    withViewTransition(() => ui.openDevelop(list, Math.max(list.indexOf(id), 0)));
  };

  const empty = progress
    ? 'Scanning…'
    : filesKey === '0:0'
      ? 'No photos in this project yet'
      : 'No photos match these filters';

  return (
    <>
      <PaneShell
        stage="cull"
        top={<LibraryTopBar stage="cull" projectId={projectId} />}
        left={<Sidebar current={{ kind: 'project', id: projectId }} stage="cull" />}
        right={<PhotoPane />}
      >
        <main aria-label={`Cull: ${title || 'Untitled'}`} className="flex min-h-0 flex-col">
          <LibraryFilterBar
            count={ids.length}
            progress={progress}
            projectOpen
            scope="project"
            selected={selected}
            filtersInSidebar
          />
          <div className="relative min-h-0 flex-1">
            {ids.length === 0 ? (
              progress ? (
                <p className="p-8 text-center text-fg-muted text-xs">{empty}</p>
              ) : (
                <EmptyState className="p-8">{empty}</EmptyState>
              )
            ) : developOpen ? null : (
              <CullStage sourceKey={`project:${projectId}`} onDevelop={toDevelop} />
            )}
          </div>
        </main>
      </PaneShell>
      <DevelopMode />
      <SyncDialog />
      <CopySettingsDialog />
      <XmpImportDialog />
    </>
  );
}

/** `readable:total` of the project's files: changes when a file joins, leaves or fails, not when a thumbnail lands. */
function filesSignature(files: Record<string, { status: string }>): string {
  let total = 0;
  let readable = 0;
  for (const key in files) {
    total += 1;
    if (files[key]?.status !== 'error') readable += 1;
  }
  return `${readable}:${total}`;
}
