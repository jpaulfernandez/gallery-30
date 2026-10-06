import { BOOK_TEMPLATES, type BookTemplateName, DEFAULT_TEMPLATE } from '@photobook/shared';
import { Link, useLoaderData, useNavigate } from '@tanstack/react-router';
import { open } from '@tauri-apps/plugin-dialog';
import { useState } from 'react';
import { errorMessage } from '../lib/errors';
import { basename } from '../lib/path';
import { useBookStore } from '../store/book';

export function HomeRoute() {
  const { recent, error: launchError } = useLoaderData({ from: '/' });
  const loadFromFolder = useBookStore((s) => s.loadFromFolder);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(launchError);
  const [template, setTemplate] = useState<BookTemplateName>(DEFAULT_TEMPLATE);

  async function openFolder(folder: string) {
    setBusy(true);
    setError(null);
    try {
      await loadFromFolder(folder, { template });
      await navigate({ to: '/book' });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function pickFolder() {
    const folder = await open({ directory: true, multiple: false, title: 'Choose a photo folder' });
    if (typeof folder === 'string') await openFolder(folder);
  }

  return (
    <div className="dot-grid flex h-full flex-col items-center justify-center gap-8 p-8">
      <Link to="/settings" className="absolute top-4 right-4 text-fg-muted hover:text-fg">
        Settings
      </Link>

      <div className="text-center">
        <h1 className="font-serif text-4xl font-medium tracking-tight">Photobook</h1>
        <p className="mt-2 text-fg-muted">Turn a folder of photos into a book you can share.</p>
      </div>

      {recent && (
        <button
          type="button"
          disabled={busy}
          onClick={() => openFolder(recent)}
          className="w-80 rounded-lg border border-line bg-panel p-4 text-left hover:border-accent disabled:opacity-50"
        >
          <div className="label">Recent</div>
          <div className="mt-1 truncate text-base">{basename(recent)}</div>
          <div className="mt-0.5 truncate text-fg-muted text-xs">{recent}</div>
        </button>
      )}

      <TemplatePicker value={template} onChange={setTemplate} disabled={busy} />

      <button
        type="button"
        disabled={busy}
        onClick={pickFolder}
        className="rounded-md bg-accent px-4 py-2 font-medium text-white hover:brightness-110 disabled:opacity-50"
      >
        {busy ? 'Opening…' : 'Open folder…'}
      </button>

      {error && (
        <p role="alert" className="max-w-lg whitespace-pre-wrap text-center text-red-400 text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

const TEMPLATES = Object.values(BOOK_TEMPLATES).filter((t) => !t.comingSoon);
const SWATCH = 34;

/** Page size for a new book (a folder that already has a book keeps its own). */
function TemplatePicker({
  value,
  onChange,
  disabled,
}: {
  value: BookTemplateName;
  onChange: (name: BookTemplateName) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="m-0 flex max-w-3xl min-w-0 flex-col items-center gap-2 border-0 p-0" disabled={disabled}>
      <legend className="label mb-1 p-0 text-center">Page size for a new book</legend>
      <div className="flex flex-wrap justify-center gap-2">
        {TEMPLATES.map((t) => {
          const selected = t.name === value;
          const w = SWATCH * Math.min(1, t.width / t.height);
          const h = SWATCH * Math.min(1, t.height / t.width);
          return (
            <label
              key={t.name}
              className={`flex w-36 cursor-pointer flex-col items-center gap-1.5 rounded-lg border bg-panel p-3 text-center has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                selected ? 'border-accent' : 'border-line hover:border-fg-muted'
              }`}
            >
              <input
                type="radio"
                name="template"
                value={t.name}
                checked={selected}
                onChange={() => onChange(t.name)}
                className="sr-only"
              />
              <span className="flex items-center justify-center" style={{ width: SWATCH, height: SWATCH }}>
                <span
                  aria-hidden="true"
                  className={`block rounded-[2px] ${selected ? 'bg-accent' : 'bg-fg-muted/60'}`}
                  style={{ width: w, height: h }}
                />
              </span>
              <span className="font-medium text-fg text-xs">{t.label}</span>
              <span className="text-[11px] text-fg-muted tabular-nums">{t.ratio}</span>
              <span className="text-[11px] text-fg-muted leading-snug">{t.description}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
