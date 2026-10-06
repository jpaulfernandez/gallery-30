import { type SitePassword, verifyPassword } from '@photobook/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { writeGrant } from '../storage';

/**
 * The soft site password over the blurred cover. A correct word stores `{ version, grantedAt }` in
 * local storage (see `grantIsValid`) and the device is not asked again until the word changes.
 */
export function PasswordGate({
  password,
  cover,
  onGranted,
}: {
  password: SitePassword;
  cover: string | null;
  onGranted: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [word, setWord] = useState('');
  const [wrong, setWrong] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!word.trim() || checking) return;
    setChecking(true);
    const ok = await verifyPassword(word, password);
    setChecking(false);
    if (ok) {
      writeGrant({ version: password.version, grantedAt: new Date().toISOString() });
      onGranted();
    } else {
      setWrong(true);
      input.current?.select();
    }
  };

  return (
    <div class="pv-gate">
      {cover && <div class="pv-gate-cover" style={{ backgroundImage: `url("${cover}")` }} aria-hidden="true" />}
      <form class="pv-gate-form" onSubmit={submit}>
        <p class="pv-gate-title">This book is private</p>
        <input
          ref={input}
          class={wrong ? 'pv-input is-wrong' : 'pv-input'}
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Password"
          value={word}
          aria-label="Password"
          aria-invalid={wrong}
          aria-describedby="pv-gate-error"
          onInput={(e) => {
            setWord(e.currentTarget.value);
            setWrong(false);
          }}
        />
        <button type="submit" class="pv-button" disabled={checking || !word.trim()}>
          Open
        </button>
        <p id="pv-gate-error" class="pv-gate-error" role="alert">
          {wrong ? 'That’s not it. Try again.' : ''}
        </p>
      </form>
    </div>
  );
}
