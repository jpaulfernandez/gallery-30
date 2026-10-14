import { type Book, locatePage } from '@photobook/shared';
import { type CaptionPlacement, type PageCaption, placeCaptions } from '../../lib/ai/placeCaptions';
import type { CaptionMode, PagePhoto } from '../../lib/jobs/aiPageCaption';

/**
 * Workflow plan 35: the review of one page's captions, shared by the Caption this page sheet and the rows of the
 * Caption book dialog. Each caption with what it is about (the page, or a photo by its index number and file name),
 * its alt text, and where Apply puts it (`placeCaptions`, computed on the page as it is now). `editing` turns the texts
 * into fields.
 */

const fieldClass =
  'w-full resize-y rounded-md border border-line bg-panel-2 px-2 py-1 text-fg text-xs outline-none select-text focus:border-accent';

/** Where a placement puts its text, for the review. */
export function placementLine(p: CaptionPlacement): string {
  if (p.elementId === null) return 'New caption at the bottom of the page';
  const before = p.replaces.replace(/\s+/g, ' ').trim();
  if (!before) return 'Into the empty caption box';
  return `Replaces “${before.length > 60 ? `${before.slice(0, 57)}…` : before}”`;
}

/** The placements Apply would make for `captions` on page `pageId` now (none when the page is gone). */
export function previewPlacements(book: Book | null, pageId: string, captions: readonly PageCaption[]) {
  const at = book ? locatePage(book, pageId) : undefined;
  const page = at?.pages[at.index];
  return page && at ? placeCaptions(page, captions, at.template) : [];
}

export function CaptionReview({
  book,
  pageId,
  photos,
  captions,
  mode,
  editing = false,
  onChange,
  notSent = 0,
}: {
  book: Book | null;
  pageId: string;
  /** In `page` mode the photos carry alt text only. */
  mode: CaptionMode;
  photos: readonly PagePhoto[];
  captions: readonly PageCaption[];
  editing?: boolean;
  onChange?: (captions: PageCaption[]) => void;
  /** Photos of the page the request did not send (not read yet, or beyond 20): said, not hidden. */
  notSent?: number;
}) {
  const label = (assetId: string | null): string => {
    if (assetId === null) return 'The page';
    const photo = photos.find((p) => p.assetId === assetId);
    return photo ? `${photo.label} · ${photo.name}` : 'A photo';
  };
  const update = (i: number, patch: Partial<PageCaption>) =>
    onChange?.(captions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const placements = previewPlacements(book, pageId, captions);
  const placementOf = (assetId: string | null) => placements.find((p) => p.assetIds.includes(assetId));

  return (
    <ul className="space-y-1.5">
      {notSent > 0 && (
        <li className="text-[11px] text-fg-muted">
          {notSent === 1 ? '1 photo' : `${notSent} photos`} of this page not sent (not read yet, or over 20 a page): no
          caption or alt text for {notSent === 1 ? 'it' : 'them'}.
        </li>
      )}
      {captions.map((c, i) => {
        const hasOwnAlt = Boolean(c.assetId && book?.assets[c.assetId]?.alt?.trim());
        const placement = c.text.trim() ? placementOf(c.assetId) : undefined;
        return (
          <li key={c.assetId ?? 'page'} className="space-y-1 rounded-md border border-line bg-panel-2 p-2">
            <span className="section-title block">{label(c.assetId)}</span>
            {(editing ? c.assetId === null || mode === 'photo' : c.text !== '') &&
              (editing ? (
                <textarea
                  aria-label={`Caption: ${label(c.assetId)}`}
                  value={c.text}
                  rows={2}
                  onChange={(e) => update(i, { text: e.target.value })}
                  className={fieldClass}
                />
              ) : (
                <p className="select-text text-fg leading-relaxed">{c.text}</p>
              ))}
            {c.assetId !== null &&
              (editing ? (
                <input
                  aria-label={`Alt text: ${label(c.assetId)}`}
                  value={c.alt ?? ''}
                  onChange={(e) => update(i, { alt: e.target.value })}
                  placeholder="Alt text"
                  className={fieldClass}
                />
              ) : c.alt ? (
                <p className="select-text text-[11px] text-fg-muted">
                  {hasOwnAlt ? 'Alt text (the photo keeps its own): ' : 'Alt text: '}
                  {c.alt}
                </p>
              ) : null)}
            {placement && <p className="text-[11px] text-fg-muted">→ {placementLine(placement)}</p>}
          </li>
        );
      })}
    </ul>
  );
}
