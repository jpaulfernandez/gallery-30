import { DISPLAY_NAME_MAX } from '@photobook/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ANONYMOUS, cleanName } from '../social';

/**
 * Asked once per device before the first like, download, share, zip or page share. The name goes
 * with every event so the book's owner sees who saved what; nobody else sees it. Skip uses
 * "Anonymous". Loaded on demand (dynamic import in `Reader`).
 */
export default function NamePrompt({ onDone, onCancel }: { onDone: (name: string) => void; onCancel: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const name = cleanName(value);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div class="pv-modal" role="dialog" aria-modal="true" aria-labelledby="pv-name-title">
      <form
        class="pv-modal-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (name) onDone(name);
        }}
      >
        <p id="pv-name-title" class="pv-modal-title">
          What should we call you?
        </p>
        <p class="pv-muted">Only the person who made this book sees it, next to what you like and save.</p>
        <input
          ref={input}
          class="pv-input"
          type="text"
          name="nickname"
          autoComplete="nickname"
          autoCapitalize="words"
          enterKeyHint="done"
          maxLength={DISPLAY_NAME_MAX}
          placeholder="Your name"
          aria-label="Your name"
          value={value}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
        <button type="submit" class="pv-button pv-button-block" disabled={!name}>
          Continue
        </button>
        <button type="button" class="pv-link" onClick={() => onDone(ANONYMOUS)}>
          Skip
        </button>
      </form>
    </div>
  );
}
