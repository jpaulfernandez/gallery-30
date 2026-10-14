// @vitest-environment jsdom
import { createDevelop, type DevelopSettings } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newLuminance, newMask } from '../../lib/develop/masks';
import { useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { loadUiPrefs, UI_PREF_KEYS, useUiStore } from '../../store/ui';

vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  noiseProfile: vi.fn(() => new Promise(() => {})),
}));

import { DevelopPanel } from './DevelopPanel';
import { DEVELOP_CARDS } from './developCards';

/**
 * Plan 54: the card manifest (`developCards.ts`) against the panel. Basic with every ▸ opened reaches every control
 * Advanced shows, each listed control is where the manifest says, and an edit behind a ▸ tags it `·edited` in Basic.
 */

const MASK_ID = 'mask-1';
const COMPONENT_ID = 'lum-1';

/** Synthetic settings: one mask with a luminance component, so the Masks card shows a component's ▸. */
function settingsWithMask(patch: (s: DevelopSettings) => void = () => {}): DevelopSettings {
  const s = createDevelop();
  s.masks = [newMask('Sky', { ...newLuminance(), id: COMPONENT_ID }, MASK_ID)];
  patch(s);
  return s;
}

function show(settings: DevelopSettings, advanced: boolean) {
  act(() =>
    useUiStore.setState({
      developAdvanced: advanced,
      developMasks: true,
      developMaskTool: { maskId: MASK_ID, componentId: COMPONENT_ID, tool: null },
    }),
  );
  const view = render(
    <DevelopPanel
      assetId="f1"
      settings={settings}
      edited
      canPaste={false}
      onCopy={() => {}}
      onCopyDialog={() => {}}
      onPaste={() => {}}
      onCrop={() => {}}
    />,
  );
  // Open every card (Masks is open through `developMasks`).
  for (const card of DEVELOP_CARDS) {
    const toggle = within(region(card.title)).getAllByRole('button')[0] as HTMLElement;
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  }
  return view;
}

const panel = () => screen.getByTestId('develop-panel');
const region = (title: string) => within(panel()).getByRole('region', { name: title });
const part = (id: string) => panel().querySelector<HTMLElement>(`[data-more="${id}"]`);
const has = (root: HTMLElement, c: { role: string; name: string | RegExp }) =>
  within(root).queryAllByRole(c.role as 'slider', { name: c.name }).length > 0;

/** Every control in the panel as `tag:role:name`, sorted (the ▸ buttons themselves left out). */
function controls(): string[] {
  const found = panel().querySelectorAll<HTMLElement>(
    'button, input, select, textarea, [role="slider"], [role="application"], [role="radio"], [role="tab"], [role="switch"]',
  );
  return [...found]
    .filter((el) => !el.hasAttribute('data-more-toggle'))
    .map(
      (el) =>
        `${el.tagName}:${el.getAttribute('role') ?? ''}:${el.getAttribute('aria-label') ?? el.textContent?.trim()}`,
    )
    .sort();
}

beforeEach(() => {
  localStorage.clear();
  const doc = structuredClone(fixtureBook);
  const f1 = doc.assets.f1;
  if (f1) f1.hash = 'hash-f1';
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: {} });
});

afterEach(async () => {
  cleanup();
  act(() => useUiStore.setState({ developAdvanced: false, developMasks: false, developMaskTool: null }));
  await useBookStore.getState().close();
});

describe('the card manifest (plan 54)', () => {
  it('lists the seven cards in the order of operations, each ▸ under its own card', () => {
    expect(DEVELOP_CARDS.map((c) => c.title)).toEqual([
      'Crop',
      'Light',
      'Color',
      'Detail',
      'Sharpen & denoise',
      'Effects',
      'Masks',
    ]);
    const ids = DEVELOP_CARDS.flatMap((c) => c.more.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const card of DEVELOP_CARDS) for (const m of card.more) expect(m.id.startsWith(`${card.id}.`)).toBe(true);
  });

  it('Basic: each card shows its basic controls, and each ▸ opens its controls in place', () => {
    show(settingsWithMask(), false);
    expect(
      within(panel())
        .getAllByRole('region')
        .map((r) => r.getAttribute('aria-label')),
    ).toEqual(DEVELOP_CARDS.map((c) => c.title));
    for (const card of DEVELOP_CARDS) {
      const root = region(card.title);
      for (const c of card.basic) expect([card.id, c.name, has(root, c)]).toEqual([card.id, c.name, true]);
      for (const more of card.more) {
        const box = part(more.id);
        if (!box) throw new Error(`${more.id} is not in the panel`);
        expect(root.contains(box)).toBe(true);
        const toggle = within(box).getByRole('button', { name: new RegExp(`^${escapeRegExp(more.label)}`) });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        for (const c of more.controls) expect([more.id, c.name, has(box, c)]).toEqual([more.id, c.name, false]);
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        for (const c of more.controls) expect([more.id, c.name, has(box, c)]).toEqual([more.id, c.name, true]);
      }
    }
    // No ▸ in the panel that the manifest does not list.
    const listed = new Set(DEVELOP_CARDS.flatMap((c) => c.more.map((m) => m.id)));
    for (const el of panel().querySelectorAll('[data-more]'))
      expect(listed.has(el.getAttribute('data-more') ?? '')).toBe(true);
  });

  it('every control reachable in Advanced is reachable from Basic through a ▸', () => {
    const settings = settingsWithMask();
    show(settings, false);
    for (const toggle of panel().querySelectorAll<HTMLElement>('[data-more-toggle]')) fireEvent.click(toggle);
    const basic = controls();
    cleanup();
    show(settings, true);
    // Advanced has no ▸ buttons: every part is open, with its label as a heading.
    expect(panel().querySelectorAll('[data-more-toggle]')).toHaveLength(0);
    for (const card of DEVELOP_CARDS) {
      for (const more of card.more) {
        const box = part(more.id);
        if (!box) throw new Error(`${more.id} is not in the panel`);
        for (const c of more.controls) expect([more.id, c.name, has(box, c)]).toEqual([more.id, c.name, true]);
      }
    }
    expect(basic.length).toBeGreaterThan(80);
    expect(basic).toContain('DIV:slider:Luminance range low');
    expect(basic).toEqual(controls());
  });

  it('an edit behind a ▸ shows as ·edited on its button in Basic, and nothing is tagged on an unedited photo', () => {
    show(settingsWithMask(), false);
    expect(within(panel()).queryAllByText('·edited')).toHaveLength(0);
    cleanup();
    const edited = settingsWithMask((s) => {
      s.geometry.transform.vertical = 10;
      s.curve.luma = [
        [0, 0.1],
        [1, 1],
      ];
      s.color.mix.blue.hue = 12;
      s.detail.sharpen.radius = 1.4;
      s.effects.grading.balance = 20;
      s.effects.grading.shadows.luminance = 10;
      s.effects.vignette.midpoint = 30;
      s.effects.halation.threshold = 60;
      s.effects.grain.size = 50;
      const c = s.masks[0]?.components[0];
      if (c?.kind === 'luminance') c.range = [0.2, 0.6];
    });
    show(edited, false);
    for (const card of DEVELOP_CARDS) {
      for (const more of card.more) {
        const toggle = part(more.id)?.querySelector('[data-more-toggle]');
        expect([more.id, toggle?.textContent?.includes('·edited')]).toEqual([more.id, true]);
        expect(more.edited(edited)).toBe(true);
      }
    }
  });

  it('a mask whose range is edited is tagged on its row in Basic, selected or not', () => {
    const edited = settingsWithMask((s) => {
      const c = s.masks[0]?.components[0];
      if (c?.kind === 'luminance') c.range = [0.2, 0.6];
    });
    show(edited, false);
    act(() => useUiStore.setState({ developMaskTool: null }));
    const row = panel().querySelector('[data-mask-row]');
    expect(row?.textContent).toContain('·edited');
    expect(part('masks.component')).toBeNull();
    cleanup();
    show(edited, true);
    expect(panel().querySelector('[data-mask-row]')?.textContent).not.toContain('·edited');
  });

  it('the switch is one, global and per machine (localStorage), never in the project', () => {
    show(settingsWithMask(), false);
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(useUiStore.getState().developAdvanced).toBe(true);
    expect(localStorage.getItem(UI_PREF_KEYS.developAdvanced)).toBe('true');
    expect(loadUiPrefs().developAdvanced).toBe(true);
    expect(JSON.stringify(useBookStore.getState().book)).not.toContain('developAdvanced');
    // Every card follows it: no ▸ is left anywhere.
    expect(panel().querySelectorAll('[data-more-toggle]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Basic' }));
    expect(loadUiPrefs().developAdvanced).toBe(false);
    expect(panel().querySelectorAll('[data-more-toggle]').length).toBe(
      DEVELOP_CARDS.reduce((n, c) => n + c.more.length, 0),
    );
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
