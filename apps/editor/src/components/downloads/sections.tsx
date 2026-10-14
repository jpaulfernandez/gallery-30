import type { SocialEvent } from '@photobook/shared';
import { useMemo, useState } from 'react';
import {
  ACTION_LABEL,
  eventPageId,
  eventPhotoIds,
  type LikeGroup,
  type PageStats,
  type PhotoStats,
  relativeTime,
} from '../../lib/activity';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { AssetThumb } from './AssetThumb';
import type { BookLookup } from './lookup';

const MAX_COLLECTION_THUMBS = 6;
const PAGE_SIZE = 100;

export function Card({
  title,
  hint,
  children,
  className = '',
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-line bg-panel ${className}`}>
      <header className="flex items-baseline justify-between gap-3 border-line border-b px-4 py-2.5">
        <h2 className="section-title m-0 font-medium">{title}</h2>
        {hint && <span className="text-[11px] text-fg-muted">{hint}</span>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <EmptyState size="md" className="items-start text-left">
      {children}
    </EmptyState>
  );
}

export const pageLabel = (lookup: BookLookup, pageId: string): string => {
  const n = lookup.pageNumber(pageId);
  return n === null ? 'Removed page' : `Page ${n}`;
};

/** What an event touched: the photo's thumbnail, "Page N", or "N photos" with a row of thumbnails. */
function EventTarget({ event, lookup }: { event: SocialEvent; lookup: BookLookup }) {
  const photos = eventPhotoIds(event);
  if (event.targetType === 'page') {
    const pageId = eventPageId(event);
    return <span className="text-fg">{pageId ? pageLabel(lookup, pageId) : 'A page'}</span>;
  }
  if (event.targetType === 'photo' && photos[0]) {
    return (
      <span className="flex min-w-0 items-center gap-2">
        <AssetThumb assetId={photos[0]} lookup={lookup} className="size-10" />
        <span className="min-w-0 truncate text-fg-muted">{lookup.photoName(photos[0]) ?? 'Removed photo'}</span>
      </span>
    );
  }
  const shown = photos.slice(0, MAX_COLLECTION_THUMBS);
  const more = photos.length - shown.length;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-fg">
        {photos.length} {photos.length === 1 ? 'photo' : 'photos'}
      </span>
      <span className="flex min-w-0 gap-1 overflow-hidden">
        {shown.map((id) => (
          <AssetThumb key={id} assetId={id} lookup={lookup} className="size-7" />
        ))}
        {more > 0 && <span className="self-center pl-1 text-[11px] text-fg-muted">+{more}</span>}
      </span>
    </span>
  );
}

/** Newest first: who, the action, what (thumbnail / page / collection), the page, and when. */
export function ActivityList({
  events,
  lookup,
  now,
}: {
  events: readonly SocialEvent[];
  lookup: BookLookup;
  now: number;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  if (events.length === 0) return <Empty>Nothing has been saved or shared yet.</Empty>;
  return (
    <div>
      <ul className="m-0 flex list-none flex-col p-0">
        {events.slice(0, limit).map((event) => {
          const pageId = event.targetType === 'page' ? null : event.pageId;
          return (
            <li
              key={event.id}
              className="grid grid-cols-[minmax(0,9rem)_5.5rem_minmax(0,1fr)_auto] items-center gap-3 border-line border-b py-2 last:border-b-0"
            >
              <span className="truncate font-medium text-fg" title={event.displayName}>
                {event.displayName}
              </span>
              <span className="text-fg-muted">{ACTION_LABEL[event.action]}</span>
              <span className="flex min-w-0 items-center gap-3">
                <EventTarget event={event} lookup={lookup} />
                {pageId && (
                  <span className="shrink-0 text-[11px] text-fg-muted">
                    on {pageLabel(lookup, pageId).toLowerCase()}
                  </span>
                )}
              </span>
              <time
                dateTime={event.createdAt}
                title={new Date(event.createdAt).toLocaleString()}
                className="text-[11px] text-fg-muted tabular-nums"
              >
                {relativeTime(event.createdAt, now)}
              </time>
            </li>
          );
        })}
      </ul>
      {events.length > limit && (
        <Button size="sm" onClick={() => setLimit((l) => l + PAGE_SIZE)} className="mt-3">
          Show more ({events.length - limit} left)
        </Button>
      )}
    </div>
  );
}

function Counts({ saves, likes }: { saves: number; likes: number }) {
  return (
    <span className="flex items-center gap-2 text-[11px] text-fg-muted tabular-nums">
      <span title="Saved (downloads, shares, zips)">{saves} saved</span>
      <span title="Likes">{likes} liked</span>
    </span>
  );
}

/** The few most saved and liked photos, ranked. */
export function TopPhotoList({ photos, lookup }: { photos: readonly PhotoStats[]; lookup: BookLookup }) {
  if (photos.length === 0) return <Empty>No photo has been saved or liked yet.</Empty>;
  return (
    <ol className="m-0 flex list-none flex-col gap-2 p-0">
      {photos.map((p, i) => (
        <li key={p.assetId} className="flex items-center gap-3">
          <span className="w-4 text-right text-[11px] text-fg-muted tabular-nums">{i + 1}</span>
          <AssetThumb assetId={p.assetId} lookup={lookup} className="size-11" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-fg">{lookup.photoName(p.assetId) ?? 'Removed photo'}</span>
            <Counts saves={p.saves} likes={p.likes} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A grid of thumbnails with their save and like counts, in book order. */
export function PhotoGrid({ photos, lookup }: { photos: readonly PhotoStats[]; lookup: BookLookup }) {
  const ordered = useMemo(
    () =>
      [...photos].sort(
        (a, b) =>
          lookup.photoOrder(a.assetId) - lookup.photoOrder(b.assetId) ||
          Number(lookup.hasPhoto(b.assetId)) - Number(lookup.hasPhoto(a.assetId)) ||
          a.assetId.localeCompare(b.assetId),
      ),
    [photos, lookup],
  );
  if (ordered.length === 0) return <Empty>No photo has been saved or liked yet.</Empty>;
  return (
    <ul
      className="m-0 grid list-none gap-3 p-0"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}
    >
      {ordered.map((p) => (
        <li key={p.assetId} className="flex flex-col gap-1.5">
          <AssetThumb assetId={p.assetId} lookup={lookup} className="aspect-square w-full" />
          <span className="flex items-center justify-between text-[11px] tabular-nums">
            <span className="text-fg" title="Saved (downloads, shares, zips)">
              {p.saves} saved
            </span>
            <span className="text-fg-muted" title="Likes">
              {p.likes} liked
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Per-page counts in page order, with a bar for the saves. */
export function PageCounts({ pages, lookup }: { pages: readonly PageStats[]; lookup: BookLookup }) {
  const ordered = useMemo(
    () =>
      [...pages].sort(
        (a, b) =>
          (lookup.pageNumber(a.pageId) ?? Number.POSITIVE_INFINITY) -
            (lookup.pageNumber(b.pageId) ?? Number.POSITIVE_INFINITY) || a.pageId.localeCompare(b.pageId),
      ),
    [pages, lookup],
  );
  if (ordered.length === 0) return <Empty>No page has been saved, shared or liked yet.</Empty>;
  const max = Math.max(1, ...ordered.map((p) => p.saves));
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {ordered.map((p) => (
        <li key={p.pageId} className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-3">
          <span className="truncate text-fg">{pageLabel(lookup, p.pageId)}</span>
          <span className="h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${(p.saves / max) * 100}%` }} />
          </span>
          <span className="flex gap-2 text-[11px] text-fg-muted tabular-nums">
            <span title="Photos saved from this page">{p.saves} saved</span>
            <span title="Page shared to Instagram">{p.shares} shared</span>
            <span title="Likes">{p.likes} liked</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Who liked which page or photo. */
export function LikesList({ groups, lookup, now }: { groups: readonly LikeGroup[]; lookup: BookLookup; now: number }) {
  if (groups.length === 0) return <Empty>Nobody has liked anything yet.</Empty>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {groups.map((g) => (
        <li key={`${g.type}:${g.id}`} className="flex items-start gap-3">
          {g.type === 'photo' ? (
            <AssetThumb assetId={g.id} lookup={lookup} className="size-11" />
          ) : (
            <span className="flex size-11 shrink-0 items-center justify-center rounded-sm border border-line text-[10px] text-fg-muted">
              {lookup.pageNumber(g.id) ?? '?'}
            </span>
          )}
          <span className="flex min-w-0 flex-col gap-1">
            <span className="text-fg">
              {g.type === 'photo' ? (lookup.photoName(g.id) ?? 'Removed photo') : pageLabel(lookup, g.id)}
              <span className="ml-2 text-[11px] text-fg-muted tabular-nums">
                {g.likes.length} {g.likes.length === 1 ? 'like' : 'likes'}
              </span>
            </span>
            <span className="flex flex-wrap gap-1">
              {g.likes.map((l) => (
                <span
                  key={`${l.deviceId}`}
                  title={relativeTime(l.createdAt, now)}
                  className="rounded-full border border-line px-2 py-0.5 text-[11px] text-fg-muted"
                >
                  {l.displayName ?? 'Someone'}
                </span>
              ))}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
