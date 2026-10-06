import { type CSSProperties, useState } from 'react';
import type { PhotoElement as PhotoElementData } from '../schema.js';
import { clampCropToCover, coverLayout, slotAspect } from './cover.js';
import { type EditableProps, editableAttrs } from './interactive.js';
import { shapeClip, shapeClipId } from './shapes.js';
import { DEFAULT_PAGE_WIDTH_PX, type PageSize, type ResolveImage } from './types.js';
import { cx, frameStyle, num, pct } from './util.js';

/** Same as the schema type; declared here so `PhotoElement` is both the component and the data type. */
export type PhotoElement = PhotoElementData;

export interface PhotoElementProps extends EditableProps {
  element: PhotoElementData;
  resolve: ResolveImage;
  /** Page size; needed for the slot's pixel aspect (cover sizing, 90/270 rotation). Defaults to square. */
  template?: PageSize;
  /** Rendered page width in px, used for `targetWidthPx`. Defaults to 1080. */
  pageWidthPx?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * Fallback transform for an `object-fit: cover` img that fills the slot, used while the photo's
 * size is unknown: `translate(x%, y%) [rotate(r)] scale(s)`, pan as a fraction of the slot. With a
 * known size the renderer uses `coverLayout` instead, which allows panning at scale 1.
 */
export function cropTransform(crop: PhotoElementData['crop'], rotate = 0): string {
  const parts = [`translate(${pct(crop.x)}, ${pct(crop.y)})`];
  if (rotate) parts.push(`rotate(${rotate}deg)`);
  parts.push(`scale(${num(crop.scale)})`);
  return parts.join(' ');
}

const FILTER_CLASS: Record<PhotoElementData['filter'], string | undefined> = {
  none: undefined,
  bw: 'pb-filter-bw',
  fade: 'pb-filter-fade',
};

/** Width / height of a size, or null when either side is missing. */
const aspectOf = (w?: number, h?: number): number | null => (w && h && w > 0 && h > 0 ? w / h : null);

/**
 * A photo slot: an `overflow: hidden` box at the element's frame with the photo inside.
 *
 * With a known photo size (the resolver's `width` / `height`, else the img's natural size once it
 * loads) the img is laid out at its cover size times `crop.scale`, centred and panned by the crop
 * (fractions of the slot), see `coverLayout`. The crop is clamped so the photo always covers the
 * slot. Before the size is known it falls back to an `object-fit: cover` img with `cropTransform`
 * (a 90/270 rotation on a wrapper sized to the slot's swapped dimensions). Both agree for any crop
 * the old clamp allowed, so (0, 0, 1) is a centred cover fit either way.
 */
export function PhotoElement(props: PhotoElementProps) {
  const { element, resolve, template, pageWidthPx = DEFAULT_PAGE_WIDTH_PX, editable, selected, className } = props;
  const f = element.frame;
  const image = element.asset ? resolve(element.asset, Math.round(f.w * pageWidthPx)) : null;
  const empty = element.asset === null;
  // Natural size from onLoad, keyed by src so a new photo does not reuse the old size.
  const [natural, setNatural] = useState<{ src: string; aspect: number } | null>(null);

  const size = template ?? { width: 1, height: 1 };
  const slot = slotAspect(f, size);
  // The shape clips the whole box, so the cover layout and crop inside are unaffected.
  const clipId = shapeClipId(element.id);
  const clip = shapeClip(element.shape, slot, clipId);

  const boxStyle: CSSProperties = { ...frameStyle(f), overflow: 'hidden', ...props.style };
  if (clip) boxStyle.clipPath = clip.css;
  if (image?.placeholder) {
    boxStyle.backgroundImage = `url("${image.placeholder}")`;
    boxStyle.backgroundSize = 'cover';
    boxStyle.backgroundPosition = 'center';
  }

  let content = null;
  if (image) {
    const src = image.src;
    // Structural event type: React and preact/compat events both fit, and the publish CLI
    // type-checks this file without the DOM lib.
    const onLoad = (e: { currentTarget: unknown }) => {
      const img = e.currentTarget as { naturalWidth: number; naturalHeight: number };
      const aspect = aspectOf(img.naturalWidth, img.naturalHeight);
      if (aspect && (natural?.src !== src || natural.aspect !== aspect)) setNatural({ src, aspect });
    };
    const img = (style: CSSProperties) => {
      const el = (
        <img
          className={cx('pb-photo-img', FILTER_CLASS[element.filter])}
          src={src}
          srcSet={image.srcSet}
          sizes={image.sizes}
          width={image.width}
          height={image.height}
          alt=""
          decoding="async"
          loading={image.loading}
          draggable={false}
          onLoad={onLoad}
          style={style}
        />
      );
      // `<picture>` is `display: contents`, so the img is laid out exactly as without it.
      return image.sources?.length ? (
        <picture className="pb-picture">
          {image.sources.map((s) => (
            <source key={s.type} type={s.type} srcSet={s.srcSet} sizes={s.sizes} />
          ))}
          {el}
        </picture>
      ) : (
        el
      );
    };
    const imageAspect = aspectOf(image.width, image.height) ?? (natural?.src === src ? natural.aspect : null);
    if (imageAspect !== null) {
      const crop = clampCropToCover(element.crop, imageAspect, slot, element.rotate);
      content = img(coverLayout(crop, element.rotate, imageAspect, slot));
    } else if (element.rotate === 90 || element.rotate === 270) {
      // The wrapper is the slot turned on its side.
      content = (
        <div className="pb-photo-crop" style={{ transform: cropTransform(element.crop) }}>
          <div
            className="pb-photo-rot"
            style={{
              width: pct(1 / slot),
              height: pct(slot),
              transform: `translate(-50%, -50%) rotate(${element.rotate}deg)`,
            }}
          >
            {img({})}
          </div>
        </div>
      );
    } else {
      content = img({ transform: cropTransform(element.crop, element.rotate) });
    }
  } else if (empty && editable) {
    content = (
      <span className="pb-photo-plus" aria-hidden="true">
        +
      </span>
    );
  }

  return (
    <div
      className={cx(
        'pb-photo',
        empty && 'pb-photo-empty',
        !empty && !image && 'pb-photo-missing',
        editable && 'pb-editable',
        selected && 'pb-selected',
        clip && 'pb-shaped',
        className,
      )}
      style={boxStyle}
      {...editableAttrs(element.id, 'photo', props)}
    >
      {clip?.svg !== undefined && (
        <svg className="pb-shape-defs" width="0" height="0" aria-hidden="true" focusable="false">
          <clipPath id={clipId} clipPathUnits="objectBoundingBox">
            <path d={clip.svg} />
          </clipPath>
        </svg>
      )}
      {content}
      {clip && empty && editable && (
        <svg className="pb-shape-outline" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <path d={clip.outline} />
        </svg>
      )}
    </div>
  );
}
