import { DEVELOP_DEFAULTS, type DevelopSettings, groupSharpness, type OutputProfile } from '@photobook/shared';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { type PreviewMode, renderDevelopPreview } from '../../lib/tauri';
import { usePhotoLookup } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useGroups } from '../../store/cull';
import { assetFolder } from '../../store/library';
import {
  COMPOSITION_GUIDES,
  type CompositionGuide,
  type CullAssist,
  DEFAULT_CULL_ASSIST,
  useUiStore,
} from '../../store/ui';
import { nextPreviewJob } from '../develop/usePreview';
import { dialogOpen } from '../ui/DialogShell';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui/Menu';
import { type AssistAction, assistKeyAction } from './keys';
import { dimClass } from './marks';
import type { Placement } from './viewport';

/**
 * Plan 53 (ODDHALLS_LAYOUT_PLAN 3, *Two at once, with helpers*): Cull's assist overlays, one component used by One
 * (`OnePicture`), Two (`ComparePane`) and Decide (`DecidePicture`). All off by default and remembered per machine
 * (`ui.cull.assist`); none writes a flag, a rating or a setting.
 *
 * - **Focus peak** (F) and **Zebra** (Z) are preview modes of `render_develop_preview` (`crates/develop`
 *   `preview_modes`, GPU with the CPU as reference): the photo's proxy developed with its settings and the mode drawn
 *   over the 8-bit result. View-only: the mode is outside the develop hash and every cache key; the JPEGs are kept
 *   only in memory here, keyed by the photo, its settings and the modes (`modeCache`), never as a file.
 * - **Composition** (O cycles, Shift+O back): thirds, golden ratio, phi spiral, centre cross, diagonals, in `fg` at
 *   50 % over the picture (SVG, not a shader).
 * - **Sharpness bars** (always in Two, `SharpnessBar`): this frame's `sharpnessMax` against its group's sharpest
 *   (plan 41's `groupSharpness`), or against the other pane when the photo is in no group.
 */

/** The overlays in effect (`DEFAULT_CULL_ASSIST` for a state from before plan 53). */
export function useAssist(): CullAssist {
  return useUiStore((s) => s.cull.assist) ?? DEFAULT_CULL_ASSIST;
}

function assistNow(): CullAssist {
  return useUiStore.getState().cull.assist ?? DEFAULT_CULL_ASSIST;
}

/** Change the overlays (view state only: `setCull`, never the library). */
export function setAssist(patch: Partial<CullAssist>): void {
  useUiStore.getState().setCull({ assist: { ...assistNow(), ...patch } });
}

/** The composition guide after `current` in O's cycle (`dir` -1: before), through "none". */
export function nextComposition(current: CompositionGuide | null, dir: 1 | -1 = 1): CompositionGuide | null {
  const cycle: (CompositionGuide | null)[] = [null, ...COMPOSITION_GUIDES];
  const at = cycle.indexOf(current);
  return cycle[(at + dir + cycle.length) % cycle.length] ?? null;
}

/** Run one assist key. */
export function runAssist(action: AssistAction): void {
  const now = assistNow();
  if (action.type === 'focusPeak') setAssist({ focusPeak: !now.focusPeak });
  else if (action.type === 'zebra') setAssist({ zebra: !now.zebra });
  else setAssist({ composition: nextComposition(now.composition, action.dir) });
}

/**
 * F, Z and O while a view with a picture is open (One, Two, Decide). Never in a text field, a menu or a dialog;
 * the key is the view's alone (it stops there).
 */
export function useAssistKeys(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('[role="menu"], [role="dialog"]')) return;
      if (dialogOpen()) return;
      const action = assistKeyAction(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      runAssist(action);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}

export const COMPOSITION_LABELS: Record<CompositionGuide, string> = {
  thirds: 'Thirds',
  golden: 'Golden ratio',
  spiral: 'Phi spiral',
  centre: 'Centre cross',
  diagonals: 'Diagonals',
};

/** The *Assist* ▾ menu (Compare's and Decide's headers): the three overlays, each with its key. */
export function AssistMenu() {
  const assist = useAssist();
  const on = (assist.focusPeak ? 1 : 0) + (assist.zebra ? 1 : 0) + (assist.composition ? 1 : 0);
  return (
    <Menu
      label={on > 0 ? `Assist · ${on} ▾` : 'Assist ▾'}
      menuLabel="Assist overlays"
      title="Overlays that help judge focus, exposure and framing; they never flag a photo"
      width={240}
      alignEnd
    >
      <MenuItem
        checked={assist.focusPeak}
        shortcut="F"
        hint="In-focus edges in the accent"
        onSelect={() => setAssist({ focusPeak: !assist.focusPeak })}
      >
        Focus peak
      </MenuItem>
      <MenuItem
        checked={assist.zebra}
        shortcut="Z"
        hint="Stripes over clipped highlights, dimmer over crushed shadows"
        onSelect={() => setAssist({ zebra: !assist.zebra })}
      >
        Zebra
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Composition (O cycles)</MenuLabel>
      <MenuItem checked={assist.composition === null} onSelect={() => setAssist({ composition: null })}>
        None
      </MenuItem>
      {COMPOSITION_GUIDES.map((guide) => (
        <MenuItem key={guide} checked={assist.composition === guide} onSelect={() => setAssist({ composition: guide })}>
          {COMPOSITION_LABELS[guide]}
        </MenuItem>
      ))}
    </Menu>
  );
}

// ---------------------------------------------------------------------------------------------
// Focus peak and zebra: the preview modes.

/**
 * The modes to request, in the order Rust paints them (focus peak, then zebra over it; both test the plain pixels, so
 * neither sees the other's paint).
 */
export function previewModes(assist: CullAssist): PreviewMode[] {
  const modes: PreviewMode[] = [];
  if (assist.focusPeak) modes.push('focus-peak');
  if (assist.zebra) modes.push('zebra');
  return modes;
}

interface ModeRequest {
  folder: string;
  relPath: string;
  hash: string;
  settings: DevelopSettings;
  profile: OutputProfile;
  modes: PreviewMode[];
}

/** Rendered mode previews (blob URLs) by request, most recent last; only in memory, never under a cache file. */
const modeCache = new Map<string, string>();
const MODE_CACHE_SIZE = 12;
const inFlight = new Map<string, Promise<string | null>>();
/** Requests run one at a time, so each takes the newest preview job id when it starts and none supersedes another. */
let queue: Promise<unknown> = Promise.resolve();

export function modeKey(r: ModeRequest): string {
  return `${r.folder}\n${r.relPath}\n${r.hash}\n${r.profile}\n${r.modes.join('+')}\n${JSON.stringify(r.settings)}`;
}

/** How many mounted overlays show each URL: an evicted URL is revoked only once none does. */
const held = new Map<string, number>();

/** Revoke `url` when it is neither cached nor shown. */
function release(url: string): void {
  if ((held.get(url) ?? 0) > 0) return;
  for (const cached of modeCache.values()) if (cached === url) return;
  URL.revokeObjectURL(url);
}

/** A mounted overlay shows `url` until the returned function runs. */
export function holdModeUrl(url: string): () => void {
  held.set(url, (held.get(url) ?? 0) + 1);
  return () => {
    const n = (held.get(url) ?? 1) - 1;
    if (n > 0) held.set(url, n);
    else held.delete(url);
    release(url);
  };
}

function remember(key: string, url: string): void {
  modeCache.set(key, url);
  while (modeCache.size > MODE_CACHE_SIZE) {
    const [oldest, old] = modeCache.entries().next().value as [string, string];
    modeCache.delete(oldest);
    release(old);
  }
}

/** Forget every cached mode preview (tests). */
export function clearModeCache(): void {
  const urls = [...modeCache.values()];
  modeCache.clear();
  for (const url of urls) release(url);
}

/** The mode preview of a request: a blob URL, or null when it failed or was superseded. */
export function requestModePreview(r: ModeRequest): Promise<string | null> {
  const key = modeKey(r);
  const hit = modeCache.get(key);
  if (hit) {
    modeCache.delete(key);
    modeCache.set(key, hit);
    return Promise.resolve(hit);
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = queue.then(async () => {
    try {
      const bytes = await renderDevelopPreview(
        r.folder,
        r.relPath,
        r.hash,
        r.settings,
        nextPreviewJob(),
        undefined,
        r.profile,
        r.modes,
      );
      if (!bytes) return null;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      remember(key, url);
      return url;
    } catch (err) {
      devLog('cull', 'assist overlay not rendered', { error: errorMessage(err) });
      return null;
    } finally {
      inFlight.delete(key);
    }
  });
  queue = run;
  inFlight.set(key, run);
  return run;
}

/** The mode preview URL of photo `id` while focus peak or zebra is on, else null (also while it renders). */
function useModePreview(id: string, modes: readonly PreviewMode[]): string | null {
  const lookup = usePhotoLookup();
  const folder = useBookStore((s) => assetFolder(s, id));
  const profile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const file = lookup.file(id);
  const develop = lookup.fields(id)?.develop;
  const relPath = lookup.path(id);
  const hash = file?.hash;
  const request = useMemo<ModeRequest | null>(
    () =>
      modes.length > 0 && folder && relPath && hash
        ? { folder, relPath, hash, settings: develop ?? DEVELOP_DEFAULTS, profile, modes: [...modes] }
        : null,
    [modes, folder, relPath, hash, develop, profile],
  );
  const key = request ? modeKey(request) : null;
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the request
  useEffect(() => {
    if (!request || !key) return;
    let live = true;
    void requestModePreview(request).then((url) => {
      if (live && url) setShown({ key, url });
    });
    return () => {
      live = false;
    };
  }, [key]);
  const url = shown && shown.key === key ? shown.url : null;
  // Held while shown, so the cache's eviction never revokes a picture on screen.
  useEffect(() => (url ? holdModeUrl(url) : undefined), [url]);
  return url;
}

// ---------------------------------------------------------------------------------------------
// The overlay layer.

/**
 * The assist overlays of photo `id`, drawn in a picture's box over the picture placed at `at` (null: not measured
 * yet, the picture fills the box). Pointer events pass through to the picture.
 */
export function AssistOverlays({
  id,
  at,
  flag,
}: {
  id: string;
  at: Placement | null;
  /** The photo's flag: a reject is dimmed like its picture. */
  flag?: 'pick' | 'reject' | null;
}) {
  const assist = useAssist();
  const modes = useMemo(() => previewModes(assist), [assist]);
  const url = useModePreview(id, modes);
  const style = at ? { left: at.left, top: at.top, width: at.width, height: at.height } : undefined;
  return (
    <>
      {url && modes.length > 0 && (
        <img
          src={url}
          alt=""
          aria-hidden="true"
          draggable={false}
          data-assist-mode={modes.join(' ')}
          className={`pointer-events-none absolute max-w-none select-none ${dimClass(flag ?? undefined)} ${
            at ? '' : 'inset-0 h-full w-full object-contain'
          }`}
          style={style}
        />
      )}
      {assist.composition && at && <CompositionGuides guide={assist.composition} at={at} />}
    </>
  );
}

/** One line segment, px. */
type Line = [number, number, number, number];

const PHI = (1 + Math.sqrt(5)) / 2;

/**
 * The phi spiral as an SVG path over a `w` by `h` box: quarter arcs through the squares of a golden rectangle (cut
 * left, top, right, bottom in turn), the rectangle stretched onto the box.
 */
export function spiralPath(w: number, h: number, turns = 10): string {
  const landscape = w >= h;
  // Unit golden rectangle, scaled onto the box.
  const sx = landscape ? w / PHI : w;
  const sy = landscape ? h : h / PHI;
  let x = 0;
  let y = 0;
  let rw = landscape ? PHI : 1;
  let rh = landscape ? 1 : PHI;
  const order = landscape
    ? (['left', 'top', 'right', 'bottom'] as const)
    : (['top', 'right', 'bottom', 'left'] as const);
  const f = (n: number) => Number(n.toFixed(2));
  const parts: string[] = [];
  const arc = (from: [number, number], to: [number, number], r: number) => {
    if (parts.length === 0) parts.push(`M${f(from[0] * sx)} ${f(from[1] * sy)}`);
    parts.push(`A${f(r * sx)} ${f(r * sy)} 0 0 1 ${f(to[0] * sx)} ${f(to[1] * sy)}`);
  };
  for (let i = 0; i < turns; i += 1) {
    const side = order[i % 4];
    if (side === 'left') {
      const s = rh;
      arc([x, y + s], [x + s, y], s);
      x += s;
      rw -= s;
    } else if (side === 'top') {
      const s = rw;
      arc([x, y], [x + s, y + s], s);
      y += s;
      rh -= s;
    } else if (side === 'right') {
      const s = rh;
      arc([x + rw, y], [x + rw - s, y + s], s);
      rw -= s;
    } else {
      const s = rw;
      arc([x + rw, y + rh], [x, y + rh - s], s);
      rh -= s;
    }
  }
  return parts.join(' ');
}

/** The lines of a composition guide over a `w` by `h` picture (the spiral is a path, `spiralPath`). */
export function guideLines(guide: CompositionGuide, w: number, h: number): Line[] {
  const lines: Line[] = [];
  const cross = (fractions: number[]) => {
    for (const k of fractions) {
      lines.push([k * w, 0, k * w, h], [0, k * h, w, k * h]);
    }
  };
  if (guide === 'thirds') cross([1 / 3, 2 / 3]);
  else if (guide === 'golden') cross([1 - 1 / PHI, 1 / PHI]);
  else if (guide === 'centre') cross([0.5]);
  else if (guide === 'diagonals') {
    // The crop grid's diagonals: 45° in from each corner, as long as the short side.
    const s = Math.min(w, h);
    lines.push([0, 0, s, s], [w, 0, w - s, s], [0, h, s, h - s], [w, h, w - s, h - s]);
  }
  return lines;
}

/** A composition guide over a picture placed at `at`, in `fg` at 50 %. */
export function CompositionGuides({ guide, at }: { guide: CompositionGuide; at: Placement }) {
  const { width: w, height: h } = at;
  return (
    <svg
      aria-hidden="true"
      data-composition={guide}
      className="pointer-events-none absolute fill-none stroke-fg/50"
      style={{ left: at.left, top: at.top, width: w, height: h }}
      viewBox={`0 0 ${w} ${h}`}
    >
      {guide === 'spiral' ? (
        <path d={spiralPath(w, h)} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ) : (
        guideLines(guide, w, h).map(([x1, y1, x2, y2]) => (
          <line
            key={`${x1},${y1},${x2},${y2}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Sharpness bars.

/**
 * Photo `id`'s sharpness against its group's sharpest (`groupSharpness`, plan 41): the frames are the photo's group
 * in the Cull list when it has one, else `peers` (Two's other pane). `relative` is 0 to 1; null without stats.
 */
export function useGroupSharpness(
  id: string,
  peers: readonly string[] = [],
): { relative: number; sharpest: boolean; inGroup: boolean } | null {
  const lookup = usePhotoLookup();
  const list = useUiStore((s) => s.review?.ids) ?? NO_IDS;
  const groups = useGroups(list);
  const group = groups.byPhoto.get(id);
  const frames = group ? group.frames : [id, ...peers.filter((p) => p !== id)];
  if (frames.length < 2) return null;
  const { best, relative } = groupSharpness(frames.map((f) => ({ id: f, stats: lookup.file(f)?.stats })));
  const value = relative.get(id);
  if (best === null || value === undefined) return null;
  return { relative: value, sharpest: best === id, inGroup: Boolean(group) };
}

const NO_IDS: readonly string[] = [];

/** Two's bar under a pane: this frame's sharpness against its group's sharpest (or the other pane's). */
export function SharpnessBar({ id, peers }: { id: string; peers: readonly string[] }) {
  const reading = useGroupSharpness(id, peers);
  if (!reading) return <div className="mx-1 mt-1 h-1 shrink-0" aria-hidden="true" />;
  return <SharpnessMeter relative={reading.relative} sharpest={reading.sharpest} inGroup={reading.inGroup} />;
}

/** The bar itself: `relative` (0 to 1) of the reference, the sharpest one drawn in `fg`. */
export function SharpnessMeter({
  relative,
  sharpest,
  inGroup,
}: {
  relative: number;
  sharpest: boolean;
  inGroup: boolean;
}) {
  const pct = Math.round(relative * 100);
  const of = inGroup ? 'the group’s sharpest' : 'the sharper of the two';
  const label = sharpest ? `Sharpest ● (${inGroup ? 'of its group' : 'of the two'})` : `${pct} % of ${of}`;
  return (
    <div
      role="img"
      aria-label={`Sharpness: ${label}`}
      title={`${label}: the sharpest tile's detail (plan 41). It ranks; it never flags.`}
      data-sharpness={pct}
      className="mx-1 mt-1 h-1 shrink-0 overflow-hidden rounded-pill bg-fg/10"
    >
      <span
        className={`block h-full rounded-pill transition-[width] duration-base ease-out ${sharpest ? 'bg-fg' : 'bg-fg-2'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
