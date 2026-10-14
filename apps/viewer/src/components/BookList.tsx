import type { Site } from '@photobook/shared';
import type { JSX } from 'preact';
import { bookPath, navigate } from '../routes';

/** Root with more than one listed book: covers with title and page count; a book with a password shows its cover blurred. */
export function BookList({ books }: { books: Site['books'] }) {
  const onClick = (path: string) => (e: JSX.TargetedMouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(path);
  };
  return (
    <main class="pv-list" aria-label="Books">
      {books.map((b) => (
        <a key={b.slug} class="pv-card" href={bookPath(b.slug)} onClick={onClick(bookPath(b.slug))}>
          <span class={b.locked ? 'pv-card-cover pv-card-locked' : 'pv-card-cover'}>
            {b.cover && <img src={b.cover} alt="" loading="lazy" decoding="async" />}
          </span>
          <span class="pv-card-title">{b.title || 'Untitled'}</span>
          <span class="pv-card-meta">
            {b.pages} {b.pages === 1 ? 'page' : 'pages'}
            {b.locked && ' · Password'}
          </span>
        </a>
      ))}
    </main>
  );
}
