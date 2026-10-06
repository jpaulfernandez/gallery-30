import type { BookTemplate, BookTemplateName } from './schema.js';

export interface BookTemplatePreset extends BookTemplate {
  label: string;
  /** Display ratio, width:height. */
  ratio: string;
  description: string;
  /** Listed in pickers but not selectable yet. */
  comingSoon?: boolean;
}

export const DEFAULT_TEMPLATE: BookTemplateName = 'phone-portrait';

/** Page sizes. Pixel sizes are the Instagram export size (or a 1080 px wide equivalent). */
export const BOOK_TEMPLATES: Record<BookTemplateName, BookTemplatePreset> = {
  'phone-portrait': {
    name: 'phone-portrait',
    label: 'Phone portrait',
    ratio: '4:5',
    width: 1080,
    height: 1350,
    description: 'Instagram feed post. Fills a phone screen.',
  },
  square: {
    name: 'square',
    label: 'Square',
    ratio: '1:1',
    width: 1080,
    height: 1080,
    description: 'Classic 8 x 8 in album feel.',
  },
  story: {
    name: 'story',
    label: 'Story',
    ratio: '9:16',
    width: 1080,
    height: 1920,
    description: 'Instagram story. Tall.',
  },
  'a4-portrait': {
    name: 'a4-portrait',
    label: 'A4 portrait',
    ratio: '1:1.414',
    width: 1080,
    height: 1527,
    description: 'Zine feel; letterboxed on phone.',
  },
  'a4-landscape': {
    name: 'a4-landscape',
    label: 'A4 landscape',
    ratio: '1.414:1',
    width: 1527,
    height: 1080,
    description: 'One page per screen with a rotate hint.',
  },
  custom: {
    name: 'custom',
    label: 'Custom',
    ratio: 'any',
    width: 1080,
    height: 1080,
    description: 'Enter width and height.',
    comingSoon: true,
  },
};

/** Strip preset metadata so the value can be stored in the project file. */
export function templateFor(name: BookTemplateName): BookTemplate {
  const { width, height } = BOOK_TEMPLATES[name];
  return { name, width, height };
}
