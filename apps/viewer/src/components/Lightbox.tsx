import type { ImageRecord } from '@photobook/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { animateScrollLeft, cancelScroll } from '../lib/scroll';
import {
  canShareFiles,
  downloadUrl,
  isIOS,
  loadFile,
  prefetchForShare,
  readyFile,
  shareFiles,
  shareLink,
  withExtension,
} from '../lib/share';
import type { Social } from '../social';
import { markSaveHintShown, saveHintShown } from '../storage';
import { Icon } from './icons';
import { Thumb } from './Thumb';

export interface LightboxItem {
  asset: string;
  /** Page the photo is on (sent with download and share events). */
  pageId: string | null;
}

export interface LightboxProps {
  images: Record<string, ImageRecord>;
  /** The photos to step through: a page's photos in page order, or the collection. */
  items: LightboxItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  social: Social;
  /** "Save one by one" from the collection: every photo shows its download version. */
  fullQuality?: boolean;
  /** Opened from the collection view: no collection badge (closing goes back to it). */
  fromCollection?: boolean;
  /** The name prompt is over it: leave the keys to that. */
  covered?: boolean;
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/**
 * Full-screen photo on black: the uncropped 2048 px share version with nothing drawn over it (the
 * iPhone long press must land on the bare `img`). Swipe or arrow between photos, a thumbnail strip,
 * and the actions under the photo: Download, Share, Add to collection, Like. On an iPhone, Download
 * swaps in the full-quality download version and (once per device) says to press and hold it; other
 * devices save the file. Loaded on demand (dynamic import in `Reader`).
 */
export default function Lightbox({
  images,
  items,
  index,
  onIndexChange,
  onClose,
  social,
  fullQuality = false,
  fromCollection = false,
  covered = false,
}: LightboxProps) {
  const track = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const count = items.length;
  const last = Math.max(0, count - 1);
  const ios = useMemo(isIOS, []);
  const [busy, setBusy] = useState<'download' | 'share' | null>(null);
  // iPhone: photos whose Download was tapped (shown in their download version), and the one still loading.
  const [full, setFull] = useState<ReadonlySet<string>>(() => new Set());
  const [loadingFull, setLoadingFull] = useState<string | null>(null);
  const [hint, setHint] = useState(false);

  // Open on the tapped photo; keep it aligned when the viewport resizes.
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const align = () => {
      if (el.clientWidth) el.scrollTo({ left: indexRef.current * el.clientWidth, behavior: 'instant' });
    };
    align();
    const ro = new ResizeObserver(align);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const goTo = (target: number) => {
    const el = track.current;
    if (!el) return;
    const i = clamp(target, 0, last);
    onIndexChange(i);
    animateScrollLeft(el, i * el.clientWidth);
  };

  const onScroll = () => {
    const el = track.current;
    if (!el?.clientWidth) return;
    const i = clamp(Math.round(el.scrollLeft / el.clientWidth), 0, last);
    if (i !== indexRef.current) onIndexChange(i);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || covered) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goTo(indexRef.current + 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goTo(indexRef.current - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const item = items[index];
  const image = item ? images[item.asset] : undefined;
  const shareName = image ? withExtension(image.download.filename, 'jpg') : '';

  // Fetch the shown photo's share JPEG ahead of a Share tap (where files can be shared at all).
  useEffect(() => {
    if (image) prefetchForShare(image.share, shareName, 'image/jpeg');
  }, [image, shareName]);

  const showsFull = (asset: string) => fullQuality || full.has(asset);

  const download = async () => {
    if (!item || !image) return;
    social.log('download', 'photo', item.asset, item.pageId);
    if (ios) {
      // Safari cannot write to Photos: show the download version for a long press instead.
      if (!showsFull(item.asset)) setLoadingFull(item.asset);
      setFull((s) => new Set(s).add(item.asset));
      if (!fullQuality && !saveHintShown()) {
        markSaveHintShown();
        setHint(true);
      }
      return;
    }
    setBusy('download');
    await downloadUrl(image.download.url, image.download.filename);
    setBusy(null);
  };

  const share = async () => {
    if (!item || !image) return;
    const log = () => social.log('share', 'photo', item.asset, item.pageId);
    if (canShareFiles()) {
      let file = readyFile(image.share);
      if (!file) {
        setBusy('share');
        try {
          file = await loadFile(image.share, shareName, 'image/jpeg');
        } catch {
          file = undefined;
        } finally {
          setBusy(null);
        }
      }
      if (file) {
        const result = await shareFiles([file]);
        if (result === 'shared') return log();
        if (result === 'cancelled') return;
        if (result === 'blocked') return social.toast('Ready. Tap Share again.');
      }
    }
    // No file sharing here: share the photo's link, or copy it.
    const result = await shareLink(image.share);
    if (result === 'shared' || result === 'copied') log();
    if (result === 'copied') social.toast('Link copied');
    else if (result === 'failed') social.toast('Couldn’t share this photo.');
  };

  const asset = item?.asset;
  const inCollection = asset ? social.collection.includes(asset) : false;
  const liked = asset ? social.likes.liked('photo', asset) : false;
  const likes = asset ? social.likes.count('photo', asset) : 0;
  // iPhone, after a Download tap: the photo on screen is the full-quality one, held to save.
  const tapped = asset ? full.has(asset) : false;
  const downloadLabel =
    busy === 'download'
      ? 'Saving…'
      : ios && asset && loadingFull === asset
        ? 'Loading…'
        : ios && tapped
          ? 'Hold photo'
          : 'Download';

  return (
    <div class="lb" role="dialog" aria-modal="true" aria-label="Photo">
      <div
        ref={track}
        class="lb-track"
        onScroll={onScroll}
        onTouchStart={() => track.current && cancelScroll(track.current)}
      >
        {items.map(({ asset: id }, i) => {
          const img = images[id];
          if (!img) return null;
          return (
            <div key={id} class="lb-slide">
              {Math.abs(i - index) <= 1 && (
                <img
                  class="lb-img"
                  src={showsFull(id) ? img.download.url : img.share}
                  width={img.width}
                  height={img.height}
                  alt={img.alt ?? ''}
                  decoding="async"
                  draggable={false}
                  style={{ backgroundImage: `url("${img.placeholder}")` }}
                  onLoad={() => setLoadingFull((l) => (l === id ? null : l))}
                  onError={() => setLoadingFull((l) => (l === id ? null : l))}
                />
              )}
            </div>
          );
        })}
      </div>

      <div class="lb-top">
        <button ref={closeRef} type="button" class="lb-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" size={20} />
        </button>
        <span class="lb-counter">
          {index + 1} / {count}
        </span>
        {!fromCollection && social.collection.length > 0 && (
          <button
            type="button"
            class="lb-btn lb-btn-right"
            onClick={social.openCollection}
            aria-label={`Open collection, ${social.collection.length} photos`}
          >
            <Icon name="stack" size={20} />
            <span class="lb-btn-badge">{social.collection.length}</span>
          </button>
        )}
      </div>

      <div class="lb-bottom">
        {count > 1 && (
          <ul class="lb-strip">
            {items.map(({ asset: id }, i) => {
              const img = images[id];
              return img ? (
                <li key={id}>
                  <button
                    type="button"
                    class={i === index ? 'lb-thumb is-current' : 'lb-thumb'}
                    aria-label={`Photo ${i + 1}`}
                    aria-current={i === index ? 'true' : undefined}
                    onClick={() => goTo(i)}
                  >
                    <Thumb image={img} sizePx={56} />
                  </button>
                </li>
              ) : null;
            })}
          </ul>
        )}

        {ios && fullQuality ? (
          <p class="lb-note">Press and hold each photo, then Add to Photos.</p>
        ) : hint ? (
          <div class="lb-hint" role="status">
            <span>Press and hold the photo, then Add to Photos</span>
            <button type="button" class="pv-link" onClick={() => setHint(false)}>
              Got it
            </button>
          </div>
        ) : null}

        <div class="lb-actions">
          <a
            class="lb-action"
            href={image?.download.url}
            download={image?.download.filename}
            aria-busy={busy === 'download' || (ios && asset !== undefined && loadingFull === asset)}
            aria-disabled={!image}
            onClick={(e) => {
              e.preventDefault();
              social.withName(() => void download());
            }}
          >
            <Icon name="download" />
            <span>{downloadLabel}</span>
          </a>
          <button
            type="button"
            class="lb-action"
            aria-label="Share this photo"
            aria-busy={busy === 'share'}
            disabled={!image}
            onClick={() => social.withName(() => void share())}
          >
            <Icon name="share" />
            <span>{busy === 'share' ? 'Loading…' : 'Share'}</span>
          </button>
          <button
            type="button"
            class={inCollection ? 'lb-action is-on' : 'lb-action'}
            aria-pressed={inCollection}
            aria-label={inCollection ? 'Remove this photo from the collection' : 'Add this photo to the collection'}
            disabled={!asset}
            onClick={() => asset && social.toggleCollection(asset)}
          >
            <Icon name={inCollection ? 'check' : 'plus'} />
            <span>{inCollection ? 'Collected' : 'Collect'}</span>
          </button>
          {social.enabled && (
            <button
              type="button"
              class={liked ? 'lb-action lb-like is-on' : 'lb-action lb-like'}
              aria-pressed={liked}
              aria-label={`${liked ? 'Unlike' : 'Like'} this photo, ${likes} ${likes === 1 ? 'like' : 'likes'}`}
              disabled={!asset}
              onClick={() => asset && social.toggleLike('photo', asset)}
            >
              <Icon name="heart" filled={liked} />
              <span class="pv-num">{likes > 0 ? likes : 'Like'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
