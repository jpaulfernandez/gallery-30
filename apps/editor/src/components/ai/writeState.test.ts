import { describe, expect, it } from 'vitest';
import { INITIAL_WRITE, previousTexts, type WriteState, writeReducer } from './writeState';

const variants = [
  { angle: 'what', text: 'We wait for the tram.', alt: 'A tram stop.' },
  { angle: 'where', text: 'Alfama at dusk.', alt: 'A tram stop.' },
  { angle: 'detail', text: 'A ticket in Ana’s hand.', alt: 'A tram stop.' },
];
const ok = {
  status: 'ok' as const,
  variants,
  model: 'claude-opus-5-5',
  servedBy: 'claude-opus-5-5',
  fellBack: false,
  usd: 0.02,
};

const run = (...events: Parameters<typeof writeReducer>[1][]): WriteState => events.reduce(writeReducer, INITIAL_WRITE);

describe('writeReducer', () => {
  it('goes closed → loading → ready, and a chip keeps the variants while it loads', () => {
    const ready = run({ type: 'request', request: 1 }, { type: 'result', request: 1, result: ok });
    expect(ready).toMatchObject({ phase: 'ready', variants, meta: { usd: 0.02 } });
    const fixing = writeReducer(ready, { type: 'request', request: 2, fix: 'shorter' });
    expect(fixing).toEqual({ phase: 'loading', request: 2, fix: 'shorter', variants });
    expect(previousTexts(ready)).toEqual(variants.map((v) => v.text));
  });

  it('shows a refusal with its message and keeps what was on screen', () => {
    const refused = run(
      { type: 'request', request: 1 },
      { type: 'result', request: 1, result: ok },
      { type: 'request', request: 2, fix: 'angle' },
      { type: 'result', request: 2, result: { status: 'refused', message: 'The model declined this page: x', usd: 0 } },
    );
    expect(refused).toEqual({ phase: 'refused', request: 2, message: 'The model declined this page: x', variants });
  });

  it('turns errors and a cancel from elsewhere into the error state', () => {
    expect(
      run(
        { type: 'request', request: 1 },
        { type: 'result', request: 1, result: { status: 'error', message: 'Offline' } },
      ),
    ).toMatchObject({ phase: 'error', message: 'Offline' });
    expect(
      run({ type: 'request', request: 1 }, { type: 'result', request: 1, result: { status: 'cancelled' } }),
    ).toMatchObject({
      phase: 'error',
    });
  });

  it('ignores a result after close or for an older request', () => {
    const closed = run({ type: 'request', request: 1 }, { type: 'close' }, { type: 'result', request: 1, result: ok });
    expect(closed.phase).toBe('closed');
    const newer = run(
      { type: 'request', request: 1 },
      { type: 'request', request: 2 },
      { type: 'result', request: 1, result: ok },
    );
    expect(newer).toMatchObject({ phase: 'loading', request: 2 });
    // Reopening after close starts without the old variants.
    const reopened = run(
      { type: 'request', request: 1 },
      { type: 'result', request: 1, result: ok },
      { type: 'close' },
      { type: 'request', request: 2 },
    );
    expect(reopened).toEqual({ phase: 'loading', request: 2, variants: [] });
  });

  it('has a no-key state that closes', () => {
    expect(run({ type: 'nokey' })).toEqual({ phase: 'nokey', request: 0 });
    expect(run({ type: 'nokey' }, { type: 'close' }).phase).toBe('closed');
  });
});
