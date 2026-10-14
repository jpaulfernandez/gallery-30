import type { DevelopSettings, OutputProfile } from '@photobook/shared';
import type { RawFrame } from './rawPreview';

/** Workflow plan 36: the `pbraw` request of the raw preview experiment (see `rawPreview.ts`). Dev builds only. */

export interface RawPreviewRequest {
  folder: string;
  relPath: string;
  hash: string;
  settings: DevelopSettings;
  job: number;
  outputProfile: OutputProfile;
}

/** Render the proxy with `req.settings` as raw RGBA; `null` when a newer job superseded it. Throws on failure. */
export async function fetchRawPreview(req: RawPreviewRequest): Promise<RawFrame | null> {
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  // `text/plain` keeps the cross-origin POST simple (no preflight).
  const res = await fetch(convertFileSrc('preview', 'pbraw'), {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(req),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`raw preview failed (${res.status}): ${await res.text()}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 16) throw new Error('raw preview: short response');
  const head = new DataView(buf, 0, 16);
  const width = head.getUint32(0, true);
  const height = head.getUint32(4, true);
  const pixels = new Uint8Array(buf, 16);
  if (pixels.byteLength !== width * height * 4) throw new Error('raw preview: size mismatch');
  return {
    job: req.job,
    width,
    height,
    pixels,
    profile: req.outputProfile,
    renderMs: head.getUint32(8, true),
    packMs: head.getUint32(12, true),
  };
}
