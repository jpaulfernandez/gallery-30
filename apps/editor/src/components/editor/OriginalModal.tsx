import { useEffect, useState } from 'react';
import { devError, devLog } from '../../lib/log';
import { basename, join } from '../../lib/path';
import { fileUrl } from '../../lib/tauri';
import { fileOfAsset, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { assetFolder } from '../../store/library';
import { useUiStore } from '../../store/ui';

/** Full-resolution original on black for inspection. Click or Escape closes. */
export function OriginalModal() {
  const target = useUiStore((s) => s.originalModal);
  const close = useUiStore((s) => s.closeOriginal);
  const folder = useBookStore((s) => (target ? assetFolder(s, target.assetId) : null));
  const asset = useBookStore((s) => (target ? s.book?.assets[target.assetId] : undefined));
  const file = useAssetsStore((s) => (asset ? fileOfAsset(s.files, target?.assetId) : undefined));
  const [failed, setFailed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the fallback when another asset opens
  useEffect(() => setFailed(false), [target?.assetId]);

  if (!target || !asset || !folder) return null;

  // The webview cannot decode every original (e.g. some HEIC files); fall back to the proxy.
  const original = originalUrl(folder, asset.path);
  const src = failed || !original ? (file?.proxyUrl ?? null) : original;
  const width = asset.width ?? file?.width;
  const height = asset.height ?? file?.height;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes through the shell shortcuts
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Original: ${basename(asset.path)}`}
      className="fixed inset-0 z-50 flex cursor-zoom-out flex-col items-center justify-center gap-4 bg-stage/95 p-8"
      onClick={close}
    >
      {src ? (
        <img
          src={src}
          alt={basename(asset.path)}
          draggable={false}
          className="min-h-0 max-w-full flex-1 object-contain"
          onError={() => {
            devLog('canvas', 'original image error', { url: src });
            if (!failed) setFailed(true);
          }}
        />
      ) : (
        <p className="flex-1 content-center text-fg-muted">The original could not be displayed.</p>
      )}
      <div className="flex items-baseline gap-3 text-xs">
        <span className="text-fg">{basename(asset.path)}</span>
        {width && height && (
          <span className="text-fg-muted tabular-nums">
            {width} × {height}
          </span>
        )}
        {failed && <span className="text-fg-muted">(showing the 1600 px proxy)</span>}
        <span className="text-fg-muted">Esc to close</span>
      </div>
    </div>
  );
}

/** Asset-protocol URL of the original, or null outside Tauri (plain browser dev). */
function originalUrl(folder: string, relPath: string): string | null {
  try {
    return fileUrl(join(folder, relPath));
  } catch (err) {
    devError('canvas', 'original url failed', err);
    return null;
  }
}
