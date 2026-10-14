import {
  BOOK_TEMPLATES,
  type Book,
  type BookTemplateName,
  createPassword,
  OUTPUT_PROFILE_LABELS,
  type OutputProfile,
  PublishInfoSchema,
  randomToken,
  resolveTheme,
  slugify,
  type Theme,
} from '@photobook/shared';
import { useEffect, useState } from 'react';
import { useBookStore } from '../../store/book';
import { type UiPrefs, useUiStore } from '../../store/ui';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Field';
import { useIdleGesture } from './gestures';
import { Field, HEX, inputClass, Section, toHex6 } from './inspectorUi';

/** Points across the 8 in reference page: grid step in pt = `theme.grid * 576`. */
export const PAGE_WIDTH_PT = 576;

/**
 * Book-wide settings (the inspector with nothing selected, above the Page sections): title,
 * template, the output colour of developed photos, the background new pages get, spacing tokens (stored in the theme, undoable), the
 * view prefs (grid, safe area, snapping; per machine, localStorage), and re-applying layouts after
 * a spacing change.
 */
export function BookSettings({ book }: { book: Book }) {
  return (
    <>
      <BookSection book={book} />
      <PublishSection book={book} />
    </>
  );
}

const SLUG = PublishInfoSchema.shape.slug;

/** Slug, listed or unlisted, the optional password, and the last publish (step 2.7). */
function PublishSection({ book }: { book: Book }) {
  const setPublish = useBookStore((s) => s.setPublish);
  const { slug, visibility, lastPublishedAt } = book.publish;
  const [slugError, setSlugError] = useState<string | null>(null);
  const commitSlug = (raw: string) => {
    const next = raw.trim().toLowerCase();
    const parsed = SLUG.safeParse(next);
    if (!parsed.success) {
      setSlugError('Lowercase letters, digits and dashes only');
      return;
    }
    setSlugError(null);
    if (next !== slug) setPublish({ slug: next });
  };
  const regenerate = () => {
    const base = slugify(book.title);
    setPublish({ slug: visibility === 'listed' ? base : `${base}-${randomToken(4)}` });
    setSlugError(null);
  };
  return (
    <Section title="Publish">
      <Field label="Link">
        <TextField key={slug} value={slug} onCommit={commitSlug} label="Book slug" mono />
      </Field>
      {slugError && <p className="text-[11px] text-danger">{slugError}</p>}
      <Field label="Visibility">
        <div className="flex rounded-md border border-line p-0.5 text-xs">
          {(['listed', 'unlisted'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={visibility === v}
              onClick={() => visibility !== v && setPublish({ visibility: v })}
              className={`rounded px-2.5 py-0.5 ${visibility === v ? 'bg-line text-fg' : 'text-fg-muted hover:text-fg'}`}
            >
              {v === 'listed' ? 'Listed' : 'Unlisted'}
            </button>
          ))}
        </div>
      </Field>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-fg-muted leading-relaxed">
          {visibility === 'listed'
            ? 'Appears on the site root. A plain slug reads best.'
            : 'Reached by link only; a random suffix keeps it unguessable.'}
        </p>
        <Button size="sm" onClick={regenerate}>
          Regenerate
        </Button>
      </div>
      <PasswordFields book={book} />
      <Field label="Last published">
        <span className="text-fg text-xs tabular-nums">
          {lastPublishedAt ? new Date(lastPublishedAt).toLocaleString() : 'Never'}
        </span>
      </Field>
    </Section>
  );
}

/**
 * The book's own soft password: off, or on with a word. Only the salted hash is kept (in the project
 * file and the manifest), so the word cannot be shown again; "Change" asks for a new one. A new word
 * asks every device again, from the next publish.
 */
function PasswordFields({ book }: { book: Book }) {
  const setPublish = useBookStore((s) => s.setPublish);
  const { password } = book.publish;
  const [editing, setEditing] = useState(false);
  const [word, setWord] = useState('');
  const on = password !== null || editing;

  const toggle = () => {
    if (on) {
      setEditing(false);
      setWord('');
      if (password) setPublish({ password: null });
    } else {
      setEditing(true);
    }
  };
  const save = async () => {
    if (!word.trim()) return;
    setPublish({ password: await createPassword(word, password) });
    setEditing(false);
    setWord('');
  };
  const expiry = password?.expiresAt ? toDateInput(password.expiresAt) : '';
  const setExpiry = (value: string) => {
    if (!password) return;
    const expiresAt = value ? new Date(`${value}T00:00:00`).toISOString() : null;
    if (expiresAt !== password.expiresAt) setPublish({ password: { ...password, expiresAt } });
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-fg-muted text-xs">Password</span>
        <Switch hideLabel label="Require a password" checked={on} onChange={toggle} />
      </div>
      {editing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            type="password"
            value={word}
            onChange={(e) => setWord(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(false);
                setWord('');
              }
            }}
            placeholder={password ? 'New password' : 'Password'}
            autoComplete="new-password"
            // biome-ignore lint/a11y/noAutofocus: shown right after the switch or "Change" was pressed
            autoFocus
            aria-label="Book password"
            className={`${inputClass} min-w-0 flex-1`}
          />
          <Button type="submit" size="sm" disabled={!word.trim()}>
            Set
          </Button>
        </form>
      ) : (
        password && (
          <>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-fg-muted leading-relaxed">Set. Viewers type it once per device.</p>
              <Button size="sm" onClick={() => setEditing(true)}>
                Change
              </Button>
            </div>
            <Field label="Ask again after">
              <input
                type="date"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                aria-label="Ask for the password again after this date (optional)"
                className={`${inputClass} w-40 min-w-0`}
              />
            </Field>
          </>
        )
      )}
      {!on && <p className="text-[11px] text-fg-muted leading-relaxed">Off: anyone with the link can open the book.</p>}
    </>
  );
}

/** An ISO datetime as the local `YYYY-MM-DD` a date input shows. */
function toDateInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function BookSection({ book }: { book: Book }) {
  const setTitle = useBookStore((s) => s.setTitle);
  const setTheme = useBookStore((s) => s.setTheme);
  const setTemplate = useBookStore((s) => s.setTemplate);
  const setDefaultBackground = useBookStore((s) => s.setDefaultPageBackground);
  const reapplyLayouts = useBookStore((s) => s.reapplyLayouts);
  const touchColor = useIdleGesture(500);
  const theme = resolveTheme(book.theme);
  const [applied, setApplied] = useState<string | null>(null);

  const setToken = (key: keyof Theme, value: number) => setTheme({ [key]: value } as Partial<Theme>);

  return (
    <Section title="Book">
      <Field label="Title">
        <TextField value={book.title} onCommit={setTitle} label="Book title" />
      </Field>
      <Field label="Template">
        <select
          aria-label="Page template"
          value={book.template.name}
          onChange={(e) => setTemplate(e.target.value as BookTemplateName)}
          className={`${inputClass} w-40 min-w-0`}
        >
          {templateOptions(book.template).map((t) => (
            <option key={t.name} value={t.name} disabled={t.comingSoon && t.name !== book.template.name}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-[11px] text-fg-muted leading-relaxed">
        {templateLabel(book.template)}. Frames are fractions of the page, so photos and text stretch to a new shape; use
        "Apply margin & gutter" below to re-fit layout pages.
      </p>
      <OutputColourField book={book} />
      <Field label="Page background">
        <ColorField
          value={theme.defaultPageBackground}
          label="Default page background"
          onPick={(v) => {
            touchColor();
            setDefaultBackground(v);
          }}
          onCommit={setDefaultBackground}
        />
      </Field>
      <Field label="Safe margin">
        <NumberField
          value={theme.margin * 100}
          min={0}
          max={25}
          step={0.1}
          unit="%"
          label="Safe margin, percent of the page width"
          onCommit={(v) => setToken('margin', v / 100)}
        />
      </Field>
      <Field label="Gutter">
        <NumberField
          value={theme.gutter * 100}
          min={0}
          max={20}
          step={0.1}
          unit="%"
          label="Gutter, percent of the page width"
          onCommit={(v) => setToken('gutter', v / 100)}
        />
      </Field>
      <Field label="Wide gutter">
        <NumberField
          value={theme.wideGutter * 100}
          min={0}
          max={20}
          step={0.1}
          unit="%"
          label="Wide gutter, percent of the page width"
          onCommit={(v) => setToken('wideGutter', v / 100)}
        />
      </Field>
      <Field label="Grid step">
        <NumberField
          value={theme.grid * PAGE_WIDTH_PT}
          min={1}
          max={72}
          step={1}
          unit="pt"
          label="Grid step, points on an 8 inch wide page"
          onCommit={(v) => setToken('grid', v / PAGE_WIDTH_PT)}
        />
      </Field>
      <div className="space-y-2 pt-1">
        <PrefSwitch pref="showGrid" label="Show grid" />
        <PrefSwitch pref="showMargins" label="Show safe area / margins" />
        <PrefSwitch pref="snapEnabled" label="Snap to guides" hint="Hold Cmd while dragging to skip" />
      </div>
      <div className="space-y-1.5">
        <Button
          size="sm"
          onClick={() => {
            const n = reapplyLayouts();
            setApplied(n === 0 ? 'No layout pages to update' : `Updated ${n} ${n === 1 ? 'page' : 'pages'}`);
          }}
          className="w-full"
        >
          Apply margin & gutter to all layout pages
        </Button>
        <p className="text-[11px] text-fg-muted leading-relaxed" aria-live="polite">
          {applied ??
            'Moves the frames of every page that still follows a library layout. Blank pages and pages you edited by hand are left as they are.'}
        </p>
      </div>
    </Section>
  );
}

/** The colour space edited photos are rendered and published in (`Book.outputProfile`, step D6.2). */
function OutputColourField({ book }: { book: Book }) {
  const setOutputProfile = useBookStore((s) => s.setOutputProfile);
  return (
    <>
      <Field label="Output colour">
        <select
          aria-label="Output colour profile"
          value={book.outputProfile}
          onChange={(e) => setOutputProfile(e.target.value as OutputProfile)}
          className={`${inputClass} w-40 min-w-0`}
        >
          {(Object.keys(OUTPUT_PROFILE_LABELS) as OutputProfile[]).map((p) => (
            <option key={p} value={p}>
              {OUTPUT_PROFILE_LABELS[p]}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-[11px] text-fg-muted leading-relaxed">
        {book.outputProfile === 'display-p3'
          ? 'Display P3 keeps the richer colours of Apple displays and iPhone photos; the viewer shows them on P3 screens and browsers on sRGB screens convert.'
          : 'sRGB is the web standard and looks the same everywhere. Display P3 keeps richer colours for Apple displays.'}{' '}
        Applies to edited photos.
      </p>
    </>
  );
}

function templateLabel(template: Book['template']): string {
  const { label, ratio } = BOOK_TEMPLATES[template.name];
  return `${label}, ${ratio}, ${template.width} × ${template.height} px`;
}

/** Presets a book can switch to; a book that already is `custom` keeps it listed as its current value. */
function templateOptions(current: Book['template']) {
  return Object.values(BOOK_TEMPLATES).filter((t) => !t.comingSoon || t.name === current.name);
}

/** Text input committed on blur or Enter (one undo step); Escape reverts. */
function TextField({
  value,
  onCommit,
  label,
  mono = false,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          e.stopPropagation();
          setDraft(value);
        }
      }}
      spellCheck={false}
      aria-label={label}
      className={`${inputClass} w-40 min-w-0${mono ? ' font-mono' : ''}`}
    />
  );
}

/** Number input committed on blur or Enter (one undo step), clamped to [min, max]. */
export function NumberField({
  value,
  min,
  max,
  step,
  unit,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  label: string;
  onCommit: (v: number) => void;
}) {
  const decimals = step < 1 ? 2 : 0;
  const shown = String(Number(value.toFixed(decimals)));
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    const v = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(v)) {
      setDraft(shown);
      return;
    }
    const next = Math.min(Math.max(v, min), max);
    if (Math.abs(next - value) > 1e-9) onCommit(next);
    setDraft(String(Number(next.toFixed(decimals))));
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(shown);
          }
        }}
        aria-label={label}
        className={`${inputClass} w-16 tabular-nums`}
      />
      <span className="w-4 text-[11px] text-fg-muted">{unit}</span>
    </div>
  );
}

/** Color swatch + hex field. `onPick` fires while the native picker moves, `onCommit` for typed hex. */
export function ColorField({
  value,
  label,
  onPick,
  onCommit,
}: {
  value: string;
  label: string;
  onPick: (v: string) => void;
  onCommit: (v: string) => void;
}) {
  const [hex, setHex] = useState(value);
  useEffect(() => setHex(value), [value]);
  const commitHex = () => {
    const v = hex.trim().startsWith('#') ? hex.trim() : `#${hex.trim()}`;
    if (HEX.test(v)) onCommit(v.toLowerCase());
    else setHex(value);
  };
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={toHex6(value)}
        onChange={(e) => onPick(e.target.value)}
        aria-label={label}
        className="h-6 w-8 cursor-pointer rounded border border-line bg-transparent p-0"
      />
      <input
        type="text"
        value={hex}
        onChange={(e) => setHex(e.target.value)}
        onBlur={commitHex}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitHex();
        }}
        spellCheck={false}
        aria-label={`${label} hex`}
        className={`${inputClass} w-24 font-mono`}
      />
    </div>
  );
}

/** A switch bound to a boolean UI pref. */
function PrefSwitch({
  pref,
  label,
  hint,
}: {
  pref: Exclude<keyof UiPrefs, 'leftTab' | 'surround'>;
  label: string;
  hint?: string;
}) {
  const on = useUiStore((s) => s[pref]);
  const setPref = useUiStore((s) => s.setPref);
  return (
    <div className="flex items-center justify-between gap-3" title={hint}>
      <span className="text-fg-muted text-xs">{label}</span>
      <Switch hideLabel label={label} checked={on} onChange={() => setPref(pref, !on)} />
    </div>
  );
}
