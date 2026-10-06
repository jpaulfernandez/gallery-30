import type { Manifest } from '@photobook/shared';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { pagePhotos } from '../lib/resolve';
import { canShareFiles, formatBytes, isIOS, loadFile, saveBlob, shareFiles, withExtension } from '../lib/share';
import type { ZipProgress } from '../lib/zip';
import type { Social } from '../social';
import { Icon } from './icons';
import { Thumb } from './Thumb';

export interface CollectionProps {
  manifest: Manifest;
  social: Social;
  onClose: () => void;
  /** Open the lightbox on the collection; `fullQuality` is Save one by one. */
  onOpenPhotos: (index: number, fullQuality: boolean) => void;
  /** The lightbox or the name prompt is over it: leave the keys to that. */
  covered?: boolean;
}

type ZipState =
  | { kind: 'idle' }
  | { kind: 'building'; progress: ZipProgress; abort: AbortController }
  | { kind: 'ready'; file: File; href: string }
  | { kind: 'error' };

// Local header (30) + data descriptor (16) + central directory entry (46), plus the name twice.
const ZIP_ENTRY_OVERHEAD = 92;
const ZIP_END_RECORD = 22;

type ShareState = { kind: 'idle' } | { kind: 'loading'; done: number } | { kind: 'ready'; files: File[] };

/**
 * The collection: the photos this device picked across the book, with remove, Clear all, Share all
 * (every share JPEG to the system sheet) and Download zip (the download versions, zipped in the
 * browser, see `lib/zip.ts`). On iPhone the zip lands in Files, so it also offers Save one by one.
 * Loaded on demand (dynamic import in `Reader`); fflate loads only when a zip is built.
 */
export default function Collection({ manifest, social, onClose, onOpenPhotos, covered = false }: CollectionProps) {
  const ids = social.collection;
  const ios = useMemo(isIOS, []);
  const shareable = useMemo(() => canShareFiles(), []);
  const [zip, setZip] = useState<ZipState>({ kind: 'idle' });
  const [share, setShare] = useState<ShareState>({ kind: 'idle' });
  const [confirmClear, setConfirmClear] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  /** Asset id -> 1-based number of the first page that shows it. */
  const pageOf = useMemo(() => {
    const map = new Map<string, number>();
    manifest.pages.forEach((p, i) => {
      for (const id of pagePhotos(p)) if (!map.has(id)) map.set(id, i + 1);
    });
    return map;
  }, [manifest]);

  const items = ids.flatMap((id) => {
    const image = manifest.images[id];
    return image ? [{ id, image }] : [];
  });
  const key = ids.join(',');
  // Stored entries: the photos' bytes plus the zip headers.
  const encoder = new TextEncoder();
  const estimate = items.reduce(
    (sum, { image }) =>
      sum + image.download.bytes + ZIP_ENTRY_OVERHEAD + 2 * encoder.encode(image.download.filename).length,
    ZIP_END_RECORD,
  );

  // The list changed: a built zip or prepared share no longer matches it.
  useEffect(() => {
    setZip((z) => {
      if (z.kind === 'building') z.abort.abort();
      if (z.kind === 'ready') URL.revokeObjectURL(z.href);
      return { kind: 'idle' };
    });
    setShare({ kind: 'idle' });
    setConfirmClear(false);
  }, [key]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    if (covered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, covered]);

  // Leaving: stop a running zip and free the built one.
  const zipRef = useRef(zip);
  zipRef.current = zip;
  useEffect(
    () => () => {
      const z = zipRef.current;
      if (z.kind === 'building') z.abort.abort();
      if (z.kind === 'ready') URL.revokeObjectURL(z.href);
    },
    [],
  );

  const zipName = `${(manifest.title || social.slug).replace(/[\\/:*?"<>|]+/g, '').trim() || 'photos'}.zip`;

  const buildZip = async () => {
    const abort = new AbortController();
    const list = items.map(({ id, image }) => ({
      id,
      url: image.download.url,
      filename: image.download.filename,
      bytes: image.download.bytes,
    }));
    const total = list.reduce((s, i) => s + i.bytes, 0);
    setZip({ kind: 'building', abort, progress: { done: 0, total: list.length, bytesDone: 0, bytesTotal: total } });
    try {
      const { buildZip } = await import('../lib/zip');
      const blob = await buildZip(
        list,
        (progress) => setZip((z) => (z.kind === 'building' && z.abort === abort ? { ...z, progress } : z)),
        abort.signal,
      );
      if (abort.signal.aborted) return;
      social.log(
        'zip',
        'collection',
        list.map((i) => i.id),
        null,
      );
      const file = new File([blob], zipName, { type: 'application/zip' });
      const href = URL.createObjectURL(file);
      setZip({ kind: 'ready', file, href });
      saveBlob(file, zipName);
    } catch {
      if (!abort.signal.aborted) setZip({ kind: 'error' });
    }
  };

  const shareAll = async () => {
    const log = () =>
      social.log(
        'share',
        'collection',
        items.map((i) => i.id),
        null,
      );
    let files = share.kind === 'ready' ? share.files : null;
    if (!files) {
      setShare({ kind: 'loading', done: 0 });
      try {
        files = [];
        for (const { image } of items) {
          files.push(await loadFile(image.share, withExtension(image.download.filename, 'jpg'), 'image/jpeg'));
          setShare({ kind: 'loading', done: files.length });
        }
      } catch {
        setShare({ kind: 'idle' });
        social.toast('Couldn’t load the photos. Try again.');
        return;
      }
    }
    const result = await shareFiles(files, manifest.title || undefined);
    if (result === 'blocked') {
      setShare({ kind: 'ready', files });
      social.toast('Ready. Tap Share all again.');
      return;
    }
    setShare({ kind: 'idle' });
    if (result === 'shared') log();
    else if (result === 'unsupported' || result === 'failed') social.toast('Couldn’t share. Download the zip instead.');
  };

  const n = items.length;
  const building = zip.kind === 'building' ? zip : null;

  return (
    <div class="pv-coll-wrap">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes (handled on window) */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a pointer shortcut */}
      <div class="pv-coll-backdrop" onClick={onClose} />
      <section class="pv-coll" role="dialog" aria-modal="true" aria-labelledby="pv-coll-title">
        <header class="pv-coll-head">
          <div>
            <h2 id="pv-coll-title" class="pv-coll-title">
              Your collection
            </h2>
            <p class="pv-muted pv-num">
              {n === 0 ? 'Empty' : `${n} ${n === 1 ? 'photo' : 'photos'} · zip ${formatBytes(estimate)}`}
            </p>
          </div>
          {n > 0 && (
            <button
              type="button"
              class={confirmClear ? 'pv-link pv-coll-clear is-danger' : 'pv-link pv-coll-clear'}
              onClick={() => {
                if (confirmClear) social.clearCollection();
                else setConfirmClear(true);
              }}
            >
              {confirmClear ? 'Tap again to clear' : 'Clear all'}
            </button>
          )}
          <button ref={closeRef} type="button" class="lb-btn pv-coll-close" onClick={onClose} aria-label="Close">
            <Icon name="close" size={20} />
          </button>
        </header>

        {n === 0 ? (
          <div class="pv-coll-empty">
            <Icon name="stack" size={28} />
            <p>Tap + on a photo to add it here, then download them all at once.</p>
          </div>
        ) : (
          <ul class="pv-coll-list">
            {items.map(({ id, image }, i) => (
              <li key={id} class="pv-coll-row">
                <button
                  type="button"
                  class="pv-coll-thumb"
                  aria-label={`Open ${image.download.filename}`}
                  onClick={() => onOpenPhotos(i, false)}
                >
                  <Thumb image={image} sizePx={56} />
                </button>
                <span class="pv-coll-meta">
                  <span class="pv-coll-name">{image.download.filename}</span>
                  <span class="pv-muted pv-num">
                    Page {pageOf.get(id) ?? '–'} · {formatBytes(image.download.bytes)}
                  </span>
                </span>
                <button
                  type="button"
                  class="pv-icon-btn"
                  aria-label={`Remove ${image.download.filename}`}
                  onClick={() => social.removeFromCollection(id)}
                >
                  <Icon name="close" size={18} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {n > 0 && (
          <footer class="pv-coll-foot">
            {ios && (
              <p class="pv-coll-note">
                On iPhone the zip goes to the Files app, not Photos. To put photos in Photos, save them one by one.
              </p>
            )}

            {building ? (
              <div class="pv-progress" role="status">
                <div class="pv-progress-row">
                  <span class="pv-num">
                    Adding {Math.min(building.progress.done + 1, building.progress.total)} of {building.progress.total}…
                  </span>
                  <button
                    type="button"
                    class="pv-link"
                    onClick={() => {
                      building.abort.abort();
                      setZip({ kind: 'idle' });
                    }}
                  >
                    Cancel
                  </button>
                </div>
                <div class="pv-progress-bar">
                  <span
                    style={{
                      width: `${Math.round((100 * building.progress.bytesDone) / Math.max(1, building.progress.bytesTotal))}%`,
                    }}
                  />
                </div>
              </div>
            ) : zip.kind === 'ready' ? (
              <div class="pv-coll-actions">
                <a class="pv-button pv-button-block" href={zip.href} download={zipName}>
                  <Icon name="download" size={18} /> Save zip · {formatBytes(zip.file.size)}
                </a>
                {canShareFiles([zip.file]) && (
                  <button
                    type="button"
                    class="pv-chip"
                    onClick={() => {
                      shareFiles([zip.file]).then((r) => {
                        if (r === 'blocked') social.toast('Tap Share zip again.');
                      });
                    }}
                  >
                    <Icon name="share" size={18} /> Share zip
                  </button>
                )}
              </div>
            ) : (
              <div class="pv-coll-actions">
                <button
                  type="button"
                  class="pv-button pv-button-block"
                  onClick={() => social.withName(() => void buildZip())}
                >
                  <Icon name="download" size={18} /> Download zip · {formatBytes(estimate)}
                </button>
                {zip.kind === 'error' && (
                  <p class="pv-coll-error">Couldn’t build the zip. Check the connection and try again.</p>
                )}
              </div>
            )}

            {(shareable || ios) && (
              <div class="pv-coll-actions">
                {shareable && (
                  <button
                    type="button"
                    class="pv-chip"
                    aria-busy={share.kind === 'loading'}
                    onClick={() => social.withName(() => void shareAll())}
                  >
                    <Icon name="share" size={18} />
                    {share.kind === 'loading'
                      ? `Preparing ${share.done} of ${n}…`
                      : share.kind === 'ready'
                        ? `Share ${n} ${n === 1 ? 'photo' : 'photos'}`
                        : 'Share all'}
                  </button>
                )}
                {ios && (
                  <button type="button" class="pv-chip" onClick={() => onOpenPhotos(0, true)}>
                    <Icon name="photo" size={18} />
                    Save one by one
                  </button>
                )}
              </div>
            )}
          </footer>
        )}
      </section>
    </div>
  );
}
