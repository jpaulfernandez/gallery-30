import { Zip, ZipPassThrough } from 'fflate';

/**
 * A zip of the collection, built in the browser from the download versions on R2. Photos are
 * already compressed, so entries are stored (`ZipPassThrough`), and each response body is streamed
 * into the zip chunk by chunk. Output chunks are folded into `Blob`s every few MB so the JS heap
 * holds about one photo at a time and the browser can keep the rest in its blob store. One photo
 * is read while the next one downloads.
 */

export interface ZipItem {
  url: string;
  filename: string;
  bytes: number;
}

export interface ZipProgress {
  /** Photos fully added. */
  done: number;
  total: number;
  bytesDone: number;
  bytesTotal: number;
}

/** Fold output into a Blob every this many bytes. */
const FLUSH_BYTES = 4 * 1024 * 1024;

/** `IMG_1.jpg`, `IMG_1 (2).jpg`, ...: zip entries need distinct names. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((name) => {
    const clean = name.replace(/[\\/:*?"<>|]+/g, '_') || 'photo.jpg';
    let candidate = clean;
    const dot = clean.lastIndexOf('.');
    const stem = dot > 0 ? clean.slice(0, dot) : clean;
    const ext = dot > 0 ? clean.slice(dot) : '';
    for (let n = 2; seen.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}

export async function buildZip(
  items: ZipItem[],
  onProgress: (p: ZipProgress) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const parts: Blob[] = [];
  let chunks: Uint8Array<ArrayBuffer>[] = [];
  let chunkBytes = 0;
  let zipError: Error | null = null;
  const flush = () => {
    if (chunks.length) parts.push(new Blob(chunks));
    chunks = [];
    chunkBytes = 0;
  };

  const zip = new Zip((err, data, final) => {
    if (err) {
      zipError = err;
      return;
    }
    chunks.push(data);
    chunkBytes += data.length;
    if (final || chunkBytes >= FLUSH_BYTES) flush();
  });

  const names = uniqueNames(items.map((i) => i.filename));
  const bytesTotal = items.reduce((s, i) => s + i.bytes, 0);
  let bytesDone = 0;
  const get = (i: number): Promise<Response> | null => {
    const item = items[i];
    if (!item) return null;
    const p = fetch(item.url, { signal }).then((res) => {
      if (!res.ok) throw new Error(`${res.status} for ${item.url}`);
      return res;
    });
    p.catch(() => {}); // awaited below; avoid an unhandled rejection while it waits its turn
    return p;
  };

  onProgress({ done: 0, total: items.length, bytesDone, bytesTotal });
  let next = get(0);
  for (let i = 0; i < items.length; i++) {
    const res = await (next as Promise<Response>);
    next = get(i + 1);
    const entry = new ZipPassThrough(names[i] ?? `photo-${i + 1}.jpg`);
    entry.mtime = Date.now();
    zip.add(entry);
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        entry.push(value);
        bytesDone += value.length;
        onProgress({ done: i, total: items.length, bytesDone, bytesTotal });
      }
    } else {
      const data = new Uint8Array(await res.arrayBuffer());
      entry.push(data);
      bytesDone += data.length;
    }
    entry.push(new Uint8Array(0), true);
    if (zipError) throw zipError;
    onProgress({ done: i + 1, total: items.length, bytesDone, bytesTotal });
  }
  zip.end();
  if (zipError) throw zipError;
  flush();
  return new Blob(parts, { type: 'application/zip' });
}
