import { type Manifest, type ManifestPage, Page, type ResolveImage } from '@photobook/shared';
import { memo } from 'preact/compat';
import { useEffect, useRef } from 'preact/hooks';
import { usePinchZoom } from '../lib/pinch';

export interface SlideProps {
  page: ManifestPage;
  template: Manifest['template'];
  theme: Manifest['theme'];
  resolve: ResolveImage;
  /** Rendered page width in CSS px (the page fills it at the template ratio). */
  widthPx: number;
  /** The settled page. Leaving it resets the zoom. */
  active: boolean;
  onZoomChange: (zoomed: boolean) => void;
}

/**
 * One slide of the reader track: the shared `<Page>` centred in the viewport, with pinch-zoom on
 * the wrapper. Photo taps are handled by the track (event delegation), see `Reader`.
 */
export const Slide = memo(function Slide({
  page,
  template,
  theme,
  resolve,
  widthPx,
  active,
  onZoomChange,
}: SlideProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { reset } = usePinchZoom(viewport, content, onZoomChange);

  useEffect(() => {
    if (!active) reset();
  }, [active, reset]);

  return (
    <div ref={viewport} class="pv-slide">
      <div ref={content} class="pv-zoom" style={{ width: widthPx }}>
        <Page page={page} template={template} theme={theme} resolve={resolve} pageWidthPx={widthPx} />
      </div>
    </div>
  );
});
