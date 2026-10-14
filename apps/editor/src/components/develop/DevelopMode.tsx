import {
  DEVELOP_DEFAULTS,
  type DevelopGeometry,
  type DevelopSettings,
  isDefaultDevelop,
  OUTPUT_PROFILE_LABELS,
  type OutputProfile,
} from '@photobook/shared';
import {
  lazy,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueueDenoiseOnLeave } from '../../lib/denoiseQueue';
import type { SourceSize } from '../../lib/develop/cropEdit';
import { deepEqual } from '../../lib/develop/merge';
import { devLog } from '../../lib/log';
import { basename } from '../../lib/path';
import { STAGE_PICTURE } from '../../lib/viewTransition';
import { type AssetFile, currentDeveloped, type PhotoLookup, usePhotoLookup } from '../../store/assets';
import { redo, undo, useBookStore, withoutHistory } from '../../store/book';
import { assetDevelop, assetFolder, assetVersionNames, hasPhoto } from '../../store/library';
import { stepLook, useLooksStore } from '../../store/looks';
import { rangeOf, stepBrushSize, useUiStore } from '../../store/ui';
import { paneKeyAction } from '../cull/keys';
import { isEditableTarget } from '../editor/gestures';
import { usedAssetIds } from '../filmstrip/visible';
import { roleProps } from '../review/ReviewMode';
import { Button } from '../ui/Button';
import { dialogOpen } from '../ui/DialogShell';
import { Menu, MenuItem, MenuSeparator, useContextMenu } from '../ui/Menu';
import { Tooltip } from '../ui/Tooltip';
import { BatchBar } from './BatchBar';
import { CropPanel } from './CropPanel';
import { type CropOverlay, CropTool, nextOverlay } from './CropTool';
import { copySettings, pastePrevious, pasteSettings, useCanPaste } from './copyPaste';
import { DenoiseLoupe } from './DenoiseLoupe';
import { DevelopLeftPane } from './DevelopLeftPane';
import { DevelopPanel } from './DevelopPanel';
import { GuidesOverlay } from './GuidesOverlay';
import { MaskTools } from './MaskTools';
// Workflow plan 36: slider→paint timing and the dev-only raw preview canvas.
import { painted } from './previewTiming';
import type { RawFrame } from './rawPreview';
import { SideBySide } from './SideBySide';
import { StructureOverlay } from './StructureOverlay';
import { releaseAiMasksOnClose, removeLastPrompt } from './useAiMask';
import { containRect, previewCenter } from './useDenoise';
import { useMaskPreview } from './useMaskPreview';
import { useCommitOnIdle, usePreview } from './usePreview';

/**
 * Plan 54: the Before | After modes (ODDHALLS_LAYOUT_PLAN 4.5), one at a time: `flip` shows the original (`\`),
 * `split` the plan-46 split line, `side` the before and the after side by side on the linked viewport; `off` the
 * after alone.
 */
export type CompareMode = 'off' | 'flip' | 'split' | 'side';

/** What `Y` turns on next: off → side by side → split → flip → off; split is skipped while it cannot draw. */
export function nextCompareMode(mode: CompareMode, splitAllowed: boolean): CompareMode {
  const order: CompareMode[] = ['off', 'side', 'split', 'flip'];
  const next = order[(order.indexOf(mode) + 1) % order.length] ?? 'off';
  return next === 'split' && !splitAllowed ? 'flip' : next;
}

/** Thumbnails shown on each side of the current one in the bottom strip. */
const STRIP_RADIUS = 10;
/** Arrow keys on these keep their own meaning (nudge a value, move a point) instead of stepping photos. */
const OWN_ARROWS = '[role="slider"], [role="tab"], [data-no-step], select';

/**
 * Develop view (the `develop` session in the UI store), over the editor or, `inline`, as the Develop stage's main area
 * (no Done button; Escape only ends tools): one photo large, the live preview
 * on top of the cached proxy, a strip of neighbours, and the adjustment panel on the right. It steps through
 * the photos the filmstrip showed when it opened, like review, and keeps the panel open while stepping.
 *
 * Keys: Left / Right step, `\` toggles Before / After (the flip), `Y` cycles the Before | After modes (side by side,
 * split, flip, off; plan 54), `S` soft-proofs (the live render in the other output profile
 * than the book's, tagged, so the webview shows it as it would publish), Cmd+Shift+C copies settings (the remembered
 * sections; Shift+Cmd+Alt+C opens Copy Settings to choose), Cmd+Shift+V pastes them onto the strip's selection (else
 * this photo) and Cmd+Alt+V pastes from the photo before this one in the strip (workflow plan 10, `copyPaste.tsx`),
 * Cmd+Shift+I imports Lightroom settings (the XMP dialog), Cmd+Z undoes
 * (a whole slider drag is one step), Escape closes. Slider and field keys are left to the controls.
 *
 * `R` opens the crop tool (`CropTool` over the image, `CropPanel` in place of the adjustments): `X` swaps the
 * crop's orientation, `O` cycles the guides, Return (or `R` again) applies, Escape cancels back to the geometry
 * the tool opened with (one undo step). Stepping to another photo applies. Commits wait until the tool closes.
 *
 * The Transform section's Guided Upright puts `GuidesOverlay` over the image (Escape or stepping ends it).
 *
 * Masks (`M` opens the section): `MaskTools` draws the selected mask's shape, the active tool and the red overlay
 * (`O`) over the picture; `[` / `]` change the brush size (with Shift its feather), Escape ends the tool, Delete
 * removes the selected component (with Refine on, its last prompt). Closing releases the AI mask models.
 *
 * Workflow plan 08: the strip is the session's list (the Cull filter, rejects hidden at *All flags*) and shows the
 * selection (`ui.selection`); Cmd-click toggles a photo in it and Shift-click selects a range from the anchor (else from
 * the photo shown), without changing the photo shown. `BatchBar` (a pill over the picture's foot) acts on the selection;
 * `VersionStrip` (in the left pane) shows the photo's versions, and edits go to the version shown (`DevelopVersionChoice`, dropped on
 * stepping away or closing).
 *
 * Plan 51: the left pane (`DevelopLeftPane`: Looks, Presets, History, Versions), the right pane (the adjustments) and
 * the strip follow `ui.panes.develop`; Tab hides or shows both panes, Shift+Tab the strip too. Every key above works
 * with them hidden.
 */
export function DevelopMode({ inline = false }: { inline?: boolean } = {}) {
  const develop = useUiStore((s) => s.develop);
  if (!develop) return null;
  return <DevelopDialog assetIds={develop.ids} index={develop.index} inline={inline} />;
}

/**
 * `assetIds` are photo ids (see `DevelopSession`): project asset ids over the editor, library keys in the Develop stage.
 * Every section below takes the current one as `assetId` and passes it to the book store's develop actions, which
 * accept either.
 */
function DevelopDialog({ assetIds, index, inline }: { assetIds: string[]; index: number; inline: boolean }) {
  const lookup = usePhotoLookup();
  const pages = useBookStore((s) => s.book?.pages);
  const before = useUiStore((s) => s.developBeforeAfter);
  const drawingGuides = useUiStore((s) => s.developGuides);
  const showStructure = useUiStore((s) => s.showStructure);
  const masksOpen = useUiStore((s) => s.developMasks);
  const denoisePreviewOpen = useUiStore((s) => s.denoise.previewOpen);
  /** Plan 51: which panes show (Tab, Shift+Tab); per machine. */
  const panes = useUiStore((s) => s.panes.develop);
  const dialogRef = useRef<HTMLDivElement>(null);
  const canPaste = useCanPaste();
  /** The photo the crop tool is open for (stepping to another one closes it, applied). */
  const [cropFor, setCropFor] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<CropOverlay>('thirds');
  const [ruler, setRuler] = useState(false);
  /**
   * Plan 46: the before / after split (the share of the picture showing the original), view only; null when off. It
   * belongs to the photo it was opened on: stepping to another one closes it.
   */
  const [splitOf, setSplitOf] = useState<{ id: string; at: number } | null>(null);
  /**
   * Plan 54: Before | After side by side (view only), the photo it was opened on; stepping to another photo or the photo
   * becoming unedited (Reset all) closes it, like the split.
   */
  const [sideOf, setSideOf] = useState<string | null>(null);
  /** Geometry when the crop tool opened, for Cancel. */
  const cropSnapshot = useRef<{ assetId: string; geometry: DevelopGeometry } | null>(null);

  const used = useMemo(() => usedAssetIds(pages ?? []), [pages]);

  const assetId = assetIds[index] ?? '';
  const file = lookup.file(assetId);
  const fields = lookup.fields(assetId);
  // A project asset, or a library photo that is hashed: something the develop actions can write.
  const editable = useBookStore((s) => hasPhoto(s, assetId));
  const asset = editable ? (fields ?? {}) : undefined;
  // The version shown (`VersionStrip`): the project's own, the master, or Develop's choice.
  const develop = useBookStore((s) => assetDevelop(s, assetId));
  const settings = develop ?? DEVELOP_DEFAULTS;
  const edited = develop !== undefined && !isDefaultDevelop(develop);
  const selected = useUiStore((s) => s.selection.keys);
  // The batch acts on the selection within this list (a selection made elsewhere may reach beyond it).
  const targets = useMemo(() => {
    const listed = new Set(assetIds);
    return selected.filter((id) => listed.has(id));
  }, [selected, assetIds]);
  const name = basename(lookup.path(assetId));
  const cropOpen = cropFor !== null && cropFor === assetId;
  const recordedWidth = useBookStore((s) => s.book?.assets[assetId]?.width);
  const recordedHeight = useBookStore((s) => s.book?.assets[assetId]?.height);
  const recordedHash = useBookStore((s) => s.book?.assets[assetId]?.hash);
  const width = recordedWidth ?? file?.width;
  const height = recordedHeight ?? file?.height;
  const size: SourceSize | undefined = width && height ? { width, height } : undefined;

  // Guided Upright drawing (the Transform section's toggle); the crop tool takes precedence.
  const guidesOpen = drawingGuides && !cropOpen && asset !== undefined;
  // The crop tool and the guides overlay draw the whole transformed picture themselves (a CSS warp), so they
  // preview the tone settings without geometry.
  const geometryFree = cropOpen || guidesOpen;
  const previewSettings = useMemo<DevelopSettings>(
    () => (geometryFree ? { ...settings, geometry: DEVELOP_DEFAULTS.geometry } : settings),
    [geometryFree, settings],
  );
  const folder = useBookStore((s) => assetFolder(s, assetId));
  const previewSource = {
    folder,
    assetId,
    relPath: lookup.path(assetId) || undefined,
    hash: recordedHash ?? file?.hash,
  };
  // Soft proof (`S`): render the live preview in the book's output profile or the other one, to compare.
  const bookProfile = useBookStore((s) => s.book?.outputProfile ?? 'srgb');
  const [proofChoice, setProofChoice] = useState<OutputProfile | null>(null);
  const proof = proofChoice ?? bookProfile;
  const toggleProof = () => setProofChoice(proof === 'srgb' ? 'display-p3' : 'srgb');
  const toggleProofRef = useRef(toggleProof);
  toggleProofRef.current = toggleProof;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 's' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      toggleProofRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const preview = usePreview(previewSource, previewSettings, proof);
  /** The sharpening mask while a Sharpening slider is held with Alt (Detail section); it replaces the picture. */
  const maskUrl = useMaskPreview(previewSource, previewSettings);
  useCommitOnIdle(assetId, settings, cropOpen);
  // Plan 27: stepping away from (or closing) a photo whose denoise settings changed queues its full run.
  useQueueDenoiseOnLeave(editable ? assetId : '');

  // `[` / `]` step through the looks: with the left pane (and its Looks strip) hidden, the saved looks load here.
  useEffect(() => {
    if (!panes.left && !useLooksStore.getState().loaded) void useLooksStore.getState().load();
  }, [panes.left]);

  // Closing the view drops the AI mask job and frees the mask models and the SAM encoding.
  useEffect(() => releaseAiMasksOnClose, []);

  // A version choice belongs to the photo shown: stepping to another one or closing drops it.
  useEffect(
    () => () => {
      if (useBookStore.getState().developVersion?.id !== assetId) return;
      withoutHistory(() => useBookStore.setState({ developVersion: null }));
    },
    [assetId],
  );

  // Focus the dialog so keys never reach a focused filmstrip cell or the canvas; give focus back on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  // Warm the cache for the neighbours so stepping shows them at once.
  useEffect(() => {
    for (const near of [assetIds[index + 1], assetIds[index - 1]]) {
      const url = near ? lookup.file(near)?.proxyUrl : undefined;
      if (url) new Image().src = url;
    }
  }, [assetIds, index, lookup]);

  const shown = () => {
    const ui = useUiStore.getState();
    return ui.develop?.ids[ui.develop.index];
  };
  /** The selection within the strip, else the photo shown: what the paste keys act on. */
  const pasteTargets = (): string[] => {
    const ui = useUiStore.getState();
    const id = shown();
    if (!ui.develop || !id) return [];
    const listed = new Set(ui.develop.ids);
    const picked = ui.selection.keys.filter((key) => listed.has(key));
    return picked.length > 0 ? picked : [id];
  };
  const copy = () => {
    const id = shown();
    if (id) copySettings(id);
  };
  const openCopy = () => {
    const id = shown();
    if (id && hasPhoto(useBookStore.getState(), id)) useUiStore.getState().openCopyDialog(id);
  };
  // The panel's Paste: this photo only.
  const paste = () => {
    const id = shown();
    if (id) void pasteSettings([id]);
  };
  const pasteKey = () => void pasteSettings(pasteTargets());
  const pasteFromPrevious = () => {
    const ui = useUiStore.getState();
    const id = shown();
    if (ui.develop && id) pastePrevious(ui.develop.ids, id, pasteTargets());
  };
  const openCrop = () => {
    const ui = useUiStore.getState();
    const id = ui.develop?.ids[ui.develop.index];
    const store = useBookStore.getState();
    if (!id || !hasPhoto(store, id)) return;
    cropSnapshot.current = {
      assetId: id,
      geometry: structuredClone(assetDevelop(store, id)?.geometry ?? DEVELOP_DEFAULTS.geometry),
    };
    setRuler(false);
    setCropFor(id);
    devLog('develop', 'crop tool opened', { assetId: id });
  };
  const applyCrop = () => {
    cropSnapshot.current = null;
    setRuler(false);
    setCropFor(null);
  };
  const cancelCrop = () => {
    const snap = cropSnapshot.current;
    if (snap) {
      const now = assetDevelop(useBookStore.getState(), snap.assetId)?.geometry ?? DEVELOP_DEFAULTS.geometry;
      if (!deepEqual(now, snap.geometry)) useBookStore.getState().setGeometry(snap.assetId, snap.geometry);
    }
    applyCrop();
  };
  const swapCrop = () => {
    if (cropFor) useBookStore.getState().swapCropOrientation(cropFor, size);
  };

  const importXmp = () => {
    const ui = useUiStore.getState();
    const id = ui.develop?.ids[ui.develop.index];
    if (id && hasPhoto(useBookStore.getState(), id)) ui.openXmpImport([id]);
  };

  // Plan 54: the Before | After modes. The split needs the picture unchanged in shape (the original is the uncropped
  // proxy, plan 46); side by side does not (two panes, the linked viewport).
  const geometryEdited = !deepEqual(settings.geometry, DEVELOP_DEFAULTS.geometry);
  const splitAllowed = edited && !maskUrl && !geometryEdited;
  const splitAt = splitOf?.id === assetId ? splitOf.at : null;
  // Stepping away or Reset all closes side by side (state set during render, like `cropFor` above).
  if (sideOf !== null && (sideOf !== assetId || !edited)) setSideOf(null);
  const sideBySide = sideOf === assetId && edited;
  const compareMode: CompareMode = sideBySide
    ? 'side'
    : before
      ? 'flip'
      : splitAt !== null && splitAllowed
        ? 'split'
        : 'off';
  const setCompareMode = (mode: CompareMode) => {
    useUiStore.getState().setDevelopBeforeAfter(mode === 'flip');
    setSideOf(mode === 'side' ? assetId : null);
    setSplitOf(mode === 'split' ? { id: assetId, at: splitAt ?? 0.5 } : null);
  };
  const flipCompare = () => setCompareMode(compareMode === 'flip' ? 'off' : 'flip');
  const cycleCompare = () => {
    if (edited && !cropOpen && !guidesOpen) setCompareMode(nextCompareMode(compareMode, splitAllowed));
  };

  // The key handler below is installed once and reads the latest actions through this ref.
  const actions = useRef({
    copy,
    openCopy,
    pasteKey,
    pasteFromPrevious,
    importXmp,
    openCrop,
    applyCrop,
    cancelCrop,
    swapCrop,
    flipCompare,
    cycleCompare,
    cropOpen,
    guidesOpen,
    inline,
  });
  actions.current = {
    copy,
    openCopy,
    pasteKey,
    pasteFromPrevious,
    importXmp,
    openCrop,
    applyCrop,
    cancelCrop,
    swapCrop,
    flipCompare,
    cycleCompare,
    cropOpen,
    guidesOpen,
    inline,
  };

  // Guide drawing belongs to one photo: stepping ends it.
  const drawnFor = useRef(assetId);
  useEffect(() => {
    if (drawnFor.current === assetId) return;
    drawnFor.current = assetId;
    if (useUiStore.getState().developGuides) useUiStore.getState().setDevelopGuides(false);
  }, [assetId]);

  // Stepping to another photo with the tool open applies it (the edits are already in the store).
  if (cropFor !== null && cropFor !== assetId) {
    cropSnapshot.current = null;
    setCropFor(null);
    setRuler(false);
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ui = useUiStore.getState();
      if (!ui.develop) return;
      // Typed values keep their keys (Enter and Escape are handled by the field itself).
      if (isEditableTarget(e.target)) return;
      // The Sync / Import / Presets dialogs own every key while they are open.
      if (dialogOpen()) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      let handled = true;
      const crop = actions.current.cropOpen;
      // Plan 51: Tab hides or shows the side panes, Shift+Tab the strip too (not on a control, in a menu or field).
      const pane = paneKeyAction(e);
      if (pane) ui.togglePanes('develop', pane);
      // Alt changes `key` on a Mac (Alt+V is √), so these two go by the physical key.
      else if (mod && e.altKey && e.shiftKey && e.code === 'KeyC') actions.current.openCopy();
      else if (mod && e.altKey && !e.shiftKey && e.code === 'KeyV') actions.current.pasteFromPrevious();
      else if (e.altKey) handled = false;
      else if (crop && !mod && e.key === 'Escape') actions.current.cancelCrop();
      else if (crop && !mod && e.key === 'Enter') {
        // A focused slider uses Enter to type a value.
        if (target?.closest('[role="slider"]')) handled = false;
        else actions.current.applyCrop();
      } else if (crop && !mod && key === 'x') actions.current.swapCrop();
      else if (crop && !mod && key === 'o') setOverlay(nextOverlay);
      else if (!mod && !e.shiftKey && key === 'r') {
        if (crop) actions.current.applyCrop();
        else actions.current.openCrop();
      } else if (mod) {
        if (key === 'z') {
          if (e.shiftKey) redo();
          else undo();
        } else if (e.shiftKey && key === 'c') actions.current.copy();
        else if (e.shiftKey && key === 'v') actions.current.pasteKey();
        else if (e.shiftKey && key === 'i') actions.current.importXmp();
        else handled = false;
      } else if (e.key === 'Escape' && target?.closest('[role="menu"]')) handled = false;
      else if (e.key === 'Escape' && actions.current.guidesOpen) ui.setDevelopGuides(false);
      else if (e.key === 'Escape' && ui.developMaskTool?.tool) {
        const t = ui.developMaskTool;
        ui.setDevelopMaskTool(t.create === 'new' ? null : { maskId: t.maskId, componentId: t.componentId, tool: null });
      } else if (
        e.key === 'Escape' &&
        ui.denoise.previewOpen &&
        document.querySelector('[data-testid="denoise-loupe"]')
      ) {
        // Plan 28: Escape closes the Denoise loupe first.
        ui.updateDenoise(() => ({ previewOpen: false }));
      } else if (e.key === 'Escape') {
        // In the Develop stage there is nothing to close back to.
        if (actions.current.inline) handled = false;
        else ui.closeDevelop();
      } else if (!crop && !e.shiftKey && key === 'm') ui.setDevelopMasks(!ui.developMasks);
      else if (!crop && key === 'o' && ui.developMasks) ui.setPref('maskOverlay', !ui.maskOverlay);
      else if (
        (e.code === 'BracketLeft' || e.code === 'BracketRight' || '[]{}'.includes(e.key)) &&
        ui.developMasks &&
        ui.developMaskTool?.tool === 'brush'
      ) {
        const dir = e.code === 'BracketRight' || e.key === ']' || e.key === '}' ? 1 : -1;
        const b = ui.maskBrush;
        if (e.shiftKey) ui.setMaskBrush({ feather: Math.min(100, Math.max(0, b.feather + dir * 10)) });
        else ui.setMaskBrush({ size: stepBrushSize(b.size, dir) });
      } else if (
        // Workflow plan 20: `[` / `]` step through the looks (None first) when the brush does not own them.
        !crop &&
        !e.shiftKey &&
        (e.code === 'BracketLeft' || e.code === 'BracketRight' || e.key === '[' || e.key === ']')
      ) {
        const id = ui.develop.ids[ui.develop.index] ?? '';
        if (hasPhoto(useBookStore.getState(), id)) stepLook(id, e.code === 'BracketRight' || e.key === ']' ? 1 : -1);
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        ui.developMasks &&
        ui.developMaskTool?.componentId &&
        !target?.closest('[role="slider"], [role="menu"]')
      ) {
        const t = ui.developMaskTool;
        const id = ui.develop.ids[ui.develop.index] ?? '';
        // With Refine on, Delete takes the last prompt back instead of removing the component.
        if (t.tool === 'refine') removeLastPrompt(id, t.maskId, t.componentId ?? '');
        else useBookStore.getState().removeMaskComponent(id, t.maskId, t.componentId ?? '');
      } else if ((e.key === '\\' || key === 'y') && target?.closest('[role="menu"]')) handled = false;
      else if (e.key === '\\') actions.current.flipCompare();
      else if (!crop && !e.shiftKey && key === 'y') actions.current.cycleCompare();
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (target?.closest(OWN_ARROWS)) handled = false;
        else ui.setDevelopIndex(ui.develop.index + (e.key === 'ArrowRight' ? 1 : -1));
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // Keep Tab inside the dialog.
  const onDialogKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const go = (i: number) => useUiStore.getState().setDevelopIndex(i);
  const developed = currentDeveloped(file, develop, bookProfile);
  // The original is the uncropped proxy, so with a crop or rotation the halves would not line up: no split then.
  const splitOn = splitAllowed && !before && !sideBySide;
  const sideShown = sideBySide && asset !== undefined;
  // Stepping to another photo drops the split (state set during render, like the crop tool's `cropFor` above).
  if (splitOf !== null && splitOf.id !== assetId) setSplitOf(null);
  const split = splitOf?.id === assetId ? splitOf.at : null;
  const setSplit = (at: number | null) => setSplitOf(at === null ? null : { id: assetId, at });

  return (
    <div
      ref={dialogRef}
      {...roleProps(inline, `Develop: ${name}`)}
      {...(inline ? {} : { onKeyDown: onDialogKeyDown })}
      tabIndex={-1}
      className={`${inline ? 'absolute' : 'fixed z-50'} inset-0 flex flex-col bg-stage outline-none`}
    >
      {/* Plan 43: over the whole window (not inline), this is the top bar: the window drags from it and the traffic
          lights sit in the 78 px inset. */}
      <header
        data-tauri-drag-region={inline ? undefined : 'deep'}
        className={`flex h-11 shrink-0 items-center gap-3 border-line border-b ${inline ? 'px-4' : 'pr-4 pl-[78px]'} text-xs`}
      >
        <span className="truncate text-fg">{name}</span>
        <span className="text-fg-muted tabular-nums">
          {index + 1} / {assetIds.length}
        </span>
        {width && height && (
          <span className="text-fg-muted tabular-nums">
            {width} × {height}
          </span>
        )}
        {used.has(assetId) && <span className="rounded-sm bg-accent/20 px-1.5 py-0.5 text-fg">In the book</span>}
        <div className="ml-auto flex items-center gap-3">
          {/* Plan 46: the toggles of UI 4.1 (on is the accent wash). */}
          <Button
            variant="toggle"
            size="sm"
            pressed={cropOpen}
            disabled={!asset}
            onClick={() => (cropOpen ? applyCrop() : openCrop())}
            title="Crop and straighten (R)"
          >
            Crop <span className="font-mono text-fg-muted">R</span>
          </Button>
          {/* Plan 54: a split button (ODDHALLS_LAYOUT_PLAN 4.5): the click is the flip, ▾ the three modes. */}
          <div className="flex items-center gap-px">
            <Button
              variant="toggle"
              size="sm"
              pressed={compareMode !== 'off'}
              disabled={!edited}
              onClick={flipCompare}
              title="Show the original (\); ▾ for split and side by side (Y)"
              className="rounded-r-none"
            >
              Before / After <span className="font-mono text-fg-muted">\</span>
            </Button>
            <Menu
              label={<ChevronDown />}
              ariaLabel="Before and after modes"
              title="Flip, split or side by side (Y cycles them)"
              menuLabel="Before and after"
              variant="toggle"
              disabled={!edited}
              className="rounded-l-none px-1"
              alignEnd
              width={220}
            >
              <MenuItem
                checked={compareMode === 'flip'}
                keepOpen={false}
                shortcut={'\\'}
                onSelect={() => setCompareMode(compareMode === 'flip' ? 'off' : 'flip')}
              >
                Flip
              </MenuItem>
              <MenuItem
                checked={compareMode === 'split'}
                keepOpen={false}
                disabled={!splitAllowed}
                hint="Drag the line"
                title={
                  splitAllowed
                    ? 'The original left of a line you drag'
                    : 'Not with a crop, a rotation or a transform: the original would not line up'
                }
                onSelect={() => setCompareMode(compareMode === 'split' ? 'off' : 'split')}
              >
                Split
              </MenuItem>
              <MenuItem
                checked={compareMode === 'side'}
                keepOpen={false}
                shortcut="Y"
                onSelect={() => setCompareMode(compareMode === 'side' ? 'off' : 'side')}
              >
                Side by side
              </MenuItem>
            </Menu>
          </div>
          <Button
            variant="toggle"
            size="sm"
            pressed={proof !== bookProfile}
            disabled={!edited}
            onClick={toggleProof}
            title={`Soft proof (S): preview this edit in ${OUTPUT_PROFILE_LABELS[proof === 'srgb' ? 'display-p3' : 'srgb']}. Edited photos publish in ${OUTPUT_PROFILE_LABELS[bookProfile]} (Book settings).`}
          >
            Proof: {OUTPUT_PROFILE_LABELS[proof]} <span className="font-mono text-fg-muted">S</span>
          </Button>
          {!inline && (
            <button
              type="button"
              onClick={() => useUiStore.getState().closeDevelop()}
              className="rounded-md px-2 py-1 text-fg-muted outline-none hover:bg-line hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
            >
              Done <span className="text-fg-muted">Esc</span>
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Plan 51: Looks, Presets, History and Versions (ODDHALLS_LAYOUT_PLAN 4.3); Tab hides it. */}
        {panes.left && asset && (
          <aside
            aria-label="Looks and history"
            className="flex w-[220px] shrink-0 flex-col border-line border-r bg-panel"
          >
            <DevelopLeftPane assetId={assetId} settings={settings} />
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1 bg-surround">
            {cropOpen && asset ? (
              <div className="absolute inset-0">
                <CropTool
                  assetId={assetId}
                  geometry={settings.geometry}
                  imageUrl={(before ? undefined : preview.url) ?? file?.proxyUrl ?? file?.thumbUrl}
                  size={size ?? { width: 3, height: 2 }}
                  overlay={overlay}
                  ruler={ruler}
                  onRulerDone={() => setRuler(false)}
                  name={name}
                />
              </div>
            ) : guidesOpen && asset ? (
              <div className="absolute inset-0">
                <GuidesOverlay
                  assetId={assetId}
                  geometry={settings.geometry}
                  imageUrl={(before ? undefined : preview.url) ?? file?.proxyUrl ?? file?.thumbUrl}
                  size={size ?? { width: 3, height: 2 }}
                  name={name}
                />
              </div>
            ) : sideShown ? (
              <SideBySide
                key={assetId}
                beforeUrl={file?.proxyUrl ?? file?.thumbUrl}
                afterUrl={preview.url ?? developed?.proxyUrl ?? file?.proxyUrl ?? file?.thumbUrl}
                name={name}
                width={width}
                height={height}
              />
            ) : (
              <DevelopImage
                file={file}
                name={name}
                baseUrl={!before && developed ? developed.proxyUrl : undefined}
                previewUrl={preview.url}
                rawFrame={preview.frame}
                showOriginal={before || !edited}
                labelOriginal={before && edited}
                hideBase={geometryEdited && !before && edited && preview.url !== null}
                unavailable={preview.unavailable}
                maskUrl={maskUrl}
                split={splitOn ? split : null}
                onSplit={splitOn && !denoisePreviewOpen ? setSplit : undefined}
                pick={
                  denoisePreviewOpen && settings.detail.denoise
                    ? {
                        assetId,
                        settings,
                        geometry: settings.geometry,
                        onPick: (fx, fy) =>
                          useUiStore
                            .getState()
                            .updateDenoise(() => ({ center: previewCenter(fx, fy, settings.geometry) })),
                      }
                    : undefined
                }
              />
            )}
            {/* Automatic Upright's lines over the developed picture (not over the original, the crop or the guides). */}
            {showStructure && !cropOpen && !guidesOpen && !before && !sideShown && asset && size && (
              <StructureOverlay assetId={assetId} geometry={settings.geometry} size={size} />
            )}
            {/* The Masks section's tools and overlay, over the developed picture. */}
            {masksOpen && !cropOpen && !guidesOpen && !before && !sideShown && asset && size && (
              <MaskTools
                assetId={assetId}
                settings={settings}
                size={size}
                sampleUrl={preview.url ?? developed?.proxyUrl ?? file?.proxyUrl}
                source={previewSource}
              />
            )}
            {/* Over the crop frame they would cover the side handles; the strip and the arrow keys still step. */}
            {!cropOpen && !guidesOpen && (
              <>
                <StepButton side="left" disabled={index === 0} onClick={() => go(index - 1)} />
                <StepButton side="right" disabled={index === assetIds.length - 1} onClick={() => go(index + 1)} />
                {/* Plan 46: the batch bar floats over the picture as a pill (the versions: the left pane, plan 51). */}
                <BatchBar ids={targets} current={assetId} all={assetIds} />
              </>
            )}
          </div>
          {panes.strip && <Strip assetIds={assetIds} index={index} lookup={lookup} selected={selected} />}
        </div>

        {/* The crop tool's panel shows even with the right pane hidden: it holds Apply and Cancel. */}
        {(panes.right || cropOpen) && (
          <aside aria-label="Adjustments" className="flex w-80 shrink-0 flex-col border-line border-l bg-panel">
            {asset && cropOpen ? (
              <CropPanel
                assetId={assetId}
                geometry={settings.geometry}
                size={size ?? { width: 3, height: 2 }}
                overlay={overlay}
                onOverlay={setOverlay}
                ruler={ruler}
                onRuler={setRuler}
                onApply={applyCrop}
                onCancel={cancelCrop}
              />
            ) : asset ? (
              <DevelopPanel
                assetId={assetId}
                settings={settings}
                edited={edited}
                canPaste={canPaste}
                onCopy={copy}
                onCopyDialog={openCopy}
                onPaste={paste}
                onCrop={openCrop}
              />
            ) : (
              <p className="p-4 text-fg-muted text-xs">Preparing this photo…</p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

interface DevelopImageProps {
  file: AssetFile | undefined;
  name: string;
  /** The cached developed proxy when it matches the settings: shown under the live render instead of the original. */
  baseUrl?: string;
  previewUrl: string | null;
  /** Plan 36 experiment: the live render as raw RGBA, drawn by WebGL over the base (dev builds with the flag only). */
  rawFrame?: RawFrame | null;
  /**
   * Hide the base image under the live render: with a crop or rotation the render's shape differs from the
   * original's, which would show around it. Each image fits the area by its own natural size (`object-contain`).
   */
  hideBase?: boolean;
  /** Show only the cached proxy: Before is on, or the photo is unedited. */
  showOriginal: boolean;
  /** Tag the image "Original" (the Before view of an edited photo). */
  labelOriginal: boolean;
  unavailable: boolean;
  /** The sharpening mask (Alt-drag on a Sharpening slider): shown alone, over everything else. */
  maskUrl?: string | null;
  /** Plan 46: the share of the picture (from the left) that shows the original, or null for no split. */
  split?: number | null;
  /** Moves or ends the split (null); without it there is no split handle. */
  onSplit?: (split: number | null) => void;
  /**
   * The Denoise loupe is open (workflow plan 28): `DenoiseLoupe` sits on the picture at `ui.denoise.center`, and a
   * click elsewhere on the picture moves it there (fractions of the picture shown).
   */
  pick?: {
    assetId: string;
    settings: DevelopSettings;
    geometry: DevelopGeometry;
    onPick: (fx: number, fy: number) => void;
  };
}

/** The cached proxy with the live render layered exactly over it; both fit the area the same way. */
/** Plan 36's WebGL canvas, loaded only in dev builds (`import.meta.env.DEV` is a constant, so release drops it). */
const RawPreviewCanvas = import.meta.env.DEV
  ? lazy(() => import('./RawPreviewCanvas').then((m) => ({ default: m.RawPreviewCanvas })))
  : null;

function DevelopImage({
  file,
  name,
  baseUrl,
  previewUrl,
  rawFrame = null,
  hideBase = false,
  showOriginal,
  labelOriginal,
  unavailable,
  maskUrl = null,
  split = null,
  onSplit,
  pick,
}: DevelopImageProps) {
  const [failed, setFailed] = useState<string | null>(null);
  /** Aspect (width / height) of the base and the live render once loaded: the area `object-contain` leaves for each. */
  const [baseAr, setBaseAr] = useState<number | null>(null);
  const [liveAr, setLiveAr] = useState<number | null>(null);
  const ar = previewUrl && !showOriginal ? liveAr : baseAr;
  const aspectOf = (img: HTMLImageElement) => (img.naturalWidth > 0 ? img.naturalWidth / img.naturalHeight : null);
  const proxy = baseUrl && failed !== baseUrl ? baseUrl : file?.proxyUrl;
  const src = proxy && failed !== proxy ? proxy : file?.thumbUrl;
  if (!src) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <p className="text-fg-muted text-xs">{file?.status === 'error' ? file.error : 'Preparing preview…'}</p>
      </div>
    );
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut for the Denoise preview
    // biome-ignore lint/a11y/useKeyWithClickEvents: picking a crop position has no keyboard route
    <div
      className={`absolute inset-6 ${pick ? 'cursor-crosshair' : ''}`}
      style={{ viewTransitionName: STAGE_PICTURE }}
      data-testid="develop-image"
      onClick={
        pick
          ? (e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const fit = containRect(box.width, box.height, ar);
              const fx = (e.clientX - box.left - fit.x) / fit.w;
              const fy = (e.clientY - box.top - fit.y) / fit.h;
              if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) pick.onPick(fx, fy);
            }
          : undefined
      }
    >
      {maskUrl && (
        <img
          src={maskUrl}
          alt="Sharpening mask"
          draggable={false}
          data-testid="develop-mask"
          className="absolute inset-0 z-10 h-full w-full bg-surround object-contain"
        />
      )}
      <img
        key={src}
        src={src}
        alt={name}
        draggable={false}
        onError={() => setFailed(src)}
        onLoad={(e) => setBaseAr(aspectOf(e.currentTarget))}
        className={`absolute inset-0 h-full w-full object-contain ${hideBase ? 'invisible' : ''}`}
      />
      {previewUrl && (
        <img
          src={previewUrl}
          alt=""
          draggable={false}
          data-testid="develop-preview"
          onLoad={(e) => {
            setLiveAr(aspectOf(e.currentTarget));
            painted(e.currentTarget.src);
          }}
          className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-fast ease-out ${showOriginal ? 'opacity-0' : ''}`}
        />
      )}
      {rawFrame && RawPreviewCanvas && (
        <Suspense fallback={null}>
          <RawPreviewCanvas frame={rawFrame} hidden={showOriginal} />
        </Suspense>
      )}
      {split !== null && !showOriginal && file?.proxyUrl && (
        <>
          <img
            src={file.proxyUrl}
            alt=""
            draggable={false}
            data-testid="develop-split-original"
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
            style={{ clipPath: `inset(0 ${Number(((1 - split) * 100).toFixed(3))}% 0 0)` }}
          />
          <span className="pointer-events-none absolute top-2 left-2 rounded-xs bg-stage/60 px-1.5 py-0.5 text-[11px] text-fg">
            Before
          </span>
          <span className="pointer-events-none absolute top-2 right-2 rounded-xs bg-stage/60 px-1.5 py-0.5 text-[11px] text-fg">
            After
          </span>
        </>
      )}
      {onSplit && !showOriginal && file?.proxyUrl && <SplitHandle split={split} onSplit={onSplit} />}
      {pick && <DenoiseLoupe assetId={pick.assetId} settings={pick.settings} ar={ar} />}
      {labelOriginal && (
        <span className="absolute bottom-2 left-2 rounded-sm bg-stage/60 px-1.5 py-0.5 text-[11px] text-fg">
          Original
        </span>
      )}
      {unavailable && (
        <span className="absolute top-2 right-2 rounded-sm bg-stage/60 px-1.5 py-0.5 text-[11px] text-fg-muted">
          Live preview unavailable
        </span>
      )}
    </div>
  );
}

/** Below this share of the picture a released split closes. */
const SPLIT_CLOSE = 0.02;

/**
 * Plan 46: the before / after split's handle (view only, never an edit). Without a split it is a grip at the picture's
 * left edge; dragging it opens the split at the pointer. With one it is the dividing line and its grip: drag to move,
 * release near the left edge, double-click, Delete or Escape to close; arrow keys move it by 5 % (Shift: 1 %).
 */
function SplitHandle({ split, onSplit }: { split: number | null; onSplit: (split: number | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const at = (clientX: number): number => {
    const box = ref.current?.parentElement?.getBoundingClientRect();
    if (!box || box.width <= 0) return 0.5;
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  };
  const open = split !== null;
  const x = split ?? 0;
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Before and after split"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(x * 100)}
      aria-valuetext={open ? `${Math.round(x * 100)} % original` : 'Off'}
      title={open ? 'Drag to compare; double-click to close' : 'Drag to compare with the original'}
      data-testid="develop-split-handle"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onSplit(null);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        dragging.current = true;
      }}
      onPointerMove={(e) => {
        if (dragging.current) onSplit(at(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        if (at(e.clientX) < SPLIT_CLOSE) onSplit(null);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={(e) => {
        const by = e.shiftKey ? 0.01 : 0.05;
        let next: number | null | undefined;
        if (e.key === 'ArrowRight') next = Math.min(1, x + by);
        else if (e.key === 'ArrowLeft') next = x - by < SPLIT_CLOSE ? null : x - by;
        else if (open && (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Escape')) next = null;
        if (next === undefined) return;
        e.preventDefault();
        e.stopPropagation();
        onSplit(next);
      }}
      className={`group absolute inset-y-0 z-10 flex w-6 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center outline-none ${
        open ? '' : 'opacity-60 hover:opacity-100 focus-visible:opacity-100'
      }`}
      style={{ left: `${x * 100}%` }}
    >
      {open && <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-fg/80" />}
      <span
        aria-hidden="true"
        className={`relative flex items-center justify-center rounded-pill bg-panel-3 text-fg-2 shadow-float transition-[width,height] duration-fast ease-out group-hover:text-fg group-focus-visible:ring-2 group-focus-visible:ring-accent ${
          open ? 'size-6' : 'h-10 w-2'
        }`}
      >
        {open && (
          <svg
            viewBox="0 0 16 16"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path d="M6 4L2 8l4 4M10 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
    </div>
  );
}

function StepButton({ side, disabled, onClick }: { side: 'left' | 'right'; disabled: boolean; onClick: () => void }) {
  const label = side === 'left' ? 'Previous photo' : 'Next photo';
  return (
    <Tooltip
      label={label}
      shortcut={side === 'left' ? '←' : '→'}
      className={`absolute top-1/2 ${side === 'left' ? 'left-3' : 'right-3'} z-10 flex -translate-y-1/2`}
    >
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={`rounded-full bg-stage/40 p-2 text-fg outline-none hover:bg-stage/70 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-0`}
      >
        <svg
          viewBox="0 0 16 16"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path d={side === 'left' ? 'M10 3L5 8l5 5' : 'M6 3l5 5-5 5'} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </Tooltip>
  );
}

/**
 * Make a version of photo `id` (workflow plan 08) and show it: in a project the new version is the project's. Returns
 * false when the photo cannot hold versions (its folder library is not loaded).
 */
function makeVersion(id: string): boolean {
  const store = useBookStore.getState();
  const version = store.createVersion(id);
  if (!version) return false;
  if (Object.hasOwn(store.book?.assets ?? {}, id)) store.setAssetVersion(id, version);
  store.showVersion(id, version);
  return true;
}

/**
 * Neighbouring thumbnails: click one to jump to it; Cmd-click toggles it in the selection and Shift-click selects the
 * range from the anchor (else from the photo shown), both without changing the photo shown. Edited photos carry a dot,
 * selected ones a check, and a project photo that uses a version its name (`v2`). Right-click (plan 45, on
 * `Menu.Context`): Make a version, Copy settings, Paste settings (onto the selection when the photo is in it).
 */
function Strip({
  assetIds,
  index,
  lookup,
  selected,
}: {
  assetIds: string[];
  index: number;
  lookup: PhotoLookup;
  selected: readonly string[];
}) {
  const versions = useBookStore(assetVersionNames);
  const canPaste = useCanPaste();
  const menu = useContextMenu<{ id: string; at: number }>();
  const start = Math.max(0, index - STRIP_RADIUS);
  const nearby = assetIds.slice(start, index + STRIP_RADIUS + 1);
  const chosen = new Set(selected);
  const click = (id: string, at: number, e: ReactMouseEvent) => {
    const ui = useUiStore.getState();
    if (e.metaKey || e.ctrlKey) ui.toggleSelected(id);
    else if (e.shiftKey) {
      const listed = ui.selection.anchor !== null && assetIds.includes(ui.selection.anchor);
      const anchor = listed ? ui.selection.anchor : (assetIds[index] ?? id);
      ui.setSelection(rangeOf(assetIds, anchor, id), anchor);
    } else ui.setDevelopIndex(at);
  };
  return (
    <div className="flex h-20 shrink-0 items-center justify-center gap-1 overflow-hidden px-4">
      {nearby.map((id, i) => {
        const at = start + i;
        const file = lookup.file(id);
        const meta = lookup.fields(id);
        const on = chosen.has(id);
        const version = versions[id];
        return (
          <button
            key={id}
            type="button"
            aria-label={`Develop ${basename(lookup.path(id) || id)}`}
            aria-current={at === index}
            data-selected={on || undefined}
            title="Click to show; Cmd-click or Shift-click to select; right-click for more"
            onClick={(e) => click(id, at, e)}
            onContextMenu={(e) => menu.onContextMenu(e, { id, at })}
            className={`relative size-14 shrink-0 overflow-hidden rounded-sm bg-line outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              at === index ? 'ring-2 ring-accent' : on ? 'ring-2 ring-fg/70' : 'opacity-70 hover:opacity-100'
            }`}
          >
            {file?.thumbUrl && (
              <img src={file.thumbUrl} alt="" draggable={false} className="h-full w-full object-cover" />
            )}
            {meta?.develop && (
              <span
                role="img"
                aria-label="Edited"
                className="absolute top-0.5 right-0.5 size-2 rounded-full border border-stage/50 bg-accent"
              />
            )}
            {on && (
              <span
                role="img"
                aria-label="Selected"
                className="absolute top-0.5 left-0.5 flex size-3.5 items-center justify-center rounded-full bg-accent text-[9px] text-accent-ink"
              >
                ✓
              </span>
            )}
            {version !== undefined && (
              <span className="absolute right-0.5 bottom-0.5 max-w-12 truncate rounded-sm bg-stage/70 px-0.5 text-[9px] text-fg leading-3">
                {version}
              </span>
            )}
          </button>
        );
      })}
      {menu.menu && (
        <Menu.Context
          at={menu.at}
          label={basename(lookup.path(menu.menu.data.id) || menu.menu.data.id)}
          onClose={menu.close}
          width={200}
          above
        >
          <StripMenuItems id={menu.menu.data.id} at={menu.menu.data.at} canPaste={canPaste} selected={chosen} />
        </Menu.Context>
      )}
    </div>
  );
}

/** The Develop strip's right-click items for photo `id` (its place `at` in the strip). */
function StripMenuItems({
  id,
  at,
  canPaste,
  selected,
}: {
  id: string;
  at: number;
  canPaste: boolean;
  selected: ReadonlySet<string>;
}) {
  return (
    <>
      <MenuItem
        onSelect={() => {
          if (!makeVersion(id)) devLog('develop', 'version not made: the folder library is not loaded', { id });
          useUiStore.getState().setDevelopIndex(at);
        }}
      >
        Make a version
      </MenuItem>
      <MenuSeparator />
      <MenuItem shortcut="⇧⌘C" onSelect={() => copySettings(id)}>
        Copy settings
      </MenuItem>
      <MenuItem
        shortcut="⇧⌘V"
        disabled={!canPaste}
        onSelect={() => {
          // Onto the selection when the photo is part of it, else onto this photo.
          const ids = selected.has(id) ? [...selected] : [id];
          void pasteSettings(ids);
        }}
      >
        Paste settings{selected.has(id) && selected.size > 1 ? ` to ${selected.size} photos` : ''}
      </MenuItem>
    </>
  );
}

/** The ▾ of a split button. */
function ChevronDown() {
  return (
    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
