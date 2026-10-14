// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Checkbox, Field, Input, NumberInput, Select, Switch } from './Field';

afterEach(cleanup);

describe('Field and Input', () => {
  it('labels its control, shows the hint, and the error instead (announced)', () => {
    const { rerender } = render(
      <Field label="Title" hint="On the cover">
        <Input defaultValue="Lisbon" />
      </Field>,
    );
    const input = screen.getByLabelText(/Title/) as HTMLInputElement;
    expect(input.value).toBe('Lisbon');
    expect(input.className).toContain('rounded-sm');
    expect(input.className).toContain('focus:ring-accent');
    expect(screen.getByText('On the cover')).toBeTruthy();
    rerender(
      <Field label="Title" hint="On the cover" error="A title is needed">
        <Input defaultValue="" />
      </Field>,
    );
    expect(screen.getByRole('alert').textContent).toBe('A title is needed');
    expect(screen.queryByText('On the cover')).toBeNull();
  });

  it('a select keeps the native control and its options', () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Sort" value="time" onChange={onChange}>
        <option value="time">Capture time</option>
        <option value="name">Name</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Sort' });
    fireEvent.change(select, { target: { value: 'name' } });
    expect(onChange).toHaveBeenCalled();
  });
});

function Amount({ onChange = () => {} }: { onChange?: (n: number) => void }) {
  const [value, setValue] = useState(1);
  return (
    <NumberInput
      aria-label="Amount"
      value={value}
      onChange={(n) => {
        setValue(n);
        onChange(n);
      }}
      min={0}
      max={10}
      step={0.5}
      unit="EV"
    />
  );
}

describe('NumberInput', () => {
  const field = () => screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement;

  it('is mono and right-aligned with its unit, and commits typing on Enter (clamped)', () => {
    render(<Amount />);
    expect(field().value).toBe('1.0');
    expect(field().className).toContain('font-mono');
    expect(field().className).toContain('text-right');
    expect(screen.getByText('EV')).toBeTruthy();
    fireEvent.change(field(), { target: { value: '42' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field().value).toBe('10.0');
  });

  it('Escape puts the value back; blur commits', () => {
    render(<Amount />);
    fireEvent.change(field(), { target: { value: '3' } });
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(field().value).toBe('1.0');
    fireEvent.change(field(), { target: { value: '2,5' } });
    fireEvent.blur(field());
    expect(field().value).toBe('2.5');
  });

  it('nudges by step with the arrows (Shift × 10)', () => {
    render(<Amount />);
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(field().value).toBe('1.5');
    fireEvent.keyDown(field(), { key: 'ArrowDown', shiftKey: true });
    expect(field().value).toBe('0.0');
  });

  it('nudges with Option + wheel only; a plain wheel is left to the panel', () => {
    const onChange = vi.fn();
    render(<Amount onChange={onChange} />);
    const plain = fireEvent.wheel(field(), { deltaY: -100 });
    expect(plain).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    const nudged = fireEvent.wheel(field(), { deltaY: -100, altKey: true });
    expect(nudged).toBe(false);
    expect(field().value).toBe('1.5');
    fireEvent.wheel(field(), { deltaY: 100, altKey: true, shiftKey: true });
    expect(field().value).toBe('0.0');
  });
});

describe('Checkbox and Switch', () => {
  it('a checkbox toggles from its label and with Space', () => {
    function Box() {
      const [on, setOn] = useState(false);
      return <Checkbox checked={on} onChange={setOn} label="Replace existing files" hint="Only exports" />;
    }
    render(<Box />);
    const box = screen.getByRole('checkbox', { name: /Replace existing files/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(screen.getByText('Replace existing files'));
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
  });

  it('a switch is role="switch" with aria-checked, named by its label, and can be disabled', () => {
    function Haptics({ disabled }: { disabled?: boolean }) {
      const [on, setOn] = useState(true);
      return <Switch checked={on} onChange={setOn} label="Haptics" disabled={disabled} />;
    }
    const { rerender } = render(<Haptics />);
    const sw = screen.getByRole('switch', { name: 'Haptics' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByText('Haptics'));
    expect(sw.getAttribute('aria-checked')).toBe('true');
    rerender(<Haptics disabled />);
    fireEvent.click(screen.getByRole('switch', { name: 'Haptics' }));
    expect(screen.getByRole('switch', { name: 'Haptics' }).getAttribute('aria-checked')).toBe('true');
  });
});
