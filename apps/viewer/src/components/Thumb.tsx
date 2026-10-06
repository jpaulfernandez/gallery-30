import { type ImageRecord, resolveImageRecord } from '@photobook/shared';

/**
 * A square, cover-fit thumbnail from the browse ladder (AVIF + WebP `<source>`s, share JPEG
 * fallback) with the placeholder behind it. `sizePx` is the square's CSS size.
 */
export function Thumb({ image, sizePx }: { image: ImageRecord; sizePx: number }) {
  // A landscape photo needs more than the square's width to cover it.
  const r = resolveImageRecord(image, Math.round(sizePx * Math.max(1, image.width / image.height)));
  return (
    <picture class="pv-thumb">
      {r.sources?.map((s) => (
        <source key={s.type} type={s.type} srcSet={s.srcSet} sizes={s.sizes} />
      ))}
      <img
        src={r.src}
        width={r.width}
        height={r.height}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        style={r.placeholder ? { backgroundImage: `url("${r.placeholder}")` } : undefined}
      />
    </picture>
  );
}
