import { PagePanel, type PagePanelProps } from './PagePanel';

/**
 * Desktop (> 900 px) right column: the drawer content as a permanent side panel, under the book's
 * title. Loaded on demand (dynamic import in `Reader`), so phones never fetch it.
 */
export default function PhotoPanel(props: PagePanelProps) {
  const { manifest, pageNumber } = props;
  return (
    <aside class="pv-aside" aria-label="This page">
      <header class="pv-aside-head">
        <h1 class="pv-aside-title">{manifest.title || 'Untitled'}</h1>
        <p class="pv-aside-meta">
          Page {pageNumber} of {manifest.pages.length}
        </p>
      </header>
      <PagePanel {...props} />
      <p class="pv-muted pv-aside-hint">Click a photo to see it full size, download, share or like it.</p>
    </aside>
  );
}
