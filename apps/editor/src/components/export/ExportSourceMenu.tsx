import { errorMessage } from '../../lib/errors';
import { devLog } from '../../lib/log';
import type { LibrarySource } from '../../store/collections';
import { Menu, MenuItem } from '../ui/Menu';
import { exportLibrarySource } from './entryPoints';

/** A sidebar folder or collection right-clicked for Export (workflow plan 11). */
export interface ExportSourceMenuState {
  x: number;
  y: number;
  source: LibrarySource;
  name: string;
  /** A folder's absolute path (read from its index when this session has not read it). */
  path?: string;
}

/**
 * The right-click menu of a sidebar folder or built-in collection: Export… opens the dialog on all its photos. Plan 45:
 * on `Menu.Context`.
 */
export function ExportSourceMenu({ menu, onClose }: { menu: ExportSourceMenuState; onClose: () => void }) {
  const exportAll = () => {
    exportLibrarySource(menu.source, menu.name, menu.path).catch((err) =>
      devLog('export', 'source not exported', { error: errorMessage(err) }),
    );
  };
  return (
    <Menu.Context at={{ x: menu.x, y: menu.y }} label={menu.name} onClose={onClose} width={180}>
      <MenuItem onSelect={exportAll}>Export “{menu.name}”…</MenuItem>
    </Menu.Context>
  );
}
