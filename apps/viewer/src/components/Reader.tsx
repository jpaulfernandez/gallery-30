import type { EventAction, EventTargetType, LikeTargetType, Manifest, ManifestPage, Site } from '@photobook/shared';
import type { JSX } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useCollection } from '../collection';
import { makeResolvers, pagePhotos } from '../lib/resolve';
import { animateScrollLeft, cancelScroll } from '../lib/scroll';
import { bookPath, replacePath } from '../routes';
import { ANONYMOUS, deviceId, logEvent, readName, type Social, useLikes, writeName } from '../social';
import { guideShown, readLastPage, writeLastPage } from '../storage';
import { Guide } from './Guide';
import type { LightboxItem } from './Lightbox';
import type { PageImage } from './PagePanel';
import { RotateHint } from './RotateHint';
import { Slide } from './Slide';

// Code-split: a friend who only swipes never downloads these.
const PageGrid = lazy(() => import('./PageGrid'));
const Lightbox = lazy(() => import('./Lightbox'));
const loadDrawer = () => import('./Drawer');
const Drawer = lazy(loadDrawer);
const PhotoPanel = lazy(() => import('./PhotoPanel'));
const Collection = lazy(() => import('./Collection'));
const NamePrompt = lazy(() => import('./NamePrompt'));
const ImageView = lazy(() => import('./ImageView'));

/** Edge zones (fraction of the track width) where a tap steps a page. */
const EDGE_ZONE = 0.2;
/** Fallback for engines without `scrollend`: settle this long after the last scroll event. */
const SETTLE_MS = 120;
/** Above this the page sits in a centred column and the photo list becomes a side panel. */
const DESKTOP_QUERY = '(min-width: 901px)';
const DESKTOP_PAD = 32;
/** Pages ahead of the current one that are mounted and fetched before they are reached. */
const PRELOAD_AHEAD = 3;
/** Pages behind the current one kept mounted. */
const PRELOAD_BEHIND = 1;
/** The controls fade out this long after the last interaction. */
const CHROME_MS = 3500;
/** An upward drag this long (px) on the handle or the bottom pills opens the drawer. */
const SWIPE_UP = 24;
const TOAST_MS = 2600;

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

export interface ReaderProps {
  manifest: Manifest;
  /** For `site.api`: the social Worker, or null (likes hidden, nothing logged). */
  site: Site;
  slug: string;
  /** 1-based page from the URL; changes on back/forward. */
  routePage: number | null;
}

/**
 * The book: a horizontal scroll-snap track of pages (one per viewport, the shared `<Page>` mounted
 * for the current page and its neighbours), the page counter that opens the jump grid, the lightbox,
 * the side panel above 900 px. Ported from the editor's preview Reader.
 */
interface LightboxState {
  items: LightboxItem[];
  index: number;
  /** Save one by one: download versions. */
  fullQuality: boolean;
  fromCollection: boolean;
}

export function Reader({ manifest, site, slug, routePage }: ReaderProps) {
  const count = manifest.pages.length;
  const last = Math.max(0, count - 1);
  const trackRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touching = useRef(false);

  // `index` is the settled page (counter, URL, side panel). `near` follows the scroll position so a
  // fast swipe past the neighbours still finds mounted pages.
  const [index, setIndex] = useState(() => clamp((routePage ?? readLastPage(slug) ?? 1) - 1, 0, last));
  const [near, setNear] = useState(index);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [gridOpen, setGridOpen] = useState(false);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [pageImage, setPageImage] = useState<PageImage | null>(null);
  const [nameOpen, setNameOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const touch = useMediaQuery('(hover: none)');
  const [guideOpen, setGuideOpen] = useState(() => !guideShown());

  // Controls (arrows, counter, photos): shown on load and after any interaction, faded after a
  // pause so nothing sits over the page while reading. The grid and lightbox keep them.
  const [chrome, setChrome] = useState(true);
  const chromeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealChrome = useCallback(() => {
    setChrome(true);
    if (chromeTimer.current) clearTimeout(chromeTimer.current);
    chromeTimer.current = setTimeout(() => setChrome(false), CHROME_MS);
  }, []);
  useEffect(() => {
    revealChrome();
    return () => {
      if (chromeTimer.current) clearTimeout(chromeTimer.current);
    };
  }, [revealChrome]);

  const current = clamp(index, 0, last);
  const indexRef = useRef(current);
  indexRef.current = current;
  const zoomedRef = useRef(zoomed);
  zoomedRef.current = zoomed;

  const resolvers = useMemo(() => makeResolvers(manifest), [manifest]);

  // --- Social: likes, the download log, the display name, the collection ---------------------
  const api = site.api;
  const showToast = useCallback((text: string) => setToast((t) => ({ text, n: (t?.n ?? 0) + 1 })), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const likes = useLikes(api, manifest.id, () => showToast('Couldn’t save your like. Try again.'));
  const exists = useCallback((id: string) => id in manifest.images, [manifest]);
  const collection = useCollection(slug, exists);

  // The action waiting for the name prompt (runs from its Continue or Skip tap).
  const pendingName = useRef<((name: string) => void) | null>(null);
  const withName = useCallback(
    (action: (name: string | null) => void) => {
      if (!api) return action(null);
      const name = readName();
      if (name) return action(name);
      pendingName.current = action;
      setNameOpen(true);
    },
    [api],
  );
  const onNameDone = useCallback((name: string) => {
    writeName(name);
    setNameOpen(false);
    const action = pendingName.current;
    pendingName.current = null;
    action?.(readName() ?? ANONYMOUS);
  }, []);
  const onNameCancel = useCallback(() => {
    pendingName.current = null;
    setNameOpen(false);
  }, []);

  const log = useCallback(
    (action: EventAction, targetType: EventTargetType, targetId: string | string[], pageId: string | null) => {
      if (!api) return;
      logEvent(api, {
        bookId: manifest.id,
        targetType,
        targetId,
        action,
        displayName: readName() ?? ANONYMOUS,
        deviceId: deviceId(),
        pageId,
      });
    },
    [api, manifest.id],
  );

  const openCollection = useCallback(() => {
    setLightbox(null);
    setDrawerOpen(false);
    setCollectionOpen(true);
  }, []);

  const social = useMemo<Social>(
    () => ({
      enabled: api !== null,
      bookId: manifest.id,
      slug,
      title: manifest.title,
      likes,
      toggleLike: (type: LikeTargetType, id: string) => withName((name) => likes.toggle(type, id, name)),
      withName,
      log,
      collection: collection.ids,
      toggleCollection: collection.toggle,
      removeFromCollection: collection.remove,
      clearCollection: collection.clear,
      openCollection,
      toast: showToast,
    }),
    [api, manifest, slug, likes, withName, log, collection, openCollection, showToast],
  );

  /** Asset id -> id of the first page that shows it (for events from the collection). */
  const pageIdOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of manifest.pages) for (const id of pagePhotos(p)) if (!map.has(id)) map.set(id, p.id);
    return map;
  }, [manifest]);

  const openPagePhoto = useCallback(
    (pageIndex: number, photo: number) => {
      const p = manifest.pages[pageIndex];
      if (!p) return;
      const items = pagePhotos(p).map((asset) => ({ asset, pageId: p.id }));
      if (items.length === 0) return;
      setDrawerOpen(false);
      setLightbox({ items, index: clamp(photo, 0, items.length - 1), fullQuality: false, fromCollection: false });
    },
    [manifest],
  );

  const openCollectionPhotos = useCallback(
    (index: number, fullQuality: boolean) => {
      const items = collection.ids.map((asset) => ({ asset, pageId: pageIdOf.get(asset) ?? null }));
      if (items.length === 0) return;
      setLightbox({ items, index: clamp(index, 0, items.length - 1), fullQuality, fromCollection: true });
    },
    [collection.ids, pageIdOf],
  );

  const openDrawer = useCallback(() => {
    revealChrome();
    setDrawerOpen(true);
  }, [revealChrome]);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  // The sheet only exists below 901 px: crossing the breakpoint with it open (a rotated tablet) would
  // otherwise leave `drawerOpen` stuck and the arrow keys disabled.
  useEffect(() => {
    if (isDesktop) setDrawerOpen(false);
  }, [isDesktop]);
  const closeCollection = useCallback(() => setCollectionOpen(false), []);
  const closeImage = useCallback(() => setPageImage(null), []);

  // Swipe up on the handle or the bottom pills opens the drawer.
  const swipeFrom = useRef<number | null>(null);
  const onDockTouchStart = (e: TouchEvent) => {
    swipeFrom.current = e.touches[0]?.clientY ?? null;
    loadDrawer();
  };
  const onDockTouchMove = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY;
    if (swipeFrom.current === null || y === undefined) return;
    if (swipeFrom.current - y > SWIPE_UP) {
      swipeFrom.current = null;
      openDrawer();
    }
  };

  // The URL and the remembered page follow the settled page.
  useEffect(() => {
    replacePath(bookPath(slug, current + 1));
    writeLastPage(slug, current + 1);
  }, [slug, current]);

  /** Turn to a page: ~250 ms slide, or instant (grid pick, back/forward). */
  const goTo = useCallback(
    (target: number, behavior: 'smooth' | 'instant' = 'smooth') => {
      const i = clamp(target, 0, last);
      revealChrome();
      indexRef.current = i;
      setIndex(i);
      if (behavior === 'instant') setNear(i);
      const el = trackRef.current;
      if (!el) return;
      const left = i * el.clientWidth;
      if (behavior === 'instant') {
        cancelScroll(el);
        el.scrollTo({ left, behavior: 'instant' });
      } else {
        animateScrollLeft(el, left);
      }
    },
    [last, revealChrome],
  );

  // Back/forward changed the page in the URL.
  useEffect(() => {
    if (routePage !== null && routePage - 1 !== indexRef.current) goTo(routePage - 1, 'instant');
  }, [routePage, goTo]);

  // Measure the track; keep the current page aligned when its width changes.
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const update = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      setSize((s) =>
        s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight },
      );
      const left = indexRef.current * el.clientWidth;
      if (Math.abs(el.scrollLeft - left) > 1) {
        cancelScroll(el);
        el.scrollTo({ left, behavior: 'instant' });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** The scroll came to rest: adopt the page under the viewport, re-align if a cancelled turn left it between pages. */
  const settle = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    const el = trackRef.current;
    if (!el || el.clientWidth === 0 || count === 0) return;
    const i = clamp(Math.round(el.scrollLeft / el.clientWidth), 0, last);
    indexRef.current = i;
    setIndex(i);
    setNear(i);
    const left = i * el.clientWidth;
    if (!touching.current && !zoomedRef.current && Math.abs(el.scrollLeft - left) > 1) animateScrollLeft(el, left);
  }, [count, last]);

  const scheduleSettle = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(settle, SETTLE_MS);
  }, [settle]);

  const onScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el || el.clientWidth === 0) return;
    setNear(clamp(Math.round(el.scrollLeft / el.clientWidth), 0, last));
    scheduleSettle();
  }, [last, scheduleSettle]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    el.addEventListener('scrollend', settle);
    return () => {
      el.removeEventListener('scrollend', settle);
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
  }, [settle]);

  // A finger or wheel on the track takes over from a running page turn.
  const interrupt = () => {
    const el = trackRef.current;
    if (el) cancelScroll(el);
  };
  const onTouchStart = () => {
    touching.current = true;
    interrupt();
  };
  const onTouchEnd = () => {
    touching.current = false;
    scheduleSettle();
  };

  // Keyboard: arrows step, Escape closes the grid. The overlays have their own keys while open.
  const overlayOpen = lightbox !== null || drawerOpen || collectionOpen || nameOpen || pageImage !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || overlayOpen) return;
      if (e.key === 'Escape') {
        if (gridOpen) {
          e.preventDefault();
          setGridOpen(false);
        }
      } else if (!gridOpen && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        goTo(indexRef.current + (e.key === 'ArrowRight' ? 1 : -1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gridOpen, overlayOpen, goTo]);

  const openPhoto = useCallback(
    (pageIndex: number, assetId: string) => {
      const photo = pagePhotos(manifest.pages[pageIndex]).indexOf(assetId);
      if (photo >= 0) openPagePhoto(pageIndex, photo);
    },
    [manifest, openPagePhoto],
  );

  // Taps: the outer 20 % of either side steps a page (unless zoomed in); a photo elsewhere opens the lightbox.
  const onTrackClick = (e: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = (e.clientX - rect.left) / rect.width;
    if (!zoomedRef.current) {
      if (x < EDGE_ZONE) {
        goTo(indexRef.current - 1);
        return;
      }
      if (x > 1 - EDGE_ZONE) {
        goTo(indexRef.current + 1);
        return;
      }
    }
    const photoEl = (e.target as Element | null)?.closest('.pb-photo');
    const slideEl = photoEl?.closest<HTMLElement>('[data-slide]');
    if (!photoEl || !slideEl) {
      // A tap on the page itself (text, background) shows or hides the controls.
      if (chrome) {
        if (chromeTimer.current) clearTimeout(chromeTimer.current);
        setChrome(false);
      } else revealChrome();
      return;
    }
    const pageIndex = Number(slideEl.dataset.slide);
    const page = manifest.pages[pageIndex];
    if (!page) return;
    const assetId = assetOfPhotoElement(photoEl, page);
    if (assetId) openPhoto(pageIndex, assetId);
  };

  const ratio = manifest.template.width / manifest.template.height;
  const pad = isDesktop ? DESKTOP_PAD : 0;
  const pageW = size.w ? Math.max(1, Math.floor(Math.min(size.w - pad * 2, (size.h - pad * 2) * ratio))) : 0;
  const page = manifest.pages[current];
  const photoCount = pagePhotos(page).length;
  const pageLikes = page && social.enabled ? likes.count('page', page.id) : 0;
  const panelProps = {
    manifest,
    page,
    pageNumber: current + 1,
    social,
    onOpenPhoto: (photo: number) => openPagePhoto(current, photo),
    onShowImage: setPageImage,
  };
  const chromeClass = chrome || gridOpen || guideOpen ? 'pv-chrome' : 'pv-chrome is-hidden';

  if (count === 0) {
    return (
      <main class="pv-center">
        <p>This book has no pages yet.</p>
      </main>
    );
  }

  return (
    <div class="pv-book">
      <div class="pv-stage" style={{ background: manifest.theme.background }}>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: arrow keys are handled on window; the tap zones are a pointer shortcut */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
        <div
          ref={trackRef}
          class={zoomed ? 'pv-track is-zoomed' : 'pv-track'}
          onScroll={onScroll}
          onClick={onTrackClick}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
          onWheel={interrupt}
          onMouseMove={touch ? undefined : revealChrome}
        >
          {manifest.pages.map((p, i) => {
            // Mounted: one page behind, three ahead (fetched eagerly so the next turns are instant),
            // plus whatever a fast swipe is passing over.
            const ahead = i - current;
            const preload = ahead >= -PRELOAD_BEHIND && ahead <= PRELOAD_AHEAD;
            const mounted = preload || Math.abs(i - near) <= 1;
            return (
              <div key={p.id} class="pv-slide-wrap" data-slide={i}>
                {pageW > 0 && mounted ? (
                  <Slide
                    page={p}
                    template={manifest.template}
                    theme={manifest.theme}
                    resolve={preload ? resolvers.eager : resolvers.lazy}
                    widthPx={pageW}
                    active={i === current}
                    onZoomChange={setZoomed}
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        {!touch && (
          <>
            <button
              type="button"
              class={`pv-arrow pv-arrow-prev ${chromeClass}`}
              aria-label="Previous page"
              disabled={current === 0}
              onClick={() => goTo(indexRef.current - 1)}
            >
              <Chevron />
            </button>
            <button
              type="button"
              class={`pv-arrow pv-arrow-next ${chromeClass}`}
              aria-label="Next page"
              disabled={current === last}
              onClick={() => goTo(indexRef.current + 1)}
            >
              <Chevron />
            </button>
          </>
        )}

        {!isDesktop && (
          <button
            type="button"
            class="pv-handle"
            aria-label="Open photos, likes and sharing for this page"
            aria-expanded={drawerOpen}
            onClick={openDrawer}
            onTouchStart={onDockTouchStart}
            onTouchMove={onDockTouchMove}
          >
            <span class="pv-handle-grip" />
          </button>
        )}

        <div class={`pv-bar ${chromeClass}`} onTouchStart={onDockTouchStart} onTouchMove={onDockTouchMove}>
          <button
            type="button"
            class="pv-pill pv-counter"
            aria-label="Show all pages"
            aria-expanded={gridOpen}
            onClick={() => {
              revealChrome();
              setGridOpen((open) => !open);
            }}
          >
            <GridGlyph />
            {current + 1} / {count}
          </button>
          {photoCount > 0 && !isDesktop && (
            <button
              type="button"
              class="pv-pill pv-photos"
              aria-label={`The ${photoCount} ${photoCount === 1 ? 'photo' : 'photos'} on this page: download, share, like`}
              aria-expanded={drawerOpen}
              onClick={openDrawer}
            >
              <PhotoGlyph />
              {photoCount === 1 ? '1 photo' : `${photoCount} photos`}
              {pageLikes > 0 && (
                <span class="pv-pill-likes">
                  <HeartGlyph />
                  {pageLikes}
                </span>
              )}
            </button>
          )}
        </div>

        {guideOpen && (
          <Guide
            touch={touch}
            counter={`${current + 1} / ${count}`}
            onDismiss={() => {
              setGuideOpen(false);
              revealChrome();
            }}
          />
        )}

        {drawerOpen && !isDesktop && (
          <Suspense fallback={null}>
            <Drawer {...panelProps} onClose={closeDrawer} covered={nameOpen} />
          </Suspense>
        )}

        <RotateHint template={manifest.template} />

        {gridOpen && (
          <Suspense fallback={null}>
            <PageGrid
              manifest={manifest}
              resolve={resolvers.lazy}
              current={current}
              width={size.w}
              onPick={(i) => {
                setGridOpen(false);
                goTo(i, 'instant');
              }}
              onClose={() => setGridOpen(false)}
            />
          </Suspense>
        )}
      </div>

      {isDesktop && (
        <Suspense fallback={<aside class="pv-aside" />}>
          <PhotoPanel {...panelProps} />
        </Suspense>
      )}

      {collectionOpen && (
        <Suspense fallback={null}>
          <Collection
            manifest={manifest}
            social={social}
            onClose={closeCollection}
            onOpenPhotos={openCollectionPhotos}
            covered={lightbox !== null || nameOpen}
          />
        </Suspense>
      )}

      {lightbox && (
        <Suspense fallback={<div class="lb" />}>
          <Lightbox
            images={manifest.images}
            items={lightbox.items}
            index={clamp(lightbox.index, 0, Math.max(0, lightbox.items.length - 1))}
            onIndexChange={(index) => setLightbox((l) => (l ? { ...l, index } : l))}
            onClose={() => setLightbox(null)}
            social={social}
            fullQuality={lightbox.fullQuality}
            fromCollection={lightbox.fromCollection}
            covered={nameOpen}
          />
        </Suspense>
      )}

      {pageImage && (
        <Suspense fallback={<div class="lb" />}>
          <ImageView image={pageImage} touch={touch} onClose={closeImage} covered={nameOpen} />
        </Suspense>
      )}

      {nameOpen && (
        <Suspense fallback={null}>
          <NamePrompt onDone={onNameDone} onCancel={onNameCancel} />
        </Suspense>
      )}

      {toast && (
        <div key={toast.n} class="pv-toast pv-toast-top" role="status">
          {toast.text}
        </div>
      )}
    </div>
  );
}

/**
 * Map a rendered `.pb-photo` back to its asset. The renderer only adds `data-element-id` when
 * `editable`, so this relies on render order: the background photo (`pb-page-bg`) first, then one
 * `.pb-photo` per photo element of `page.elements` in order (empty slots included).
 */
function assetOfPhotoElement(photoEl: Element, page: ManifestPage): string | null {
  if (photoEl.classList.contains('pb-page-bg')) {
    return typeof page.background === 'object' ? page.background.asset : null;
  }
  const pageEl = photoEl.parentElement;
  if (!pageEl) return null;
  const rendered = Array.from(pageEl.children).filter(
    (c) => c.classList.contains('pb-photo') && !c.classList.contains('pb-page-bg'),
  );
  const n = rendered.indexOf(photoEl);
  if (n < 0) return null;
  const photos = page.elements.filter((el) => el.type === 'photo');
  return photos[n]?.asset ?? null;
}

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        d="M9 5l7 7-7 7"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function GridGlyph() {
  return (
    <svg class="pv-glyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
      />
    </svg>
  );
}

function PhotoGlyph() {
  return (
    <svg class="pv-glyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function HeartGlyph() {
  return (
    <svg class="pv-glyph" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        d="M12 20.5s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.5 2.8c0 5.5-7.5 10.1-7.5 10.1z"
        fill="currentColor"
      />
    </svg>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
