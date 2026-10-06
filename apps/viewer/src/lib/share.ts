/**
 * Saving and sharing files from the reader: the system share sheet (`navigator.share` with files),
 * anchor downloads from blob URLs, and a small cache of fetched files so a share sheet can open
 * straight from the tap (Safari drops the user activation across a slow fetch). Only imported by
 * the lazy chunks (lightbox, drawer, collection).
 */

/** iPhone, iPod, or an iPad (which reports itself as a Mac with touch). */
export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Replace the extension (the share version is always a JPEG, the original may be a HEIC). */
export function withExtension(filename: string, ext: string): string {
  const dot = filename.lastIndexOf('.');
  return `${dot > 0 ? filename.slice(0, dot) : filename}.${ext}`;
}

const pending = new Map<string, Promise<File>>();
const ready = new Map<string, File>();
/** Keep the cache small: a page or two of photos. */
const CACHE_MAX = 8;

/** Fetch a URL as a `File` (cached). */
export function loadFile(url: string, filename: string, type?: string): Promise<File> {
  const hit = pending.get(url);
  if (hit) return hit;
  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      return res.blob();
    })
    .then((blob) => {
      const file = new File([blob], filename, { type: type ?? blob.type ?? 'application/octet-stream' });
      ready.set(url, file);
      if (ready.size > CACHE_MAX) {
        const oldest = ready.keys().next().value;
        if (oldest !== undefined) {
          ready.delete(oldest);
          pending.delete(oldest);
        }
      }
      return file;
    });
  pending.set(url, promise);
  promise.catch(() => pending.delete(url));
  return promise;
}

/** The file if it is already fetched (so a share can start without awaiting anything). */
export const readyFile = (url: string): File | undefined => ready.get(url);

/** True when this browser can hand files to the share sheet (iOS, Android, Safari on the Mac). */
export function canShareFiles(files?: File[]): boolean {
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: files ?? [new File([''], 'probe.jpg', { type: 'image/jpeg' })] });
  } catch {
    return false;
  }
}

/** Start fetching files a share may need, only where files can be shared at all. */
export function prefetchForShare(url: string, filename: string, type?: string): void {
  if (canShareFiles()) loadFile(url, filename, type).catch(() => {});
}

export type ShareResult = 'shared' | 'cancelled' | 'blocked' | 'unsupported' | 'failed';

/**
 * Open the share sheet with files. `blocked` means the browser wanted a fresh tap (the user
 * activation expired while fetching): the files are cached now, so asking to tap again works.
 */
export async function shareFiles(files: File[], title?: string): Promise<ShareResult> {
  if (!canShareFiles(files)) return 'unsupported';
  try {
    await navigator.share(title ? { files, title } : { files });
    return 'shared';
  } catch (e) {
    const name = (e as Error | null)?.name;
    if (name === 'AbortError') return 'cancelled';
    if (name === 'NotAllowedError') return 'blocked';
    return 'failed';
  }
}

/** Share a link through the sheet, or copy it. Resolves to what happened. */
export async function shareLink(url: string, title?: string): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share(title ? { url, title } : { url });
      return 'shared';
    } catch (e) {
      if ((e as Error | null)?.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return copyWithSelection(url) ? 'copied' : 'failed';
  }
}

/** Old-style copy for browsers without (or refusing) the async clipboard. */
function copyWithSelection(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  field.remove();
  return ok;
}

/** Save a blob through an anchor with `download` (Files on iPhone, the downloads folder elsewhere). */
export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/**
 * Cross-origin anchors ignore `download`, so fetch the file (R2 CORS allows GET from the book
 * domain) and save it from a blob URL; if that fails, open the file in a new tab.
 */
export async function downloadUrl(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    saveBlob(await res.blob(), filename);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

/** "3.4 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
