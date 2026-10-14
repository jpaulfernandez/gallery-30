import { DevelopSchema } from '@photobook/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lutPresent: vi.fn() }));
vi.mock('./tauri', () => ({ lutPresent: mocks.lutPresent }));

import { missingLutMessage } from './lutPreflight';

const WARM = 'a'.repeat(64);
const GONE = 'b'.repeat(64);
const withLut = (id: string, name: string) => DevelopSchema.parse({ version: 1, look: { lut: { id, name } } });

beforeEach(() => {
  mocks.lutPresent.mockReset();
  mocks.lutPresent.mockImplementation(async (id: string) => id !== GONE);
});

describe('missingLutMessage', () => {
  it('is null when every LUT is there or none is used', async () => {
    expect(await missingLutMessage([])).toBeNull();
    const plain = DevelopSchema.parse({ version: 1 });
    expect(
      await missingLutMessage([
        { label: 'a.jpg', settings: plain },
        { label: 'b.jpg', settings: undefined },
      ]),
    ).toBe(null);
    expect(await missingLutMessage([{ label: 'a.jpg', settings: withLut(WARM, 'Warm') }])).toBeNull();
    expect(mocks.lutPresent).not.toHaveBeenCalledWith(GONE);
  });

  it('lists the photos with a missing LUT in one message, asking about each LUT once', async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ label: `IMG_0${i}.jpg`, settings: withLut(GONE, 'Faded') }));
    items.push({ label: 'ok.jpg', settings: withLut(WARM, 'Warm') });
    const message = await missingLutMessage(items);
    expect(message).toMatch(/^7 photos use a LUT that is missing on this Mac: IMG_00\.jpg \(Faded\), /);
    expect(message).toContain('IMG_04.jpg (Faded) and 2 more.');
    expect(message).toContain('Locate');
    expect(mocks.lutPresent).toHaveBeenCalledTimes(2);
  });
});
