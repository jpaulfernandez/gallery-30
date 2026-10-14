import { devError } from '../../lib/log';
import { useAssetsStore } from '../../store/assets';

/**
 * Commit an asset's current develop settings: render the cached proxy and thumbnail for them so the book
 * canvas and the filmstrip show the edit (plan section 5, "Preview flow" step 4).
 *
 * The Develop view calls this when a slider drag ends (pointer up) and 300 ms after the last change
 * otherwise, once per burst of edits, never for an unchanged photo. It also runs when the view closes or
 * steps to another photo with a change still pending.
 *
 * Delegates to the assets store's `renderDeveloped`, which reads `book.assets[assetId].develop`, calls
 * `render_develop_cached` and records the files (unedited settings clear them). Never throws, and may be
 * called while a previous commit for the same asset is still running (the store queues one rerun).
 */
export async function commitDevelop(assetId: string): Promise<void> {
  try {
    await useAssetsStore.getState().renderDeveloped(assetId);
  } catch (err) {
    devError('develop', 'commit failed', err);
  }
}
