import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A hidden window must keep its JS running: scans, exports and publish are JS-driven jobs, and macOS suspends an
// invisible WebContent process after a few seconds unless background throttling is off (wave 7 smoke, Oct 14, 2026).
describe('tauri.conf.json main window', () => {
  const conf = JSON.parse(readFileSync(resolve(__dirname, '../../src-tauri/tauri.conf.json'), 'utf8'));
  const main = conf.app.windows.find((w: { label: string }) => w.label === 'main');

  it('keeps the webview running while hidden', () => {
    expect(main.backgroundThrottling).toBe('disabled');
  });

  it('keeps native file drop off so dnd-kit drags work', () => {
    expect(main.dragDropEnabled).toBe(false);
  });
});
