import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { redo, undo, useBookStore, useHistoryAvailability } from '../../store/book';
import { type SaveStatus, useUiStore } from '../../store/ui';
import { RedoIcon, UndoIcon } from './icons';
import { PublishPanel } from './PublishPanel';
import { useUnpublishedChanges } from './UnpublishedBadge';

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  dirty: 'Unsaved',
  error: 'Save failed',
};

/** 44 px bar: title (click to rename), Edit | Preview, undo and redo, save status, settings, publish. */
export function TopBar({ onClose }: { onClose: () => void }) {
  const title = useBookStore((s) => s.book?.title ?? '');
  const setTitle = useBookStore((s) => s.setTitle);
  const saveStatus = useUiStore((s) => s.saveStatus);
  const saveError = useUiStore((s) => s.saveError);
  const { canUndo, canRedo } = useHistoryAvailability();
  const [editing, setEditing] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const publishState = useUnpublishedChanges();

  const commit = () => {
    const next = editing?.trim();
    if (next && next !== title) setTitle(next);
    setEditing(null);
  };

  const iconButton =
    'flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-white/10 hover:text-fg disabled:pointer-events-none disabled:opacity-35';

  return (
    <header className="col-span-3 grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-line border-b bg-panel-2 px-3">
      <div className="min-w-0">
        {editing !== null ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: the field appears because the user clicked the title
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(null);
              }
            }}
            aria-label="Book title"
            className="w-full max-w-80 rounded-md border border-accent bg-panel px-2 py-0.5 font-medium text-fg outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(title)}
            title="Rename"
            className="max-w-full truncate rounded-md px-2 py-0.5 text-left font-medium hover:bg-white/5"
          >
            {title || 'Untitled'}
          </button>
        )}
      </div>

      <nav className="flex rounded-md border border-line p-0.5 text-xs">
        <span className="rounded bg-line px-3 py-1 text-fg">Edit</span>
        <Link to="/book/preview" className="px-3 py-1 text-fg-muted hover:text-fg">
          Preview
        </Link>
      </nav>

      <div className="flex items-center justify-end gap-1 text-xs">
        <button
          type="button"
          onClick={undo}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo (Cmd+Z)"
          className={iconButton}
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo (Shift+Cmd+Z)"
          className={iconButton}
        >
          <RedoIcon />
        </button>
        <span
          role="status"
          title={saveError ?? undefined}
          className={`ml-2 w-16 ${saveStatus === 'error' ? 'text-red-400' : 'text-fg-muted'}`}
        >
          {SAVE_LABEL[saveStatus]}
        </span>
        <Link to="/book/downloads" className="ml-2 text-fg-muted hover:text-fg">
          Downloads
        </Link>
        <Link to="/settings" className="ml-2 text-fg-muted hover:text-fg">
          Settings
        </Link>
        <button type="button" onClick={onClose} className="ml-3 text-fg-muted hover:text-fg">
          Close book
        </button>
        <button
          type="button"
          onClick={() => setPublishing(true)}
          title={
            publishState === 'changes'
              ? 'Unpublished changes'
              : publishState === 'published'
                ? 'Published and up to date'
                : 'Not published yet'
          }
          className="ml-3 flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-white hover:brightness-110"
        >
          {publishState === 'changes' && (
            <span title="Unpublished changes" className="size-1.5 rounded-full bg-amber-300" />
          )}
          Publish
        </button>
      </div>
      {publishing && <PublishPanel onClose={() => setPublishing(false)} />}
    </header>
  );
}
