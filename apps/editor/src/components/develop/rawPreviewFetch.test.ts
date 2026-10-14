import { DEVELOP_DEFAULTS } from '@photobook/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRawPreview, type RawPreviewRequest } from './rawPreviewFetch';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${path}`,
}));

const req: RawPreviewRequest = {
  folder: 'F1',
  relPath: 'a.jpg',
  hash: 'h',
  settings: DEVELOP_DEFAULTS,
  job: 42,
  outputProfile: 'display-p3',
};

/** A `pbraw` body: the 16-byte little-endian header, then `pixels`. */
function body(width: number, height: number, renderMs: number, packMs: number, pixels: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(16 + pixels.length);
  const view = new DataView(buf);
  [width, height, renderMs, packMs].forEach((v, i) => {
    view.setUint32(i * 4, v, true);
  });
  new Uint8Array(buf, 16).set(pixels);
  return buf;
}

function respond(status: number, payload: ArrayBuffer | string = '') {
  const fetchMock = vi.fn(async () => new Response(status === 204 ? null : payload, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('fetchRawPreview (plan 36)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the request as text and parses the header and pixels', async () => {
    const pixels = [1, 2, 3, 255, 4, 5, 6, 255];
    const fetchMock = respond(200, body(2, 1, 9, 2, pixels));
    const frame = await fetchRawPreview(req);
    expect(fetchMock).toHaveBeenCalledWith('pbraw://localhost/preview', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(req),
    });
    expect(frame).toMatchObject({ job: 42, width: 2, height: 1, profile: 'display-p3', renderMs: 9, packMs: 2 });
    expect([...(frame?.pixels ?? [])]).toEqual(pixels);
  });

  it('returns null for a superseded job (204)', async () => {
    respond(204);
    expect(await fetchRawPreview(req)).toBeNull();
  });

  it('throws with the server message on an error', async () => {
    respond(500, 'no such folder');
    await expect(fetchRawPreview(req)).rejects.toThrow('raw preview failed (500): no such folder');
  });

  it('rejects a body whose size does not match its header', async () => {
    respond(200, body(2, 2, 1, 1, [0, 0, 0, 0]));
    await expect(fetchRawPreview(req)).rejects.toThrow('size mismatch');
  });
});
