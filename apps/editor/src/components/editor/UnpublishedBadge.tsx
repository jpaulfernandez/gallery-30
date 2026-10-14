import { hasUnpublishedChanges } from '@photobook/shared';
import { useEffect, useState } from 'react';
import { useBookStore } from '../../store/book';
import { libraryBook } from '../../store/library';

/** "Unpublished changes" next to the Publish button: the publish fingerprint differs from the document. */
export function useUnpublishedChanges(): 'never' | 'changes' | 'published' | null {
  // Develop settings read through the folder's library, as publishing renders them.
  const book = useBookStore(libraryBook);
  const [state, setState] = useState<'never' | 'changes' | 'published' | null>(null);
  useEffect(() => {
    if (!book) return;
    if (!book.publish.lastPublishedAt) {
      setState('never');
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void hasUnpublishedChanges(book).then((changed) => {
        if (!cancelled) setState(changed ? 'changes' : 'published');
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [book]);
  return state;
}
