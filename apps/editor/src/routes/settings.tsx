import { useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { errorMessage } from '../lib/errors';
import { type PublishEvent, startPublish } from '../lib/publishRunner';
import { checkHealth } from '../lib/socialApi';
import { type PublishSettingKey, type PublishSettings, readPublishSettings, writePublishSettings } from '../lib/tauri';

interface FieldDef {
  key: PublishSettingKey;
  label: string;
  hint?: string;
  type?: 'text' | 'password' | 'number' | 'url';
  placeholder?: string;
}

const R2_FIELDS: FieldDef[] = [
  { key: 'R2_BUCKET', label: 'Bucket', placeholder: 'photobook' },
  {
    key: 'R2_PUBLIC_URL',
    label: 'Public base URL',
    type: 'url',
    placeholder: 'https://pub-….r2.dev or https://cdn.example.com',
  },
  { key: 'R2_ACCOUNT_ID', label: 'Account ID', hint: 'Cloudflare dashboard, R2 overview' },
  { key: 'R2_ACCESS_KEY_ID', label: 'Access key ID', hint: 'R2 API token with object read and write' },
  { key: 'R2_SECRET_ACCESS_KEY', label: 'Secret access key', type: 'password' },
];

const SITE_FIELDS: FieldDef[] = [
  {
    key: 'VIEWER_URL',
    label: 'Viewer URL',
    type: 'url',
    placeholder: 'https://your-viewer.vercel.app',
    hint: 'Where the reader is deployed; used for the links',
  },
  {
    key: 'SITE_PASSWORD',
    label: 'Site password',
    type: 'password',
    hint: 'The one word friends type once per device. Changing it asks every device again',
  },
  {
    key: 'SITE_PASSWORD_EXPIRES_AT',
    label: 'Password expires',
    placeholder: '2027-01-01T00:00:00Z',
    hint: 'Optional ISO date',
  },
];

const IMAGE_FIELDS: FieldDef[] = [
  { key: 'DOWNLOAD_MAX_EDGE', label: 'Download long edge (px)', type: 'number', placeholder: '4096' },
  { key: 'DOWNLOAD_QUALITY', label: 'Download JPEG quality', type: 'number', placeholder: '88' },
];

const SOCIAL_FIELDS: FieldDef[] = [
  {
    key: 'SOCIAL_API_URL',
    label: 'Worker URL',
    type: 'url',
    placeholder: 'https://photobook-social.<you>.workers.dev',
    hint: 'The Cloudflare Worker that records likes and downloads; written into site.json on the next publish',
  },
  {
    key: 'SOCIAL_ADMIN_TOKEN',
    label: 'Admin token',
    type: 'password',
    hint: 'The ADMIN_TOKEN secret of the Worker; lets this app read the download log',
  },
];

const inputClass =
  'w-full rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-fg text-xs outline-none focus:border-accent';

/**
 * Step 2.7: publish settings, stored in `<appdata>/publish.env` (never in the project file) and
 * read by the CLI. "Test connection" runs `photobook doctor`; "Apply password" rewrites
 * `site.json` alone (`photobook password sync`).
 */
export function SettingsRoute() {
  const router = useRouter();
  const [values, setValues] = useState<PublishSettings | null>(null);
  const [saved, setSaved] = useState<PublishSettings | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [workerCheck, setWorkerCheck] = useState<{ ok: boolean; message: string } | 'testing' | null>(null);

  useEffect(() => {
    readPublishSettings().then(
      (v) => {
        setValues(v);
        setSaved(v);
      },
      (err) => setStatus(errorMessage(err)),
    );
  }, []);

  if (!values) {
    return <div className="p-8 text-fg-muted">{status ?? 'Loading…'}</div>;
  }
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);
  const set = (key: PublishSettingKey, v: string) => setValues((s) => ({ ...s, [key]: v }));

  const save = async (): Promise<boolean> => {
    try {
      await writePublishSettings(values);
      setSaved(values);
      setStatus('Saved');
      return true;
    } catch (err) {
      setStatus(errorMessage(err));
      return false;
    }
  };

  const run = async (command: 'doctor' | 'password-sync') => {
    if (dirty && !(await save())) return;
    setBusy(true);
    setLog([]);
    const lines: string[] = [];
    const onEvent = (e: PublishEvent) => {
      if (e.type === 'log') lines.push(e.message);
      else if (e.type === 'error') lines.push(`Error: ${e.message}`);
      else if (e.type === 'raw' && e.line.trim()) lines.push(e.line);
      setLog([...lines]);
    };
    const { done } = await startPublish({ command }, onEvent);
    const code = await done;
    if (code !== 0) lines.push(code === null ? 'Cancelled' : `Exited with code ${code}`);
    setLog([...lines]);
    setBusy(false);
  };

  const testWorker = async () => {
    const url = (values.SOCIAL_API_URL ?? '').trim();
    if (!url) {
      setWorkerCheck({ ok: false, message: 'Enter the Worker URL first' });
      return;
    }
    setWorkerCheck('testing');
    try {
      await checkHealth(url);
      setWorkerCheck({ ok: true, message: 'ok' });
    } catch (err) {
      setWorkerCheck({ ok: false, message: errorMessage(err) });
    }
  };

  const field = (f: FieldDef) => (
    <label key={f.key} className="block space-y-1">
      <span className="text-fg-muted text-xs">{f.label}</span>
      <input
        type={f.type ?? 'text'}
        value={values[f.key] ?? ''}
        onChange={(e) => set(f.key, e.target.value)}
        placeholder={f.placeholder}
        spellCheck={false}
        autoComplete="off"
        className={inputClass}
      />
      {f.hint && <span className="block text-[11px] text-fg-muted/80">{f.hint}</span>}
    </label>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-xl flex-col gap-6 p-8">
        <div className="flex items-center justify-between">
          <button type="button" onClick={() => router.history.back()} className="text-fg-muted hover:text-fg">
            ← Back
          </button>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-fg-muted">{status}</span>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty}
              className="rounded-md bg-accent px-3 py-1.5 text-white disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
        <h1 className="font-medium text-xl">Settings</h1>

        <section className="space-y-3">
          <h2 className="label">Cloudflare R2</h2>
          <label className="block space-y-1">
            <span className="text-fg-muted text-xs">Transport</span>
            <select
              value={values.R2_TRANSPORT ?? 's3'}
              onChange={(e) => set('R2_TRANSPORT', e.target.value)}
              className={inputClass}
            >
              <option value="s3">S3 API keys (fast, needed for prune and unpublish)</option>
              <option value="wrangler">wrangler CLI login (slower, no keys needed)</option>
            </select>
          </label>
          {R2_FIELDS.filter(
            (f) => (values.R2_TRANSPORT ?? 's3') === 's3' || f.key === 'R2_BUCKET' || f.key === 'R2_PUBLIC_URL',
          ).map(field)}
          <button
            type="button"
            onClick={() => void run('doctor')}
            disabled={busy}
            className="rounded-md border border-line px-3 py-1.5 text-xs hover:border-accent disabled:opacity-40"
          >
            Test connection
          </button>
        </section>

        <section className="space-y-3">
          <h2 className="label">Site</h2>
          {SITE_FIELDS.map(field)}
          <button
            type="button"
            onClick={() => void run('password-sync')}
            disabled={busy}
            className="rounded-md border border-line px-3 py-1.5 text-xs hover:border-accent disabled:opacity-40"
          >
            Apply password to the site now
          </button>
          <p className="text-[11px] text-fg-muted">Every publish also applies it; this rewrites only site.json.</p>
        </section>

        <section className="space-y-3">
          <h2 className="label">Likes and downloads</h2>
          {SOCIAL_FIELDS.map(field)}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void testWorker()}
              disabled={workerCheck === 'testing'}
              className="rounded-md border border-line px-3 py-1.5 text-xs hover:border-accent disabled:opacity-40"
            >
              {workerCheck === 'testing' ? 'Testing…' : 'Test'}
            </button>
            {workerCheck && workerCheck !== 'testing' && (
              <span
                role="status"
                className={`min-w-0 break-words text-xs ${workerCheck.ok ? 'text-emerald-400' : 'text-red-400'}`}
              >
                {workerCheck.message}
              </span>
            )}
          </div>
          <p className="text-[11px] text-fg-muted">
            Test checks the Worker URL (GET /v1/health). The Downloads tab in the editor reads the log with the token.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="label">Download version</h2>
          {IMAGE_FIELDS.map(field)}
        </section>

        {log.length > 0 && (
          <pre className="max-h-48 overflow-auto rounded-md bg-panel-2 p-3 font-mono text-[11px] leading-relaxed">
            {log.join('\n')}
          </pre>
        )}
        <p className="text-[11px] text-fg-muted">
          Setup steps for the bucket and the viewer are in docs/PUBLISHING.md.
        </p>
      </div>
    </div>
  );
}
