import { BOOK_OUTPUT_ID, hasOutput } from '@photobook/shared';
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  isRedirect,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { errorMessage } from './lib/errors';
import { devLog } from './lib/log';
import { getRecent, listFolders } from './lib/tauri';
import { isStageChange } from './lib/viewTransition';
import { BookRoute } from './routes/book';
import { DownloadsRoute } from './routes/downloads';
import { FixtureRoute } from './routes/fixture';
import { HomeRoute } from './routes/home';
import { LibraryCullRoute, LibraryDevelopRoute } from './routes/library';
import { PreviewRoute } from './routes/preview';
import { ProjectCullRoute } from './routes/projectCull';
import { SettingsRoute } from './routes/settings';
import { useBookStore } from './store/book';
import { isCollectionId, savedCollection, useCollectionsStore } from './store/collections';
import { useLibraryStore } from './store/library';
import { useUiStore } from './store/ui';

const rootRoute = createRootRoute({ component: Outlet });

/** Why the last project route could not open its project; Home shows it once. */
let openError: string | null = null;

/** Take (and clear) the error of the last project that failed to open from a route. */
export function takeOpenError(): string | null {
  const error = openError;
  openError = null;
  return error;
}

/** Home reopens the recent project once, on launch only. */
let launchChecked = false;

/** Tests: start over as if the app had just launched (Home reopens the recent project again). */
export function resetLaunch(): void {
  launchChecked = false;
  openError = null;
}

/**
 * Project routes need their project open: the open one when the id matches, else it is loaded here (a link or a
 * reload with the id in the hash). A project that cannot be opened sends the user Home with the reason.
 */
const requireProject = async ({ params }: { params: { id: string } }) => {
  // A webview that starts on a project route has opened what it wanted: Home must not reopen the recent one later.
  launchChecked = true;
  const { book, projectId, loadProject } = useBookStore.getState();
  if (book && projectId === params.id) return;
  try {
    await loadProject(params.id);
  } catch (err) {
    openError = errorMessage(err);
    devLog('book', 'open failed', { project: params.id, error: openError });
    throw redirect({ to: '/' });
  }
};

/**
 * Library routes need an imported folder on disk: its registry entry joins the library store (the stage scans it). An
 * unknown or missing folder sends the user Home with the reason.
 */
export const requireFolder = async ({ params }: { params: { folderId: string } }) => {
  launchChecked = true;
  const folder = (await listFolders().catch(() => [])).find((f) => f.id === params.folderId);
  if (!folder || folder.missing) {
    openError = folder
      ? `${folder.name} is not on disk right now (${folder.path}).`
      : 'That folder is not imported. Import it on Home.';
    devLog('library', 'folder not opened', { folder: params.folderId, error: openError });
    throw redirect({ to: '/' });
  }
  useLibraryStore.getState().addFolder(folder.id, folder.path);
};

/**
 * Collection routes take a built-in collection (Picks, Edited, Needs denoise) or a saved one (workflow plan 06, read
 * from `collections.json` once per session).
 */
export const requireCollection = async ({ params }: { params: { collectionId: string } }) => {
  launchChecked = true;
  if (isCollectionId(params.collectionId)) return;
  await useCollectionsStore.getState().load();
  if (savedCollection(params.collectionId)) return;
  openError = `There is no collection called “${params.collectionId}”.`;
  throw redirect({ to: '/' });
};

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // On app launch only: reopen the last project if it still exists.
  loader: async () => {
    let error: string | null = takeOpenError();
    if (!launchChecked) {
      launchChecked = true;
      const recent = await getRecent().catch(() => null);
      if (recent) {
        try {
          await useBookStore.getState().loadProject(recent);
          throw redirect({ to: '/project/$id/design', params: { id: recent } });
        } catch (err) {
          if (isRedirect(err)) throw err;
          error = errorMessage(err);
        }
      }
    }
    return { error };
  },
  component: HomeRoute,
});

// The project's own address goes to its Design stage (the canvas).
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/project/$id',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/project/$id/design', params: { id: params.id } });
  },
});

// The Design stage shows one document of the project (workflow plan 13): `book` (its pages) or an output's id. Plain
// `/design` goes to the document it showed last when the project still has it, else to the book.
const designRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/project/$id/design',
  beforeLoad: async ({ params }) => {
    await requireProject({ params });
    const book = useBookStore.getState().book;
    const last = useUiStore.getState().design.outputId;
    const outputId = book && hasOutput(book, last) ? last : BOOK_OUTPUT_ID;
    throw redirect({ to: '/project/$id/design/$outputId', params: { id: params.id, outputId } });
  },
});

// An unknown output id (deleted, or another project's) goes to the book.
const designOutputRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/project/$id/design/$outputId',
  beforeLoad: async ({ params }) => {
    await requireProject({ params });
    const book = useBookStore.getState().book;
    if (!book || !hasOutput(book, params.outputId)) {
      throw redirect({ to: '/project/$id/design/$outputId', params: { id: params.id, outputId: BOOK_OUTPUT_ID } });
    }
    useUiStore.getState().setDesignOutput(params.outputId);
  },
  component: BookRoute,
});

// The project's own photos in the Cull grid (workflow plan 06); Develop opens over it on them.
const projectCullRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/project/$id/cull',
  beforeLoad: requireProject,
  component: ProjectCullRoute,
});

// Cull and Develop over the library: one imported folder, or a collection (built-in or saved). No project.
const folderCullRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/$folderId/cull',
  beforeLoad: requireFolder,
  component: LibraryCullRoute,
});

const folderDevelopRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/$folderId/develop',
  beforeLoad: requireFolder,
  component: LibraryDevelopRoute,
});

const collectionCullRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/collection/$collectionId/cull',
  beforeLoad: requireCollection,
  component: LibraryCullRoute,
});

const collectionDevelopRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/collection/$collectionId/develop',
  beforeLoad: requireCollection,
  component: LibraryDevelopRoute,
});

// Sibling of /project/$id rather than a child: preview replaces the whole editor shell.
const previewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/project/$id/preview',
  beforeLoad: requireProject,
  component: PreviewRoute,
});

// Sibling like preview: the designer's view of likes and downloads replaces the editor shell.
const downloadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/project/$id/downloads',
  beforeLoad: requireProject,
  component: DownloadsRoute,
});

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsRoute });
const fixtureRoute = createRoute({ getParentRoute: () => rootRoute, path: '/fixture', component: FixtureRoute });

export const routeTree = rootRoute.addChildren([
  homeRoute,
  projectRoute,
  designRoute,
  designOutputRoute,
  projectCullRoute,
  folderCullRoute,
  folderDevelopRoute,
  collectionCullRoute,
  collectionDevelopRoute,
  previewRoute,
  downloadsRoute,
  settingsRoute,
  // The renderer fixture and the kitchen sink (synthetic stores) exist in development builds only (plan 47).
  ...(import.meta.env.DEV ? [fixtureRoute] : []),
]);

// Hash history: the production webview serves a single index.html with no server-side rewrites.
export const router = createRouter({ routeTree, history: createHashHistory() });
type AppRouter = typeof router;

// Plan 49: the stage crossfade (ODDHALLS_UI_PLAN 4.4). A navigation that changes the stage (Cull, Develop, Design)
// commits inside a view transition; the router feature-detects `document.startViewTransition` and cuts without it.
// Set per navigation (a redirect navigates again and is decided again); every other route change stays a cut. The
// durations are the tokens' (`styles.css`), so reduced motion cuts too.
export function installStageTransitions(target: { subscribe: AppRouter['subscribe']; shouldViewTransition?: unknown }) {
  return target.subscribe('onBeforeNavigate', ({ fromLocation, toLocation }) => {
    target.shouldViewTransition = isStageChange(fromLocation?.pathname, toLocation.pathname);
  });
}
installStageTransitions(router);

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
