import type { Book } from '@photobook/shared';
import { type AssetFile, fileOfAsset } from '../../store/assets';

/** Desktop preview's right column (320 px): the current page's photos as square thumbnails. */
export function PhotoPanel({
  book,
  pageIndex,
  files,
}: {
  book: Book;
  pageIndex: number;
  files: Record<string, AssetFile>;
}) {
  const page = book.pages[pageIndex];
  const assetIds: string[] = [];
  for (const el of page?.elements ?? []) {
    if (el.type === 'photo' && el.asset && !assetIds.includes(el.asset)) assetIds.push(el.asset);
  }

  return (
    <aside
      className="flex h-full w-[320px] shrink-0 flex-col gap-3 scrollbar overflow-x-hidden overflow-y-auto border-l border-line bg-stage p-4"
      aria-label="Photos on this page"
    >
      <h2 className="section-title">Photos on this page</h2>
      {assetIds.length === 0 ? (
        <p className="text-fg-muted">No photos on this page</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0">
          {assetIds.map((id) => {
            const file = book.assets[id] ? fileOfAsset(files, id) : undefined;
            const src = file?.thumbUrl ?? file?.proxyUrl;
            return (
              <li key={id} className="aspect-square overflow-hidden rounded bg-panel-2">
                {src && <img src={src} alt="" draggable={false} className="h-full w-full object-cover" />}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
