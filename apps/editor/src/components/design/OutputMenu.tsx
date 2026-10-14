import { BOOK_OUTPUT_ID, findOutput, OUTPUT_KIND_LABELS, type Output, type OutputKind } from '@photobook/shared';
import { useNavigate } from '@tanstack/react-router';
import { ask } from '@tauri-apps/plugin-dialog';
import { type ReactNode, useEffect, useState } from 'react';
import { devError } from '../../lib/log';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { openCaptionBook } from '../ai/CaptionBookDialog';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import { Menu, MenuItem, MenuSeparator, useMenu } from '../ui/Menu';
import { openNextChooser } from './NextChooser';

/** What a document of the Design stage is, for its icon: the book, or an output's kind. */
type DocumentKind = 'book' | OutputKind;

function KindIcon({ kind }: { kind: DocumentKind }) {
  let shape: ReactNode;
  if (kind === 'book') {
    shape = (
      <>
        <path d="M8 4.5C6.5 3.4 4.6 3 2.5 3v9c2.1 0 4 .4 5.5 1.5 1.5-1.1 3.4-1.5 5.5-1.5V3c-2.1 0-4 .4-5.5 1.5z" />
        <path d="M8 4.5v9" />
      </>
    );
  } else if (kind === 'social') {
    shape = (
      <>
        <rect x="3" y="2.5" width="10" height="11" rx="1.5" />
        <path d="M3 10.5l3-3 2.5 2.5 1.5-1.5 3 3" />
      </>
    );
  } else if (kind === 'print') {
    shape = (
      <>
        <path d="M4.5 6V2.5h7V6" />
        <rect x="2.5" y="6" width="11" height="5" rx="1" />
        <path d="M4.5 9.5h7v4h-7z" />
      </>
    );
  } else {
    shape = (
      <>
        <rect x="2" y="3" width="12" height="9" rx="1.5" />
        <path d="M7 5.5v4l3-2z" />
      </>
    );
  }
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shape}
    </svg>
  );
}

const nameOf = (output: Output | undefined): string => output?.name || OUTPUT_KIND_LABELS.book;

/**
 * The Design stage's document drop-down, next to the Design tab (workflow plan 13): the Book, then each of the
 * project's outputs with its kind icon, New… (plan 56: the "What's next" chooser over the canvas, `NextChooser`), and
 * Rename, Duplicate and Delete for the one on screen.
 * Picking one goes to `/project/$id/design/$outputId`. The UI never says "output": Book, Post, Print, Slideshow.
 * Plan 45: on `Menu`; Rename swaps the list for its field in place.
 */
export function OutputMenu() {
  const projectId = useBookStore((s) => s.projectId);
  const outputs = useBookStore((s) => s.book?.outputs);
  const outputId = useUiStore((s) => s.design.outputId);
  const current = outputs ? findOutput({ outputs }, outputId) : undefined;

  if (!projectId || !outputs) return null;

  return (
    <Menu
      label={
        <>
          <KindIcon kind={current?.kind ?? 'book'} />
          <span className="max-w-36 truncate">{nameOf(current)}</span>
          <span aria-hidden="true">▾</span>
        </>
      }
      title="What you are designing: the book, or a post"
      ariaLabel={`Designing: ${nameOf(current)}`}
      menuLabel="Documents"
      width={220}
    >
      {(close) => (
        <OutputPanel projectId={projectId} outputs={outputs} outputId={outputId} current={current} close={close} />
      )}
    </Menu>
  );
}

/** The drop-down's panel: the list or the Rename field (its own state, reset on every open). */
function OutputPanel({
  projectId,
  outputs,
  outputId,
  current,
  close,
}: {
  projectId: string;
  outputs: Output[];
  outputId: string;
  current: Output | undefined;
  close: () => void;
}) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'list' | 'rename'>('list');
  const [name, setName] = useState('');

  /** Go to document `id`; resolves once the route shows it (never rejects). */
  const show = (id: string): Promise<void> =>
    navigate({ to: '/project/$id/design/$outputId', params: { id: projectId, outputId: id } }).catch((err) =>
      devError('book', 'open output', err),
    );

  const remove = async (output: Output) => {
    const kind = OUTPUT_KIND_LABELS[output.kind].toLowerCase();
    const confirmed = await ask(`Delete the ${kind} “${output.name}”?\n\nYou can undo this with Cmd+Z.`, {
      title: `Delete ${kind}`,
      kind: 'warning',
      okLabel: 'Delete',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;
    // Leave it first, so the canvas never shows a document that is gone.
    await show(BOOK_OUTPUT_ID);
    useBookStore.getState().deleteOutput(output.id);
  };

  // Back from Rename puts the focus on the list's first item.
  const { focusFirst } = useMenu();
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list swaps
  useEffect(() => {
    if (mode !== 'rename') focusFirst();
  }, [mode]);

  if (mode === 'rename' && current) {
    return (
      <form
        className="flex flex-col gap-2 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          useBookStore.getState().renameOutput(current.id, name);
          close();
        }}
      >
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm">
            Rename
          </Button>
        </div>
      </form>
    );
  }

  return (
    <>
      <DocumentItem
        kind="book"
        name={OUTPUT_KIND_LABELS.book}
        current={outputId === BOOK_OUTPUT_ID}
        onClick={() => void show(BOOK_OUTPUT_ID)}
      />
      {outputs.map((o) => (
        <DocumentItem
          key={o.id}
          kind={o.kind}
          name={o.name || OUTPUT_KIND_LABELS[o.kind]}
          current={o.id === outputId}
          onClick={() => void show(o.id)}
        />
      ))}
      <MenuSeparator />
      <MenuItem title="Export, a carousel, the book, a post, a print or a slideshow" onSelect={openNextChooser}>
        New…
      </MenuItem>
      {!current && (
        // Workflow plan 35: the Book's own entries.
        <MenuItem
          title="Write captions for the book's pages with AI, with the cost first; you review every page"
          onSelect={openCaptionBook}
        >
          Caption book…
        </MenuItem>
      )}
      {current && (
        <>
          <MenuItem
            keepOpen
            onSelect={() => {
              setName(current.name);
              setMode('rename');
            }}
          >
            Rename…
          </MenuItem>
          <MenuItem
            onSelect={() => {
              const id = useBookStore.getState().duplicateOutput(current.id);
              if (id) void show(id);
            }}
          >
            Duplicate
          </MenuItem>
          <MenuItem onSelect={() => void remove(current)}>Delete…</MenuItem>
        </>
      )}
    </>
  );
}

function DocumentItem({
  kind,
  name,
  current,
  onClick,
}: {
  kind: DocumentKind;
  name: string;
  current: boolean;
  onClick: () => void;
}) {
  return (
    <MenuItem icon={<KindIcon kind={kind} />} current={current} onSelect={onClick}>
      {name}
    </MenuItem>
  );
}
