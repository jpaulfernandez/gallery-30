// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fixtureBook } from '../fixtures/fixturePage.js';
import { Page } from '../renderer/Page.js';
import type { Page as PageData } from '../schema.js';
import { type ImageRecord, ImageRecordSchema } from './manifest.js';
import { resolveFromManifest, resolveImageRecord } from './resolve.js';

/**
 * Plan 35: alt text travels from the manifest's image record through the viewer's resolver to the shared renderer's
 * `<img alt>` (the viewer renders pages with `resolveFromManifest`; it has no test setup of its own).
 */

const record = (alt?: string): ImageRecord =>
  ImageRecordSchema.parse({
    width: 3000,
    height: 2000,
    download: { url: 'https://cdn.example.test/d.jpg', bytes: 10, filename: 'IMG_1.jpg' },
    share: 'https://cdn.example.test/s.jpg',
    avif: [{ w: 640, url: 'https://cdn.example.test/w640.avif' }],
    webp: [{ w: 640, url: 'https://cdn.example.test/w640.webp' }],
    placeholder: 'data:image/webp;base64,AAAA',
    ...(alt === undefined ? {} : { alt }),
  });

const page = fixtureBook.pages[0] as PageData;
const assets = [
  ...new Set(page.elements.flatMap((el) => (el.type === 'photo' && el.asset ? [el.asset] : []))),
] as string[];

function render(images: Record<string, ImageRecord>): HTMLElement {
  const html = renderToStaticMarkup(
    <Page
      page={page}
      template={fixtureBook.template}
      theme={fixtureBook.theme}
      resolve={resolveFromManifest({ images })}
    />,
  );
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('alt text in the published viewer', () => {
  it('passes the record alt through the resolver, and leaves it out when absent', () => {
    expect(resolveImageRecord(record('A tram at dusk.'), 400).alt).toBe('A tram at dusk.');
    expect('alt' in resolveImageRecord(record(), 400)).toBe(false);
    expect(ImageRecordSchema.safeParse({ ...record(), alt: 5 }).success).toBe(false);
  });

  it('sets each photo img alt from the manifest, and alt="" for a photo without one', () => {
    expect(assets.length).toBeGreaterThan(1);
    const [first, ...rest] = assets as [string, ...string[]];
    const images: Record<string, ImageRecord> = { [first]: record('Two friends on a tram, evening light.') };
    for (const id of rest) images[id] = record();
    const imgs = Array.from(render(images).querySelectorAll('img.pb-photo-img'));
    expect(imgs.length).toBe(assets.length);
    expect(imgs.map((img) => img.getAttribute('alt'))).toEqual([
      'Two friends on a tram, evening light.',
      ...rest.map(() => ''),
    ]);
  });
});
