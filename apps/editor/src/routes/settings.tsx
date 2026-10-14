import { useRouter } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { AiPanel } from '../components/settings/AiPanel';
// Plan 44: Appearance (the surround).
import { AppearancePanel } from '../components/settings/AppearancePanel';
import { ModelsPanel } from '../components/settings/ModelsPanel';
// Workflow plan 16: FFmpeg for slideshow videos.
import { ToolsPanel } from '../components/settings/ToolsPanel';
import { Button } from '../components/ui/Button';
import { Field, Input, Select } from '../components/ui/Field';
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

/**
 * Step 2.7: publish settings, stored in `<appdata>/publish.env` (never in the project file) and
 * read by the CLI. "Test connection" runs `photobook doctor`; "Remove site-wide password" drops the
 * old password from `site.json` (`photobook password clear`); passwords are set per book now.
 * Models (D4.2) lists the downloadable ONNX models; it has its own state and does not use Save.
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
    return (
      <SettingsPage onBack={() => router.history.back()}>
        <p className="text-fg-muted">{status ?? 'Loading…'}</p>
      </SettingsPage>
    );
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

  const run = async (command: 'doctor' | 'password-clear') => {
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
    <Field key={f.key} label={f.label} hint={f.hint}>
      <Input
        type={f.type ?? 'text'}
        value={values[f.key] ?? ''}
        onChange={(e) => set(f.key, e.target.value)}
        placeholder={f.placeholder}
        spellCheck={false}
        autoComplete="off"
        className="w-full"
      />
    </Field>
  );

  return (
    <SettingsPage
      onBack={() => router.history.back()}
      actions={
        <>
          <span className="text-fg-muted text-xs">{status}</span>
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={!dirty}>
            Save
          </Button>
        </>
      }
    >
      <AppearancePanel />

      <section className="space-y-3">
        <h2 className="section-title">Cloudflare R2</h2>
        <Field label="Transport">
          <Select value={values.R2_TRANSPORT ?? 's3'} onChange={(e) => set('R2_TRANSPORT', e.target.value)}>
            <option value="s3">S3 API keys (fast, needed for prune and unpublish)</option>
            <option value="wrangler">wrangler CLI login (slower, no keys needed)</option>
          </Select>
        </Field>
        {R2_FIELDS.filter(
          (f) => (values.R2_TRANSPORT ?? 's3') === 's3' || f.key === 'R2_BUCKET' || f.key === 'R2_PUBLIC_URL',
        ).map(field)}
        <Button onClick={() => void run('doctor')} disabled={busy}>
          Test connection
        </Button>
      </section>

      <section className="space-y-3">
        <h2 className="section-title">Site</h2>
        {SITE_FIELDS.map(field)}
        <p className="text-[11px] text-fg-muted">
          Passwords are set per book, under Publish in the book's settings. A site-wide password from an earlier version
          still guards the book list and books not republished since; remove it once every book that needs one has its
          own.
        </p>
        <Button onClick={() => void run('password-clear')} disabled={busy}>
          Remove site-wide password
        </Button>
      </section>

      <section className="space-y-3">
        <h2 className="section-title">Likes and downloads</h2>
        {SOCIAL_FIELDS.map(field)}
        <div className="flex items-center gap-3">
          <Button onClick={() => void testWorker()} disabled={workerCheck === 'testing'}>
            {workerCheck === 'testing' ? 'Testing…' : 'Test'}
          </Button>
          {workerCheck && workerCheck !== 'testing' && (
            <span role="status" className={`min-w-0 break-words text-xs ${workerCheck.ok ? 'text-ok' : 'text-danger'}`}>
              {workerCheck.message}
            </span>
          )}
        </div>
        <p className="text-[11px] text-fg-muted">
          Test checks the Worker URL (GET /v1/health). The Downloads tab in the editor reads the log with the token.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="section-title">Download version</h2>
        {IMAGE_FIELDS.map(field)}
      </section>

      <AiPanel />

      <ModelsPanel />

      <ToolsPanel />

      {log.length > 0 && (
        <pre className="scrollbar max-h-48 overflow-auto rounded-md bg-panel-2 p-3 font-mono text-[11px] leading-relaxed">
          {log.join('\n')}
        </pre>
      )}
      <p className="text-[11px] text-fg-muted">Setup steps for the bucket and the viewer are in docs/PUBLISHING.md.</p>
    </SettingsPage>
  );
}

/**
 * Plan 49: Settings' frame, the same bar as Home's (plan 50): 44 px, `panel-2` over a hairline, the window drags from
 * anywhere in it but its controls, and the traffic lights sit in the 78 px inset. Back and the title on the left, the
 * save status and Save on the right; the page scrolls under it (plan 43's floating 32 px strip is gone).
 */
function SettingsPage({ onBack, actions, children }: { onBack: () => void; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-canvas">
      <header
        data-tauri-drag-region="deep"
        className="flex h-11 shrink-0 items-center gap-3 border-hairline border-b bg-panel-2 pr-3 pl-[78px]"
      >
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <h1 className="m-0 font-medium text-[13px] text-fg">Settings</h1>
        <span className="ml-auto flex items-center gap-3">{actions}</span>
      </header>
      <main className="scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto flex max-w-xl flex-col gap-6 p-8">{children}</div>
      </main>
    </div>
  );
}
