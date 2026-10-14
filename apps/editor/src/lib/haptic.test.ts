// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../store/ui';
import { HAPTIC_INTERVAL_MS, resetHapticClock, tick } from './haptic';

const haptic = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./tauri', () => ({ haptic }));

let reduced = false;
let now = 1000;

beforeEach(() => {
  reduced = false;
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  window.matchMedia = ((query: string) => ({ matches: reduced && query.includes('reduce') })) as never;
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  useUiStore.setState({ haptics: true, zoom: 'fit', fitZoom: 0.8 });
  resetHapticClock();
  haptic.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('tick', () => {
  it('plays the kind asked for', () => {
    expect(tick('alignment')).toBe(true);
    expect(haptic).toHaveBeenCalledWith('alignment');
  });

  it('lets one tick through per interval', () => {
    expect(tick()).toBe(true);
    now += HAPTIC_INTERVAL_MS - 1;
    expect(tick()).toBe(false);
    now += 1;
    expect(tick()).toBe(true);
    expect(haptic).toHaveBeenCalledTimes(2);
  });

  it('is off when the Settings switch is off', () => {
    useUiStore.setState({ haptics: false });
    expect(tick('alignment')).toBe(false);
    expect(haptic).not.toHaveBeenCalled();
  });

  it('is off under reduced motion', () => {
    reduced = true;
    expect(tick('alignment')).toBe(false);
    expect(haptic).not.toHaveBeenCalled();
  });

  it('plays nothing outside Tauri', () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    expect(tick()).toBe(true);
    expect(haptic).not.toHaveBeenCalled();
  });
});

describe('zoom', () => {
  it('ticks when the canvas zoom reaches Fit or 100 %, or passes 100 %', () => {
    useUiStore.getState().setZoom(0.5);
    expect(haptic).not.toHaveBeenCalled();
    now += 100;
    useUiStore.getState().setZoom(1);
    expect(haptic).toHaveBeenLastCalledWith('levelChange');
    now += 100;
    useUiStore.getState().setZoom(1.5);
    expect(haptic).toHaveBeenCalledTimes(1);
    now += 100;
    useUiStore.getState().setZoom(0.75);
    expect(haptic).toHaveBeenCalledTimes(2);
    now += 100;
    useUiStore.getState().setZoom('fit');
    expect(haptic).toHaveBeenCalledTimes(3);
  });

  it('stays silent when the store is reset to Fit (a book opening or closing)', () => {
    useUiStore.getState().setZoom(2);
    now += 100;
    haptic.mockClear();
    useUiStore.getState().reset();
    expect(useUiStore.getState().zoom).toBe('fit');
    expect(haptic).not.toHaveBeenCalled();
    now += 100;
    useUiStore.setState({ zoom: 1 });
    expect(haptic).not.toHaveBeenCalled();
  });
});
