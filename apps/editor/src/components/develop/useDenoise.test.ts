import { createDevelop, type DevelopGeometry } from '@photobook/shared';
import { describe, expect, it } from 'vitest';
import type { AiModelInfo, DenoiseStatus } from '../../lib/tauri';
import { containRect, denoisePhase, denoiseView, phaseLabel, previewCenter, shownPosition } from './useDenoise';

const geometry = (over: Partial<DevelopGeometry> = {}): DevelopGeometry => ({ ...createDevelop().geometry, ...over });
const crop = (angle = 0): DevelopGeometry =>
  geometry({ crop: { rect: { x: 0.2, y: 0.1, w: 0.5, h: 0.4 }, angle, aspect: 'free' } });

describe('previewCenter / shownPosition', () => {
  it('is the click position in the picture when there is no crop', () => {
    expect(previewCenter(0.25, 0.75, geometry())).toEqual([0.25, 0.75]);
    expect(shownPosition([0.25, 0.75], geometry())).toEqual([0.25, 0.75]);
  });

  it('clamps clicks to the picture', () => {
    expect(previewCenter(-1, 2, geometry())).toEqual([0, 1]);
  });

  it('maps a click through an axis-aligned crop into the source frame, and back', () => {
    const [x, y] = previewCenter(0.5, 0.5, crop());
    expect(x).toBeCloseTo(0.45);
    expect(y).toBeCloseTo(0.3);
    const [fx, fy] = shownPosition([x, y], crop());
    expect(fx).toBeCloseTo(0.5);
    expect(fy).toBeCloseTo(0.5);
  });

  it('falls back to the position in the picture for a straightened, rotated or warped crop', () => {
    expect(previewCenter(0.5, 0.5, crop(3))).toEqual([0.5, 0.5]);
    expect(previewCenter(0.5, 0.5, { ...crop(), rotate: 90 })).toEqual([0.5, 0.5]);
    const warped = crop();
    warped.transform = { ...warped.transform, vertical: 20 };
    expect(previewCenter(0.5, 0.5, warped)).toEqual([0.5, 0.5]);
  });
});

describe('containRect', () => {
  it('letterboxes a wide picture in a tall box and the reverse', () => {
    expect(containRect(400, 400, 2)).toEqual({ x: 0, y: 100, w: 400, h: 200 });
    expect(containRect(400, 200, 0.5)).toEqual({ x: 150, y: 0, w: 100, h: 200 });
  });

  it('fills the box while the aspect is unknown', () => {
    expect(containRect(400, 200, null)).toEqual({ x: 0, y: 0, w: 400, h: 200 });
  });
});

describe('denoiseView', () => {
  const model = (state: 'installed' | 'missing' | 'partial'): AiModelInfo => ({
    name: 'm',
    title: 'M',
    version: '1',
    bytes: 1,
    licence: 'MIT',
    licenceUrl: '',
    status: state === 'partial' ? { state, bytes: 1 } : { state },
  });
  const status = (over: Partial<DenoiseStatus> = {}): DenoiseStatus => ({
    key: 'k',
    ready: false,
    bytes: 0,
    model: model('installed'),
    ...over,
  });
  const view = (input: Partial<Parameters<typeof denoiseView>[0]>) =>
    denoiseView({ on: true, status: status(), running: false, lastRun: undefined, ...input }).kind;

  it('covers every state', () => {
    expect(view({ on: false })).toBe('off');
    expect(view({ status: null })).toBe('loading');
    expect(view({ running: true })).toBe('running');
    expect(view({})).toBe('idle');
    expect(view({ lastRun: { key: 'old', elapsedMs: 1 } })).toBe('stale');
    expect(view({ lastRun: { key: 'k', elapsedMs: 1 } })).toBe('idle');
    expect(view({ status: status({ ready: true }) })).toBe('applied');
    expect(view({ status: status({ model: model('missing') }) })).toBe('missingModel');
    expect(view({ status: status({ model: model('partial') }) })).toBe('missingModel');
  });

  it('shows Applied, not the missing model, when the intermediate exists', () => {
    expect(view({ status: status({ ready: true, model: model('missing') }) })).toBe('applied');
  });

  it('reports the elapsed time only for the run that made this intermediate', () => {
    const ready = status({ ready: true });
    expect(denoiseView({ on: true, status: ready, running: false, lastRun: { key: 'k', elapsedMs: 900 } })).toEqual({
      kind: 'applied',
      elapsedMs: 900,
    });
    expect(denoiseView({ on: true, status: ready, running: false, lastRun: { key: 'x', elapsedMs: 900 } })).toEqual({
      kind: 'applied',
      elapsedMs: null,
    });
    expect(denoiseView({ on: true, status: ready, running: false, lastRun: { key: 'k', elapsedMs: 0 } })).toEqual({
      kind: 'applied',
      elapsedMs: null,
    });
  });
});

describe('denoisePhase (the pill, plan 28)', () => {
  const job = (state: 'queued' | 'running', done = 0, total = 0, cancelling = false) => ({
    state,
    done,
    total,
    cancelling,
  });
  const label = (...args: Parameters<typeof denoisePhase>) => phaseLabel(denoisePhase(...args));

  it('walks off → checking → Needs apply → Queued → Running → Applied → Needs apply', () => {
    expect(label({ kind: 'off' })).toBeNull();
    expect(label({ kind: 'loading' })).toBe('Checking…');
    expect(label({ kind: 'idle' })).toBe('Needs apply');
    expect(label({ kind: 'running' }, job('queued'))).toBe('Queued');
    expect(label({ kind: 'running' }, job('running'))).toBe('Running 0 %');
    expect(label({ kind: 'running' }, job('running', 43, 117))).toBe('Running 36 %');
    expect(label({ kind: 'running' }, job('running', 117, 117))).toBe('Running 100 %');
    expect(label({ kind: 'applied', elapsedMs: 900 })).toBe('Applied');
    expect(label({ kind: 'stale' })).toBe('Needs apply');
  });

  it('says Cancelling while a cancelled run reaches its next tile, and Needs model without the model', () => {
    expect(label({ kind: 'running' }, job('running', 3, 9, true))).toBe('Cancelling');
    expect(denoisePhase({ kind: 'running' }, job('running', 3, 9, true))).toEqual({
      kind: 'running',
      percent: 33,
      cancelling: true,
    });
    expect(label({ kind: 'missingModel', model: {} as never })).toBe('Needs model');
  });
});
