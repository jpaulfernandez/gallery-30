import { grantIsValid, type Manifest, type Site } from '@photobook/shared';
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { loadManifest, loadSite } from './api';
import { BookList } from './components/BookList';
import { PasswordGate } from './components/PasswordGate';
import { Reader } from './components/Reader';
import { CONFIG_ERROR, R2_BASE } from './config';
import { bookPath, currentRoute, navigate, type Route, replacePath } from './routes';
import { readGrant } from './storage';

type Loaded<T> = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; value: T };

const LOADING: Loaded<never> = { status: 'loading' };

/**
 * Boot: `site.json` (listed books), then the book's manifest and its password. Root with one listed
 * book redirects to it, with several shows the list, with none stays blank. A manifest published
 * before per-book passwords has no `password` field and falls back to the legacy `site.password`,
 * which also still gates the list.
 */
export function App() {
  const route = useRoute();
  const [attempt, setAttempt] = useState(0);
  const site = useSite(attempt);
  const books = site.status === 'ready' ? site.value.books : [];
  const onlyBook = books.length === 1 ? books[0] : undefined;
  const slug = route.kind === 'book' ? route.slug : (onlyBook?.slug ?? null);
  const manifest = useManifest(slug, attempt);

  const loaded = manifest.status === 'ready' ? manifest.value : null;
  const sitePassword = site.status === 'ready' ? site.value.password : null;
  // Whose password applies: the book's own (`bookId` set) or the legacy site-wide one.
  const gate =
    slug !== null && loaded && loaded.password !== undefined
      ? { password: loaded.password, bookId: loaded.id }
      : { password: sitePassword, bookId: null };
  // Granted this session (the stored grant is re-read on every render; it is cheap and always current).
  const [grantedKey, setGrantedKey] = useState<string | null>(null);
  const password = gate.password;
  const gateKey = password ? `${gate.bookId ?? ''}:${password.version}` : null;
  const granted = password === null || grantedKey === gateKey || grantIsValid(readGrant(gate.bookId), password);

  // Exactly one listed book: the root is that book.
  useEffect(() => {
    if (route.kind === 'root' && onlyBook) replacePath(bookPath(onlyBook.slug));
  }, [route.kind, onlyBook]);

  const title = manifest.status === 'ready' && manifest.value && slug ? manifest.value.title : '';
  useEffect(() => {
    document.title = title ? `${title} · Photobook` : 'Photobook';
  }, [title]);

  if (R2_BASE === null) {
    return (
      <main class="pv-center">
        <p class="pv-error">{CONFIG_ERROR}</p>
      </main>
    );
  }
  if (site.status === 'loading') return null;
  if (site.status === 'error')
    return <Retry message="Couldn’t load this site." onRetry={() => setAttempt((a) => a + 1)} />;

  // A book's password is in its manifest: wait for it before deciding.
  if (slug !== null && manifest.status === 'loading') return null;

  if (password && !granted) {
    const cover = loaded?.pages[0]?.thumbnail || books.find((b) => b.slug === slug)?.cover || books[0]?.cover || null;
    return (
      <PasswordGate
        key={gateKey}
        password={password}
        bookId={gate.bookId}
        cover={cover}
        onGranted={() => setGrantedKey(gateKey)}
      />
    );
  }

  if (slug === null) return books.length > 1 ? <BookList books={books} /> : null;
  if (manifest.status === 'loading') return null;
  if (manifest.status === 'error') {
    return <Retry message="Couldn’t load this book." onRetry={() => setAttempt((a) => a + 1)} />;
  }
  if (manifest.value === null) return <NotFound hasBooks={books.length > 0} />;

  return (
    <Reader
      key={slug}
      manifest={manifest.value}
      site={site.value}
      slug={slug}
      routePage={route.kind === 'book' ? route.page : null}
    />
  );
}

function Retry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main class="pv-center">
      <p>{message}</p>
      <button type="button" class="pv-button" onClick={onRetry}>
        Retry
      </button>
    </main>
  );
}

function NotFound({ hasBooks }: { hasBooks: boolean }) {
  const onClick = (e: JSX.TargetedMouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    navigate('/');
  };
  return (
    <main class="pv-center">
      <p class="pv-big">This book isn’t here.</p>
      <p>Check the link you were sent.</p>
      {hasBooks && (
        <a class="pv-button" href="/" onClick={onClick}>
          All books
        </a>
      )}
    </main>
  );
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(currentRoute);
  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return route;
}

function useSite(attempt: number): Loaded<Site> {
  const [state, setState] = useState<{ attempt: number; result: Loaded<Site> }>({ attempt: -1, result: LOADING });
  useEffect(() => {
    if (R2_BASE === null) return;
    let live = true;
    loadSite(R2_BASE).then(
      (value) => live && setState({ attempt, result: { status: 'ready', value } }),
      (error) => live && setState({ attempt, result: { status: 'error', error } }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  return state.attempt === attempt ? state.result : LOADING;
}

function useManifest(slug: string | null, attempt: number): Loaded<Manifest | null> {
  const key = `${attempt}:${slug ?? ''}`;
  const [state, setState] = useState<{ key: string; result: Loaded<Manifest | null> }>({ key: '', result: LOADING });
  useEffect(() => {
    if (R2_BASE === null || slug === null) return;
    let live = true;
    loadManifest(R2_BASE, slug).then(
      (value) => live && setState({ key, result: { status: 'ready', value } }),
      (error) => live && setState({ key, result: { status: 'error', error } }),
    );
    return () => {
      live = false;
    };
  }, [slug, key]);
  return state.key === key ? state.result : LOADING;
}
