import { DEVELOP_DEFAULTS, type DevelopMaskComponent, type DevelopSettings, HUE_BANDS } from '@photobook/shared';
import { isIdentityTransform } from '../../lib/develop/geometry';
import { DEPTH_RANGE_DEFAULT } from '../../lib/develop/masks';
import { deepEqual } from '../../lib/develop/merge';
import { isSectionDefault } from '../../lib/develop/sections';

/**
 * Plan 54 (ODDHALLS_LAYOUT_PLAN 4.1): the Develop panel's card manifest. The seven cards in their fixed order, what
 * each shows in Basic and what each ▸ ("more") opens in place. In Advanced every ▸ is open and drawn as a heading
 * instead of a button; in Basic each is a button with the `·edited` tag while one of its controls is off its
 * default, so nothing that changes the picture is hidden.
 *
 * The components read their ▸ labels and `edited` tests from here (`cardMore`), and `developCards.test.tsx` walks
 * the list: every control a card lists is in the panel where the list says, and Basic with every ▸ opened shows the
 * same controls as Advanced. A plan that adds a control registers it here (plan 55: the grading wheels in the Effects
 * card's Basic, the luminance offsets and the Global wheel in `effects.wheels`).
 *
 * A control is named the way a person (and the test) finds it: its ARIA role and its accessible name.
 */
export type DevelopCardId = 'crop' | 'light' | 'color' | 'detail' | 'sharpen' | 'effects' | 'masks';

export interface CardControl {
  role:
    | 'slider'
    | 'button'
    | 'radiogroup'
    | 'checkbox'
    | 'switch'
    | 'tablist'
    | 'toolbar'
    | 'group'
    | 'application'
    | 'textbox'
    | 'combobox';
  name: string | RegExp;
}

export interface CardMore {
  /** `<card>.<part>`, also the `data-more` attribute of the part in the panel. */
  id: string;
  /** The ▸ button's label in Basic and the heading in Advanced. */
  label: string;
  controls: readonly CardControl[];
  /** True while any control behind this ▸ is off its default: Basic tags the button `·edited`. */
  edited: (settings: DevelopSettings) => boolean;
}

export interface DevelopCard {
  id: DevelopCardId;
  /** The card's title (its region's accessible name). */
  title: string;
  /** Shown in Basic and in Advanced. */
  basic: readonly CardControl[];
  /** Behind a ▸ in Basic, inline in Advanced (in this order inside the card). */
  more: readonly CardMore[];
}

const slider = (name: string): CardControl => ({ role: 'slider', name });
const sliders = (...names: string[]): CardControl[] => names.map(slider);
const off = <T>(value: T, def: T) => !deepEqual(value, def);

const D = DEVELOP_DEFAULTS;

/**
 * An advanced setting of a mask component is off its default: a luminance range or smoothness, a colour mask's
 * Refine, an AI mask's prompts or depth range. (Colour samples are picked on the photo, in Basic too.)
 */
export function componentAdvancedEdited(c: DevelopMaskComponent): boolean {
  if (c.kind === 'luminance') return off(c.range, [0.5, 1]) || c.feather !== 25;
  if (c.kind === 'color') return c.tolerance !== 50;
  if (c.kind === 'ai')
    return c.prompts.length > 0 || (c.depthRange !== undefined && off(c.depthRange, DEPTH_RANGE_DEFAULT));
  return false;
}

export const DEVELOP_CARDS: readonly DevelopCard[] = [
  {
    id: 'crop',
    title: 'Crop',
    // The crop tool (R) holds the ratio presets, straighten, rotate and the flips (its panel replaces the cards).
    basic: [{ role: 'button', name: 'Crop & straighten' }],
    more: [
      {
        id: 'crop.transform',
        label: 'Upright & transform',
        controls: [
          { role: 'radiogroup', name: 'Upright mode' },
          { role: 'button', name: 'Update' },
          { role: 'button', name: 'Show structure' },
          { role: 'button', name: /^Draw guides/ },
          ...sliders('Vertical', 'Horizontal', 'Rotate', 'Aspect', 'Scale', 'X Offset', 'Y Offset'),
          { role: 'checkbox', name: 'Constrain Crop' },
        ],
        edited: ({ geometry: g }) =>
          g.upright.mode !== 'off' ||
          g.upright.guides.length > 0 ||
          !isIdentityTransform(g.transform) ||
          g.constrainCrop !== D.geometry.constrainCrop,
      },
    ],
  },
  {
    id: 'light',
    title: 'Light',
    basic: sliders('Exposure', 'Contrast', 'Highlights', 'Shadows', 'Whites', 'Blacks'),
    more: [
      {
        id: 'light.curve',
        label: 'Curve',
        controls: [
          { role: 'group', name: 'Curve presets' },
          ...sliders('Highlights', 'Lights', 'Darks', 'Shadows'),
          ...sliders('Shadows / Darks split', 'Darks / Lights split', 'Lights / Highlights split'),
          { role: 'tablist', name: 'Curve channel' },
          { role: 'application', name: /^Tone curve/ },
        ],
        edited: (s) => !isSectionDefault(s, 'curve'),
      },
    ],
  },
  {
    id: 'color',
    title: 'Color',
    basic: [
      { role: 'radiogroup', name: 'White balance mode' },
      ...sliders('Temperature', 'Tint', 'Vibrance', 'Saturation'),
    ],
    more: [
      {
        id: 'color.mix',
        label: 'Color mix',
        controls: [
          { role: 'toolbar', name: 'Color bands' },
          { role: 'tablist', name: 'Color mix property' },
          ...sliders('Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'),
        ],
        edited: (s) => HUE_BANDS.some((band) => off(s.color.mix[band], D.color.mix[band])),
      },
    ],
  },
  {
    id: 'detail',
    title: 'Detail',
    basic: sliders('Texture', 'Clarity', 'Dehaze'),
    more: [],
  },
  {
    id: 'sharpen',
    title: 'Sharpen & denoise',
    // The Denoise group keeps its own Advanced disclosure (plan 28) for Luminance, Colour, the colour source and the
    // model, in Basic and Advanced alike.
    basic: [slider('Amount'), { role: 'switch', name: 'Denoise' }],
    more: [
      {
        id: 'sharpen.more',
        label: 'Radius, detail, masking',
        controls: sliders('Radius', 'Detail', 'Masking'),
        edited: ({ detail: { sharpen } }) =>
          sharpen.radius !== D.detail.sharpen.radius ||
          sharpen.detail !== D.detail.sharpen.detail ||
          sharpen.masking !== D.detail.sharpen.masking,
      },
    ],
  },
  {
    id: 'effects',
    title: 'Effects',
    basic: [
      // Plan 55: the grading wheels (each a wheel and its two numbers), the harmony lock and the preset chips.
      { role: 'combobox', name: 'Harmony lock' },
      ...(['Shadows', 'Midtones', 'Highlights'] as const).flatMap((w): CardControl[] => [
        { role: 'application', name: `${w} wheel` },
        { role: 'textbox', name: `${w} hue` },
        { role: 'textbox', name: `${w} saturation` },
      ]),
      { role: 'group', name: 'Grading presets' },
      ...sliders('Vignette amount', 'Halation amount', 'Grain amount'),
    ],
    more: [
      {
        // Plan 55: the per-wheel luminance offsets and the Global wheel.
        id: 'effects.wheels',
        label: 'Luminance, global wheel',
        controls: [
          ...sliders('Shadows luminance', 'Midtones luminance', 'Highlights luminance'),
          { role: 'application', name: 'Global wheel' },
          { role: 'textbox', name: 'Global hue' },
          { role: 'textbox', name: 'Global saturation' },
          slider('Global luminance'),
        ],
        edited: ({ effects: { grading } }) =>
          off(grading.global, D.effects.grading.global) ||
          [grading.shadows, grading.midtones, grading.highlights].some((w) => w.luminance !== 0),
      },
      {
        id: 'effects.grading',
        label: 'Blending, balance',
        controls: sliders('Blending', 'Balance'),
        edited: ({ effects: { grading } }) =>
          grading.blending !== D.effects.grading.blending || grading.balance !== D.effects.grading.balance,
      },
      {
        id: 'effects.vignette',
        label: 'Midpoint, feather, roundness',
        controls: sliders('Midpoint', 'Feather', 'Roundness'),
        edited: ({ effects: { vignette } }) =>
          vignette.midpoint !== D.effects.vignette.midpoint ||
          vignette.feather !== D.effects.vignette.feather ||
          vignette.roundness !== D.effects.vignette.roundness,
      },
      {
        id: 'effects.halation',
        label: 'Threshold, radius',
        controls: sliders('Threshold', 'Radius'),
        edited: ({ effects: { halation } }) =>
          halation.threshold !== D.effects.halation.threshold || halation.radius !== D.effects.halation.radius,
      },
      {
        id: 'effects.grain',
        label: 'Size, roughness',
        controls: sliders('Size', 'Roughness'),
        edited: ({ effects: { grain } }) =>
          grain.size !== D.effects.grain.size || grain.roughness !== D.effects.grain.roughness,
      },
    ],
  },
  {
    id: 'masks',
    title: 'Masks',
    basic: [{ role: 'button', name: 'Create new mask' }],
    more: [
      {
        // Shown for the selected component; the controls listed are a luminance component's.
        id: 'masks.component',
        label: 'Range & refine',
        controls: sliders('Luminance range low', 'Luminance range high', 'Smoothness'),
        edited: (s) => s.masks.some((m) => m.components.some(componentAdvancedEdited)),
      },
    ],
  },
];

/** The ▸ of `id` (throws on an unknown id, so a typo fails the first render in a test). */
export function cardMore(id: string): CardMore {
  for (const card of DEVELOP_CARDS) {
    const more = card.more.find((m) => m.id === id);
    if (more) return more;
  }
  throw new Error(`No develop card part "${id}"`);
}

/** A card of the manifest by id. */
export function developCard(id: DevelopCardId): DevelopCard {
  const card = DEVELOP_CARDS.find((c) => c.id === id);
  if (!card) throw new Error(`No develop card "${id}"`);
  return card;
}
