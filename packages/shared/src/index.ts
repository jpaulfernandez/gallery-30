export {
  type CreateEmptyBookOptions,
  createEmptyBook,
  createEmptyPage,
  loadBook,
  parseBook,
  serializeBook,
} from './book.js';
export { BookLoadError } from './errors.js';
export { newId, randomToken, slugify } from './ids.js';
export * from './layouts/index.js';
export { migrate } from './migrate.js';
export * from './publish/index.js';
// Page, PhotoElement and TextElement are both the renderer components and the schema data types
// (the renderer modules re-declare the types), so the explicit exports here shadow `export *` above.
export {
  blobPath,
  blobPoints,
  clampCropToCover,
  coverLayout,
  coverSize,
  cropPanLimit,
  cropTransform,
  DEFAULT_PAGE_WIDTH_PX,
  DEFAULT_SHAPE,
  DEFAULT_TEXT_COLOR,
  type EditableProps,
  type ElementPointerDownHandler,
  type ElementPointerEvent,
  FONT_STACKS,
  fontStack,
  type ImageSource,
  MAX_CROP_SCALE,
  MIN_CROP_SCALE,
  OVERLAY_MARGIN,
  overlayPadding,
  Page,
  type PageProps,
  type PageSize,
  PhotoElement,
  type PhotoElementProps,
  polygonPoints,
  type ResolvedImage,
  type ResolveImage,
  rotatedAspect,
  type ShapeClip,
  shapeClip,
  shapeClipId,
  shapeClipPath,
  slotAspect,
  TEXT_PRESETS,
  TextElement,
  type TextElementProps,
  type TextPreset,
  type TextPresetName,
  type TextStyleOptions,
  textStyle,
} from './renderer/index.js';
export * from './schema.js';
export { BOOK_TEMPLATES, type BookTemplatePreset, DEFAULT_TEMPLATE, templateFor } from './templates.js';
export { resolveTheme, THEME_DEFAULTS } from './theme.js';
