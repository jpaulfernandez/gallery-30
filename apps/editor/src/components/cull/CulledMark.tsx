import { useBookStore } from '../../store/book';
import { folderCulled } from '../../store/decide';
import { useLibraryStore } from '../../store/library';

/**
 * The small check on a folder's sidebar row (plan 40): the folder was culled (`library.cull.culledAt`, stamped when a
 * Decide pass ends) and no photo of it is undecided, so a new photo takes the check away until it is decided.
 */
export function CulledMark({ folderId }: { folderId: string }) {
  const folder = useLibraryStore((s) => s.folders[folderId]);
  const culled = useBookStore((s) => folderCulled(folder, s.libraries));
  if (!culled) return null;
  return (
    <span role="img" aria-label="Culled" title="Culled: every photo kept or rejected" className="text-ok">
      ✓
    </span>
  );
}
