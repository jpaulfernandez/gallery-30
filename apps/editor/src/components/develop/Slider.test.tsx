// @vitest-environment jsdom
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushIdleGestures, useBookStore } from '../../store/book';
import { Slider } from './Slider';

const tick = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../lib/haptic', () => ({ tick }));

afterEach(() => {
  cleanup();
  tick.mockClear();
});

function Controlled(props: Partial<React.ComponentProps<typeof Slider>> & { onValue?: (v: number) => void }) {
  const [value, setValue] = useState(props.value ?? 0);
  const { onValue, ...rest } = props;
  return (
    <Slider
      label="Exposure"
      min={-5}
      max={5}
      step={0.01}
      {...rest}
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue?.(v);
      }}
    />
  );
}

const track = () => screen.getByRole('slider', { name: 'Exposure' });

describe('Slider', () => {
  it('shows the value with the decimals of its step and a sign on positives', () => {
    const { rerender } = render(
      <Slider label="Exposure" value={0.5} min={-5} max={5} step={0.01} onChange={() => {}} />,
    );
    expect(screen.getByRole('button', { name: '+0.50' })).toBeTruthy();
    rerender(<Slider label="Exposure" value={-1.25} min={-5} max={5} step={0.01} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '-1.25' })).toBeTruthy();
    rerender(<Slider label="Contrast" value={12} min={-100} max={100} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '+12' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Contrast' }).getAttribute('aria-valuenow')).toBe('12');
  });

  it('resets to the default on double-click', () => {
    const onValue = vi.fn();
    render(<Controlled value={1.5} onValue={onValue} />);
    fireEvent.doubleClick(track());
    expect(onValue).toHaveBeenCalledWith(0);
    expect(track().getAttribute('aria-valuenow')).toBe('0');
    // Already at the default: nothing to do.
    onValue.mockClear();
    fireEvent.doubleClick(track());
    expect(onValue).not.toHaveBeenCalled();
  });

  it('resets from the keyboard with Delete', () => {
    const onValue = vi.fn();
    render(<Controlled value={1.5} onValue={onValue} />);
    fireEvent.keyDown(track(), { key: 'Delete' });
    expect(onValue).toHaveBeenCalledWith(0);
  });

  it('resets to a custom default', () => {
    const onValue = vi.fn();
    render(<Controlled value={60} min={0} max={150} step={1} defaultValue={40} onValue={onValue} />);
    fireEvent.doubleClick(track());
    expect(onValue).toHaveBeenCalledWith(40);
  });

  it('nudges with the arrow keys, ten times as far with Shift, and stops at the ends', () => {
    const onValue = vi.fn();
    render(<Controlled value={0} min={-100} max={100} step={1} onValue={onValue} />);
    fireEvent.keyDown(track(), { key: 'ArrowRight' });
    expect(onValue).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(track(), { key: 'ArrowUp' });
    expect(onValue).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(track(), { key: 'ArrowLeft', shiftKey: true });
    expect(onValue).toHaveBeenLastCalledWith(-8);
    fireEvent.keyDown(track(), { key: 'PageUp' });
    expect(onValue).toHaveBeenLastCalledWith(2);
    for (let i = 0; i < 12; i++) fireEvent.keyDown(track(), { key: 'ArrowRight', shiftKey: true });
    expect(onValue).toHaveBeenLastCalledWith(100);
    const calls = onValue.mock.calls.length;
    fireEvent.keyDown(track(), { key: 'ArrowRight' });
    expect(onValue.mock.calls.length).toBe(calls);
    flushIdleGestures();
  });

  it('does not let handled keys reach the window (they would step the photo)', () => {
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    render(<Controlled />);
    fireEvent.keyDown(track(), { key: 'ArrowRight' });
    expect(onWindow).not.toHaveBeenCalled();
    window.removeEventListener('keydown', onWindow);
    flushIdleGestures();
  });

  it('avoids floating point noise when nudging by 0.01', () => {
    const onValue = vi.fn();
    render(<Controlled value={0.07} onValue={onValue} />);
    fireEvent.keyDown(track(), { key: 'ArrowRight' });
    expect(onValue).toHaveBeenLastCalledWith(0.08);
    flushIdleGestures();
  });

  it('types a value after a click on the readout: Enter commits (clamped), Escape cancels', () => {
    const onValue = vi.fn();
    render(<Controlled value={1} onValue={onValue} />);
    fireEvent.click(screen.getByRole('button', { name: '+1.00' }));
    let input = screen.getByRole('textbox', { name: 'Exposure value' }) as HTMLInputElement;
    expect(input.value).toBe('1');
    fireEvent.change(input, { target: { value: '2,5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onValue).toHaveBeenLastCalledWith(2.5);
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+2.50' }));
    input = screen.getByRole('textbox', { name: 'Exposure value' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onValue).toHaveBeenLastCalledWith(5);

    onValue.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '+5.00' }));
    input = screen.getByRole('textbox', { name: 'Exposure value' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '-3' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(onValue).not.toHaveBeenCalled();
    expect(track().getAttribute('aria-valuenow')).toBe('5');

    // Garbage is ignored.
    fireEvent.click(screen.getByRole('button', { name: '+5.00' }));
    input = screen.getByRole('textbox', { name: 'Exposure value' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onValue).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const onValue = vi.fn();
    render(<Controlled disabled onValue={onValue} />);
    fireEvent.keyDown(track(), { key: 'ArrowRight' });
    fireEvent.doubleClick(track());
    expect(onValue).not.toHaveBeenCalled();
  });
});

describe('Slider dragging', () => {
  beforeEach(() => {
    useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos' });
    useBookStore.temporal.getState().clear();
  });
  afterEach(() => useBookStore.getState().close());

  const contrast = () => useBookStore.getState().book?.assets.f1?.develop?.light.contrast;
  const steps = () => useBookStore.temporal.getState().pastStates.length;

  function Bound({ min = -100, max = 100 }: { min?: number; max?: number }) {
    const value = useBookStore((s) => s.book?.assets.f1?.develop?.light.contrast ?? 0);
    return (
      <Slider
        label="Exposure"
        value={value}
        min={min}
        max={max}
        step={1}
        onChange={(v) => useBookStore.getState().setAssetDevelop('f1', { light: { contrast: v } })}
      />
    );
  }

  function layout() {
    track().getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 16, right: 200, bottom: 16 }) as DOMRect;
  }

  it('follows the pointer and records the whole drag as one undo step', () => {
    render(<Bound />);
    layout();
    fireEvent.pointerDown(track(), { pointerId: 1, clientX: 50, button: 0 });
    // A press without travel changes nothing yet.
    expect(contrast()).toBeUndefined();
    for (const x of [60, 80, 100, 150]) fireEvent.pointerMove(track(), { pointerId: 1, clientX: x });
    // 150 px of 200 over -100..100.
    expect(contrast()).toBe(50);
    expect(steps()).toBe(0);
    fireEvent.pointerUp(track(), { pointerId: 1, clientX: 150 });
    expect(steps()).toBe(1);
    expect(contrast()).toBe(50);
    act(() => {
      useBookStore.getState().setAssetDevelop('f1', { light: { contrast: 10 } });
    });
    expect(steps()).toBe(2);
  });

  it('Shift makes the drag ten times finer', () => {
    render(<Bound />);
    layout();
    fireEvent.pointerDown(track(), { pointerId: 1, clientX: 100, button: 0 });
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 110 });
    // 110 px of 200 over -100..100.
    expect(contrast()).toBe(10);
    // Holding Shift re-bases at the pointer, then 40 px move the value by 4 instead of 40.
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 110, shiftKey: true });
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 150, shiftKey: true });
    expect(contrast()).toBe(14);
    fireEvent.pointerUp(track(), { pointerId: 1 });
    expect(steps()).toBe(1);
  });

  it('a click without movement changes nothing and a double-click is a single reset step', () => {
    render(<Bound />);
    layout();
    act(() => {
      useBookStore.getState().setAssetDevelop('f1', { light: { contrast: 40 } });
    });
    useBookStore.temporal.getState().clear();
    for (let i = 0; i < 2; i++) {
      fireEvent.pointerDown(track(), { pointerId: 1, clientX: 20, button: 0 });
      fireEvent.pointerUp(track(), { pointerId: 1, clientX: 20 });
    }
    fireEvent.doubleClick(track());
    expect(contrast()).toBeUndefined();
    expect(steps()).toBe(1);
  });

  it('ends the undo step when it unmounts mid-drag', () => {
    const { unmount } = render(<Bound />);
    layout();
    fireEvent.pointerDown(track(), { pointerId: 1, clientX: 50, button: 0 });
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 150 });
    expect(contrast()).toBe(50);
    expect(steps()).toBe(0);
    unmount();
    expect(steps()).toBe(1);
  });

  it('a burst of key nudges is one undo step once the idle gesture ends', () => {
    render(<Bound />);
    for (let i = 0; i < 4; i++) fireEvent.keyDown(track(), { key: 'ArrowRight' });
    expect(contrast()).toBe(4);
    flushIdleGestures();
    expect(steps()).toBe(1);
  });

  it('a drag from the label moves the value from where it is, without jumping', () => {
    render(<Bound />);
    layout();
    act(() => {
      useBookStore.getState().setAssetDevelop('f1', { light: { contrast: 40 } });
    });
    const label = screen.getByText('Exposure');
    fireEvent.pointerDown(label, { pointerId: 1, clientX: 10, button: 0 });
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 20 });
    // The drag starts at 20 px: still 40.
    expect(contrast()).toBe(40);
    fireEvent.pointerMove(label, { pointerId: 1, clientX: 40 });
    // 20 px of 200 over -100..100 is 20.
    expect(contrast()).toBe(60);
    fireEvent.pointerUp(label, { pointerId: 1 });
    expect(steps()).toBe(2);
  });

  it('a click on the readout edits instead of dragging', () => {
    render(<Bound />);
    layout();
    const readout = screen.getByRole('button', { name: '0' });
    fireEvent.pointerDown(readout, { pointerId: 1, clientX: 190, button: 0 });
    fireEvent.pointerUp(readout, { pointerId: 1, clientX: 190 });
    fireEvent.click(readout);
    expect(screen.getByRole('textbox', { name: 'Exposure value' })).toBeTruthy();
    expect(contrast()).toBeUndefined();
  });

  it('holds the default inside the detent and clicks once per crossing', () => {
    render(<Bound />);
    layout();
    fireEvent.pointerDown(track(), { pointerId: 1, clientX: 140, button: 0 });
    // Jump to 40, then towards the default: 1.5 % of 200 is 3, so 2 is held at 0.
    for (const x of [144, 120, 102]) fireEvent.pointerMove(track(), { pointerId: 1, clientX: x });
    expect(contrast() ?? 0).toBe(0);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenLastCalledWith('alignment');
    // Still inside the notch: no more clicks.
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 97 });
    expect(contrast() ?? 0).toBe(0);
    // Out of the other side: the value follows, no second click for the same crossing.
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 90 });
    expect(contrast()).toBe(-10);
    expect(tick).toHaveBeenCalledTimes(1);
    // Back across: a second crossing, a second click.
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 101 });
    expect(contrast() ?? 0).toBe(0);
    expect(tick).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(track(), { pointerId: 1 });
  });

  it('the detent lands exactly on an off-grid default, and nudges click at its snapped value', () => {
    const onValue = vi.fn();
    render(<Controlled value={60} min={0} max={150} step={1} defaultValue={40.4} onValue={onValue} />);
    layout();
    fireEvent.pointerDown(track(), { pointerId: 1, clientX: 80, button: 0 });
    // Jump to 63, then 30 px left is 22.5 down: 40.5, inside the 2.25 detent around 40.4.
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 84 });
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 54 });
    fireEvent.pointerUp(track(), { pointerId: 1 });
    expect(onValue).toHaveBeenLastCalledWith(40.4);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(track().closest('[data-slider-row]')?.querySelector('[data-edited-dot]')).toBeNull();
    // From 40.4 the keys move on the grid: 40.4 → 41 passes nothing, back to 40 crosses the snapped default (40)…
    fireEvent.keyDown(track(), { key: 'ArrowRight' });
    expect(onValue).toHaveBeenLastCalledWith(41);
    fireEvent.keyDown(track(), { key: 'ArrowLeft' });
    expect(onValue).toHaveBeenLastCalledWith(40);
    expect(tick).toHaveBeenCalledTimes(2);
    // …and stepping on to 39 does not click again.
    fireEvent.keyDown(track(), { key: 'ArrowLeft' });
    expect(tick).toHaveBeenCalledTimes(2);
    flushIdleGestures();
  });

  it('Shift skips the detent but still clicks when the default is passed', () => {
    render(<Bound />);
    layout();
    fireEvent.pointerDown(track(), { pointerId: 1, clientX: 110, button: 0, shiftKey: true });
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 114, shiftKey: true });
    // Jumped to 14; 10 px left with Shift is -1, inside the notch but not held.
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 104, shiftKey: true });
    expect(contrast()).toBe(13);
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: -36, shiftKey: true });
    expect(contrast()).toBe(-1);
    expect(tick).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(track(), { pointerId: 1 });
  });
});

describe('Slider wheel and edited state', () => {
  it('a plain wheel leaves the value alone; Option + wheel nudges (Shift: ten steps)', () => {
    const onValue = vi.fn();
    render(<Controlled value={0} min={-100} max={100} step={1} onValue={onValue} />);
    const row = track().closest('[data-slider-row]') as HTMLElement;
    const plain = new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true });
    row.dispatchEvent(plain);
    expect(onValue).not.toHaveBeenCalled();
    // The panel keeps the scroll.
    expect(plain.defaultPrevented).toBe(false);
    const option = new WheelEvent('wheel', { deltaY: -40, altKey: true, bubbles: true, cancelable: true });
    act(() => {
      row.dispatchEvent(option);
    });
    expect(option.defaultPrevented).toBe(true);
    expect(onValue).toHaveBeenLastCalledWith(1);
    act(() => {
      row.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, altKey: true, shiftKey: true, bubbles: true }));
    });
    expect(onValue).toHaveBeenLastCalledWith(-9);
    flushIdleGestures();
  });

  it('a nudge that lands on or passes the default clicks', () => {
    render(<Controlled value={2} min={-100} max={100} step={1} />);
    fireEvent.keyDown(track(), { key: 'ArrowLeft' });
    expect(tick).not.toHaveBeenCalled();
    fireEvent.keyDown(track(), { key: 'ArrowLeft' });
    expect(tick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(track(), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(track(), { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(track(), { key: 'ArrowLeft', shiftKey: true });
    // 0 → 10 leaves (no click), 10 → 0 lands (click), 0 → -10 leaves (no click).
    expect(tick).toHaveBeenCalledTimes(2);
    flushIdleGestures();
  });

  it('shows the accent dot before the label only while the value is off its default', () => {
    const { rerender } = render(<Slider label="Exposure" value={0} min={-5} max={5} onChange={() => {}} />);
    const row = () => track().closest('[data-slider-row]') as HTMLElement;
    expect(row().querySelector('[data-edited-dot]')).toBeNull();
    rerender(<Slider label="Exposure" value={0.5} min={-5} max={5} onChange={() => {}} />);
    expect(row().querySelector('[data-edited-dot]')).not.toBeNull();
    rerender(<Slider label="Exposure" value={40} min={0} max={150} defaultValue={40} onChange={() => {}} />);
    expect(row().querySelector('[data-edited-dot]')).toBeNull();
  });
});
