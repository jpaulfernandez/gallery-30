import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { type Surround, useUiStore } from '../../store/ui';
import { SurroundPicker } from '../settings/AppearancePanel';
import { Segmented } from '../ui/Segmented';
import { CullSink } from './CullSink';
import { chromaOf, contrast, parseColor, toHex } from './color';
import { DesignSink } from './DesignSink';
import { HomeSink } from './HomeSink';
import { PrimitivesSink } from './PrimitivesSink';
import { ShellSink } from './ShellSink';

/**
 * Plan 44: the kitchen sink. Every token of `styles.css` with its computed value, the contrast pairs of
 * ODDHALLS_UI_PLAN 2.2 against their table values, the radii, the elevation steps, the type scale, the motion
 * durations and the surround switch. It reads only the stylesheet (no `invoke`), so it renders under Vite alone
 * (`editor-web`) for review screenshots. Plan 45 adds two pages: Primitives (every control of `components/ui` in every
 * state) and Shell (the top bar, sidebar, filter bar and jobs pill of ODDHALLS_UI_PLAN 3); plan 48 adds Design (the
 * canvas chrome on the fixture book); plan 50 adds Home (cover cards and folder rows on synthetic data); plan 47 adds
 * Cull (every grid cell state, the batch pill and a live grid). `#/fixture?tab=sink&page=shell` opens a page directly.
 */

export const SINK_PAGES = ['tokens', 'primitives', 'shell', 'design', 'home', 'cull'] as const;
export type SinkPage = (typeof SINK_PAGES)[number];

function askedPage(): SinkPage {
  const hash = globalThis.location?.hash ?? '';
  const asked = new URLSearchParams(hash.slice(hash.indexOf('?') + 1)).get('page');
  return SINK_PAGES.find((p) => p === asked) ?? 'tokens';
}

export const COLOR_TOKENS = [
  'stage',
  'stage-mid',
  'surround',
  'canvas',
  'panel',
  'panel-2',
  'panel-3',
  'hairline',
  'line',
  'fg',
  'fg-2',
  'fg-muted',
  'accent',
  'accent-ink',
  'accent-soft',
  'danger',
  'warn',
  'ok',
  'guide',
  'pick',
] as const;

/** The contrast pairs of ODDHALLS_UI_PLAN 2.2, with the ratio its table gives. */
export const CONTRAST_PAIRS = [
  { fg: 'fg', bg: 'panel', table: 12.6 },
  { fg: 'fg-2', bg: 'panel', table: 6.4 },
  { fg: 'fg-muted', bg: 'panel', table: 3.6 },
  { fg: 'accent-ink', bg: 'accent', table: 9.8 },
] as const;

/** How far a measured ratio may sit from the table's (the table rounds its hex values) and still match. */
export const CONTRAST_TOLERANCE = 0.7;

const RADII = ['xs', 'sm', 'md', 'lg', 'pill'] as const;
const SHADOWS = [
  { token: 'raised', className: 'shadow-raised' },
  { token: 'float', className: 'shadow-float' },
] as const;
/** Every `--dur-*` token (plan 49 adds the check's stroke and the job's hold); `--stagger` is read beside them. */
const DURATIONS = ['fast', 'base', 'slow', 'check', 'hold'] as const;
const ELEVATION = ['stage', 'canvas', 'panel', 'panel-2', 'panel-3'] as const;

type Computed = Record<string, string>;

/** The computed value of every token, read from probe elements after layout (and again on a surround change). */
function useComputed(root: RefObject<HTMLElement | null>, surround: Surround): Computed {
  const [values, setValues] = useState<Computed>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: the surround changes `--color-stage`; re-read then.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const next: Computed = {};
    for (const probe of el.querySelectorAll<HTMLElement>('[data-token]')) {
      const style = getComputedStyle(probe);
      const kind = probe.dataset.kind;
      const key = probe.dataset.token ?? '';
      next[key] = kind === 'radius' ? style.borderTopLeftRadius : style.backgroundColor;
    }
    // Durations, easing and shadows as declared (a computed `box-shadow` also lists Tailwind's empty ring layers).
    const rootStyle = getComputedStyle(document.documentElement);
    for (const s of SHADOWS) next[`shadow-${s.token}`] = rootStyle.getPropertyValue(`--shadow-${s.token}`).trim();
    for (const d of DURATIONS) next[`dur-${d}`] = rootStyle.getPropertyValue(`--dur-${d}`).trim();
    next.stagger = rootStyle.getPropertyValue('--stagger').trim();
    next['ease-out'] = rootStyle.getPropertyValue('--ease-out').trim();
    next['highlight-top'] = rootStyle.getPropertyValue('--highlight-top').trim();
    setValues(next);
  }, [root, surround]);
  return values;
}

function Swatch({ token, value }: { token: (typeof COLOR_TOKENS)[number]; value: string | undefined }) {
  const parsed = value ? parseColor(value) : null;
  const chroma = parsed ? chromaOf(parsed) : null;
  return (
    <figure className="m-0 flex flex-col gap-1.5" data-testid={`swatch-${token}`}>
      {/* Over `panel`, so the alpha tokens (hairline, line, accent-soft) show as they are used. */}
      <div className="h-14 rounded-md border border-hairline bg-panel">
        <div data-token={token} className="size-full rounded-md" style={{ backgroundColor: `var(--color-${token})` }} />
      </div>
      <figcaption className="flex flex-col gap-0.5">
        <span className="font-mono text-[12px] text-fg">{token}</span>
        <span className="truncate font-mono text-[11px] text-fg-muted tabular-nums" title={value}>
          {value || '…'}
        </span>
        {parsed && (
          <span className="font-mono text-[11px] text-fg-muted tabular-nums" data-chroma={chroma?.toFixed(3)}>
            {toHex(parsed)} · C {chroma !== null && chroma < 0.0005 ? '0' : chroma?.toFixed(3)}
            {parsed.a < 1 ? ` · α ${parsed.a.toFixed(2)}` : ''}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

export function KitchenSink() {
  const [page, setPage] = useState<SinkPage>(askedPage);
  return (
    <div className="flex flex-col gap-6">
      <Segmented
        label="Kitchen sink page"
        items={[
          { value: 'tokens', label: 'Tokens' },
          { value: 'primitives', label: 'Primitives' },
          { value: 'shell', label: 'Shell' },
          { value: 'design', label: 'Design' },
          { value: 'home', label: 'Home' },
          { value: 'cull', label: 'Cull' },
        ]}
        value={page}
        onChange={setPage}
        className="self-start"
      />
      {page === 'primitives' ? (
        <PrimitivesSink />
      ) : page === 'shell' ? (
        <ShellSink />
      ) : page === 'design' ? (
        <DesignSink />
      ) : page === 'home' ? (
        <HomeSink />
      ) : page === 'cull' ? (
        <CullSink />
      ) : (
        <TokensPage />
      )}
    </div>
  );
}

function TokensPage() {
  const root = useRef<HTMLDivElement>(null);
  const surround = useUiStore((s) => s.surround);
  const values = useComputed(root, surround);
  const [moved, setMoved] = useState(false);
  const color = (t: string) => {
    const v = values[t];
    return v ? parseColor(v) : null;
  };
  const surroundChroma = color('surround');

  return (
    <div ref={root} className="flex max-w-5xl flex-col gap-10 text-fg">
      <Section title="Surround">
        <div className="flex flex-wrap items-center gap-4">
          <SurroundPicker />
          <span className="font-mono text-[12px] text-fg-2 tabular-nums" data-testid="surround-chroma">
            surround {values.surround ?? '…'} · chroma{' '}
            {surroundChroma
              ? chromaOf(surroundChroma) < 0.0005
                ? '0 (no hue)'
                : chromaOf(surroundChroma).toFixed(4)
              : '…'}
          </span>
        </div>
      </Section>

      <Section title="Colour">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
          {COLOR_TOKENS.map((t) => (
            <Swatch key={t} token={t} value={values[t]} />
          ))}
        </div>
      </Section>

      <Section title="Contrast">
        <table className="w-full max-w-xl border-collapse text-left text-[12px]">
          <thead className="text-fg-2">
            <tr>
              <th className="py-1 font-medium">Pair</th>
              <th className="py-1 font-medium">Sample</th>
              <th className="py-1 text-right font-medium">Measured</th>
              <th className="py-1 text-right font-medium">Table</th>
              <th className="py-1 text-right font-medium">Match</th>
            </tr>
          </thead>
          <tbody>
            {CONTRAST_PAIRS.map((p) => {
              const a = color(p.fg);
              const b = color(p.bg);
              const ratio = a && b ? contrast(a, b) : null;
              const ok = ratio !== null && Math.abs(ratio - p.table) <= CONTRAST_TOLERANCE;
              return (
                <tr key={`${p.fg}/${p.bg}`} className="border-hairline border-t" data-testid={`contrast-${p.fg}`}>
                  <td className="py-1.5 font-mono">
                    {p.fg} on {p.bg}
                  </td>
                  <td className="py-1.5">
                    <span
                      className="rounded-xs px-2 py-0.5"
                      style={{ color: `var(--color-${p.fg})`, backgroundColor: `var(--color-${p.bg})` }}
                    >
                      Aa 13 px
                    </span>
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">
                    {ratio === null ? '…' : `${ratio.toFixed(1)} : 1`}
                  </td>
                  <td className="py-1.5 text-right font-mono text-fg-2 tabular-nums">{p.table.toFixed(1)} : 1</td>
                  <td className={`py-1.5 text-right ${ok ? 'text-ok' : 'text-danger'}`}>
                    {ratio === null ? '' : ok ? 'yes' : 'no'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <Section title="Elevation">
        <div className="flex overflow-hidden rounded-md border border-hairline">
          {ELEVATION.map((t) => (
            <div
              key={t}
              className="flex h-16 flex-1 items-end p-2 font-mono text-[11px] text-fg-2"
              style={{ backgroundColor: `var(--color-${t})` }}
            >
              {t}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-6 bg-canvas p-6">
          {SHADOWS.map(({ token, className }) => (
            <div key={token} className="flex flex-col gap-1.5">
              <div className={`size-24 rounded-md bg-panel-3 ${className}`} />
              <span className="font-mono text-[12px]">{className}</span>
              <span className="max-w-48 font-mono text-[11px] text-fg-muted">{values[`shadow-${token}`] ?? '…'}</span>
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <div className="size-24 rounded-md bg-panel-2" style={{ boxShadow: 'var(--highlight-top)' }} />
            <span className="font-mono text-[12px]">--highlight-top</span>
            <span className="max-w-48 font-mono text-[11px] text-fg-muted">{values['highlight-top'] ?? '…'}</span>
          </div>
        </div>
      </Section>

      <Section title="Radius">
        <div className="flex flex-wrap gap-6">
          {RADII.map((r) => (
            <div key={r} className="flex flex-col gap-1.5">
              <div
                data-token={`radius-${r}`}
                data-kind="radius"
                className="h-12 w-20 border border-line bg-panel-2"
                style={{ borderRadius: `var(--radius-${r})` }}
              />
              <span className="font-mono text-[12px]">radius-{r}</span>
              <span className="font-mono text-[11px] text-fg-muted tabular-nums">{values[`radius-${r}`] ?? '…'}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type">
        <div className="flex flex-col gap-3 rounded-md bg-panel p-4">
          <p className="m-0 font-medium text-[15px]">Dialog title · Inter 15 medium</p>
          <p className="m-0 text-[13px]">Chrome text · Inter 13 regular, the body of every panel</p>
          <p className="m-0 text-[12px] text-fg-2">Dense rows and labels · Inter 12, fg-2</p>
          <p className="section-title m-0">Section title · sentence case, 12 medium, fg-2</p>
          <p className="m-0">
            <span className="tag">tag · mono 10 uppercase</span>
          </p>
          <p className="m-0 font-mono text-[12px] tabular-nums">+0.35 EV · 1/250 · 4 032 × 3 024 · 100 %</p>
          <p className="m-0 font-['Instrument_Serif'] text-4xl italic tracking-tight">oddhalls</p>
          <p className="m-0 text-[11px] text-fg-muted">Hint · Inter 11, fg-muted (never for a control)</p>
        </div>
      </Section>

      <Section title="Motion">
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setMoved((m) => !m)}
            className="self-start rounded-sm bg-panel-2 px-3 py-1 text-fg text-xs outline-none hover:bg-panel-3 focus-visible:ring-2 focus-visible:ring-accent"
          >
            Play
          </button>
          {DURATIONS.map((d) => (
            <div key={d} className="flex items-center gap-4">
              <span className="w-40 font-mono text-[12px]">
                --dur-{d}{' '}
                <span data-testid={`motion-dur-${d}`} className="text-fg-muted tabular-nums">
                  {values[`dur-${d}`] ?? '…'}
                </span>
              </span>
              <div className="relative h-3 w-64 rounded-pill bg-panel-2">
                <span
                  className="absolute top-0 left-0 size-3 rounded-pill bg-accent transition-transform ease-out"
                  style={{
                    transitionDuration: `var(--dur-${d})`,
                    transform: moved ? 'translateX(calc(16rem - 0.75rem))' : 'none',
                  }}
                />
              </div>
            </div>
          ))}
          <span className="font-mono text-[11px] text-fg-muted">
            --stagger <span data-testid="motion-stagger">{values.stagger ?? '…'}</span> · --ease-out{' '}
            {values['ease-out'] ?? '…'} · reduced motion sets every duration to 0 (plan 49)
          </span>
        </div>
      </Section>
    </div>
  );
}
