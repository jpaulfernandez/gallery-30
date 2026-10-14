import { AI_MODELS, AI_PRICING, AI_PRICING_DATE, type AiModel, aiModelLabel } from '@photobook/shared';
import { useEffect, useState } from 'react';
import { formatUsd } from '../../lib/ai/cost';
import { errorMessage } from '../../lib/errors';
import { type AiSettingsUpdate, aiTest } from '../../lib/tauri';
import { useAiStore } from '../../store/ai';
import { buttonClass as buttonLook } from '../ui/Button';

const inputClass =
  'w-full rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-fg text-xs outline-none focus:border-accent';
// Plan 45: the look of a `Button` (components/ui) on these plain buttons.
const buttonClass = buttonLook({ size: 'sm' });

type Check = { ok: boolean; message: string } | 'testing' | null;

function priceLine(model: AiModel): string {
  const p = AI_PRICING[model];
  return `${p.label}: $${p.input} in, $${p.output} out per million tokens`;
}

/**
 * Settings → AI (workflow plan 32): provider, API key (masked; stored by Rust in `<appdata>/ai.env`, never shown
 * again), the caption and index models, a Test button that counts tokens with the stored key (free), this month's
 * usage and the privacy sentence. It saves on its own, like Models, not through the page's Save.
 */
export function AiPanel() {
  const settings = useAiStore((s) => s.settings);
  const loadError = useAiStore((s) => s.error);
  const month = useAiStore((s) => s.month);
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [check, setCheck] = useState<Check>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void useAiStore.getState().load();
  }, []);

  if (!settings) {
    return (
      <section className="space-y-3">
        <h2 className="section-title">AI</h2>
        <p className="text-fg-muted text-xs">{loadError ?? 'Loading…'}</p>
      </section>
    );
  }

  const save = async (update: AiSettingsUpdate, done: string) => {
    setBusy(true);
    try {
      await useAiStore.getState().save(update);
      setStatus(done);
      return true;
    } catch (err) {
      setStatus(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async () => {
    if (await save({ key: key.trim() }, 'Key saved')) {
      setKey('');
      setCheck(null);
    }
  };

  const test = async () => {
    if (key.trim() && !(await save({ key: key.trim() }, 'Key saved'))) return;
    setKey('');
    setCheck('testing');
    try {
      const result = await aiTest();
      // count_tokens names no model: this is the configured one the key was checked against.
      setCheck({ ok: true, message: `The key works (checked with ${aiModelLabel(result.model)}).` });
    } catch (err) {
      setCheck({ ok: false, message: errorMessage(err) });
    }
  };

  const tokens = month.usage.inputTokens + month.usage.outputTokens + month.usage.cacheCreationInputTokens;
  const cached = month.usage.cacheReadInputTokens;

  return (
    <section className="space-y-3">
      <h2 className="section-title">AI</h2>
      <label className="block space-y-1">
        <span className="text-fg-muted text-xs">Provider</span>
        <select value={settings.provider} disabled className={inputClass}>
          <option value="anthropic">Anthropic (Claude)</option>
        </select>
      </label>

      <label className="block space-y-1">
        <span className="text-fg-muted text-xs">API key</span>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={
            settings.hasKey ? `Saved (${settings.keyHint ?? '…'}); paste a new one to replace it` : 'sk-ant-…'
          }
          spellCheck={false}
          autoComplete="off"
          className={inputClass}
        />
        <span className="block text-[11px] text-fg-muted/80">
          From console.anthropic.com, API keys. Stored in ai.env in the app's data folder, readable only by you.
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void saveKey()} disabled={busy || !key.trim()} className={buttonClass}>
          Save key
        </button>
        <button
          type="button"
          onClick={() => void test()}
          disabled={busy || check === 'testing' || (!settings.hasKey && !key.trim())}
          className={buttonClass}
        >
          {check === 'testing' ? 'Testing…' : 'Test'}
        </button>
        {settings.hasKey && (
          <button
            type="button"
            onClick={() => void save({ key: '' }, 'Key removed').then(() => setCheck(null))}
            disabled={busy}
            className={buttonClass}
          >
            Remove key
          </button>
        )}
        {status && <span className="text-fg-muted text-xs">{status}</span>}
      </div>
      {check && check !== 'testing' && (
        <p role="status" className={`break-words text-xs ${check.ok ? 'text-ok' : 'text-danger'}`}>
          {check.message}
        </p>
      )}

      <label className="block space-y-1">
        <span className="text-fg-muted text-xs">Model for captions</span>
        <select
          value={settings.model}
          onChange={(e) => void save({ model: e.target.value as AiModel }, 'Saved')}
          disabled={busy}
          className={inputClass}
        >
          {AI_MODELS.map((m) => (
            <option key={m} value={m}>
              {AI_PRICING[m].label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-fg-muted text-xs">Model for describing photos</span>
        <select
          value={settings.indexModel}
          onChange={(e) => void save({ indexModel: e.target.value as AiModel }, 'Saved')}
          disabled={busy}
          className={inputClass}
        >
          {AI_MODELS.map((m) => (
            <option key={m} value={m}>
              {AI_PRICING[m].label}
            </option>
          ))}
        </select>
        <span className="block text-[11px] text-fg-muted/80">
          {priceLine(settings.model)}. {priceLine(settings.indexModel)}. Prices as of {AI_PRICING_DATE}.
        </span>
      </label>

      <p className="text-fg-muted text-xs" data-testid="ai-usage">
        This month: {tokens.toLocaleString('en-US')} tokens
        {cached > 0 ? ` and ${cached.toLocaleString('en-US')} read from cache` : ''}, about {formatUsd(month.usd)} over{' '}
        {month.requests} {month.requests === 1 ? 'request' : 'requests'} (estimated on this computer from each answer)
        {month.unpricedTokens > 0
          ? `; ${month.unpricedTokens.toLocaleString('en-US')} tokens on models without a price here are not in the dollars`
          : ''}
        .
      </p>
      <p className="text-[11px] text-fg-muted">
        Photos on the page are sent to the provider you configured, and to nobody else; nothing is sent until you press
        Generate. The key never goes into a project or a photo folder.
      </p>
    </section>
  );
}
