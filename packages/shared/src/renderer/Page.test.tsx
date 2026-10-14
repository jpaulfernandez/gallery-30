// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURE_PAGES, fixtureBook, fixtureResolve, fixtureSquareBook } from '../fixtures/fixturePage.js';
import { BookSchema, type Page as PageData, type PhotoElement as PhotoData } from '../schema.js';
import { coverSize, slotAspect } from './cover.js';
import { Page } from './Page.js';
import { cropTransform } from './PhotoElement.js';
import type { ResolveImage } from './types.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const template = fixtureBook.template;
const theme = fixtureBook.theme;

function render(page: PageData, props: Partial<Parameters<typeof Page>[0]> = {}): HTMLElement {
  const html = renderToStaticMarkup(
    <Page page={page} template={template} theme={theme} resolve={fixtureResolve} {...props} />,
  );
  const host = document.createElement('div');
  host.innerHTML = html;
  // React 19 SSR hoists <link rel="preload" as="image"> tags ahead of the markup.
  return host.querySelector('.pb-page') as HTMLElement;
}

const heroPage = fixtureBook.pages[0] as PageData;

describe('<Page>', () => {
  it('renders one positioned child per element at the template aspect', () => {
    const root = render(heroPage);
    expect(root.className).toBe('pb-page');
    const style = root.getAttribute('style') ?? '';
    expect(style).toContain('aspect-ratio:1080 / 1350');
    expect(style).toContain('container-type:inline-size');
    expect(style).toContain('overflow:hidden');
    expect(root.children).toHaveLength(heroPage.elements.length);
    expect(root.querySelectorAll('.pb-photo')).toHaveLength(3);
    expect(root.querySelectorAll('.pb-text')).toHaveLength(2);
  });

  it('positions elements with percentages from their frames', () => {
    const root = render(heroPage);
    const first = root.children[0] as HTMLElement;
    const f = (heroPage.elements[0] as PhotoData).frame;
    const pct = (n: number) => `${Math.round(n * 100 * 1e4) / 1e4}%`;
    expect(first.style.left).toBe(pct(f.x));
    expect(first.style.top).toBe(pct(f.y));
    expect(first.style.width).toBe(pct(f.w));
    expect(first.style.height).toBe(pct(f.h));
    expect(first.style.position).toBe('absolute');
    expect(first.style.overflow).toBe('hidden');
  });

  it('lays the img out at its cover size and applies the crop as pan and scale', () => {
    const root = render(heroPage);
    const img = root.querySelector('img') as HTMLImageElement;
    const hero = heroPage.elements[0] as PhotoData;
    const slot = slotAspect(hero.frame, template);
    // f1 is about 3:2 (the fixture resolver rounds its size), wider than the hero slot: cover is
    // full height, wider than the slot.
    const r = fixtureResolve('f1', Math.round(hero.frame.w * 1080));
    const aspect = (r?.width ?? 0) / (r?.height ?? 1);
    expect(img.style.position).toBe('absolute');
    expect(img.style.left).toBe('54%');
    expect(img.style.top).toBe('50%');
    expect(Number.parseFloat(img.style.width)).toBeCloseTo((100 * aspect) / slot, 3);
    expect(img.style.height).toBe('100%');
    expect(img.style.transform).toBe('translate(-50%, -50%) scale(1.1)');
    expect(img.getAttribute('draggable')).toBe('false');
    expect(img.getAttribute('src')).toContain('picsum.photos/seed/f1/');
    expect(cropTransform({ x: 0.1, y: -0.25, scale: 1.5 }, 180)).toBe('translate(10%, -25%) rotate(180deg) scale(1.5)');
    // The bw filter is a class.
    expect(root.querySelectorAll('img.pb-filter-bw')).toHaveLength(1);
  });

  it('falls back to an object-fit cover img with cropTransform when the size is unknown', () => {
    const noSize: ResolveImage = (id, w) => {
      const r = fixtureResolve(id, w);
      return r && { src: r.src };
    };
    const root = render(heroPage, { resolve: noSize });
    const img = root.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('style')).toContain('transform:translate(4%, 0%) scale(1.1)');
    expect(img.style.position).toBe('');
  });

  it('asks the resolver for the slot width at the given page width', () => {
    const resolve = vi.fn<ResolveImage>(() => ({ src: 'x.jpg' }));
    render(fixtureBook.pages[1] as PageData, { resolve, pageWidthPx: 500 });
    expect(resolve).toHaveBeenCalledWith('f4', 500);
    resolve.mockClear();
    render(heroPage, { resolve });
    const w = (heroPage.elements[1] as PhotoData).frame.w;
    expect(resolve).toHaveBeenCalledWith('f2', Math.round(w * 1080));
  });

  it('rotates 90/270 with the cover size computed from the swapped aspect', () => {
    const page = fixtureBook.pages[2] as PageData;
    const root = render(page);
    const img = root.querySelector('img.pb-filter-fade') as HTMLImageElement;
    expect(img.style.transform).toBe('translate(-50%, -50%) rotate(90deg) scale(1)');
    const f = (page.elements[0] as PhotoData).frame;
    const a = slotAspect(f, template);
    // f5 is about 3:2; rotated it is 2:3. The unrotated img's width runs along the slot height.
    const r = fixtureResolve('f5', Math.round(f.w * 1080));
    const c = coverSize((r?.width ?? 0) / (r?.height ?? 1), a, 90);
    expect(Number.parseFloat(img.style.width)).toBeCloseTo((100 * c.h) / a, 3);
    expect(Number.parseFloat(img.style.height)).toBeCloseTo(100 * c.w * a, 3);
  });

  it('rotates 90/270 on a wrapper sized to the swapped slot when the size is unknown', () => {
    const page = fixtureBook.pages[2] as PageData;
    const root = render(page, { resolve: (id, w) => ({ src: fixtureResolve(id, w)?.src ?? '' }) });
    const rot = root.querySelector('.pb-photo-rot') as HTMLElement;
    expect(rot.style.transform).toBe('translate(-50%, -50%) rotate(90deg)');
    const f = (page.elements[0] as PhotoData).frame;
    const a = (f.w * template.width) / (f.h * template.height);
    expect(Number.parseFloat(rot.style.width)).toBeCloseTo(100 / a, 3);
    expect(Number.parseFloat(rot.style.height)).toBeCloseTo(100 * a, 3);
    expect(root.querySelector('img.pb-filter-fade')).not.toBeNull();
  });

  it('scales text with the page through container units, with a px fallback', () => {
    const root = render(heroPage);
    const title = root.querySelector('.pb-text-title') as HTMLElement;
    const style = title.getAttribute('style') ?? '';
    // size 0.04 of the page height on a 4:5 page = 0.04 * 1.25 * 100 cqw.
    expect(style).toContain('--pb-fs:5cqw');
    expect(style).toContain('--pb-fs-px:54px');
    expect(style).toContain('Fraunces');
    expect(title.querySelector('.pb-pill')?.textContent).toBe('Kyoto, April');
    const caption = root.querySelector('.pb-text-caption') as HTMLElement;
    expect(caption.style.color).toBe('rgb(255, 255, 255)');
    expect(caption.style.textAlign).toBe('right');
  });

  it('renders a photo background behind the slots', () => {
    const page = fixtureSquareBook.pages[2] as PageData;
    const root = render(page, { template: fixtureSquareBook.template });
    const bg = root.children[0] as HTMLElement;
    expect(bg.className).toContain('pb-page-bg');
    expect(bg.querySelector('img')?.getAttribute('src')).toContain('/seed/f9/');
    expect(root.children).toHaveLength(page.elements.length + 1);
  });

  it('shows empty slots only when editable', () => {
    const page = fixtureSquareBook.pages[1] as PageData;
    const plain = render(page, { template: fixtureSquareBook.template });
    expect(plain.querySelector('.pb-photo-plus')).toBeNull();
    expect(plain.querySelector('[data-element-id]')).toBeNull();
    const editable = render(page, { template: fixtureSquareBook.template, editable: true, selectedId: 's2-e2' });
    expect(editable.querySelectorAll('.pb-photo-empty.pb-editable')).toHaveLength(1);
    expect(editable.querySelector('.pb-photo-plus')).not.toBeNull();
    expect(editable.querySelectorAll('[data-element-type="photo"]')).toHaveLength(4);
    expect(editable.querySelectorAll('[data-element-type="text"]')).toHaveLength(1);
    expect(editable.querySelector('.pb-selected')?.getAttribute('data-element-id')).toBe('s2-e2');
  });

  it('reports pointer down with the element id when editable', async () => {
    const onDown = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <Page
          page={heroPage}
          template={template}
          theme={theme}
          resolve={fixtureResolve}
          editable
          onElementPointerDown={onDown}
        />,
      );
    });
    const target = host.querySelector('[data-element-id="p1-e2"]') as HTMLElement;
    await act(async () => {
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 5 }));
    });
    expect(onDown).toHaveBeenCalledTimes(1);
    expect(onDown.mock.calls[0]?.[0]).toBe('p1-e2');
    expect(onDown.mock.calls[0]?.[1]).toMatchObject({ clientX: 5 });
    act(() => root.unmount());
    host.remove();
  });
});

describe('<Page> and ruler guides (workflow plan 31)', () => {
  it('ignores page guides: the markup is the same with and without them', () => {
    const withGuides = {
      ...heroPage,
      guides: [
        { axis: 'x' as const, value: 0.25 },
        { axis: 'y' as const, value: 0.5 },
      ],
    };
    const bare = { ...heroPage, guides: [] };
    expect(render(withGuides).outerHTML).toBe(render(bare).outerHTML);
    expect(render(withGuides, { editable: true }).outerHTML).toBe(render(bare, { editable: true }).outerHTML);
  });
});

describe('fixture', () => {
  it('is a valid book in both templates', () => {
    expect(() => BookSchema.parse(fixtureBook)).not.toThrow();
    expect(() => BookSchema.parse(fixtureSquareBook)).not.toThrow();
    expect(fixtureBook.pages.map((p) => p.layout)).toEqual(['three-hero-two', 'single-full', 'single-caption']);
    expect(FIXTURE_PAGES.length).toBe(6);
  });
});
