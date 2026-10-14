import { COLLECTION_NAME_MAX } from '@photobook/shared';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { collectionFilterFor, type LibrarySource, useCollectionsStore } from '../../store/collections';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import { PopoverButton } from '../ui/Popover';

/**
 * **Save as collection…** in the library filter bar (workflow plan 06): names what the stage shows now (the source's
 * condition and the filters, `collectionFilterFor`) and saves it to `<appdata>/collections.json`, then opens it in the
 * same stage with the filters cleared (the collection holds them now).
 */
export function SaveCollectionButton({ source, stage }: { source: LibrarySource; stage: 'cull' | 'develop' }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (close: () => void) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const ui = useUiStore.getState();
    const filter = collectionFilterFor(source, ui.libraryView);
    if (!filter) {
      setError('These filters cannot be one collection (picks and rejects at once, or two lenses): nothing to save.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await useCollectionsStore.getState().create(trimmed, filter);
      ui.setLibraryView({
        query: DEFAULT_FILMSTRIP.query,
        flag: DEFAULT_FILMSTRIP.flag,
        minRating: DEFAULT_FILMSTRIP.minRating,
        edited: DEFAULT_FILMSTRIP.edited,
        minIso: DEFAULT_FILMSTRIP.minIso,
        lens: DEFAULT_FILMSTRIP.lens,
      });
      setName('');
      close();
      void navigate({
        to:
          stage === 'develop' ? '/library/collection/$collectionId/develop' : '/library/collection/$collectionId/cull',
        params: { collectionId: created.id },
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PopoverButton
      label="Save as collection…"
      title="Save these filters as a collection in the sidebar"
      panelLabel="Save as collection"
      width={260}
      variant="soft"
    >
      {(close) => (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save(close);
          }}
        >
          <Field label="Collection name">
            <Input autoFocus value={name} maxLength={COLLECTION_NAME_MAX} onChange={(e) => setName(e.target.value)} />
          </Field>
          <p className="text-[11px] text-fg-muted">
            A collection is a filter: it shows whatever matches when it opens.
          </p>
          {error && (
            <p role="alert" className="text-[11px] text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" size="sm" disabled={busy || name.trim() === ''} className="self-end">
            Save
          </Button>
        </form>
      )}
    </PopoverButton>
  );
}
