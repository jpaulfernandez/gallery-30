import type { DevelopSettings } from '@photobook/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import { developSharpenMask } from '../../lib/tauri';
import { useMaskView } from './maskView';
import { nextPreviewJob, PREVIEW_COALESCE_MS, type PreviewSource } from './usePreview';

/** Wait until the browser has decoded `url`, so swapping the `<img>` source never flashes blank. */
async function decoded(url: string): Promise<void> {
  const img = new Image();
  img.src = url;
  if (typeof img.decode !== 'function') return;
  try {
    await img.decode();
  } catch {
    // A bad image is reported by the <img> itself; the swap still happens.
  }
}

/**
 * The sharpening mask for the Alt-drag view: while `useMaskView` is active, requests `develop_sharpen_mask` for the
 * current photo and exposes the greyscale JPEG as a blob URL; null otherwise (and until the first mask arrives, so
 * the live preview stays up meanwhile). Follows `usePreview`'s pattern: requests are numbered, coalesced to one per
 * `PREVIEW_COALESCE_MS` carrying the newest settings, and a superseded result is dropped. Only the radius, the
 * masking and the geometry change the mask, so other edits do not re-request it. Releasing Alt or the pointer
 * (active turns false) frees the blob and the preview returns.
 */
export function useMaskPreview(source: PreviewSource, settings: DevelopSettings): string | null {
  const { folder, assetId, relPath, hash } = source;
  const active = useMaskView((s) => s.active);
  const sourceKey = folder && relPath && hash ? `${folder}\n${assetId}\n${relPath}\n${hash}` : null;
  const maskKey = useMemo(
    () => JSON.stringify([settings.detail.sharpen.radius, settings.detail.sharpen.masking, settings.geometry]),
    [settings],
  );

  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
  const urlRef = useRef<string | null>(null);
  const latestJob = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ folder, relPath, hash, settings, sourceKey });
  live.current = { folder, relPath, hash, settings, sourceKey };

  // Leaving mask view (or the photo): stop pending work, ignore in-flight requests, free the blob.
  useEffect(() => {
    if (!active || !sourceKey) return;
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      latestJob.current = nextPreviewJob();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
      setShown(null);
    };
  }, [active, sourceKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: maskKey stands for the settings; the run reads the newest from `live`
  useEffect(() => {
    if (!active || !sourceKey) return;
    // A request is already queued: it will read the newest settings when it fires.
    if (timer.current) return;
    timer.current = setTimeout(async () => {
      timer.current = null;
      const now = live.current;
      if (!now.folder || !now.relPath || !now.hash) return;
      const job = nextPreviewJob();
      latestJob.current = job;
      try {
        const bytes = await developSharpenMask(now.folder, now.relPath, now.hash, now.settings);
        if (job !== latestJob.current || bytes.byteLength === 0) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
        await decoded(url);
        if (job !== latestJob.current) {
          URL.revokeObjectURL(url);
          return;
        }
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setShown({ key: now.sourceKey ?? '', url });
      } catch (err) {
        if (job === latestJob.current) devLog('develop', 'sharpen mask unavailable', { error: errorMessage(err) });
      }
    }, PREVIEW_COALESCE_MS);
  }, [active, sourceKey, maskKey]);

  return active && shown && shown.key === sourceKey ? shown.url : null;
}
