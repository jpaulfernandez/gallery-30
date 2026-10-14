import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { FitBox } from '../components/preview/FitBox';
import { PHONE_HEIGHT, PHONE_WIDTH, PhoneFrame } from '../components/preview/PhoneFrame';
import { PhotoPanel } from '../components/preview/PhotoPanel';
import { readPreviewPage, writePreviewPage } from '../components/preview/pageParam';
import { Reader } from '../components/preview/Reader';
import { makeResolver } from '../components/preview/resolve';
import { useAssetsStore } from '../store/assets';
import { useBookStore } from '../store/book';
import { resolvedAssets } from '../store/library';

type Mode = 'phone' | 'desktop';

const DESKTOP_WIDTH = 1200;
const DESKTOP_HEIGHT = 800;

/** Step 1.9: the book as the viewer will show it, in a phone frame or a 1200 px desktop container. */
export function PreviewRoute() {
  const book = useBookStore((s) => s.book);
  const files = useAssetsStore((s) => s.files);
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('phone');
  // 0-based. Seeded from `#/project/<id>/preview?page=N`; kept in state so a mode switch reopens on the same page.
  const [index, setIndex] = useState(() => Math.max(0, (readPreviewPage() ?? 1) - 1));

  const assets = useBookStore(resolvedAssets);
  const profile = book?.outputProfile ?? 'srgb';
  const resolve = useMemo(() => makeResolver(assets, files, 'proxy', profile), [assets, files, profile]);
  const resolveThumb = useMemo(() => makeResolver(assets, files, 'thumb', profile), [assets, files, profile]);

  const onIndexChange = useCallback((i: number) => {
    setIndex(i);
    writePreviewPage(i + 1);
  }, []);
  const projectId = useBookStore((s) => s.projectId);
  const onExit = useCallback(
    () => projectId && void navigate({ to: '/project/$id/design', params: { id: projectId } }),
    [navigate, projectId],
  );

  if (!book || !projectId) return null;

  const reader = (
    <Reader
      key={mode}
      book={book}
      resolve={resolve}
      resolveThumb={resolveThumb}
      initialIndex={index}
      onIndexChange={onIndexChange}
      onExit={onExit}
    />
  );

  return (
    <div className="flex h-full flex-col bg-stage">
      {/* Plan 43: the window drags from the bar; the traffic lights sit in the 78 px inset. */}
      <header
        data-tauri-drag-region="deep"
        className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 pr-4 pl-[78px]"
      >
        <div className="flex">
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
        <h1 className="m-0 max-w-[40vw] truncate font-serif text-[15px] font-normal text-fg">{book.title}</h1>
        <div className="flex justify-end">
          <Link
            to="/project/$id/design"
            params={{ id: projectId }}
            className="rounded-md border border-line px-3 py-1.5 text-fg no-underline hover:bg-panel focus-visible:outline-2 focus-visible:outline-accent"
          >
            Back to editor
          </Link>
        </div>
      </header>

      {mode === 'phone' ? (
        <FitBox width={PHONE_WIDTH + 24} height={PHONE_HEIGHT + 24}>
          <PhoneFrame>{reader}</PhoneFrame>
        </FitBox>
      ) : (
        <FitBox width={DESKTOP_WIDTH} height={DESKTOP_HEIGHT}>
          <div
            data-testid="desktop-frame"
            className="flex overflow-hidden rounded-xl border border-line bg-stage shadow-2xl"
            style={{ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT }}
          >
            <div className="relative h-full min-w-0 flex-1">{reader}</div>
            <PhotoPanel book={book} pageIndex={Math.min(index, Math.max(0, book.pages.length - 1))} files={files} />
          </div>
        </FitBox>
      )}
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const options: Array<[Mode, string]> = [
    ['phone', 'Phone'],
    ['desktop', 'Desktop'],
  ];
  return (
    <fieldset
      aria-label="Preview size"
      className="m-0 inline-flex min-w-0 rounded-md border border-line bg-panel p-0.5"
    >
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          onClick={() => onChange(value)}
          className={`cursor-pointer rounded border-0 px-3 py-1 ${
            mode === value ? 'bg-panel-2 text-fg' : 'bg-transparent text-fg-muted hover:text-fg'
          }`}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}
