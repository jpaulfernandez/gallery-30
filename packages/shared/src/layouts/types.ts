import type { Frame, LayoutData, LayoutGroup, LayoutItem } from '../schema.js';

export type LayoutPhotoCount = 1 | 2 | 3 | 4 | 5 | 6;

/** Which photo set a layout suits: mostly landscape shots, mostly portrait shots, or either. */
export type LayoutVariant = 'landscape' | 'portrait' | 'any';

export interface LayoutDef {
  id: string;
  /** Short label for the picker. */
  name: string;
  photos: LayoutPhotoCount;
  variant: LayoutVariant;
  /** Picker section: photos only, with text, or the book's own layouts. */
  group: LayoutGroup;
  /** Kept only so pages saved with these ids still resolve; pickers should hide them. */
  legacy?: boolean;
  /** What the layout is best for (picker subtitle). */
  best?: string;
  /** Some photo runs off the trim. */
  bleed?: boolean;
  /** The serializable source for library and custom layouts (absent on legacy layouts). */
  data?: LayoutData;
  /**
   * Photo slot frames as page fractions, in reading order.
   * @param margin theme margin, fraction of the page width
   * @param gutter theme gutter, fraction of the page width
   * @param aspect page width / page height
   */
  slots: (margin: number, gutter: number, aspect: number) => Frame[];
  /** Optional caption text frame (the first text item), same units as `slots`. */
  caption?: (margin: number, gutter: number, aspect: number) => Frame;
  /**
   * Every item (photos and text) in reading order, same units as `slots`, plus the theme wide
   * gutter (width fraction; twice the gutter when absent). See `layoutItems`.
   */
  items?: (margin: number, gutter: number, aspect: number, wideGutter?: number) => LayoutItem[];
}
