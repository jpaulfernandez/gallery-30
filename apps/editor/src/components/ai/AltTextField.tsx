import { ALT_MAX } from '@photobook/shared';
import { useEffect, useState } from 'react';
import { useBookStore } from '../../store/book';
import { inputClass } from '../editor/inspectorUi';

/**
 * A photo's alt text in the photo inspector (workflow plan 35): what screen readers say for it in the published
 * book. Written by the AI captions when the photo has none, editable here; committed on Enter or blur through
 * `setAssetAlt` (blank removes it; at most `ALT_MAX` characters). Escape puts the saved text back. Alt edits are not in
 * the undo history (the newest alt always survives undo), which the field's tooltip says.
 */
export function AltTextField({ assetId }: { assetId: string }) {
  const saved = useBookStore((s) => s.book?.assets[assetId]?.alt ?? '');
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const commit = () => useBookStore.getState().setAssetAlt(assetId, draft);

  return (
    <label className="block space-y-1">
      <span className="text-fg-muted text-xs">Alt text</span>
      <textarea
        value={draft}
        rows={2}
        maxLength={ALT_MAX}
        title="Read aloud by screen readers in the published book. Alt text edits are not in the undo history."
        placeholder="What the photo shows, for screen readers"
        aria-label="Alt text"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(saved);
          }
        }}
        className={`${inputClass} w-full resize-y select-text`}
      />
    </label>
  );
}
