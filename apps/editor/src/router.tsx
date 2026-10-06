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
import { getRecent } from './lib/tauri';
import { BookRoute } from './routes/book';
import { DownloadsRoute } from './routes/downloads';
import { FixtureRoute } from './routes/fixture';
import { HomeRoute } from './routes/home';
import { PreviewRoute } from './routes/preview';
import { SettingsRoute } from './routes/settings';
import { useBookStore } from './store/book';

const rootRoute = createRootRoute({ component: Outlet });

const requireBook = () => {
  if (!useBookStore.getState().book) throw redirect({ to: '/' });
};

let launchChecked = false;

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  // On app launch only: reopen the last book if its folder still has a project file.
  loader: async () => {
    const recent = await getRecent().catch(() => null);
    let error: string | null = null;
    if (recent && !launchChecked) {
      launchChecked = true;
      try {
        const book = await useBookStore.getState().loadFromFolder(recent, { create: false });
        if (book) throw redirect({ to: '/book' });
      } catch (err) {
        if (isRedirect(err)) throw err;
        error = errorMessage(err);
      }
    }
    launchChecked = true;
    return { recent, error };
  },
  component: HomeRoute,
});

const bookRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/book',
  beforeLoad: requireBook,
  component: BookRoute,
});

// Sibling of /book rather than a child: preview replaces the whole editor shell.
const previewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/book/preview',
  beforeLoad: requireBook,
  component: PreviewRoute,
});

// Sibling of /book like preview: the designer's view of likes and downloads replaces the editor shell.
const downloadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/book/downloads',
  beforeLoad: requireBook,
  component: DownloadsRoute,
});

const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsRoute });
const fixtureRoute = createRoute({ getParentRoute: () => rootRoute, path: '/fixture', component: FixtureRoute });

const routeTree = rootRoute.addChildren([
  homeRoute,
  bookRoute,
  previewRoute,
  downloadsRoute,
  settingsRoute,
  fixtureRoute,
]);

// Hash history: the production webview serves a single index.html with no server-side rewrites.
export const router = createRouter({ routeTree, history: createHashHistory() });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
