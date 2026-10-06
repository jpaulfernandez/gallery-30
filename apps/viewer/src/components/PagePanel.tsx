import type { Manifest, ManifestPage } from '@photobook/shared';
import { useEffect, useState } from 'preact/hooks';
import { pagePhotos } from '../lib/resolve';
import { canShareFiles, loadFile, prefetchForShare, readyFile, shareFiles } from '../lib/share';
import type { Social } from '../social';
import { Icon } from './icons';
import { Thumb } from './Thumb';

/** A rendered page PNG shown for a long-press save when the share sheet cannot take files. */
export interface PageImage {
  url: string;
  filename: string;
  label: string;
}

export interface PagePanelProps {
  manifest: Manifest;
  page: ManifestPage | undefined;
  pageNumber: number;
  social: Social;
  /** Index into `pagePhotos(page)`. */
  onOpenPhoto: (index: number) => void;
  onShowImage: (image: PageImage) => void;
  /** Phones: the sheet shows "Page n of N" itself (the side panel has its own header). */
  heading?: boolean;
}

/**
 * What the drawer (phones) and the side panel (desktop) show for the current page: its like count
 * with a heart, Share page (Feed or Story), the collection badge, and the page's photos as square
 * thumbnails with an Add to collection toggle each. Tapping a thumbnail opens the lightbox.
 */
export function PagePanel({
  manifest,
  page,
  pageNumber,
  social,
  onOpenPhoto,
  onShowImage,
  heading = false,
}: PagePanelProps) {
  const photos = pagePhotos(page);
  const pageLikes = page ? social.likes.count('page', page.id) : 0;
  const pageLiked = page ? social.likes.liked('page', page.id) : false;
  const collected = social.collection.length;
  const like =
    social.enabled && page ? (
      <button
        type="button"
        class={pageLiked ? 'pv-chip pv-like is-on' : 'pv-chip pv-like'}
        aria-pressed={pageLiked}
        aria-label={`${pageLiked ? 'Unlike' : 'Like'} this page, ${pageLikes} ${pageLikes === 1 ? 'like' : 'likes'}`}
        onClick={() => social.toggleLike('page', page.id)}
      >
        <Icon name="heart" size={18} filled={pageLiked} />
        <span class="pv-num">{pageLikes}</span>
      </button>
    ) : null;

  return (
    <div class="pv-pp">
      {heading ? (
        <div class="pv-pp-row">
          <p class="pv-pp-title">
            Page {pageNumber} <span class="pv-muted">of {manifest.pages.length}</span>
          </p>
          {like}
        </div>
      ) : null}

      <div class="pv-pp-actions">
        {!heading && like}
        {page && (page.shareFeed || page.shareStory) && (
          <SharePage key={page.id} page={page} pageNumber={pageNumber} social={social} onShowImage={onShowImage} />
        )}
        <button
          type="button"
          class="pv-chip"
          onClick={social.openCollection}
          aria-label={`Collection, ${collected} ${collected === 1 ? 'photo' : 'photos'}`}
        >
          <Icon name="stack" size={18} />
          Collection
          <span class={collected ? 'pv-badge' : 'pv-badge is-empty'}>{collected}</span>
        </button>
      </div>

      <h2 class="pv-label">Photos on this page</h2>
      {photos.length === 0 ? (
        <p class="pv-muted">No photos on this page</p>
      ) : (
        <ul class="pv-photo-list">
          {photos.map((id, i) => {
            const image = manifest.images[id];
            if (!image) return null;
            const inCollection = social.collection.includes(id);
            return (
              <li key={id} class="pv-pp-cell">
                <button
                  type="button"
                  class="pv-photo-cell"
                  aria-label={`Open photo ${i + 1}`}
                  onClick={() => onOpenPhoto(i)}
                >
                  <Thumb image={image} sizePx={160} />
                </button>
                <button
                  type="button"
                  class={inCollection ? 'pv-collect is-on' : 'pv-collect'}
                  aria-pressed={inCollection}
                  aria-label={
                    inCollection ? `Remove photo ${i + 1} from collection` : `Add photo ${i + 1} to collection`
                  }
                  onClick={() => social.toggleCollection(id)}
                >
                  <span class="pv-collect-dot">
                    <Icon name={inCollection ? 'check' : 'plus'} size={15} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type Kind = 'feed' | 'story';

/** "Share page": Feed (1080 x 1350) or Story (1080 x 1920), the PNGs rendered at publish. */
function SharePage({
  page,
  pageNumber,
  social,
  onShowImage,
}: {
  page: ManifestPage;
  pageNumber: number;
  social: Social;
  onShowImage: (image: PageImage) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Kind | null>(null);
  const image = (kind: Kind): PageImage | null => {
    const url = kind === 'feed' ? page.shareFeed : page.shareStory;
    return url
      ? {
          url,
          filename: `${social.slug}-page-${pageNumber}-${kind}.png`,
          label: kind === 'feed' ? 'Feed image' : 'Story image',
        }
      : null;
  };

  // The menu is open: fetch both PNGs now so the share sheet can open straight from the tap.
  useEffect(() => {
    if (!open) return;
    for (const kind of ['feed', 'story'] as const) {
      const img = image(kind);
      if (img) prefetchForShare(img.url, img.filename, 'image/png');
    }
  });

  const share = async (kind: Kind, img: PageImage) => {
    const log = () => social.log('page_share', 'page', page.id, page.id);
    if (!canShareFiles()) {
      log();
      setOpen(false);
      onShowImage(img);
      return;
    }
    let file = readyFile(img.url);
    if (!file) {
      setBusy(kind);
      try {
        file = await loadFile(img.url, img.filename, 'image/png');
      } catch {
        social.toast('Couldn’t load the page image.');
        return;
      } finally {
        setBusy(null);
      }
    }
    const result = await shareFiles([file]);
    if (result === 'shared') {
      log();
      setOpen(false);
    } else if (result === 'blocked') {
      social.toast('Ready. Tap again to share.');
    } else if (result === 'unsupported' || result === 'failed') {
      log();
      setOpen(false);
      onShowImage(img);
    }
  };

  const pick = (kind: Kind) => {
    const img = image(kind);
    if (img) social.withName(() => void share(kind, img));
  };

  if (!open) {
    return (
      <button type="button" class="pv-chip" aria-expanded="false" onClick={() => setOpen(true)}>
        <Icon name="share" size={18} />
        Share page
      </button>
    );
  }
  return (
    <div class="pv-share-menu">
      {page.shareFeed && (
        <button type="button" class="pv-chip" aria-busy={busy === 'feed'} onClick={() => pick('feed')}>
          {busy === 'feed' ? 'Loading…' : 'Feed'} <span class="pv-muted">4:5</span>
        </button>
      )}
      {page.shareStory && (
        <button type="button" class="pv-chip" aria-busy={busy === 'story'} onClick={() => pick('story')}>
          {busy === 'story' ? 'Loading…' : 'Story'} <span class="pv-muted">9:16</span>
        </button>
      )}
      <button type="button" class="pv-chip pv-chip-icon" aria-label="Cancel" onClick={() => setOpen(false)}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
