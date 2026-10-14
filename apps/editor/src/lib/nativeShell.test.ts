// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { installNativeGuards, isReloadKey, isTextField, keepsNativeMenu } from './nativeShell';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  document.body.append(node);
  return node;
}

/** Dispatch a cancelable event on `target` and say whether something cancelled it. */
function cancelled(target: Element, type: string): boolean {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('isTextField', () => {
  it('takes text inputs, textareas and editable elements', () => {
    expect(isTextField(el('input'))).toBe(true);
    expect(isTextField(el('input', { type: 'search' }))).toBe(true);
    expect(isTextField(el('input', { type: 'number' }))).toBe(true);
    expect(isTextField(el('textarea'))).toBe(true);
    const editable = el('div', { contenteditable: 'true' });
    // jsdom does not implement isContentEditable.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTextField(editable)).toBe(true);
  });

  it('leaves out buttons, checkboxes, sliders and disabled fields', () => {
    expect(isTextField(el('button'))).toBe(false);
    expect(isTextField(el('input', { type: 'checkbox' }))).toBe(false);
    expect(isTextField(el('input', { type: 'range' }))).toBe(false);
    expect(isTextField(el('input', { disabled: '' }))).toBe(false);
    expect(isTextField(el('div'))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

describe('the reload keys', () => {
  it('are Cmd+R, Cmd+Shift+R and F5', () => {
    const key = (key: string, metaKey = false) => ({ key, metaKey, ctrlKey: false, altKey: false });
    expect(isReloadKey(key('r', true))).toBe(true);
    expect(isReloadKey(key('R', true))).toBe(true);
    expect(isReloadKey(key('F5'))).toBe(true);
    // R alone opens Review.
    expect(isReloadKey(key('r'))).toBe(false);
  });
});

describe('the document guards', () => {
  beforeAll(() => installNativeGuards({ release: true }));

  it('cancel the browser context menu except in text fields and marked regions', () => {
    expect(cancelled(el('div'), 'contextmenu')).toBe(true);
    expect(cancelled(el('img'), 'contextmenu')).toBe(true);
    expect(cancelled(el('textarea'), 'contextmenu')).toBe(false);
    const region = el('div', { 'data-native-menu': '' });
    const inside = document.createElement('span');
    region.append(inside);
    expect(cancelled(inside, 'contextmenu')).toBe(false);
    expect(keepsNativeMenu(inside)).toBe(true);
  });

  it('cancel every native drag', () => {
    expect(cancelled(el('img'), 'dragstart')).toBe(true);
    expect(cancelled(el('a', { href: '#x' }), 'dragstart')).toBe(true);
  });

  it('keep Cmd+R from reloading in release builds', () => {
    const event = new KeyboardEvent('keydown', { key: 'r', metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
