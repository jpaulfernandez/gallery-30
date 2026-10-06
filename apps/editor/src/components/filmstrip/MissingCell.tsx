import { open } from '@tauri-apps/plugin-dialog';
import { memo, useState } from 'react';
import { errorMessage } from '../../lib/errors';
import { devError } from '../../lib/log';
import { basename } from '../../lib/path';
import { useAssetsStore } from '../../store/assets';
import type { MissingAsset } from '../../store/relink';
import { relativeInside } from '../../store/relink';

interface MissingCellProps {
  asset: MissingAsset;
}

/**
 * A book photo whose file is gone from the folder. Locate opens the native file dialog and relinks
 * the asset to the chosen file, which must live inside the source folder (the fs scope ends there).
 */
export const MissingCell = memo(function MissingCell({ asset }: MissingCellProps) {
  const folder = useAssetsStore((s) => s.folder);
  const busy = useAssetsStore((s) => s.busy);
  const relink = useAssetsStore((s) => s.relink);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = basename(asset.path);

  async function locate() {
    if (!folder || working) return;
    setError(null);
    setWorking(true);
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        defaultPath: folder,
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'heic', 'heif'] }],
      });
      if (typeof picked !== 'string') return;
      const relPath = relativeInside(folder, picked);
      if (!relPath) {
        setError('Pick a file inside the book folder');
        return;
      }
      await relink(asset.assetId, relPath);
    } catch (err) {
      setError(errorMessage(err));
      devError('filmstrip', 'locate failed', err);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div
      data-asset-id={asset.assetId}
      data-status="missing"
      title={`${asset.path}\nThe file is not in the folder any more`}
      className="relative flex aspect-square flex-col items-center justify-center gap-1 overflow-hidden rounded-sm border border-fg-muted border-dashed p-1 text-center"
    >
      <span className="w-full truncate text-[10px] text-fg">{name}</span>
      <span className="text-[10px] text-fg-muted">Missing</span>
      <button
        type="button"
        onClick={locate}
        disabled={busy || working}
        className="rounded-md border border-line bg-panel-2 px-1.5 py-0.5 text-[10px] text-fg outline-none hover:border-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      >
        Locate
      </button>
      {error && (
        <span role="alert" className="line-clamp-2 w-full text-[9px] text-red-300 leading-tight">
          {error}
        </span>
      )}
    </div>
  );
});
