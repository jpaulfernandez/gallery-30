import { useEffect, useRef, useState } from 'preact/hooks';
import { downloadUrl } from '../lib/share';
import { Icon } from './icons';
import type { PageImage } from './PagePanel';

/**
 * Share page fallback when the share sheet cannot take files: the rendered page PNG on black for a
 * long-press save (nothing drawn over it), and a Download link. Loaded on demand.
 */
export default function ImageView({
  image,
  touch,
  onClose,
  covered = false,
}: {
  image: PageImage;
  touch: boolean;
  onClose: () => void;
  /** The name prompt is over it: leave the keys to that. */
  covered?: boolean;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div class="lb lb-image" role="dialog" aria-modal="true" aria-label={image.label}>
      <div class="lb-top">
        <button ref={closeRef} type="button" class="lb-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" size={20} />
        </button>
        <span class="lb-counter">{image.label}</span>
      </div>
      <div class="lb-single">
        <img class="lb-img" src={image.url} alt={image.label} draggable={false} />
      </div>
      <div class="lb-bottom">
        <p class="lb-note">
          {touch
            ? 'Press and hold the image, then Add to Photos. Then post it from Instagram.'
            : 'Download the image, then post it from Instagram.'}
        </p>
        <div class="lb-actions">
          <a
            class="lb-action lb-action-wide"
            href={image.url}
            download={image.filename}
            aria-busy={busy}
            onClick={async (e) => {
              e.preventDefault();
              setBusy(true);
              await downloadUrl(image.url, image.filename);
              setBusy(false);
            }}
          >
            <Icon name="download" />
            <span>{busy ? 'Downloading…' : 'Download'}</span>
          </a>
        </div>
      </div>
    </div>
  );
}
