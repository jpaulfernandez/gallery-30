// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiSettings } from '../../lib/tauri';

const settings = (patch: Partial<AiSettings> = {}): AiSettings => ({
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  indexModel: 'claude-haiku-5-5',
  hasKey: false,
  keyHint: null,
  ...patch,
});

const mocks = vi.hoisted(() => ({
  readAiSettings: vi.fn(),
  writeAiSettings: vi.fn(),
  aiTest: vi.fn(),
}));
vi.mock('../../lib/tauri', () => mocks);

const { AiPanel } = await import('./AiPanel');

describe('AiPanel', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('saves the key, never shows it again, and reports the model on Test', async () => {
    mocks.readAiSettings.mockResolvedValue(settings());
    mocks.writeAiSettings.mockResolvedValue(settings({ hasKey: true, keyHint: '…7f3a' }));
    mocks.aiTest.mockResolvedValue({ model: 'claude-opus-5-5', inputTokens: 9 });
    render(<AiPanel />);
    const input = (await screen.findByPlaceholderText('sk-ant-…')) as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'sk-ant-api03-abc-7f3a' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Test' })));
    expect(mocks.writeAiSettings).toHaveBeenCalledWith({ key: 'sk-ant-api03-abc-7f3a' });
    expect(input.value).toBe('');
    expect(input.placeholder).toContain('…7f3a');
    expect((await screen.findByRole('status')).textContent).toBe('The key works (checked with Claude Opus 5.5).');
    expect(screen.getByText(/to nobody else; nothing is sent until you press/)).toBeTruthy();
  });

  it('shows a readable error for a rejected key', async () => {
    mocks.readAiSettings.mockResolvedValue(settings({ hasKey: true, keyHint: '…dead' }));
    mocks.aiTest.mockRejectedValue('Anthropic rejected the API key (invalid x-api-key). Check it in Settings → AI.');
    render(<AiPanel />);
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Test' })));
    expect((await screen.findByRole('status')).textContent).toContain('Anthropic rejected the API key');
    expect(mocks.writeAiSettings).not.toHaveBeenCalled();
  });
});
