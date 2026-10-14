// @vitest-environment jsdom

import { createDevelop } from '@photobook/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { snapTargets } from '../../lib/develop/harmony';
import { GradingWheel, type GradingWheelProps } from './GradingWheel';

const tick = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../lib/haptic', () => ({ tick }));

afterEach(() => {
  cleanup();
  tick.mockClear();
});

type HueSat = GradingWheelProps['value'];

function Controlled(props: Partial<GradingWheelProps> & { onValue: (v: HueSat) => void }) {
  const [value, setValue] = useState<HueSat>(props.value ?? { hue: 0, saturation: 0 });
  const { onValue, ...rest } = props;
  return (
    <GradingWheel
      label="Shadows"
      {...rest}
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue(v);
      }}
    />
  );
}

const field = () => screen.getByRole('application', { name: 'Shadows wheel' });
/** An 88 px wheel at the origin: the centre is (44, 44), the edge 44 px away. */
function layout() {
  field().getBoundingClientRect = () => ({ left: 0, top: 0, width: 88, height: 88, right: 88, bottom: 88 }) as DOMRect;
}
/** The client point at `hue` degrees and `saturation` percent. */
const at = (hue: number, saturation: number) => {
  const r = (saturation / 100) * 44;
  const a = (hue * Math.PI) / 180;
  return { clientX: 44 + r * Math.cos(a), clientY: 44 - r * Math.sin(a) };
};

describe('GradingWheel (plan 55)', () => {
  it('maps the angle to the hue and the distance to the saturation; a press jumps', () => {
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} />);
    layout();
    fireEvent.pointerDown(field(), { pointerId: 1, button: 0, ...at(90, 100) });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 90, saturation: 100 });
    fireEvent.pointerMove(field(), { pointerId: 1, ...at(200, 30) });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 200, saturation: 30 });
    // Past the edge the saturation stops at 100.
    fireEvent.pointerMove(field(), { pointerId: 1, clientX: 200, clientY: 44 });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 0, saturation: 100 });
    fireEvent.pointerUp(field(), { pointerId: 1 });
    expect(field().getAttribute('aria-description')).toBe('hue 0°, saturation 100');
  });

  it('Shift holds the hue, Alt holds the saturation, double-click resets', () => {
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} value={{ hue: 120, saturation: 40 }} />);
    layout();
    fireEvent.pointerDown(field(), { pointerId: 1, button: 0, shiftKey: true, ...at(300, 70) });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 120, saturation: 70 });
    fireEvent.pointerUp(field(), { pointerId: 1 });
    fireEvent.pointerDown(field(), { pointerId: 2, button: 0, altKey: true, ...at(10, 20) });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 10, saturation: 70 });
    fireEvent.pointerUp(field(), { pointerId: 2 });
    fireEvent.doubleClick(field());
    expect(onValue).toHaveBeenLastCalledWith({ hue: 0, saturation: 0 });
  });

  it('snaps to the lock targets with one haptic tick per snap', () => {
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} snapTargets={[40]} />);
    layout();
    fireEvent.pointerDown(field(), { pointerId: 1, button: 0, ...at(43, 50) });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 40, saturation: 50 });
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenLastCalledWith('alignment');
    fireEvent.pointerMove(field(), { pointerId: 1, ...at(38, 60) });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 40, saturation: 60 });
    expect(tick).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(field(), { pointerId: 1, ...at(70, 60) });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 70, saturation: 60 });
    fireEvent.pointerMove(field(), { pointerId: 1, ...at(41, 60) });
    expect(tick).toHaveBeenCalledTimes(2);
    // Shift holds the hue: no snapping, no tick.
    fireEvent.pointerUp(field(), { pointerId: 1 });
    fireEvent.pointerDown(field(), { pointerId: 2, button: 0, shiftKey: true, ...at(100, 20) });
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('nudges with the keys and takes typed numbers', () => {
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} value={{ hue: 5, saturation: 20 }} />);
    fireEvent.keyDown(field(), { key: 'ArrowLeft', shiftKey: true });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 355, saturation: 20 });
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 355, saturation: 21 });
    fireEvent.keyDown(field(), { key: 'ArrowDown', shiftKey: true });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 355, saturation: 11 });
    const hue = screen.getByRole('textbox', { name: 'Shadows hue' });
    fireEvent.change(hue, { target: { value: '210' } });
    fireEvent.keyDown(hue, { key: 'Enter' });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 210, saturation: 11 });
    const sat = screen.getByRole('textbox', { name: 'Shadows saturation' });
    fireEvent.change(sat, { target: { value: '150' } });
    fireEvent.keyDown(sat, { key: 'Enter' });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 210, saturation: 100 });
    // Arrow keys stay with the wheel (Develop does not step photos on them).
    expect(field().hasAttribute('data-no-step')).toBe(true);
  });

  it('draws the lock spokes and puts the dot at the value', () => {
    const { container } = render(
      <Controlled onValue={() => {}} value={{ hue: 180, saturation: 50 }} spokes={[0, 120, 120]} />,
    );
    expect(container.querySelectorAll('[data-spoke]')).toHaveLength(3);
    const dot = container.querySelector<HTMLElement>('[data-wheel-dot]');
    expect(dot?.style.left).toBe('25%');
    expect(dot?.style.top).toBe('50%');
  });

  it('Free: a drag near 180° from a tinted shadows wheel snaps and ticks once; untinted wheels never snap', () => {
    const grading = createDevelop().effects.grading;
    grading.shadows = { hue: 200.5, saturation: 30, luminance: 0 };
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} snapTargets={snapTargets(grading, 'free', 'highlights')} />);
    layout();
    fireEvent.pointerDown(field(), { pointerId: 1, button: 0, ...at(17, 50) });
    // 200.5 + 180: the snapped hue lands as is, not rounded to a whole degree.
    expect(onValue).toHaveBeenLastCalledWith({ hue: 20.5, saturation: 50 });
    fireEvent.pointerMove(field(), { pointerId: 1, ...at(22, 55) });
    expect(onValue).toHaveBeenLastCalledWith({ hue: 20.5, saturation: 55 });
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenLastCalledWith('alignment');
    fireEvent.pointerUp(field(), { pointerId: 1 });
    cleanup();
    tick.mockClear();
    grading.shadows.saturation = 0;
    const plain = vi.fn();
    render(<Controlled onValue={plain} snapTargets={snapTargets(grading, 'free', 'highlights')} />);
    layout();
    fireEvent.pointerDown(field(), { pointerId: 1, button: 0, ...at(19, 50) });
    expect(plain).toHaveBeenLastCalledWith({ hue: 19, saturation: 50 });
    expect(tick).not.toHaveBeenCalled();
  });
});
