import {
  type BookTemplate,
  heroIndex,
  type LayoutData,
  type LayoutItem,
  layoutItemsFor,
  type Theme,
} from '@photobook/shared';
import { type CSSProperties, memo, type ReactNode, useMemo } from 'react';

/**
 * A layout drawn like docs/design/reference/layouts-4x5.html: a white page at the template's ratio,
 * numbered tinted photo tiles (the hero in slate blue), text items as gray bars. Sizes inside the
 * page are in `cqw` (the page is an inline-size container), so the drawing scales with the card.
 */

/** Photo tile tints, in order (reference TONES). */
const TONES = ['#A9BBC6', '#CBBBA3', '#AFC3AE', '#C3B1BC', '#B6BE9F', '#A3BAB9', '#C9AE9E', '#B0B4C9'];
export const HERO_TONE = '#5B7889';
const BAR = '#A3ADA8';
const BAR_STRONG = '#33423B';
const CELL = '#EEF2EF';

const pct = (n: number) => `${n * 100}%`;

function Bar({ width, strong, height, color }: { width?: string; strong?: boolean; height?: string; color?: string }) {
  return (
    <div
      style={{
        height: height ?? (strong ? '2.8cqw' : '1.15cqw'),
        width: width ?? (strong ? '85%' : '100%'),
        background: color ?? (strong ? BAR_STRONG : BAR),
        borderRadius: '0.6cqw',
        flex: 'none',
      }}
    />
  );
}

/** `n` bars, the last one short (62%) when there are several. */
function Bars({ n, color, short = '62%' }: { n: number; color?: string; short?: string }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional bars
        <Bar key={i} color={color} width={n > 1 && i === n - 1 ? short : undefined} />
      ))}
    </>
  );
}

const column: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '1.3cqw' };

/** One text item. `hUnits` is its height in reference units (the page is 100 wide). */
function TextItem({ item, hUnits, photos }: { item: LayoutItem; hUnits: number; photos: number }): ReactNode {
  switch (item.kind) {
    case 'cap':
      return (
        <div style={column}>
          <Bars n={2} />
        </div>
      );
    case 'cap1':
      return (
        <div style={column}>
          <Bars n={1} />
        </div>
      );
    case 'capR':
      return (
        <div style={{ ...column, alignItems: 'flex-end' }}>
          {Array.from({ length: hUnits >= 10 ? 2 : 1 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional bars
            <Bar key={i} width="80%" />
          ))}
        </div>
      );
    case 'overlay':
      return (
        <div
          style={{
            ...column,
            height: '100%',
            justifyContent: 'flex-end',
            padding: '0 8cqw 9cqw',
            background: 'linear-gradient(transparent, rgba(0,0,0,.38))',
          }}
        >
          <Bars n={2} color="rgba(255,255,255,.95)" short="55%" />
        </div>
      );
    case 'title':
      return (
        <div style={column}>
          <Bar strong />
        </div>
      );
    case 'titleLg':
      return (
        <div style={column}>
          <Bar strong height="5cqw" width="92%" />
          <Bar strong height="5cqw" width="60%" />
        </div>
      );
    case 'para':
      return (
        <div style={column}>
          <Bars n={Math.max(3, Math.floor(hUnits / 3.3))} />
        </div>
      );
    case 'quote':
      return (
        <div style={column}>
          <div
            style={{
              fontSize: '16cqw',
              lineHeight: 0.6,
              height: '7cqw',
              fontWeight: 700,
              color: 'var(--color-accent)',
            }}
          >
            “
          </div>
          <Bar strong width="96%" />
          <Bar strong width="88%" />
          <Bar strong width="70%" />
        </div>
      );
    case 'cell':
      return (
        <div style={{ ...column, height: '100%', gap: '1.6cqw', padding: '4cqw 3.5cqw', background: CELL }}>
          <Bar strong width="70%" />
          <Bars n={6} />
        </div>
      );
    case 'key':
      return (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${photos <= 4 ? 2 : 3}, minmax(0, 1fr))`,
            gap: '1.2cqw 3cqw',
            alignContent: 'start',
          }}
        >
          {Array.from({ length: photos }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: one entry per photo number
            <div key={i} style={{ display: 'flex', gap: '1.2cqw', alignItems: 'center' }}>
              <i
                style={{ fontStyle: 'normal', fontSize: '2.6cqw', fontWeight: 700, color: BAR_STRONG, width: '2.6cqw' }}
              >
                {i + 1}
              </i>
              <div style={{ flex: 1 }}>
                <Bar />
              </div>
            </div>
          ))}
        </div>
      );
    default:
      return null;
  }
}

export interface LayoutThumbProps {
  /** Items to draw (page fractions). An empty list draws a blank page. */
  items: readonly LayoutItem[];
  template: Pick<BookTemplate, 'width' | 'height'>;
  className?: string;
  children?: ReactNode;
}

/** The drawn page only (no name). */
export const LayoutThumb = memo(function LayoutThumb({ items, template, className, children }: LayoutThumbProps) {
  const hero = heroIndex([...items]);
  const photos = items.filter((it) => it.kind === 'photo').length;
  const heightUnits = (100 * template.height) / template.width;
  let n = 0;
  return (
    <div
      className={`relative overflow-hidden bg-white ${className ?? ''}`}
      style={{ aspectRatio: `${template.width} / ${template.height}`, containerType: 'inline-size' }}
    >
      {items.map((item, i) => {
        const box: CSSProperties = {
          position: 'absolute',
          left: pct(item.x),
          top: pct(item.y),
          width: pct(item.w),
          height: pct(item.h),
        };
        if (item.kind === 'photo') {
          n += 1;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: items are positional
              key={i}
              style={{
                ...box,
                backgroundColor: i === hero ? HERO_TONE : TONES[(n - 1) % TONES.length],
                backgroundImage:
                  'linear-gradient(155deg, rgba(255,255,255,.28), rgba(255,255,255,0) 45%, rgba(0,0,0,.10))',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  left: '2.6cqw',
                  top: '2cqw',
                  fontSize: 'max(7px, 5cqw)',
                  fontWeight: 600,
                  lineHeight: 1,
                  color: 'rgba(255,255,255,.95)',
                }}
              >
                {n}
              </span>
            </div>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: items are positional
          <div key={i} style={{ ...box, overflow: 'hidden' }}>
            <TextItem item={item} hUnits={item.h * heightUnits} photos={photos} />
          </div>
        );
      })}
      {children}
    </div>
  );
});

/** A layout's items for this book (theme spacing, template ratio), memoized. */
export function useLayoutItems(
  layout: LayoutData | null,
  template: Pick<BookTemplate, 'width' | 'height'>,
  theme: Theme,
): readonly LayoutItem[] {
  return useMemo(() => (layout ? layoutItemsFor(layout, template, theme) : []), [layout, template, theme]);
}
