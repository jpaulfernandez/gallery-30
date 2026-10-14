import { z } from 'zod';

/**
 * Technical lenses (plan 41, CULL_PLAN 4.4): Soft, Blown and Dark, computed from the index's `stats` (plan 38). One
 * rule: **they rank and explain; they never flag.** A lens is a filter (the filter bar's *Lens*, saved in collections)
 * and a dim badge with the number and the caveat; rejecting what a lens shows is the user's Cmd+A, X.
 *
 * Pure: no editor import, so the publish CLI and tests can run it. Every threshold lives in `LENS_THRESHOLDS`, so
 * tuning never needs a rescan.
 */

/**
 * The lens of a view or a collection: none, one of the three, or `any` (in at least one of them: the built-in
 * *Worth a look* collection, and a collection saved from it).
 */
export const LensSchema = z.enum(['none', 'soft', 'blown', 'dark', 'any']);
export type Lens = z.infer<typeof LensSchema>;

/** The three lenses a photo can be in (the filter bar's choices besides None). */
export type LensKind = 'soft' | 'blown' | 'dark';
export const LENS_KINDS: readonly LensKind[] = ['soft', 'blown', 'dark'];

export const LENS_LABELS: Record<LensKind, string> = { soft: 'Soft', blown: 'Blown', dark: 'Dark' };

/** Every threshold of the lenses (CULL_PLAN 4.4). */
export const LENS_THRESHOLDS = {
  /** Soft: the folder's softest share by `sharpnessMax` (the bottom decile), rounded to whole photos. */
  softShare: 0.1,
  /** Blown, "worth a look": more than this share of pixels with a channel ≥ 250 on the proxy. */
  blownLook: 0.02,
  /** Blown, "likely blown". */
  blownLikely: 0.05,
  /** High-key (bright on purpose): a median luma above this suppresses Blown... */
  highKeyLum: 0.75,
  /** ...while no more than this share is clipped (a high-key frame clipped over a quarter is still blown). */
  highKeyClipCeiling: 0.25,
  /** Dark: a median luma below this. */
  darkLum: 0.1,
} as const;

/** The stats a lens reads (the index's `stats`, plan 38); extra fields are ignored. */
export interface LensStats {
  sharpnessMax: number;
  clipHigh: number;
  medianLum: number;
}

/**
 * One photo as the lenses see it: its key in its folder (what `folderStats` was given), its stats (absent until
 * prepared) and whether its source is a camera RAW.
 */
export interface LensEntry {
  key?: string;
  stats?: LensStats;
  raw?: boolean;
}

/** What Soft needs of the photo's folder: its softest decile by `sharpnessMax`. */
export interface FolderLensStats {
  /** Photos of the folder with stats. */
  photos: number;
  /** The `sharpnessMax` of the softest decile's last photo; null when the softest share is under one photo. */
  softCut: number | null;
  /** The keys of the softest decile: never more than its count, ties at the cut taken in the folder's order. */
  soft: ReadonlySet<string>;
}

/**
 * The folder's Soft decile: the `LENS_THRESHOLDS.softShare` of its photos (rounded) with the lowest `sharpnessMax`,
 * by rank, so a folder of equal scores is not all Soft (ties go in the order given).
 */
export function folderStats(
  entries: Iterable<{ key?: string; stats?: Pick<LensStats, 'sharpnessMax'> }>,
): FolderLensStats {
  const ranked: { key: string | undefined; v: number }[] = [];
  for (const entry of entries) {
    const v = entry.stats?.sharpnessMax;
    if (typeof v === 'number' && Number.isFinite(v)) ranked.push({ key: entry.key, v });
  }
  // `Array.prototype.sort` is stable: equal scores keep the order given.
  ranked.sort((a, b) => a.v - b.v);
  const count = Math.round(ranked.length * LENS_THRESHOLDS.softShare);
  const softest = ranked.slice(0, count);
  return {
    photos: ranked.length,
    softCut: softest.at(-1)?.v ?? null,
    soft: new Set(softest.flatMap((r) => (r.key === undefined ? [] : [r.key]))),
  };
}

export type BlownLevel = 'look' | 'likely';

/** Where one photo stands under each lens. */
export interface LensVerdict {
  soft: boolean;
  /** "worth a look" above 2 %, "likely blown" above 5 %; null when not Blown (or suppressed). */
  blown: BlownLevel | null;
  dark: boolean;
  /** Blown on a RAW source: its preview clips, the RAW often holds the highlights (*RAW headroom*). */
  rawHeadroom: boolean;
  /** Bright on purpose: Blown is suppressed (up to `highKeyClipCeiling`). */
  highKey: boolean;
  /** A dark frame with clipped highlights (a backlit figure): neither Dark nor Blown. */
  silhouette: boolean;
}

/** The lenses of a photo, given its folder's `folderStats`; null without stats (never in a lens). */
export function lensOf(entry: LensEntry, folder: FolderLensStats): LensVerdict | null {
  const s = entry.stats;
  if (!s) return null;
  const t = LENS_THRESHOLDS;
  const silhouette = s.medianLum < t.darkLum && s.clipHigh > t.blownLook;
  const highKey = s.medianLum > t.highKeyLum;
  const suppressed = silhouette || (highKey && s.clipHigh <= t.highKeyClipCeiling);
  const blown: BlownLevel | null =
    suppressed || s.clipHigh <= t.blownLook ? null : s.clipHigh > t.blownLikely ? 'likely' : 'look';
  return {
    // By rank when the photo has a key (ties capped at the decile's count); by the cut otherwise.
    soft:
      entry.key !== undefined
        ? folder.soft.has(entry.key)
        : folder.softCut !== null && s.sharpnessMax <= folder.softCut,
    blown,
    dark: s.medianLum < t.darkLum && !silhouette,
    rawHeadroom: blown !== null && entry.raw === true,
    highKey,
    silhouette,
  };
}

/** The lenses a verdict puts the photo in, in the filter bar's order. */
export function lensesIn(verdict: LensVerdict | null): LensKind[] {
  if (!verdict) return [];
  return LENS_KINDS.filter((k) =>
    k === 'soft' ? verdict.soft : k === 'blown' ? verdict.blown !== null : verdict.dark,
  );
}

/** Whether a photo passes a lens filter; `none` passes everything, a photo without stats passes only `none`. */
export function inLens(lens: Lens | undefined, verdict: LensVerdict | null): boolean {
  if (lens === undefined || lens === 'none') return true;
  const kinds = lensesIn(verdict);
  return lens === 'any' ? kinds.length > 0 : kinds.includes(lens);
}

/** The one-line caveat of each lens: what it measures and what it cannot tell. Soft's is CULL_PLAN 4.4's, verbatim. */
export const LENS_CAVEATS: Record<LensKind, string> = {
  soft: 'Softest 10 % of the folder by local sharpness; intentional blur looks the same to this test',
  blown:
    'Over 2 % of the pixels clipped on the preview (over 5 %: likely blown), high-key photos and silhouettes left out; a RAW often holds what its preview clips',
  dark: 'Median brightness under 10 %, silhouettes left out; a night scene looks the same to this test',
};

const pct = (share: number) => `${Math.round(share * 1000) / 10} %`;

/** A badge's tooltip, short: the lens and the photo's number (the caveat is the filter bar's line). */
export function lensDetail(kind: LensKind, entry: LensEntry, verdict: LensVerdict): string {
  const s = entry.stats;
  if (!s) return LENS_LABELS[kind];
  switch (kind) {
    case 'soft':
      return `Soft: sharpest tile ${Math.round(s.sharpnessMax)}`;
    case 'blown':
      return `${verdict.blown === 'likely' ? 'Likely blown' : 'Blown, worth a look'}: ${pct(s.clipHigh)} clipped${
        verdict.rawHeadroom ? ' (RAW headroom)' : ''
      }`;
    case 'dark':
      return `Dark: median brightness ${pct(s.medianLum)}`;
  }
}

/**
 * The frames of a group against the group's sharpest (the within-group rank the Decide strip shows): each frame's
 * `sharpnessMax` over the best's, 0 to 1, and the sharpest frame's id. Frames without stats get no value; `best` is
 * null when no frame has stats (or the best scores 0).
 */
export function groupSharpness(frames: readonly { id: string; stats?: Pick<LensStats, 'sharpnessMax'> }[]): {
  best: string | null;
  relative: Map<string, number>;
} {
  let best: { id: string; v: number } | null = null;
  for (const f of frames) {
    const v = f.stats?.sharpnessMax;
    if (typeof v === 'number' && Number.isFinite(v) && (best === null || v > best.v)) best = { id: f.id, v };
  }
  const relative = new Map<string, number>();
  if (!best || best.v <= 0) return { best: null, relative };
  for (const f of frames) {
    const v = f.stats?.sharpnessMax;
    if (typeof v === 'number' && Number.isFinite(v)) relative.set(f.id, Math.max(0, Math.min(1, v / best.v)));
  }
  return { best: best.id, relative };
}
