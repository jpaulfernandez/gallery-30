import { useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { useBookStore } from '../../store/book';
import { editedVersion, libraryEntryOf, photoEntryPlace, versionIds } from '../../store/library';
import { buttonClass } from '../ui/Button';

const chipClass = (on: boolean) => buttonClass({ variant: 'toggle', size: 'sm', shape: 'pill', pressed: on });
const linkClass = buttonClass({ variant: 'ghost', size: 'sm' });

/**
 * The versions of the photo Develop shows (workflow plan 08): Master, its versions (virtual copies in the folder
 * library), *Make a version*, and for the version shown Rename and Delete. Plan 49: a card in Develop's left pane
 * (plan 51 moved it there from the pill over the picture) with the versions as pill chips that wrap, the actions under
 * them. A chip shows that version, and
 * every edit then goes to it. Inside a project (`assetId` is a project asset) the version the project uses is marked,
 * and *Use in this project* makes it use the one shown; Delete is refused while any project uses the version.
 */
export function VersionStrip({ assetId }: { assetId: string }) {
  const entry = useBookStore((s) => libraryEntryOf(s, assetId));
  const shown = useBookStore((s) => editedVersion(s, assetId) ?? null);
  const inProject = useBookStore((s) => Object.hasOwn(s.book?.assets ?? {}, assetId));
  const usedRaw = useBookStore((s) => s.book?.assets[assetId]?.version);
  const canHold = useBookStore((s) => photoEntryPlace(s, assetId) !== null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const ids = versionIds(entry);
  // A version the library no longer has falls back to the master, as it renders.
  const used = usedRaw !== undefined && ids.includes(usedRaw) ? usedRaw : null;
  const store = () => useBookStore.getState();

  const show = (version: string | null) => {
    setMessage(null);
    setRenaming(null);
    store().showVersion(assetId, version);
  };
  const make = () => {
    setMessage(null);
    const id = store().createVersion(assetId);
    if (!id) {
      setMessage('This photo cannot hold versions yet (its folder library is not loaded).');
      return;
    }
    // In a project the new version is this project's (WORKFLOW_PLAN 14.2); other projects keep theirs.
    if (inProject) store().setAssetVersion(assetId, id);
    store().showVersion(assetId, id);
  };
  const remove = async (version: string) => {
    setMessage(null);
    try {
      const users = await store().deleteVersion(assetId, version);
      if (users.length > 0) setMessage(`Not deleted: used by ${users.join(', ')}.`);
    } catch (err) {
      setMessage(`Not deleted: ${errorMessage(err)}`);
      devLog('library', 'version not deleted', { error: errorMessage(err) });
    }
  };

  if (!canHold) return null;
  return (
    <div
      role="toolbar"
      aria-label="Versions"
      className="flex shrink-0 flex-wrap items-center gap-1 rounded-md bg-panel-2 p-2 text-xs shadow-raised"
    >
      <h3 className="section-title m-0 mb-1 w-full text-fg">Versions</h3>
      <button
        type="button"
        aria-pressed={shown === null}
        onClick={() => show(null)}
        className={chipClass(shown === null)}
      >
        Master{inProject && used === null && <InProjectMark />}
      </button>
      {ids.map((id) => {
        const name = entry?.versions[id]?.name ?? id;
        if (renaming === id) {
          return (
            <input
              key={id}
              // biome-ignore lint/a11y/noAutofocus: the field replaces the chip the person just chose to rename
              autoFocus
              defaultValue={name}
              aria-label="Version name"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  store().renameVersion(assetId, id, e.currentTarget.value);
                  setRenaming(null);
                } else if (e.key === 'Escape') setRenaming(null);
                e.stopPropagation();
              }}
              onBlur={(e) => {
                store().renameVersion(assetId, id, e.currentTarget.value);
                setRenaming(null);
              }}
              className="h-6 w-24 rounded-sm border border-accent bg-panel-2 px-2 text-fg outline-none"
            />
          );
        }
        return (
          <button
            key={id}
            type="button"
            aria-pressed={shown === id}
            onClick={() => show(id)}
            onDoubleClick={() => setRenaming(id)}
            title="Show and edit this version (double-click to rename)"
            className={chipClass(shown === id)}
          >
            {name}
            {inProject && used === id && <InProjectMark />}
          </button>
        );
      })}
      <span className="w-full" aria-hidden="true" />
      <button type="button" onClick={make} title="Copy the settings shown into a new version" className={linkClass}>
        Make a version
      </button>
      {inProject && shown !== used && (
        <button
          type="button"
          onClick={() => store().setAssetVersion(assetId, shown)}
          title="Render this version wherever the project uses the photo"
          className={buttonClass({ variant: 'primary', size: 'sm' })}
        >
          Use in this project
        </button>
      )}
      {shown !== null && renaming === null && (
        <>
          <button type="button" onClick={() => setRenaming(shown)} className={linkClass}>
            Rename
          </button>
          <button type="button" onClick={() => void remove(shown)} className={linkClass}>
            Delete
          </button>
        </>
      )}
      {message && (
        <span role="status" className="w-full px-1 text-[11px] text-danger leading-snug">
          {message}
        </span>
      )}
    </div>
  );
}

/** The dot on the chip of the version the open project uses. */
function InProjectMark() {
  return (
    <span
      role="img"
      aria-label="(used in this project)"
      title="This project uses this version"
      className="ml-1.5 inline-block size-1.5 rounded-full bg-accent align-middle"
    />
  );
}
