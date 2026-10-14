import { createDevelop, type DevelopGeometry } from '@photobook/shared';
import { frameOf, type SourceSize } from '../../lib/develop/cropEdit';
import { andThen, applyMat, perspectiveMatrix, scale } from '../../lib/develop/geometry';
import { devLog } from '../../lib/log';
import { type AutoUprightMode, analyseGeometry, type GeometryAnalysis } from '../../lib/tauri';
import { photoFileOf } from '../../store/assets';
import { flushIdleGestures, type UprightOutcome, useBookStore } from '../../store/book';
import { assetDevelop, assetFolder, hasPhoto, photoMeta } from '../../store/library';
import { orientationKey, useUiStore } from '../../store/ui';

const CORRECTED: Record<'level' | 'vertical' | 'full', string> = {
  level: 'Level: the horizontal guides are now level.',
  vertical: 'Vertical: the vertical guides are now plumb.',
  full: 'Full: horizontal and vertical guides corrected.',
};

/**
 * Solve guided Upright for the photo's current guides (`updateUpright`) and put the outcome in the UI store's
 * `uprightMessage` (an invalid combination is an error line; a correction a note; no guides clears it).
 */
export async function runUprightUpdate(assetId: string, size?: SourceSize): Promise<UprightOutcome> {
  const outcome = await useBookStore.getState().updateUpright(assetId, size, stillShown());
  const ui = useUiStore.getState();
  if (!outcome.ok) {
    // An empty message means a newer edit superseded this solve: leave the line to it.
    if (outcome.message) ui.setUprightMessage({ assetId, text: outcome.message, error: true });
  } else if (outcome.correction) {
    ui.setUprightMessage({ assetId, text: CORRECTED[outcome.correction], error: false });
    devLog('develop', 'guided upright', { assetId, correction: outcome.correction, residual: outcome.residual });
  } else ui.setUprightMessage(null);
  return outcome;
}

/** The Upright message for `assetId` (messages for other photos are stale). */
export const useUprightMessage = (assetId: string) =>
  useUiStore((s) => (s.uprightMessage?.assetId === assetId ? s.uprightMessage : null));

const LABEL: Record<AutoUprightMode, string> = { auto: 'Auto', level: 'Level', vertical: 'Vertical', full: 'Full' };

/** `−2.0°` / `+1.3°` (a real minus sign). */
export const formatDegrees = (deg: number): string => {
  const v = Math.abs(deg) < 0.05 ? 0 : deg;
  return `${v < 0 ? '\u2212' : v > 0 ? '+' : ''}${Math.abs(v).toFixed(1)}°`;
};

/** The analysis's own "no structure" reason as a sentence: `already level; nothing to correct` → `Already level`. */
export function noStructureText(message: string): string {
  const head = (message.split(';')[0] ?? message).trim();
  return head ? head.charAt(0).toUpperCase() + head.slice(1) : 'No straight lines found';
}

/** The message line for a correction: `Level −2.0° · confidence 0.9`, `Auto: Vertical +0.4° · confidence 0.7`. */
export function autoUprightText(mode: AutoUprightMode, r: GeometryAnalysis): string {
  const applied = r.correction ? LABEL[r.correction] : LABEL[mode];
  const head = r.correction && r.correction !== mode ? `${LABEL[mode]}: ${applied}` : applied;
  const angle = r.angle === null ? '' : ` ${formatDegrees(r.angle)}`;
  return `${head}${angle} · confidence ${r.confidence.toFixed(1)}`;
}

/** Where `analyseGeometry` finds a photo: its folder, its path and content hash (null while unknown). */
export function analysisSource(assetId: string): { folder: string; relPath: string; hash: string } | null {
  const state = useBookStore.getState();
  const folder = assetFolder(state, assetId);
  const asset = photoMeta(state, assetId);
  const file = photoFileOf(assetId);
  const relPath = file?.relPath ?? asset?.path;
  const hash = asset?.hash ?? file?.hash;
  return folder && relPath && hash ? { folder, relPath, hash } : null;
}

/** The photo the Develop view shows (null while it is closed). */
function shownPhoto(): string | null {
  const develop = useUiStore.getState().develop;
  return develop ? (develop.ids[develop.index] ?? null) : null;
}

/**
 * True for as long as the Develop view shows what it shows now. A result that arrives after the user stepped to
 * another photo is dropped: written then, it would land out of sight, as an undo step on a photo not on screen.
 */
function stillShown(): () => boolean {
  const shown = shownPhoto();
  return () => shownPhoto() === shown;
}

const geometryOf = (assetId: string): DevelopGeometry | undefined => {
  const state = useBookStore.getState();
  if (!hasPhoto(state, assetId)) return undefined;
  return assetDevelop(state, assetId)?.geometry ?? createDevelop().geometry;
};

/** What `runAutoUpright` did: applied a correction, declined (no structure / error, nothing written) or went stale. */
export type AutoUprightOutcome =
  | { ok: true; result: GeometryAnalysis }
  | { ok: false; message: string; result?: GeometryAnalysis };

/**
 * Analyse the photo in its current orientation and solve `mode` (`analyseGeometry`). A correction is stored with
 * `applyUpright` (one undo step; a different mode resets the manual sliders unless `keepTransform`); "no structure"
 * or a rejected warp writes nothing. Either way the lines go to the UI store for the structure overlay and the
 * outcome to the message line. A result for an orientation the photo no longer has is dropped.
 */
export async function runAutoUpright(
  assetId: string,
  mode: AutoUprightMode,
  size?: SourceSize,
  options: { keepTransform?: boolean } = {},
): Promise<AutoUprightOutcome> {
  const ui = useUiStore.getState();
  const g = geometryOf(assetId);
  const source = analysisSource(assetId);
  const current = stillShown();
  if (!g || !source) {
    const message = 'This photo is not ready yet.';
    ui.setUprightMessage({ assetId, text: message, error: true });
    return { ok: false, message };
  }
  let result: GeometryAnalysis;
  try {
    result = await analyseGeometry(source.folder, source.relPath, source.hash, mode, g.rotate, g.flipH, g.flipV);
  } catch (err) {
    const text = String(err instanceof Error ? err.message : err);
    const message = text.startsWith('Unstable:') ? 'The correction would distort the photo too much.' : text;
    devLog('develop', 'auto upright failed', { assetId, mode, message });
    useUiStore.getState().setUprightMessage({ assetId, text: message, error: true });
    return { ok: false, message };
  }
  const now = geometryOf(assetId);
  const orientation = orientationKey(g);
  if (!now || orientationKey(now) !== orientation || !current()) return { ok: false, message: '' };
  useUiStore.getState().setUprightLines({ assetId, orientation, lines: result.lines });
  const used = result.lines.filter((l) => l.used).length;
  if (!result.transform) {
    const message = noStructureText(result.message ?? '');
    const level = /already level/i.test(message);
    useUiStore.getState().setUprightMessage({ assetId, text: message, error: !level });
    devLog('develop', 'auto upright declined', { assetId, mode, message, lines: result.lines.length });
    return { ok: false, message, result };
  }
  useBookStore
    .getState()
    .applyUpright(assetId, mode, { transform: result.transform, focal: result.focal }, options, size);
  useUiStore.getState().setUprightMessage({ assetId, text: autoUprightText(mode, result), error: false });
  devLog('develop', 'auto upright', {
    assetId,
    mode,
    correction: result.correction,
    angle: result.angle,
    confidence: result.confidence,
    lines: result.lines.length,
    used,
    ms: Math.round(result.elapsedMs),
  });
  return { ok: true, result };
}

/**
 * The rotation (degrees clockwise) Upright and the manual Transform already apply at the frame centre (Rust
 * `centre_angle`): what the crop tool's Auto takes off the level angle, which is measured before them.
 */
export function centreRotation(g: DevelopGeometry, size: SourceSize): number {
  const { fw, fh } = frameOf(g, size);
  const m = andThen(andThen(scale(1 / fw, 1 / fh), perspectiveMatrix(g, fw, fh)), scale(fw, fh));
  const c: [number, number] = [fw / 2, fh / 2];
  const a = applyMat(m, c);
  const b = applyMat(m, [c[0] + 1e-3 * Math.max(fw, fh), c[1]]);
  const deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  return Number.isFinite(deg) ? deg : 0;
}

/**
 * The crop tool's Auto: a Level analysis of the photo in its orientation, applied as the straighten angle (less
 * the rotation Upright and the Transform already apply) with `setCropAngle`, one undo step. Resolves the message
 * line: the angle set, or why nothing was (no structure, an error); '' when the photo changed meanwhile.
 */
export async function runAutoLevelCrop(
  assetId: string,
  size: SourceSize,
): Promise<{ ok: boolean; text: string; angle?: number }> {
  const g = geometryOf(assetId);
  const source = analysisSource(assetId);
  const current = stillShown();
  if (!g || !source) return { ok: false, text: 'This photo is not ready yet.' };
  let result: GeometryAnalysis;
  try {
    result = await analyseGeometry(source.folder, source.relPath, source.hash, 'level', g.rotate, g.flipH, g.flipV);
  } catch (err) {
    return { ok: false, text: String(err instanceof Error ? err.message : err) };
  }
  const now = geometryOf(assetId);
  if (!now || orientationKey(now) !== orientationKey(g) || !current()) return { ok: false, text: '' };
  useUiStore.getState().setUprightLines({ assetId, orientation: orientationKey(g), lines: result.lines });
  if (result.angle === null) return { ok: false, text: noStructureText(result.message ?? '') };
  const angle = Math.min(Math.max(result.angle - centreRotation(now, size), -45), 45);
  const rounded = Math.round(angle * 100) / 100;
  flushIdleGestures();
  useBookStore.getState().setCropAngle(assetId, rounded, size);
  devLog('develop', 'crop auto level', { assetId, angle: rounded, confidence: result.confidence });
  return {
    ok: true,
    angle: rounded,
    text: `Level ${formatDegrees(rounded)} · confidence ${result.confidence.toFixed(1)}`,
  };
}
