import { useCallback, useEffect, useState } from 'react';
import { allPresets, type Preset } from '../../lib/develop/presets';
import { devLog } from '../../lib/log';
import { listPresets } from '../../lib/tauri';

/**
 * The built-in presets followed by the saved ones, loaded from the app data dir when `active` turns true (a menu
 * or dialog opens), so nothing is read while the panel is closed. A failed read leaves the built-in ones and sets `error`.
 */
export function usePresets(active: boolean) {
  const [saved, setSaved] = useState<Preset[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSaved(await listPresets());
      setError(null);
    } catch (err) {
      devLog('develop', 'could not list presets', { error: String(err) });
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    if (active) void reload();
  }, [active, reload]);

  return { presets: allPresets(saved), saved, error, reload };
}
