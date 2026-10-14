import {
  type Asset,
  type AssetDraft,
  type AssetFlag,
  allPages,
  type Book,
  type BookTemplate,
  type BookTemplateName,
  type BrushStroke,
  type Crop,
  CURRENT_VERSION,
  createDevelop,
  createEmptyBook,
  DEFAULT_DENOISE,
  type Denoise,
  type DevelopCrop,
  type DevelopGeometry,
  type DevelopMask,
  type DevelopMaskComponent,
  DevelopSchema,
  type DevelopSettings,
  type Frame,
  hasOutput,
  isDefaultDevelop,
  LAYOUT_BLANK,
  LAYOUT_CUSTOM,
  type LayoutData,
  type Library,
  type LocalAdjustments,
  locatePage,
  type ManualTransform,
  newId,
  type OutputProfile,
  type Page,
  type PageBackground,
  type PhotoElement,
  pagesOf,
  parseBook,
  reflowLayout,
  resolveTheme,
  type SlotRatio,
  serializeBook,
  serializeLibrary,
  applyLayout as sharedApplyLayout,
  setSlotRatio as sharedSetSlotRatio,
  type Theme,
  templateFor,
  type UprightGuide,
  type UprightMode,
} from '@photobook/shared';
import { current, type Draft, isDraft } from 'immer';
import { temporal } from 'zundo';
import { create, useStore } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { clampCrop, cropFit } from '../lib/crop';
import { clipOf, type DevelopClip } from '../lib/develop/clipboard';
import {
  applyAngle,
  applyAspect,
  applyConstrain,
  applyFlip,
  applyRotate90,
  aspectRatioOf,
  type CropAspect,
  constrainFit,
  fitCropTo,
  frameOf,
  normalizeCrop,
  refitWarpedCrop,
  resetCropTool,
  type SourceSize,
  swapOrientation,
  warpedPolygon,
} from '../lib/develop/cropEdit';
import {
  IDENTITY_TRANSFORM,
  identity,
  orientedSize,
  perspectiveMatrix,
  preCropMatrix,
  remapPoints,
} from '../lib/develop/geometry';
import { replaceLook } from '../lib/develop/looks';
import {
  type ComponentMode,
  cloneMask,
  DEFAULT_LOCAL_ADJUSTMENTS,
  type MaskComponentPatch,
  maskDisplayName,
} from '../lib/develop/masks';
import { type DeepPartial, deepEqual, deepMerge } from '../lib/develop/merge';
import { applyPreset as applyPresetTo, makePreset, type Preset } from '../lib/develop/presets';
import { remapGeometryVectors } from '../lib/develop/remap';
import type { DevelopSectionKey } from '../lib/develop/sections';
import {
  applySections,
  copySectionsOf,
  DEFAULT_COPY_SECTIONS,
  type DevelopCopySection,
  type DevelopSyncSection,
} from '../lib/develop/sync';
import { importedDevelop, type OrientationChange } from '../lib/develop/xmpImport';
import {
  type FrameGridOptions,
  photoDropFrame,
  type SplitAxis,
  withFrame,
  withFrameGrid,
  withMergedFrames,
  withSplitFrame,
} from '../lib/frames';
import { newCaption } from '../lib/grid';
import { devLog } from '../lib/log';
import {
  createProject as createProjectFile,
  type GuidedUprightSolution,
  importFolder,
  importLegacyBook,
  listFolders,
  listProjects,
  readProject,
  savePreset,
  saveProjectAs,
  setRecent,
  solveUprightGuides,
  writeLibrary,
  writeProject,
  type XmpImport,
} from '../lib/tauri';
import { type CaptionsSlice, createCaptionsSlice } from './captions';
import {
  assetDevelop,
  assetFolderPath,
  bookForDisk,
  createLibrarySlice,
  type DevelopVersionChoice,
  hasPhoto,
  isLibraryWritable,
  isPhotoKey,
  type LibrarySlice,
  type LibraryView,
  libraryEntryOf,
  mergeLibrariesForHistory,
  nextVersionName,
  openFolderId,
  type PhotoFields,
  type PhotoMeta,
  type PhotoRef,
  patchPhotoDraft,
  photoEntryPlace,
  photoMeta,
  readFolderLibrary,
  reconcileAsset,
  setLibraryWriteFailed,
  syncBookWithLibraries,
  withFolder,
  writePhotoFields,
} from './library';
import { activeOutputId, blankPage, copyPage, createOutputsSlice, type OutputsSlice, postFull } from './outputs';
// Workflow plan 16: slideshow settings.
import { createSlideshowSlice, type SlideshowSlice } from './slideshow';

/**
 * The document store: `book` is the open project file (`<appData>/projects/<id>/project.photobook.json` or wherever
 * Save as put it, workflow plan 04; with a working mirror of the library's fields on its assets, which the saved file
 * leaves out, see `bookForDisk`), `libraries` the libraries of its folders (./library.ts: ratings, flags and develop
 * settings by content hash). Every action is an Immer recipe,
 * and zundo's `temporal` tracks `book` and `libraries` together for undo and redo (UI state lives in ./ui.ts and is
 * never undone).
 *
 * History rules:
 * - One action = one undo step, except inside `beginGesture()` / `endGesture()`, which records the
 *   whole gesture (a pan drag, a zoom slider drag, a pinch) as a single step.
 * - Idle gestures (`createIdleGesture`: pinch, color picker) end on their own after a pause; undo,
 *   redo and every discrete action (rotate, filter, layout, page and slot edits) end them first,
 *   so the gesture is its own step and is what the next undo reverts.
 * - Loading or closing a book clears the history.
 * - `fillAssets`, `replaceAssetId` and `removeAssets` (scan bookkeeping) and `reviewAssets` (ratings and flags) are never
 *   undo steps, and undo/redo keep the newest asset metadata (see `applyHistory`) so undoing an edit never forgets a hash,
 *   a size or a rating.
 * - Develop edits (`Asset.develop`) are real undo steps and the one piece of asset data undo does restore. A slider
 *   drag is bracketed by `beginDevelopDrag()` / `endDevelopDrag()` (the gesture pair) and records one step.
 * - Ratings, flags and develop settings are written through to the library entry of the asset's hash and read back
 *   through it (`writePhotoFields`, `assetDevelop`); undo restores the library's develop with the book's
 *   (`mergeLibrariesForHistory`).
 */

type PageElement = Page['elements'][number];
type Filter = PhotoElement['filter'];
type Shape = NonNullable<PhotoElement['shape']>;

interface LoadOptions {
  /** Create a new project on the folder when it has none. Default true. */
  create?: boolean;
  /** Page size of a project created here (ignored when the folder already has one). Default phone portrait. */
  template?: BookTemplateName;
}

/** What `createProject` needs: a title, a page size and the imported folder (registry id) the photos come from. */
export interface NewProject {
  title: string;
  template?: BookTemplateName;
  folderId: string;
}

export interface BookState extends LibrarySlice, OutputsSlice, CaptionsSlice, SlideshowSlice {
  /** The open project document, exactly as stored in its project file. */
  book: Book | null;
  /** Id of the open project (`<appData>/projects/<id>/` or its `projects.json` entry). */
  projectId: string | null;
  /**
   * Absolute path of the open project's primary folder: the first of `book.folders` that is imported and on disk. The
   * filmstrip scans it and new photos in it join the project; assets in other folders (a relink found them there) keep
   * their own folder (`assetFolderPath`).
   */
  folder: string | null;
  /** Replace the whole document (one undo step). */
  setBook: (book: Book) => void;
  /**
   * Open project `id`: migrate an older file, load the library of every imported folder it draws from (an entry wins
   * over the book's rating, flag and develop; book fields of a hash with no entry are lifted into the library, which is
   * then saved), write the file back when that changed it, and record it as recent. Rejects when none of its folders
   * is imported and on disk.
   */
  loadProject: (id: string) => Promise<Book>;
  /** Create a project in app data on one imported folder, open it, and resolve its id. */
  createProject: (project: NewProject) => Promise<string>;
  /** Save the open project as `path` (from the save dialog); it lives there from now on. */
  saveAs: (path: string) => Promise<void>;
  /**
   * The pre-plan-04 way in, kept for folders: import `folder` (it must be in the registry or dialog-picked), turn its
   * legacy `book.photobook.json` into a project if it has one, and open that; else open the most recently opened
   * project on the folder; else create one (unless `create: false`, which resolves to null).
   */
  loadFromFolder: (folder: string, options?: LoadOptions) => Promise<Book | null>;
  /** Wait for autosave to write the open book, then close it. */
  close: () => Promise<void>;

  setTitle: (title: string) => void;
  /** The colour space developed photos are rendered in (`Book.outputProfile`). One undo step. */
  setOutputProfile: (profile: OutputProfile) => void;
  /** Merge publish settings (slug, visibility, the publish record). One undo step. */
  setPublish: (patch: Partial<Book['publish']>) => void;
  /**
   * Change the page size to a preset (`templateFor`). Frames are page fractions, so elements stretch
   * to the new ratio; photo crops are re-clamped so every photo still covers its slot. One undo step;
   * not available for `custom` or when the template is already the one set.
   */
  setTemplate: (name: BookTemplateName) => void;
  /** Merge book-wide theme tokens (margin, gutter, grid, ...). One undo step. */
  setTheme: (patch: Partial<Theme>) => void;
  /**
   * Background color new pages get (`theme.defaultPageBackground`). Not `discrete`, so the color
   * picker's idle gesture makes a drag one undo step.
   */
  setDefaultPageBackground: (color: string) => void;
  /**
   * Re-fit every page to its layout with the current theme (margin, gutter changed): geometry only
   * (shared `reflowLayout`), so photo slots and text items move to the recomputed frames by index
   * and elements without a slot (extra text, extra photos) are left alone; nothing is added or
   * deleted. Blank pages, hand-edited pages (`LAYOUT_CUSTOM`), the book's custom layouts (captured
   * in page fractions, the theme does not change them) and unknown ids are skipped. One undo step;
   * returns how many pages were re-flowed.
   */
  reapplyLayouts: () => number;
  /** Mutate one page in place (Immer draft). */
  updatePage: (pageId: string, fn: (page: Draft<Page>) => void) => void;
  /**
   * Mutate one element in place (Immer draft). Content only (text, style): frame changes go through
   * `setFrames`, which marks the page custom.
   */
  updateElement: (pageId: string, elementId: string, fn: (el: Draft<PageElement>) => void) => void;
  /**
   * Put an asset in a photo slot (or empty it with null). Resets crop and rotation, which belonged
   * to the previous photo. `asset` adds the `book.assets` entry when the id is not there yet (a
   * filmstrip file dropped before its hash landed), so the book never holds a dangling id.
   */
  setElementAsset: (pageId: string, elementId: string, assetId: string | null, asset?: AssetDraft) => void;
  /** Swap the photos of two slots on a page: asset, rotation and filter travel, crops reset. */
  swapAssets: (pageId: string, elementA: string, elementB: string) => void;
  /** Set a slot's crop, clamped so the photo always covers the slot (see lib/crop.ts). */
  setCrop: (pageId: string, elementId: string, crop: Crop) => void;
  /** Rotate a photo 90 degrees clockwise. */
  rotateElement: (pageId: string, elementId: string) => void;
  setFilter: (pageId: string, elementId: string, filter: Filter) => void;
  /**
   * Set a slot's clip shape (`rect` removes it). The crop is kept: clipping does not change the cover
   * math. A circle also makes the frame square in page pixels around its centre (shrunk to its short
   * side, kept on the page), sets the 1:1 ratio and re-clamps the pan for the new slot; when that
   * moves the frame the page becomes custom (`LAYOUT_CUSTOM`).
   */
  setShape: (pageId: string, elementId: string, shape: Shape) => void;
  /** Shared `setSlotRatio` against the page's layout frame (library or the book's custom layouts) and the book theme. */
  setSlotRatio: (pageId: string, elementId: string, ratio: SlotRatio) => void;
  /** Shared `applyLayout` (library, custom or blank): photos keep their ids and order. */
  applyLayout: (pageId: string, layoutId: string) => void;
  /**
   * Set a color or photo background. For a photo, `asset` adds the `book.assets` entry when the id
   * is not there yet (as in `setElementAsset`); an unknown id without it is refused.
   */
  setPageBackground: (pageId: string, background: PageBackground, asset?: AssetDraft) => void;
  /**
   * Insert a blank page (no elements, `theme.defaultPageBackground`) at `index` (default: the end).
   * Returns its id.
   */
  addPage: (index?: number, outputId?: string) => string | null;
  /** Copy a page right after itself with a new page id and new element ids. Returns the new id. */
  duplicatePage: (pageId: string) => string | null;
  /** Remove a page (one undo step). The last page can be deleted too. */
  deletePage: (pageId: string) => void;
  /** Move the page at `from` to index `to`. Page and element ids never change. */
  movePage: (from: number, to: number, outputId?: string) => void;
  /** Add an empty caption at the page's bottom margin (see lib/grid.ts) and mark the page custom. Returns its id. */
  addText: (pageId: string) => string | null;
  /**
   * Remove an element from a page (text boxes, empty frames; filled slots are emptied with
   * `setElementAsset`). The page becomes custom.
   */
  removeElement: (pageId: string, elementId: string) => void;
  /**
   * Delete key on a selection (one undo step): text boxes and empty frames are removed, filled
   * photo frames are emptied (a second Delete then removes the frame). Removing anything marks the
   * page custom.
   */
  deleteElements: (pageId: string, elementIds: readonly string[]) => void;
  /**
   * Set element frames (a resize or move drag step, a nudge, an inspector field). Photo crops are
   * re-clamped against the new slot, and a page whose frames changed becomes custom
   * (`LAYOUT_CUSTOM`), so re-flowing layouts never undoes hand edits. Not `discrete`, so it can run
   * inside a gesture.
   */
  setFrames: (pageId: string, frames: Readonly<Record<string, Frame>>) => void;
  /**
   * Drop a photo on a page area that is not a slot: fill the page's first empty frame, or else add
   * a new frame holding it (the largest frame of the photo's aspect inside the safe margins,
   * centred) and mark the page custom. `asset` adds the `book.assets` entry as in
   * `setElementAsset`. Returns the frame's id.
   */
  dropPhotoOnPage: (pageId: string, assetId: string, asset?: AssetDraft) => string | null;
  /** Add an empty photo frame (after the last photo) and mark the page custom. Returns its id. */
  addFrame: (pageId: string, frame: Frame) => string | null;
  /** Fill the page with a grid of empty frames, keeping filled photos (see lib/frames.ts `withFrameGrid`). */
  addFrameGrid: (pageId: string, options: FrameGridOptions) => string[];
  /** Merge two or more photo frames into one at their bounding box. Returns the kept frame's id. */
  mergeFrames: (pageId: string, elementIds: readonly string[]) => string | null;
  /** Split a photo frame in two with a gutter. Returns both ids (the original first). */
  splitFrame: (pageId: string, elementId: string, axis: SplitAxis) => [string, string] | null;
  /**
   * Add a layout to `book.customLayouts` (one undo step); with `pageId`, that page now uses it. The
   * layout always gets a fresh `custom-<ulid>` id (any incoming id is ignored), so it can never clash
   * with a library layout or another custom one. Returns the new id.
   */
  addCustomLayout: (layout: LayoutData, pageId?: string) => string | null;
  renameCustomLayout: (layoutId: string, name: string) => void;
  /** Remove a custom layout; pages that used it become custom pages (their frames stay). */
  removeCustomLayout: (layoutId: string) => void;
  /**
   * Merge scan metadata into `book.assets`. An entry without a `folder` keeps the one it replaces, else joins the open
   * folder. Not an undo step.
   */
  fillAssets: (assets: Record<string, AssetDraft>) => void;
  /**
   * Point every element and page background that uses `fromId` at `toId` and delete the `fromId`
   * entry (Locate onto a file another, unused asset id held). Not an undo step.
   */
  replaceAssetId: (fromId: string, toId: string) => void;
  /** Delete `book.assets` entries (unused files gone from the folder). Not an undo step. */
  removeAssets: (ids: string[]) => void;
  /**
   * Add library photos to the project (workflow plan 05): each becomes an asset `{ id: newId(), folder, path, hash, … }`
   * in the project's entry for its folder (added to `book.folders` under the registry id when the project has none for
   * that path), and its library entry's fields mirror onto it. A photo the project already has (same folder and path)
   * keeps its asset id. Not an undo step (assets are bookkeeping; pages that use them are the edit). Returns the asset
   * ids in order, empty with no project open.
   */
  addPhotos: (photos: readonly NewPhoto[]) => string[];
  /**
   * Relink by hash across imported folders (workflow plan 04): point each asset at the file it was found as, in
   * `folderPath` (added to `book.folders` under `folderId`, the registry id, when the book has no entry for that path),
   * keeping the asset id. The library entry of its hash comes along when the new folder's library (loaded first) has
   * none, and the mirror then follows that library. A folder left with no assets is dropped unless it is the primary
   * one. Not an undo step.
   */
  relinkAssets: (moves: AssetMove[]) => void;
  /**
   * Set or clear (null) the review rating and flag of photos, by photo id (an asset id or a library key, see
   * `ReviewTarget`). A project photo the scan has not recorded yet gets an entry with just its path; the scan fills in
   * the rest under the same id. Not an undo step.
   */
  reviewAssets: (targets: ReviewTarget[], patch: ReviewPatch) => void;
  /**
   * Edit an asset's develop settings. `patch` is merged over the current settings (objects key by key;
   * arrays such as curve points are replaced whole), or a function maps the previous settings (defaults
   * when the asset has none) to the next ones. The result is validated by `DevelopSchema`; an invalid one
   * is ignored. When the result equals the defaults the `develop` key is removed, so untouched photos
   * stay byte-identical in the project file. Not `discrete`: call it inside `beginDevelopDrag()` /
   * `endDevelopDrag()` for a drag (one undo step), otherwise each call is one step. No-op for unknown assets.
   *
   * Every develop action takes a photo id: a project asset id, or a library key (`photoKey`) that edits the master in
   * its folder's library with no project open (workflow plan 05; `hasPhoto` says whether an id can be edited).
   */
  setAssetDevelop: (
    assetId: string,
    patch: DeepPartial<DevelopSettings> | ((prev: DevelopSettings) => DevelopSettings),
  ) => void;
  /** Remove an asset's develop settings (back to the original). One undo step. */
  resetAssetDevelop: (assetId: string) => void;
  /** Put one section (or several, as one undo step) of an asset's develop settings back to the defaults. */
  resetDevelopSection: (assetId: string, section: DevelopSectionKey | readonly DevelopSectionKey[]) => void;
  /**
   * Denoise (step D5.2), through `setAssetDevelop`: null turns it off (`detail.denoise = null`); a patch turns it on
   * (starting from `DEFAULT_DENOISE` when it was off) and merges over the current values. Each call is one undo step;
   * inside `beginDevelopDrag()` / `endDevelopDrag()` a slider drag is one step.
   */
  setDenoise: (assetId: string, patch: Partial<Denoise> | null) => void;
  /**
   * Geometry (crop tool) actions, each built on `setAssetDevelop` (so inside `beginDevelopDrag()` / `endDevelopDrag()`
   * a drag is one undo step). `size` is the upright source size the crop maths needs; it defaults to the asset's
   * scanned `width` / `height`. See `lib/develop/cropEdit.ts` for the maths.
   *
   * `setDevelopCrop` stores a crop as given (null removes it; a full, level, free crop is stored as none). Named
   * apart from `setCrop`, which pans a photo inside its frame on a page.
   */
  setDevelopCrop: (assetId: string, crop: DevelopCrop | null) => void;
  /**
   * Straighten angle (−45..45). With constrain on, a crop that filled the frame keeps filling it, any other one
   * shrinks to fit; during a drag the change is measured from the crop at the start of the drag, so turning back
   * regrows it.
   */
  setCropAngle: (assetId: string, angle: number, size?: SourceSize) => void;
  /** Lock the crop to an aspect (or `free`), re-fitted about its centre. One undo step. */
  setCropAspect: (assetId: string, aspect: CropAspect, size?: SourceSize) => void;
  /** Swap the crop between landscape and portrait (the `X` key). One undo step. */
  swapCropOrientation: (assetId: string, size?: SourceSize) => void;
  /** Turn the picture 90° on screen (1 clockwise); the crop keeps the same pixels. One undo step. */
  rotate90: (assetId: string, dir: 1 | -1) => void;
  /** Mirror the picture on screen; the crop keeps the same pixels. One undo step. */
  flip: (assetId: string, axis: 'h' | 'v') => void;
  /** Constrain the crop to the image (turning it on shrinks the crop into the rotated image). One undo step. */
  setConstrainCrop: (assetId: string, on: boolean, size?: SourceSize) => void;
  /** Put the whole geometry (orientation, crop, angle, Upright, Transform) back to the defaults. One undo step. */
  resetGeometry: (assetId: string) => void;
  /**
   * The crop tool's Reset: orientation, crop, angle and constrain back to the defaults, Upright and the manual
   * Transform kept (see `resetCropTool`); masks and guides follow. One undo step.
   */
  resetCrop: (assetId: string, size?: SourceSize) => void;
  /** Replace the geometry as a whole (the crop tool's Cancel restores its snapshot). One undo step. */
  setGeometry: (assetId: string, geometry: DevelopGeometry) => void;
  /**
   * Transform section (step D2.2). Every action that changes the perspective (`perspectiveMatrix`, or the whole
   * pre-crop map) re-maps the vector masks and the guides through `H_new · H_old⁻¹` so they stay on the content
   * they were drawn on, and with `constrainCrop` refits the crop to the largest one inside the warped image
   * (`maxCropInWarped`, keeping the crop's aspect). Each call is one undo step; inside `beginDevelopDrag()` /
   * `endDevelopDrag()` a slider drag is one step.
   *
   * `setTransform` merges a patch of the seven manual sliders (Vertical, Horizontal, Rotate, Aspect, Scale,
   * Offset X / Y). Not `discrete` (slider drags group it).
   */
  setTransform: (assetId: string, patch: Partial<ManualTransform>, size?: SourceSize) => void;
  /** The seven sliders back to their defaults; `{ upright: true }` also turns Upright off and clears its guides. */
  resetTransform: (assetId: string, options?: { upright?: boolean }, size?: SourceSize) => void;
  /**
   * Choose the Upright mode. A different mode resets the manual sliders, as Lightroom does (Alt-click there:
   * `{ keepTransform: true }`). `off` keeps the stored transform and guides but ignores them; `guided` keeps them.
   */
  setUprightMode: (
    assetId: string,
    mode: UprightMode,
    options?: { keepTransform?: boolean },
    size?: SourceSize,
  ) => void;
  /**
   * Replace the guides (fractions of the transformed, uncropped frame, like masks; at most 4). Does not solve:
   * `updateUpright` does. Not `discrete` (a guide drag groups it with the solve that follows).
   */
  setUprightGuides: (assetId: string, guides: UprightGuide[]) => void;
  /** Store a solver result as the Upright transform and focal (`mode` defaults to the current one). */
  setUprightResult: (
    assetId: string,
    result: { transform: number[] | null; focal: number | null; mode?: UprightMode },
    size?: SourceSize,
  ) => void;
  /**
   * Solve guided Upright for the current guides (mapped back to the oriented frame) with the
   * `solve_upright_guides` command and store the result (mode becomes `guided`). No guides clears the transform.
   * An invalid combination or an unstable solve writes nothing and resolves `{ ok: false, message }`; so does a
   * solve that comes back after `isCurrent()` turned false (message empty).
   */
  updateUpright: (assetId: string, size?: SourceSize, isCurrent?: () => boolean) => Promise<UprightOutcome>;
  /**
   * Store an automatic Upright result (`analyseGeometry`): the mode with its transform and focal, as one undo step
   * (`setUprightMode` + `setUprightResult`). A different mode resets the manual sliders unless `keepTransform`
   * (Alt-click); the same mode (Update) keeps them. The detected lines are not stored: the stored transform makes
   * every render deterministic.
   */
  applyUpright: (
    assetId: string,
    mode: UprightMode,
    result: { transform: number[]; focal: number | null },
    options?: { keepTransform?: boolean },
    size?: SourceSize,
  ) => void;
  /**
   * The clipboard payload of a photo's settings (the version it shows; defaults when unedited) for `sections`
   * (`lib/develop/clipboard.ts`, workflow plan 10), or null for an unknown photo. Reads only: the clipboard itself
   * (in memory and on the system clipboard) is `components/develop/copyPaste.tsx`'s.
   */
  copyDevelop: (assetId: string, sections?: readonly DevelopCopySection[]) => DevelopClip | null;
  /**
   * Paste a clipboard payload onto photos (each the version it shows): the sections it lists replace theirs. Tone
   * sections are replaced as they are; `transform` moves the target's masks and refits its crop as Sync does; `crop`
   * sets the crop, fitted to the target as the crop tool would (`fitCropTo`: aspect lock, constrain); `masks` replaces
   * the masks with copies that have fresh ids unless they already match ids aside (AI masks re-run on the target:
   * their cache is keyed by component and source hash). Rotation and flips stay. `clip.source` (the photo copied
   * from) is skipped. One undo step for all; written through to each photo's library. Returns how many changed.
   */
  pasteDevelop: (assetIds: readonly string[], clip: DevelopClip) => number;
  /**
   * Lightroom-style presets and sync (step D6.3). All of them replace whole parts of the settings and are one undo
   * step for every photo they touch; each returns how many photos changed.
   *
   * `applyDevelopPreset` merges the preset's values over the sections it lists (`lib/develop/presets.ts`); geometry
   * and masks stay. `syncDevelop` copies the chosen sections of `fromAssetId` onto `toAssetIds` (the source itself is
   * skipped): `basic` is light plus white balance; `transform` copies the Upright result and the Transform sliders (the
   * target's masks and crop follow the new warp; the crop itself is never copied); `masks` replaces the masks with
   * copies that have fresh ids. Rotation, flips and crop are never synced.
   */
  applyDevelopPreset: (assetIds: readonly string[], preset: Pick<Preset, 'sections' | 'settings'>) => number;
  /**
   * Looks (workflow plan 20): switch each photo to `look` at `amount` percent (null: no look) through `replaceLook`
   * (`lib/develop/looks.ts`): a different look applied before has its sections put back first when `lookup` knows it.
   * One undo step for every photo; returns how many changed.
   */
  applyDevelopLook: (
    assetIds: readonly string[],
    look: Preset | null,
    amount: number,
    lookup?: (presetId: string) => Preset | undefined,
  ) => number;
  syncDevelop: (fromAssetId: string, toAssetIds: readonly string[], sections: readonly DevelopSyncSection[]) => number;
  /**
   * Remove the develop settings of several photos (each the version it shows, see `editedVersion`) as one undo step:
   * the batch bar's Reset edits (workflow plan 08). Returns how many changed.
   */
  resetDevelopMany: (assetIds: readonly string[]) => number;
  /**
   * Versions (virtual copies, workflow plan 08): `photos[hash].versions` in the photo's folder library; a project
   * asset's `version` picks one, absent means the master. None of these is an undo step (like ratings); editing a
   * version's settings is, through the develop actions, which write the version the photo shows.
   *
   * `developVersion` is Develop's choice for the photo it shows (see `DevelopVersionChoice`); `showVersion` sets it
   * (null: the master) and drops it when it is the photo's own. `createVersion` copies the settings the photo shows into
   * a new version named `name` (default `v2`, `v3`, …) and returns its id (null when the photo has no library entry to
   * hold it: not hashed yet, or its library is not loaded). `deleteVersion` refuses a version some project uses (the
   * open one, read in memory after the files, or any other project file; one that cannot be read counts as using it) and
   * resolves to their titles (an unreadable one marked "(could not be read)"), else deletes it and resolves to `[]`. `setAssetVersion` makes the open project's asset use a version (null: the master).
   */
  developVersion: DevelopVersionChoice | null;
  showVersion: (id: string, version: string | null) => void;
  createVersion: (id: string, name?: string) => string | null;
  renameVersion: (id: string, versionId: string, name: string) => void;
  deleteVersion: (id: string, versionId: string) => Promise<string[]>;
  setAssetVersion: (assetId: string, versionId: string | null) => void;
  /**
   * Import XMP settings (`readXmp`) into photos: each asset's develop settings become the imported ones over the
   * defaults (`importedDevelop`). `orientationChange` is the sidecar's rotation relative to the file; with
   * `applyOrientation` it sets `geometry.rotate` / `flipH`, without it the photo's geometry is kept. Invalid settings
   * are skipped. `importXmp` is one photo, `importXmpMany` several as one undo step.
   */
  importXmp: (
    assetId: string,
    imported: XmpImport,
    options: { applyOrientation: boolean; orientationChange?: OrientationChange | null },
  ) => boolean;
  importXmpMany: (
    items: readonly { assetId: string; imported: XmpImport; orientationChange?: OrientationChange | null }[],
    options: { applyOrientation: boolean },
  ) => number;
  /**
   * Save the chosen sections of an asset's settings as a named preset in the app data dir and return it.
   * Rejects with the command's message when it cannot be written.
   */
  savePresetFromAsset: (assetId: string, name: string, sections: readonly DevelopSectionKey[]) => Promise<Preset>;
  /**
   * Masks (step D4.1), all through `setAssetDevelop` on `develop.masks` (shapes in fractions of the transformed,
   * uncropped frame). The discrete ones (add, remove, duplicate, rename, toggles, modes, resets) are one undo step
   * each. `setMaskOpacity`, `setMaskFeather`, `setMaskAdjustments`, `updateComponent`, `appendBrushStroke` and
   * `setLastBrushStroke` are not: inside `beginDevelopDrag()` / `endDevelopDrag()` a slider or handle drag, or a
   * brush stroke streaming its points, is one step. Ids are kept (never regenerated); unknown ids are no-ops.
   */
  addMask: (assetId: string, mask: DevelopMask) => void;
  /** Remove a mask. */
  removeMask: (assetId: string, maskId: string) => void;
  /** Copy a mask (new ids, name "… copy") right after the original; returns the new mask's id. */
  duplicateMask: (assetId: string, maskId: string) => string | null;
  renameMask: (assetId: string, maskId: string, name: string) => void;
  setMaskEnabled: (assetId: string, maskId: string, enabled: boolean) => void;
  setMaskInvert: (assetId: string, maskId: string, invert: boolean) => void;
  /** 0..100. */
  setMaskOpacity: (assetId: string, maskId: string, opacity: number) => void;
  /** 0..100. */
  setMaskFeather: (assetId: string, maskId: string, feather: number) => void;
  /** Merge a patch of the local sliders. */
  setMaskAdjustments: (assetId: string, maskId: string, patch: Partial<LocalAdjustments>) => void;
  /** Every local slider of the mask back to zero. */
  resetMaskAdjustments: (assetId: string, maskId: string) => void;
  /** Append a component (Add / Subtract / Intersect by its `mode`). */
  addMaskComponent: (assetId: string, maskId: string, component: DevelopMaskComponent) => void;
  /** Remove a component; removing the last one removes the mask (a mask needs one). */
  removeMaskComponent: (assetId: string, maskId: string, componentId: string) => void;
  setComponentMode: (assetId: string, maskId: string, componentId: string, mode: ComponentMode) => void;
  setComponentInvert: (assetId: string, maskId: string, componentId: string, invert: boolean) => void;
  /** Merge fields of the component's kind (gradient handles, luminance range, colour samples, tolerance). */
  updateComponent: (assetId: string, maskId: string, componentId: string, patch: MaskComponentPatch) => void;
  /** Add a stroke to a brush component. */
  appendBrushStroke: (assetId: string, maskId: string, componentId: string, stroke: BrushStroke) => void;
  /** Replace the brush component's last stroke (the one being painted). No-op without strokes. */
  setLastBrushStroke: (assetId: string, maskId: string, componentId: string, stroke: BrushStroke) => void;
  /**
   * Replace a component with others in its place (an AI component with its generated or refined version, or a People
   * component with one component per person). One undo step; no-op for unknown ids or an empty list.
   */
  replaceMaskComponent: (
    assetId: string,
    maskId: string,
    componentId: string,
    components: readonly DevelopMaskComponent[],
  ) => void;
}

/** What `updateUpright` did. */
export type UprightOutcome =
  | { ok: true; correction: GuidedUprightSolution['correction'] | null; residual: number | null }
  | { ok: false; message: string };

/** Where `relinkAssets` found a photo: the folder (registry id and path), the path in it, size and mtime. */
export interface AssetMove {
  assetId: string;
  folderId: string;
  folderPath: string;
  path: string;
  size: number;
  mtime: number;
}

/** A library photo to add to the project: its ref, its folder's path, and what the scan knows of the file. */
export type NewPhoto = PhotoRef & { folderPath: string } & Pick<
    Asset,
    'size' | 'mtime' | 'width' | 'height' | 'orientation'
  >;

/**
 * A photo to rate or flag: its photo id (a project asset id, or a library key `${folderId}/${path}` that rates the
 * folder's library entry with no project open) and its path relative to the folder.
 */
export interface ReviewTarget {
  assetId: string;
  path: string;
}

/** Rating 1 to 5 or flag to set; null clears; absent leaves it unchanged. */
export interface ReviewPatch {
  rating?: number | null;
  flag?: AssetFlag | null;
}

type HistoryState = Pick<BookState, 'book' | 'libraries'>;

/** zundo's internal "push this past state" function, captured through the `handleSet` option. */
let recordHistory: ((past: HistoryState, current: HistoryState) => void) | null = null;

// Output documents (workflow plan 13): a page is found in the book's pages or in any output's frames (page ids are
// unique across the book), and its photos are fitted against the template of the document it is in.
function findPage(book: Draft<Book> | null, pageId: string): Draft<Page> | undefined {
  const at = book ? locatePage(book, pageId) : undefined;
  return at?.pages[at.index];
}

/** The page size of the document page `pageId` is in (the book's when the page is unknown). */
function pageTemplate(book: Draft<Book>, pageId: string): BookTemplate {
  return locatePage(book, pageId)?.template ?? book.template;
}

/** What `cropFit` needs for an element of page `pageId`: the book's assets and that page's template. */
function fitOf(book: Draft<Book> | null, pageId: string): Pick<Book, 'assets' | 'template'> | null {
  return book ? { assets: book.assets, template: pageTemplate(book, pageId) } : null;
}
// End of the output documents helpers.

function findPhoto(book: Draft<Book> | null, pageId: string, elementId: string): Draft<PhotoElement> | undefined {
  const el = findPage(book, pageId)?.elements.find((e) => e.id === elementId);
  return el?.type === 'photo' ? el : undefined;
}

const EMPTY_CROP: Crop = { x: 0, y: 0, scale: 1 };

/** A hand edit (frame moved or resized, element added or deleted): the page no longer follows a layout. */
function markCustom(page: Draft<Page> | undefined): void {
  if (page && page.layout !== LAYOUT_CUSTOM) page.layout = LAYOUT_CUSTOM;
}

/**
 * Immer recipe step: put `page` in place of the page with `pageId`, with its photo crops re-clamped.
 * `page` may share (frozen) elements with the current state, so crops are fixed on copies.
 */
function replacePage(s: Draft<BookState>, pageId: string, page: Page): void {
  const book = s.book;
  const at = book ? locatePage(book, pageId) : undefined;
  if (!book || !at) return;
  const fit = { assets: book.assets, template: at.template };
  const elements = page.elements.map((el) => {
    if (el.type !== 'photo') return el;
    const crop = clampCrop(el.crop, cropFit(fit, el));
    const same = crop.x === el.crop.x && crop.y === el.crop.y && crop.scale === el.crop.scale;
    return same ? el : { ...el, crop };
  });
  at.pages[at.index] = { ...page, elements };
}

/** Wrap a discrete action so any open idle gesture is recorded as its own step first. */
function discrete<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    flushIdleGestures();
    return fn(...args);
  };
}

/** The photo's upright source size for the crop maths: `size` when given, else the scanned size (1×1 unknown). */
function sourceSizeOf(
  asset: Pick<PhotoMeta, 'width' | 'height'> | undefined,
  size: SourceSize | undefined,
): SourceSize {
  if (size && size.width > 0 && size.height > 0) return size;
  if (asset?.width && asset.height) return { width: asset.width, height: asset.height };
  return { width: 1, height: 1 };
}

const matsClose = (a: readonly number[], b: readonly number[], eps = 1e-12): boolean =>
  a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) <= eps);

/** The draft setter of the book store, as `writeDevelopMany` needs it. */
type DraftSet = (recipe: (draft: Draft<BookState>) => void) => void;

/**
 * Compute new develop settings for several assets and write them in ONE store update (one undo step). A result the
 * schema rejects, or one equal to the asset's current settings (read through the library), is skipped; one equal to
 * the defaults removes the `develop` key. Written through to the library (`writePhotoFields`). Returns how many
 * assets changed.
 */
function writeDevelopMany(
  set: DraftSet,
  assetIds: readonly string[],
  compute: (prev: DevelopSettings, meta: PhotoMeta | undefined, assetId: string) => DevelopSettings,
): number {
  let changed = 0;
  set((s) => {
    for (const id of new Set(assetIds)) {
      if (!hasPhoto(s, id)) continue;
      // A plain snapshot, not the draft: the computations clone and compare it freely.
      const resolved = assetDevelop(s, id);
      const before = resolved && isDraft(resolved) ? current(resolved) : resolved;
      const prev = before ?? createDevelop();
      const parsed = DevelopSchema.safeParse(compute(prev, photoMeta(s, id), id));
      if (!parsed.success) {
        devLog('develop', 'ignored invalid develop settings', { assetId: id, issues: parsed.error.issues.length });
        continue;
      }
      const next = isDefaultDevelop(parsed.data) ? undefined : parsed.data;
      // A version holds the defaults where the master holds nothing.
      if (next === undefined ? before === undefined || isDefaultDevelop(before) : deepEqual(next, before)) continue;
      writePhotoFields(s, id, { develop: next });
      // A refused write (a library key whose library is not loaded) changed nothing: not counted.
      if (assetDevelop(s, id) !== resolved) changed++;
    }
  });
  return changed;
}

/**
 * Follow a geometry change: re-map masks and guides when the pre-crop map changed (guides only when the edit kept
 * them: a replaced guide list is already in the new frame), and when `refit` and constrain are on and the
 * perspective part changed, refit the crop inside the warped image.
 */
function followGeometry(
  prev: DevelopSettings,
  next: DevelopGeometry,
  size: SourceSize,
  refit: boolean,
): DevelopSettings {
  const old = prev.geometry;
  const { width: w, height: h } = size;
  let geometry = next;
  let masks = prev.masks;
  if (!matsClose(preCropMatrix(old, w, h), preCropMatrix(next, w, h))) {
    const keepGuides = next.upright.guides === old.upright.guides;
    const moved = remapGeometryVectors(old, next, w, h, prev.masks, keepGuides ? old.upright.guides : []);
    masks = moved.masks;
    if (keepGuides && moved.guides.length > 0) {
      geometry = { ...geometry, upright: { ...geometry.upright, guides: moved.guides } };
    }
  }
  if (refit && geometry.constrainCrop) {
    const [ow, oh] = orientedSize(old.rotate, w, h);
    const [nw, nh] = orientedSize(geometry.rotate, w, h);
    const changed = ow !== nw || !matsClose(perspectiveMatrix(old, ow, oh), perspectiveMatrix(geometry, nw, nh), 1e-15);
    if (changed) geometry = refitWarpedCrop(geometry, size);
  }
  return { ...prev, geometry, masks };
}

/**
 * Apply a geometry edit that may change the perspective or orientation: through `setAssetDevelop`, with masks
 * and guides following the picture (`followGeometry`).
 */
function editPerspective(
  get: () => BookState,
  assetId: string,
  size: SourceSize | undefined,
  edit: (geometry: DevelopGeometry, size: SourceSize) => DevelopGeometry,
  refit = true,
): void {
  const state = get();
  const sz = sourceSizeOf(photoMeta(state, assetId), size);
  state.setAssetDevelop(assetId, (prev) => followGeometry(prev, edit(prev.geometry, sz), sz, refit));
}

/**
 * `target` with `sections` of `source` (Copy / Paste and Sync): the tone sections as they are (`applySections`); the
 * Upright result and Transform sliders with the target's masks and crop following the new warp; the crop (rect,
 * angle, aspect), fitted to the target (`fitCropTo`); the masks as fresh copies at the
 * same positions. Rotation and flips are never taken.
 */
function pasteSections(
  source: DevelopSettings,
  target: DevelopSettings,
  sections: readonly DevelopCopySection[],
  meta: PhotoMeta | undefined,
): DevelopSettings {
  const size = sourceSizeOf(meta, undefined);
  let next = applySections(source, target, sections);
  if (sections.includes('transform')) {
    const geometry = {
      ...next.geometry,
      upright: structuredClone(source.geometry.upright),
      transform: { ...source.geometry.transform },
    };
    next = followGeometry(next, geometry, size, true);
  }
  if (sections.includes('crop')) {
    const geometry = { ...next.geometry, crop: structuredClone(source.geometry.crop) };
    next = { ...next, geometry: fitCropTo(geometry, size) };
  }
  // Masks that already match (ids aside) stay as they are, so pasting twice changes nothing the second time.
  if (sections.includes('masks') && !deepEqual(withoutIds(next.masks), withoutIds(source.masks))) {
    next = { ...next, masks: source.masks.map((m) => cloneMask(m, m.name)) };
  }
  return next;
}

/** Masks with their and their components' ids blanked, to compare what they draw and do. */
const withoutIds = (masks: readonly DevelopMask[]) =>
  masks.map((m) => ({ ...m, id: '', components: m.components.map((c) => ({ ...c, id: '' })) }));

/** After a 90° turn or a flip with a perspective part: shrink the crop into the warped image (never grow it). */
function keepCropInWarped(g: DevelopGeometry, size: SourceSize): DevelopGeometry {
  const poly = g.constrainCrop && g.crop ? warpedPolygon(g, size) : null;
  if (!poly || !g.crop) return g;
  const { ia } = frameOf(g, size);
  const r = aspectRatioOf(g.crop.aspect, g, size);
  const rect = constrainFit(g.crop.rect, r, g.crop.angle, ia, poly);
  return rect === g.crop.rect ? g : { ...g, crop: { ...g.crop, rect } };
}

/** Apply a pure geometry edit to an asset's develop settings through `setAssetDevelop`. */
function editGeometry(
  get: () => BookState,
  assetId: string,
  size: SourceSize | undefined,
  edit: (geometry: DevelopGeometry, size: SourceSize) => DevelopGeometry,
): void {
  const state = get();
  const sz = sourceSizeOf(photoMeta(state, assetId), size);
  state.setAssetDevelop(assetId, (prev) => ({ ...prev, geometry: edit(prev.geometry, sz) }));
}

const IDENTITY_MATRIX = identity();

/** Map an asset's mask list through `setAssetDevelop` (returning the same array changes nothing). */
function editMasks(get: () => BookState, assetId: string, edit: (masks: DevelopMask[]) => DevelopMask[]): void {
  get().setAssetDevelop(assetId, (prev) => {
    const masks = edit(prev.masks);
    return masks === prev.masks ? prev : { ...prev, masks };
  });
}

/** Map one mask (no-op for an unknown id). */
function editMask(
  get: () => BookState,
  assetId: string,
  maskId: string,
  edit: (mask: DevelopMask) => DevelopMask,
): void {
  editMasks(get, assetId, (masks) =>
    masks.some((m) => m.id === maskId) ? masks.map((m) => (m.id === maskId ? edit(m) : m)) : masks,
  );
}

/** Map one component of one mask (no-op for unknown ids). */
function editComponent(
  get: () => BookState,
  assetId: string,
  maskId: string,
  componentId: string,
  edit: (component: DevelopMaskComponent) => DevelopMaskComponent,
): void {
  editMasks(get, assetId, (masks) => {
    const mask = masks.find((m) => m.id === maskId);
    if (!mask?.components.some((c) => c.id === componentId)) return masks;
    return masks.map((m) =>
      m.id === maskId ? { ...m, components: m.components.map((c) => (c.id === componentId ? edit(c) : c)) } : m,
    );
  });
}

/** A user-facing line for a rejected solve (`InvalidGuides: …` / `Unstable: …` from the command). */
export function uprightErrorMessage(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  if (text.startsWith('InvalidGuides:')) {
    return text.includes('use 2H')
      ? 'Use 2 horizontal or 2 vertical guides, or 2 to 4 with at least one of each (at most 2 per direction).'
      : 'A guide is too short or two guides lie on one line. Move one.';
  }
  if (text.startsWith('Unstable:')) return 'These guides would distort the photo too much. Adjust or remove one.';
  return text;
}

/** The `version` a project file was written with (before migration); undefined when it has none. */
function fileVersion(text: string): unknown {
  try {
    return (JSON.parse(text) as { version?: unknown }).version;
  } catch {
    return undefined;
  }
}

/** What `loadProject` read from (or wrote to) disk for the open project: what autosave starts from. */
let onDisk: { projectId: string; book: Book | null; libraries: Record<string, Library> } | null = null;

/**
 * The open project's book and its folders' libraries as they are on disk right after `loadProject` (null for another
 * project or before any load). Autosave adopts these as its saved state, so an in-memory book or library that already
 * differs (fields lifted or restored on open) is written.
 */
export function loadedFromDisk(
  projectId: string | null,
): { book: Book | null; libraries: Record<string, Library> } | null {
  return projectId !== null && onDisk?.projectId === projectId ? onDisk : null;
}

let flushBook: () => Promise<void> = async () => {};
let flushLibraries: () => Promise<void> = async () => {};

/** Write the pending book and library changes (both autosaves), before another project opens or on close. */
async function flushSave(): Promise<void> {
  await flushBook();
  await flushLibraries();
}

/**
 * Why version `versionId` cannot be deleted, one line per project (version ids are ULIDs, unique across libraries): the
 * title of each project whose assets use it, and "<title> (could not be read)" for a project file that cannot be read
 * or parsed, which may use it (fail closed). Every registered project file is read; the project open once the reads
 * are done is judged by the book in memory instead (it may hold unsaved changes, or have changed while the files were
 * read). Empty when nothing stands in the way.
 */
async function versionBlockers(versionId: string): Promise<string[]> {
  const uses = (b: Pick<Book, 'assets'>) => Object.values(b.assets).some((a) => a.version === versionId);
  const files: { id: string; title: string; uses: boolean | null }[] = [];
  for (const project of await listProjects()) {
    try {
      files.push({ id: project.id, title: project.title, uses: uses(parseBook(await readProject(project.id))) });
    } catch (err) {
      devLog('library', 'project not checked for versions', { id: project.id, error: String(err) });
      files.push({ id: project.id, title: project.title, uses: null });
    }
  }
  // After the awaits: the open project as it is now.
  const { book, projectId } = useBookStore.getState();
  const blockers: string[] = [];
  if (book && uses(book)) blockers.push(book.title || 'Untitled');
  for (const file of files) {
    if (book && file.id === projectId) continue;
    if (file.uses === null) blockers.push(`${file.title || 'Untitled'} (could not be read)`);
    else if (file.uses) blockers.push(file.title || 'Untitled');
  }
  return blockers;
}

/** Autosave registers its flush here, so closing or switching books waits for the write. */
export function setSaveFlusher(fn: (() => Promise<void>) | null): void {
  flushBook = fn ?? (async () => {});
}

/** The library autosave registers its flush here (see `setSaveFlusher`). */
export function setLibrarySaveFlusher(fn: (() => Promise<void>) | null): void {
  flushLibraries = fn ?? (async () => {});
}

export const useBookStore = create<BookState>()(
  temporal(
    immer((set, get) => ({
      book: null,
      projectId: null,
      folder: null,
      developVersion: null,
      ...createLibrarySlice(set, get, withoutHistory),
      ...createOutputsSlice(set, get, discrete),
      ...createCaptionsSlice(set, get, discrete),
      ...createSlideshowSlice(set, get, discrete),

      setBook: discrete((book: Book) => set({ book })),

      loadProject: async (id) => {
        // Write the open project first: autosave targets it by id.
        flushIdleGestures();
        await flushSave();
        const text = await readProject(id);
        const opened = parseBook(text);
        const fromVersion = fileVersion(text);
        // Only imported folders are in scope; the first one on disk is where the filmstrip scans.
        const imported = new Set((await listFolders()).filter((f) => !f.missing).map((f) => f.path));
        const paths = [...new Set(Object.values(opened.folders).map((f) => f.path))];
        const folder = paths.find((p) => imported.has(p));
        if (!folder) {
          throw new Error(
            paths.length === 0
              ? `${opened.title} has no photo folder`
              : `The photo folder of ${opened.title} (${paths.join(', ')}) is not imported or not on disk. Import it on Home, then open the project again.`,
          );
        }
        // Every library of the project is the source of truth for its photos: its fields win, book fields it lacks
        // are lifted into it.
        const diskLibraries: Record<string, Library> = {};
        for (const path of paths) {
          if (!imported.has(path)) continue;
          setLibraryWriteFailed(path, false);
          diskLibraries[path] = await readFolderLibrary(path);
        }
        const synced = syncBookWithLibraries(folder, opened, diskLibraries);
        const book = synced.book;
        const libraries = synced.libraries;
        const migrated = fromVersion !== CURRENT_VERSION;
        // An older version (migrated, its fields lifted into the library), or one whose saved form changed otherwise (a
        // stale mirror the library corrected) is written now in the current format, so the publish CLI reads what the
        // editor shows. Restoring the in-memory mirror of a v8 file alone changes nothing on disk. A failed rewrite
        // leaves the book unsaved for autosave to retry.
        let bookOnDisk: Book | null = opened;
        const librariesOnDisk = { ...diskLibraries };
        const diskText = () => serializeBook(bookForDisk({ libraries }, book, folder));
        if (migrated || !deepEqual(bookForDisk({ libraries }, book, folder), opened)) {
          // The saved book leaves out the fields the libraries hold, so lifted ones reach the library files first. If
          // a write fails the book keeps them (`bookForDisk`), and the library autosave retries.
          for (const [path, library] of Object.entries(libraries)) {
            if (library === diskLibraries[path] || !isLibraryWritable(path)) continue;
            try {
              await writeLibrary(path, serializeLibrary(library));
              librariesOnDisk[path] = library;
              setLibraryWriteFailed(path, false);
            } catch (err) {
              setLibraryWriteFailed(path, true);
              devLog('library', 'write after lift failed', { folder: path, error: String(err) });
            }
          }
          try {
            // Computed after the library writes: a failed one keeps the fields in the book.
            await writeProject(id, diskText());
            bookOnDisk = book;
            if (migrated) devLog('book', 'migrated', { project: id, from: fromVersion, to: CURRENT_VERSION });
          } catch (err) {
            devLog('book', 'rewrite after library sync failed', { project: id, error: String(err) });
          }
        }
        // Lifted fields not written above make a library differ from its file: the library autosave writes it.
        onDisk = { projectId: id, book: bookOnDisk, libraries: librariesOnDisk };
        await setRecent(id);
        set({ book, projectId: id, folder, libraries });
        useBookStore.temporal.getState().clear();
        devLog('book', 'loaded', {
          project: id,
          title: book.title,
          pages: book.pages.length,
          folder,
          folders: paths.length,
        });
        if (synced.lifted > 0 || synced.restored > 0) {
          devLog('library', 'synced on open', { lifted: synced.lifted, restored: synced.restored });
        }
        return book;
      },

      createProject: async ({ title, template, folderId }) => {
        const folder = (await listFolders()).find((f) => f.id === folderId);
        if (!folder) throw new Error('That folder is no longer imported');
        // The registry id doubles as the folder's id in the project.
        const book = createEmptyBook({ title, folders: { [folder.id]: { path: folder.path } }, template });
        await createProjectFile(book.id, serializeBook(book));
        devLog('book', 'project created', { project: book.id, title, folder: folder.path });
        await get().loadProject(book.id);
        return book.id;
      },

      saveAs: async (path) => {
        flushIdleGestures();
        await flushSave();
        const { book, projectId, folder } = get();
        if (!book || !projectId) throw new Error('No project is open');
        const summary = await saveProjectAs(projectId, path, serializeBook(bookForDisk(get(), book, folder)));
        devLog('book', 'saved as', { project: projectId, path: summary.path });
      },

      loadFromFolder: async (path, { create = true, template } = {}) => {
        const folder = await importFolder(path);
        // A legacy book that cannot be imported (unreadable, not JSON) never stops the folder from opening.
        let id: string | undefined;
        try {
          id = (await importLegacyBook(folder.id))?.id;
        } catch (err) {
          devLog('book', 'legacy book not imported', { folder: folder.path, error: String(err) });
        }
        if (!id) {
          // The most recently opened project on this folder (the list is newest first).
          const projects = await listProjects();
          id = projects.find((p) => !p.error && p.folders.some((f) => f.path === folder.path))?.id;
        }
        if (id) return get().loadProject(id);
        if (!create) return null;
        await get().createProject({ title: folder.name, template, folderId: folder.id });
        // A project started from a folder holds all of its photos, added once the folder is scanned (the assets store
        // imports this store, so it is loaded lazily here).
        void import('./assets')
          .then(({ addFolderPhotos }) => addFolderPhotos(folder.id, 'all'))
          .catch((err) => devLog('assets', 'photos of the new project not added', { error: String(err) }));
        return get().book;
      },

      close: async () => {
        flushIdleGestures();
        await flushSave();
        onDisk = null;
        set({ book: null, projectId: null, folder: null, libraries: {}, developVersion: null });
        useBookStore.temporal.getState().clear();
      },

      setTitle: (title) =>
        set((s) => {
          if (s.book) s.book.title = title;
        }),

      setOutputProfile: discrete((profile: OutputProfile) => {
        const from = get().book?.outputProfile;
        if (!from || from === profile) return;
        set((s) => {
          if (s.book) s.book.outputProfile = profile;
        });
        devLog('book', 'output profile changed', { from, to: profile });
      }),

      setPublish: discrete((patch: Partial<Book['publish']>) =>
        set((s) => {
          if (!s.book) return;
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            (s.book.publish as Record<string, unknown>)[key] = value;
          }
        }),
      ),

      setTemplate: discrete((name: BookTemplateName) => {
        const book = get().book;
        if (!book || name === 'custom' || book.template.name === name) return;
        const next = templateFor(name);
        set((s) => {
          if (!s.book) return;
          s.book.template = next;
          // The slot's pixel ratio changed with the page's: keep each photo covering its slot.
          for (const page of s.book.pages) {
            for (const el of page.elements) {
              if (el.type !== 'photo') continue;
              const crop = clampCrop(el.crop, cropFit(s.book, el));
              if (crop.x !== el.crop.x || crop.y !== el.crop.y || crop.scale !== el.crop.scale) el.crop = crop;
            }
          }
        });
        devLog('book', 'template changed', { from: book.template.name, to: name });
      }),

      setTheme: discrete((patch: Partial<Theme>) =>
        set((s) => {
          if (!s.book) return;
          for (const [key, value] of Object.entries(patch) as Array<[keyof Theme, Theme[keyof Theme]]>) {
            if (value === undefined || s.book.theme[key] === value) continue;
            (s.book.theme as Record<keyof Theme, unknown>)[key] = value;
          }
        }),
      ),

      setDefaultPageBackground: (color) =>
        set((s) => {
          if (s.book && s.book.theme.defaultPageBackground !== color) s.book.theme.defaultPageBackground = color;
        }),

      reapplyLayouts: discrete(() => {
        const book = get().book;
        if (!book) return 0;
        const custom = new Set(book.customLayouts.map((l) => l.id));
        let count = 0;
        const pages = book.pages.map((page) => {
          if (page.layout === LAYOUT_BLANK || page.layout === LAYOUT_CUSTOM || custom.has(page.layout)) return page;
          // Unknown ids (hand-edited file) come back as the same page.
          const next = reflowLayout(page, book.theme, book.template, book.customLayouts);
          if (next !== page) count += 1;
          return next;
        });
        if (count === 0) return 0;
        set((s) => {
          // Re-clamp each pan against its new slot (on copies: unchanged elements are frozen state).
          pages.forEach((page, i) => {
            if (page !== book.pages[i]) replacePage(s, page.id, page);
          });
        });
        return count;
      }),

      updatePage: (pageId, fn) =>
        set((s) => {
          const page = findPage(s.book, pageId);
          if (page) fn(page);
        }),

      updateElement: (pageId, elementId, fn) =>
        set((s) => {
          const el = findPage(s.book, pageId)?.elements.find((e) => e.id === elementId);
          if (el) fn(el);
        }),

      setElementAsset: discrete((pageId: string, elementId: string, assetId: string | null, asset?: AssetDraft) =>
        set((s) => {
          const el = findPhoto(s.book, pageId, elementId);
          if (!el || !s.book) return;
          if (assetId !== null && !(assetId in s.book.assets)) {
            if (!asset) return;
            s.book.assets[assetId] = withFolder(asset, undefined, openFolderId(s.book, s.folder));
          }
          el.asset = assetId;
          el.crop = { ...EMPTY_CROP };
          el.rotate = 0;
        }),
      ),

      swapAssets: discrete((pageId: string, elementA: string, elementB: string) =>
        set((s) => {
          if (elementA === elementB) return;
          const a = findPhoto(s.book, pageId, elementA);
          const b = findPhoto(s.book, pageId, elementB);
          if (!a || !b) return;
          const held = { asset: a.asset, rotate: a.rotate, filter: a.filter };
          a.asset = b.asset;
          a.rotate = b.rotate;
          a.filter = b.filter;
          b.asset = held.asset;
          b.rotate = held.rotate;
          b.filter = held.filter;
          a.crop = { ...EMPTY_CROP };
          b.crop = { ...EMPTY_CROP };
        }),
      ),

      setCrop: (pageId, elementId, crop) =>
        set((s) => {
          const el = findPhoto(s.book, pageId, elementId);
          if (!el) return;
          // Clamp against the asset's size, the slot frame and the template (old rule if size unknown).
          const next = clampCrop(crop, cropFit(fitOf(s.book, pageId), el));
          if (next.x === el.crop.x && next.y === el.crop.y && next.scale === el.crop.scale) return;
          el.crop = next;
        }),

      rotateElement: discrete((pageId: string, elementId: string) =>
        set((s) => {
          const el = findPhoto(s.book, pageId, elementId);
          if (!el) return;
          el.rotate = ((el.rotate + 90) % 360) as PhotoElement['rotate'];
          // The cover size changes with the rotation, so the stored pan must stay in range.
          el.crop = clampCrop(el.crop, cropFit(fitOf(s.book, pageId), el));
        }),
      ),

      setFilter: discrete((pageId: string, elementId: string, filter: Filter) =>
        set((s) => {
          const el = findPhoto(s.book, pageId, elementId);
          if (el) el.filter = filter;
        }),
      ),

      setShape: discrete((pageId: string, elementId: string, shape: Shape) =>
        set((s) => {
          const el = findPhoto(s.book, pageId, elementId);
          if (!el || !s.book) return;
          if (shape.kind === 'rect') {
            if (el.shape) delete el.shape;
          } else if (JSON.stringify(el.shape) !== JSON.stringify(shape)) {
            el.shape = shape;
          }
          if (shape.kind !== 'circle') return;
          const { width, height } = pageTemplate(s.book, pageId);
          const f = el.frame;
          const side = Math.min(f.w * width, f.h * height, width, height);
          const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
          const w = r6(side / width);
          const h = r6(side / height);
          const x = r6(Math.min(Math.max(f.x + (f.w - w) / 2, 0), 1 - w));
          const y = r6(Math.min(Math.max(f.y + (f.h - h) / 2, 0), 1 - h));
          if (x !== f.x || y !== f.y || w !== f.w || h !== f.h) {
            el.frame = { x, y, w, h };
            el.crop = clampCrop(el.crop, cropFit(fitOf(s.book, pageId), el));
            markCustom(findPage(s.book, pageId));
          }
          if (el.ratio !== '1:1') el.ratio = '1:1';
        }),
      ),

      setSlotRatio: discrete((pageId: string, elementId: string, ratio: SlotRatio) => {
        const book = get().book;
        const at = book ? locatePage(book, pageId) : undefined;
        const page = at?.pages[at.index];
        if (!book || !at || !page) return;
        const next = sharedSetSlotRatio(page, elementId, ratio, at.template, book.theme, book.customLayouts);
        if (next === page) return;
        set((s) => {
          const target = s.book ? locatePage(s.book, pageId) : undefined;
          if (!target) return;
          target.pages[target.index] = next;
          // The slot's aspect changed, so re-clamp the pan against the new cover size.
          const el = findPhoto(s.book, pageId, elementId);
          if (el) el.crop = clampCrop(el.crop, cropFit(fitOf(s.book, pageId), el));
        });
      }),

      applyLayout: discrete((pageId: string, layoutId: string) => {
        const book = get().book;
        const at = book ? locatePage(book, pageId) : undefined;
        const page = at?.pages[at.index];
        if (!book || !at || !page) return;
        const next = sharedApplyLayout(page, layoutId, book.theme, at.template, book.customLayouts);
        set((s) => {
          const target = s.book ? locatePage(s.book, pageId) : undefined;
          if (!target) return;
          target.pages[target.index] = next;
          // Every slot may have a new frame, so re-clamp each pan against its new cover size.
          const fit = fitOf(s.book, pageId);
          for (const el of target.pages[target.index]?.elements ?? []) {
            if (el.type === 'photo') el.crop = clampCrop(el.crop, cropFit(fit, el));
          }
        });
      }),

      setPageBackground: (pageId, background, asset) =>
        set((s) => {
          const page = findPage(s.book, pageId);
          if (!page || !s.book) return;
          if (typeof background === 'object' && !(background.asset in s.book.assets)) {
            if (!asset) return;
            s.book.assets[background.asset] = withFolder(asset, undefined, openFolderId(s.book, s.folder));
          }
          page.background = background;
        }),

      // Page actions work on the document the page is in; `addPage` and `movePage` take the output (default: the one
      // on the Design stage, `activeOutputId`).
      addPage: discrete((index?: number, outputId: string = activeOutputId()) => {
        const book = get().book;
        if (!book) return null;
        // A blank page, whatever `createEmptyPage` puts on it: layouts are applied on purpose.
        const page: Page = blankPage(book);
        const count = pagesOf(book, outputId).length;
        // A post holds as many frames as its network allows (plan 14; the UI says so).
        if (postFull(book, outputId)) return null;
        const at = Math.min(Math.max(index ?? count, 0), count);
        let added = false;
        set((s) => {
          // An unknown output has no page list to add to.
          if (!s.book || !hasOutput(s.book, outputId)) return;
          pagesOf(s.book, outputId).splice(at, 0, page);
          added = true;
        });
        return added ? page.id : null;
      }),

      duplicatePage: discrete((pageId: string) => {
        const book = get().book;
        const at = book ? locatePage(book, pageId) : undefined;
        const source = at?.pages[at.index];
        if (!source) return null;
        if (book && at && postFull(book, at.outputId)) return null;
        const copy = copyPage(source);
        set((s) => {
          const target = s.book ? locatePage(s.book, pageId) : undefined;
          target?.pages.splice(target.index + 1, 0, copy);
        });
        return copy.id;
      }),

      deletePage: discrete((pageId: string) =>
        set((s) => {
          const at = s.book ? locatePage(s.book, pageId) : undefined;
          at?.pages.splice(at.index, 1);
        }),
      ),

      movePage: discrete((from: number, to: number, outputId: string = activeOutputId()) =>
        set((s) => {
          const pages = s.book ? pagesOf(s.book, outputId) : undefined;
          if (!pages || from === to) return;
          if (from < 0 || from >= pages.length || to < 0 || to >= pages.length) return;
          const [page] = pages.splice(from, 1);
          if (page) pages.splice(to, 0, page);
        }),
      ),

      addText: discrete((pageId: string) => {
        const book = get().book;
        const at = book ? locatePage(book, pageId) : undefined;
        if (!book || !at) return null;
        const text = newCaption(at.template, book.theme);
        set((s) => {
          const page = findPage(s.book, pageId);
          page?.elements.push(text);
          markCustom(page);
        });
        return text.id;
      }),

      removeElement: discrete((pageId: string, elementId: string) =>
        set((s) => {
          const page = findPage(s.book, pageId);
          const index = page?.elements.findIndex((e) => e.id === elementId) ?? -1;
          if (!page || index < 0) return;
          page.elements.splice(index, 1);
          markCustom(page);
        }),
      ),

      deleteElements: discrete((pageId: string, elementIds: readonly string[]) =>
        set((s) => {
          const page = findPage(s.book, pageId);
          if (!page || elementIds.length === 0) return;
          const ids = new Set(elementIds);
          for (const el of page.elements) {
            if (ids.has(el.id) && el.type === 'photo' && el.asset !== null) {
              el.asset = null;
              el.crop = { ...EMPTY_CROP };
              el.rotate = 0;
              ids.delete(el.id);
            }
          }
          if (ids.size === 0) return;
          const kept = page.elements.filter((el) => !ids.has(el.id));
          if (kept.length === page.elements.length) return;
          page.elements = kept;
          markCustom(page);
        }),
      ),

      setFrames: (pageId, frames) =>
        set((s) => {
          const page = findPage(s.book, pageId);
          if (!page || !s.book) return;
          let changed = false;
          for (const el of page.elements) {
            const f = frames[el.id];
            if (!f) continue;
            const same = el.frame.x === f.x && el.frame.y === f.y && el.frame.w === f.w && el.frame.h === f.h;
            if (same) continue;
            el.frame = { x: f.x, y: f.y, w: f.w, h: f.h };
            if (el.type === 'photo') el.crop = clampCrop(el.crop, cropFit(fitOf(s.book, pageId), el));
            changed = true;
          }
          if (changed) markCustom(page);
        }),

      dropPhotoOnPage: discrete((pageId: string, assetId: string, asset?: AssetDraft) => {
        const book = get().book;
        const page = book ? findPage(book, pageId) : undefined;
        if (!book || !page) return null;
        if (!(assetId in book.assets) && !asset) return null;
        const empty = page.elements.find((e): e is PhotoElement => e.type === 'photo' && e.asset === null);
        if (empty) {
          get().setElementAsset(pageId, empty.id, assetId, asset);
          return empty.id;
        }
        const known = book.assets[assetId] ?? asset;
        const frame = photoDropFrame(known, resolveTheme(book.theme), pageTemplate(book, pageId));
        const id = newId();
        const next = withFrame(page, frame, id);
        set((s) => {
          if (!s.book) return;
          if (!(assetId in s.book.assets) && asset) {
            s.book.assets[assetId] = withFolder(asset, undefined, openFolderId(s.book, s.folder));
          }
          replacePage(s, pageId, {
            ...next,
            elements: next.elements.map((el) => (el.id === id && el.type === 'photo' ? { ...el, asset: assetId } : el)),
          });
        });
        return id;
      }),

      addFrame: discrete((pageId: string, frame: Frame) => {
        const page = findPage(get().book, pageId);
        if (!page) return null;
        const id = newId();
        set((s) => replacePage(s, pageId, withFrame(page, frame, id)));
        return id;
      }),

      addFrameGrid: discrete((pageId: string, options: FrameGridOptions) => {
        const book = get().book;
        const page = book ? findPage(book, pageId) : undefined;
        if (!book || !page) return [];
        const next = withFrameGrid(page, options, resolveTheme(book.theme), pageTemplate(book, pageId));
        set((s) => replacePage(s, pageId, next));
        return next.elements.filter((e) => e.type === 'photo').map((e) => e.id);
      }),

      mergeFrames: discrete((pageId: string, elementIds: readonly string[]) => {
        const page = findPage(get().book, pageId);
        const merged = page ? withMergedFrames(page, elementIds) : null;
        if (!merged) return null;
        set((s) => replacePage(s, pageId, merged.page));
        return merged.id;
      }),

      splitFrame: discrete((pageId: string, elementId: string, axis: SplitAxis) => {
        const book = get().book;
        const page = book ? findPage(book, pageId) : undefined;
        const split =
          book && page
            ? withSplitFrame(page, elementId, axis, resolveTheme(book.theme), pageTemplate(book, pageId))
            : null;
        if (!split) return null;
        set((s) => replacePage(s, pageId, split.page));
        return split.ids;
      }),

      addCustomLayout: discrete((layout: LayoutData, pageId?: string) => {
        if (!get().book) return null;
        // Always a fresh id: an incoming one could shadow a library layout or another custom one.
        const id = `custom-${newId()}`;
        set((s) => {
          if (!s.book) return;
          s.book.customLayouts.push({ ...structuredClone(layout), id, source: 'custom', group: 'custom' });
          const page = pageId ? findPage(s.book, pageId) : undefined;
          if (page) page.layout = id;
        });
        return id;
      }),

      renameCustomLayout: discrete((layoutId: string, name: string) =>
        set((s) => {
          const layout = s.book?.customLayouts.find((l) => l.id === layoutId);
          const trimmed = name.trim();
          if (layout && trimmed && layout.name !== trimmed) layout.name = trimmed;
        }),
      ),

      removeCustomLayout: discrete((layoutId: string) =>
        set((s) => {
          if (!s.book) return;
          const index = s.book.customLayouts.findIndex((l) => l.id === layoutId);
          if (index < 0) return;
          s.book.customLayouts.splice(index, 1);
          for (const page of allPages(s.book)) if (page.layout === layoutId) page.layout = LAYOUT_CUSTOM;
        }),
      ),

      fillAssets: (assets) =>
        withoutHistory(() =>
          set((s) => {
            if (!s.book) return;
            const folderId = openFolderId(s.book, s.folder);
            for (const [id, draft] of Object.entries(assets)) {
              const prev = s.book.assets[id];
              const hashBefore = prev?.hash;
              const asset = withFolder(draft, prev, folderId);
              // Scan bookkeeping knows nothing about edits: a rewritten entry keeps its develop settings.
              const develop = asset.develop ?? prev?.develop;
              s.book.assets[id] = develop && !asset.develop ? { ...asset, develop } : asset;
              // The hash just landed (or changed): the library entry wins, or the book's fields are lifted into it.
              if (asset.hash && asset.hash !== hashBefore) reconcileAsset(s, id);
            }
          }),
        ),

      replaceAssetId: (fromId, toId) =>
        withoutHistory(() =>
          set((s) => {
            if (!s.book || fromId === toId || !(fromId in s.book.assets)) return;
            for (const page of allPages(s.book)) {
              if (typeof page.background === 'object' && page.background.asset === fromId) page.background.asset = toId;
              for (const el of page.elements) if (el.type === 'photo' && el.asset === fromId) el.asset = toId;
            }
            delete s.book.assets[fromId];
          }),
        ),

      removeAssets: (ids) =>
        withoutHistory(() =>
          set((s) => {
            if (!s.book) return;
            for (const id of ids) delete s.book.assets[id];
          }),
        ),

      addPhotos: (photos) => {
        const ids: string[] = [];
        withoutHistory(() =>
          set((s) => {
            const book = s.book;
            if (!book) return;
            // The project's assets by folder path and relative path: a photo it already holds keeps its id.
            const held = new Map<string, string>();
            for (const [id, asset] of Object.entries(book.assets)) {
              const key = `${assetFolderPath(book, asset, s.folder)}\n${asset.path}`;
              if (!held.has(key)) held.set(key, id);
            }
            for (const photo of photos) {
              const key = `${photo.folderPath}\n${photo.path}`;
              const existing = held.get(key);
              if (existing) {
                ids.push(existing);
                continue;
              }
              let folderId = Object.entries(book.folders).find(([, f]) => f.path === photo.folderPath)?.[0];
              if (folderId === undefined) {
                folderId = Object.hasOwn(book.folders, photo.folder) ? newId() : photo.folder;
                book.folders[folderId] = { path: photo.folderPath };
              }
              const id = newId();
              book.assets[id] = {
                path: photo.path,
                hash: photo.hash,
                folder: folderId,
                ...(photo.size !== undefined ? { size: photo.size } : {}),
                ...(photo.mtime !== undefined ? { mtime: photo.mtime } : {}),
                ...(photo.width && photo.height ? { width: photo.width, height: photo.height } : {}),
                ...(photo.orientation ? { orientation: photo.orientation } : {}),
              };
              reconcileAsset(s, id);
              held.set(key, id);
              ids.push(id);
            }
          }),
        );
        return ids;
      },

      relinkAssets: (moves) =>
        withoutHistory(() =>
          set((s) => {
            const book = s.book;
            if (!book) return;
            const left = new Set<string>();
            for (const move of moves) {
              const asset = book.assets[move.assetId];
              if (!asset) continue;
              let folderId = Object.entries(book.folders).find(([, f]) => f.path === move.folderPath)?.[0];
              if (folderId === undefined) {
                folderId = Object.hasOwn(book.folders, move.folderId) ? newId() : move.folderId;
                book.folders[folderId] = { path: move.folderPath };
              }
              const from = assetFolderPath(book, asset, s.folder);
              const hash = asset.hash;
              const target = s.libraries[move.folderPath];
              const entry = hash && from ? s.libraries[from]?.photos[hash] : undefined;
              if (hash && entry && target && !Object.hasOwn(target.photos, hash)) {
                target.photos[hash] = structuredClone(isDraft(entry) ? current(entry) : entry);
              }
              left.add(asset.folder);
              asset.folder = folderId;
              asset.path = move.path;
              asset.size = move.size;
              asset.mtime = move.mtime;
              reconcileAsset(s, move.assetId);
            }
            const primary = openFolderId(book, s.folder);
            const used = new Set(Object.values(book.assets).map((a) => a.folder));
            for (const id of left) if (id !== primary && !used.has(id)) delete book.folders[id];
          }),
        ),

      reviewAssets: (targets, patch) =>
        withoutHistory(() =>
          set((s) => {
            for (const { assetId, path } of targets) {
              // A library key writes its folder's library; an id the open book does not know yet becomes its asset.
              if (s.book && !isPhotoKey(assetId)) {
                s.book.assets[assetId] ??= withFolder({ path }, undefined, openFolderId(s.book, s.folder));
              }
              const fields: PhotoFields = {};
              if (patch.rating !== undefined) {
                fields.rating = patch.rating === null ? undefined : Math.min(5, Math.max(1, Math.round(patch.rating)));
              }
              if (patch.flag !== undefined) fields.flag = patch.flag ?? undefined;
              writePhotoFields(s, assetId, fields);
            }
          }),
        ),

      setAssetDevelop: (assetId, patch) => {
        const state = get();
        if (!hasPhoto(state, assetId)) return;
        const before = assetDevelop(state, assetId);
        const prev = before ?? createDevelop();
        const raw = typeof patch === 'function' ? patch(prev) : deepMerge(prev, patch);
        const parsed = DevelopSchema.safeParse(raw);
        if (!parsed.success) {
          devLog('develop', 'ignored invalid develop settings', { assetId, issues: parsed.error.issues.length });
          return;
        }
        const next = isDefaultDevelop(parsed.data) ? undefined : parsed.data;
        if (next === undefined ? before === undefined || isDefaultDevelop(before) : deepEqual(next, before)) return;
        set((s) => writePhotoFields(s, assetId, { develop: next }));
      },

      resetAssetDevelop: discrete((assetId: string) =>
        set((s) => {
          const develop = assetDevelop(s, assetId);
          if (develop !== undefined && !isDefaultDevelop(develop)) writePhotoFields(s, assetId, { develop: undefined });
        }),
      ),

      setDenoise: (assetId, patch) =>
        get().setAssetDevelop(assetId, (prev) => ({
          ...prev,
          detail: {
            ...prev.detail,
            denoise: patch === null ? null : { ...(prev.detail.denoise ?? DEFAULT_DENOISE), ...patch },
          },
        })),

      resetDevelopSection: discrete((assetId: string, section: DevelopSectionKey | readonly DevelopSectionKey[]) => {
        const defaults = createDevelop();
        const keys = typeof section === 'string' ? [section] : section;
        get().setAssetDevelop(assetId, (prev) => {
          const next = { ...prev };
          for (const key of keys) (next as Record<string, unknown>)[key] = defaults[key];
          return next;
        });
      }),

      setDevelopCrop: (assetId, crop) =>
        get().setAssetDevelop(assetId, (prev) => ({
          ...prev,
          geometry: { ...prev.geometry, crop: normalizeCrop(crop) },
        })),

      setCropAngle: (assetId, angle, size) => {
        const base = gestureStartCrop(assetId);
        editGeometry(get, assetId, size, (g, sz) => applyAngle(g, angle, sz, base));
      },

      setCropAspect: discrete((assetId: string, aspect: CropAspect, size?: SourceSize) =>
        editGeometry(get, assetId, size, (g, sz) => applyAspect(g, aspect, sz)),
      ),

      swapCropOrientation: discrete((assetId: string, size?: SourceSize) =>
        editGeometry(get, assetId, size, (g, sz) => swapOrientation(g, sz)),
      ),

      rotate90: discrete((assetId: string, dir: 1 | -1) =>
        editPerspective(get, assetId, undefined, (g, sz) => keepCropInWarped(applyRotate90(g, dir), sz), false),
      ),

      flip: discrete((assetId: string, axis: 'h' | 'v') =>
        editPerspective(get, assetId, undefined, (g, sz) => keepCropInWarped(applyFlip(g, axis), sz), false),
      ),

      setConstrainCrop: discrete((assetId: string, on: boolean, size?: SourceSize) =>
        editGeometry(get, assetId, size, (g, sz) => applyConstrain(g, on, sz)),
      ),

      resetGeometry: discrete((assetId: string) =>
        editPerspective(get, assetId, undefined, () => createDevelop().geometry, false),
      ),

      resetCrop: discrete((assetId: string, size?: SourceSize) =>
        editPerspective(get, assetId, size, (g, sz) => resetCropTool(g, sz), false),
      ),

      setGeometry: discrete((assetId: string, geometry: DevelopGeometry) =>
        editPerspective(get, assetId, undefined, () => structuredClone(geometry), false),
      ),

      setTransform: (assetId, patch, size) =>
        editPerspective(get, assetId, size, (g) => ({ ...g, transform: { ...g.transform, ...patch } })),

      resetTransform: discrete((assetId: string, options?: { upright?: boolean }, size?: SourceSize) =>
        editPerspective(get, assetId, size, (g) => ({
          ...g,
          transform: { ...IDENTITY_TRANSFORM },
          upright: options?.upright ? createDevelop().geometry.upright : g.upright,
        })),
      ),

      setUprightMode: discrete(
        (assetId: string, mode: UprightMode, options?: { keepTransform?: boolean }, size?: SourceSize) =>
          editPerspective(get, assetId, size, (g) =>
            g.upright.mode === mode
              ? g
              : {
                  ...g,
                  upright: { ...g.upright, mode },
                  transform: options?.keepTransform ? g.transform : { ...IDENTITY_TRANSFORM },
                },
          ),
      ),

      setUprightGuides: (assetId, guides) =>
        get().setAssetDevelop(assetId, (prev) => ({
          ...prev,
          geometry: { ...prev.geometry, upright: { ...prev.geometry.upright, guides: guides.slice(0, 4) } },
        })),

      setUprightResult: discrete(
        (
          assetId: string,
          result: { transform: number[] | null; focal: number | null; mode?: UprightMode },
          size?: SourceSize,
        ) =>
          editPerspective(get, assetId, size, (g) => ({
            ...g,
            upright: {
              ...g.upright,
              mode: result.mode ?? g.upright.mode,
              transform: result.transform ? [...result.transform] : null,
              focal: result.focal,
            },
          })),
      ),

      updateUpright: async (assetId, size, isCurrent) => {
        const asset = photoMeta(get(), assetId);
        if (!asset || !hasPhoto(get(), assetId)) return { ok: false, message: 'Unknown photo' };
        const g = assetDevelop(get(), assetId)?.geometry ?? createDevelop().geometry;
        const { guides } = g.upright;
        if (guides.length === 0) {
          if (g.upright.transform !== null)
            get().setUprightResult(assetId, { transform: null, focal: g.upright.focal }, size);
          return { ok: true, correction: null, residual: null };
        }
        const sz = sourceSizeOf(asset, size);
        const [fw, fh] = orientedSize(g.rotate, sz.width, sz.height);
        // Stored guides live in the transformed frame; the solver wants the oriented frame.
        const back = perspectiveMatrix(g, fw, fh);
        const oriented = guides.map((guide) => {
          const [from, to] = remapPoints([guide.from, guide.to], back, IDENTITY_MATRIX);
          return { ...guide, from: from ?? guide.from, to: to ?? guide.to };
        });
        let solution: GuidedUprightSolution;
        try {
          solution = await solveUprightGuides(oriented, fw, fh, g.upright.focal);
        } catch (err) {
          const message = uprightErrorMessage(err);
          devLog('develop', 'guided upright rejected', { assetId, message });
          return { ok: false, message };
        }
        // A newer edit of the guides (or another photo state) wins: its own update follows. `isCurrent` false (the
        // caller moved on, e.g. to another photo) drops the result too.
        const now = assetDevelop(get(), assetId)?.geometry;
        if (!now || !deepEqual(now.upright.guides, guides) || now.rotate !== g.rotate || isCurrent?.() === false) {
          return { ok: false, message: '' };
        }
        get().setUprightResult(assetId, { transform: solution.transform, focal: solution.focal, mode: 'guided' }, size);
        return { ok: true, correction: solution.correction, residual: solution.residual };
      },

      applyUpright: discrete(
        (
          assetId: string,
          mode: UprightMode,
          result: { transform: number[]; focal: number | null },
          options?: { keepTransform?: boolean },
          size?: SourceSize,
        ) =>
          editPerspective(get, assetId, size, (g) => ({
            ...g,
            upright: { ...g.upright, mode, transform: [...result.transform], focal: result.focal },
            transform: g.upright.mode === mode || options?.keepTransform ? g.transform : { ...IDENTITY_TRANSFORM },
          })),
      ),

      addMask: discrete((assetId: string, mask: DevelopMask) =>
        editMasks(get, assetId, (masks) => (masks.some((m) => m.id === mask.id) ? masks : [...masks, mask])),
      ),

      removeMask: discrete((assetId: string, maskId: string) =>
        editMasks(get, assetId, (masks) => masks.filter((m) => m.id !== maskId)),
      ),

      duplicateMask: discrete((assetId: string, maskId: string) => {
        const masks = assetDevelop(get(), assetId)?.masks ?? [];
        const index = masks.findIndex((m) => m.id === maskId);
        const original = masks[index];
        if (!original) return null;
        const copy = cloneMask(original, `${maskDisplayName(original, index)} copy`);
        editMasks(get, assetId, (list) => [...list.slice(0, index + 1), copy, ...list.slice(index + 1)]);
        return assetDevelop(get(), assetId)?.masks.some((m) => m.id === copy.id) ? copy.id : null;
      }),

      renameMask: discrete((assetId: string, maskId: string, name: string) =>
        editMask(get, assetId, maskId, (m) => ({ ...m, name: name.trim() })),
      ),

      setMaskEnabled: discrete((assetId: string, maskId: string, enabled: boolean) =>
        editMask(get, assetId, maskId, (m) => ({ ...m, enabled })),
      ),

      setMaskInvert: discrete((assetId: string, maskId: string, invert: boolean) =>
        editMask(get, assetId, maskId, (m) => ({ ...m, invert })),
      ),

      setMaskOpacity: (assetId, maskId, opacity) => editMask(get, assetId, maskId, (m) => ({ ...m, opacity })),

      setMaskFeather: (assetId, maskId, feather) => editMask(get, assetId, maskId, (m) => ({ ...m, feather })),

      setMaskAdjustments: (assetId, maskId, patch) =>
        editMask(get, assetId, maskId, (m) => ({ ...m, adjustments: { ...m.adjustments, ...patch } })),

      resetMaskAdjustments: discrete((assetId: string, maskId: string) =>
        editMask(get, assetId, maskId, (m) => ({ ...m, adjustments: { ...DEFAULT_LOCAL_ADJUSTMENTS } })),
      ),

      addMaskComponent: discrete((assetId: string, maskId: string, component: DevelopMaskComponent) =>
        editMask(get, assetId, maskId, (m) =>
          m.components.some((c) => c.id === component.id) ? m : { ...m, components: [...m.components, component] },
        ),
      ),

      removeMaskComponent: discrete((assetId: string, maskId: string, componentId: string) =>
        editMasks(get, assetId, (masks) =>
          masks.flatMap((m) => {
            if (m.id !== maskId) return [m];
            const components = m.components.filter((c) => c.id !== componentId);
            if (components.length === m.components.length) return [m];
            return components.length === 0 ? [] : [{ ...m, components }];
          }),
        ),
      ),

      setComponentMode: discrete((assetId: string, maskId: string, componentId: string, mode: ComponentMode) =>
        editComponent(get, assetId, maskId, componentId, (c) => ({ ...c, mode })),
      ),

      setComponentInvert: discrete((assetId: string, maskId: string, componentId: string, invert: boolean) =>
        editComponent(get, assetId, maskId, componentId, (c) => ({ ...c, invert })),
      ),

      updateComponent: (assetId, maskId, componentId, patch) =>
        editComponent(get, assetId, maskId, componentId, (c) => ({ ...c, ...patch }) as DevelopMaskComponent),

      replaceMaskComponent: discrete(
        (assetId: string, maskId: string, componentId: string, components: readonly DevelopMaskComponent[]) =>
          editMasks(get, assetId, (masks) => {
            const mask = masks.find((m) => m.id === maskId);
            if (components.length === 0 || !mask?.components.some((c) => c.id === componentId)) return masks;
            return masks.map((m) =>
              m.id === maskId
                ? { ...m, components: m.components.flatMap((c) => (c.id === componentId ? [...components] : [c])) }
                : m,
            );
          }),
      ),

      appendBrushStroke: (assetId, maskId, componentId, stroke) =>
        editComponent(get, assetId, maskId, componentId, (c) =>
          c.kind === 'brush' ? { ...c, strokes: [...c.strokes, stroke] } : c,
        ),

      setLastBrushStroke: (assetId, maskId, componentId, stroke) =>
        editComponent(get, assetId, maskId, componentId, (c) =>
          c.kind === 'brush' && c.strokes.length > 0 ? { ...c, strokes: [...c.strokes.slice(0, -1), stroke] } : c,
        ),

      copyDevelop: (assetId, sections = DEFAULT_COPY_SECTIONS) => {
        if (!hasPhoto(get(), assetId)) return null;
        return { ...clipOf(assetDevelop(get(), assetId) ?? createDevelop(), sections), source: assetId };
      },

      pasteDevelop: discrete((assetIds: readonly string[], clip: DevelopClip) => {
        if (clip.sections.length === 0) return 0;
        // The photo copied from keeps its settings (a selection that includes it pastes onto the others).
        const targets = clip.source === undefined ? assetIds : assetIds.filter((id) => id !== clip.source);
        return writeDevelopMany(set, targets, (prev, meta) => pasteSections(clip.settings, prev, clip.sections, meta));
      }),

      applyDevelopPreset: discrete((assetIds: readonly string[], preset: Pick<Preset, 'sections' | 'settings'>) =>
        writeDevelopMany(set, assetIds, (prev) => applyPresetTo(prev, preset)),
      ),

      // Workflow plan 20: Looks.
      applyDevelopLook: discrete(
        (
          assetIds: readonly string[],
          look: Preset | null,
          amount: number,
          lookup?: (presetId: string) => Preset | undefined,
        ) => writeDevelopMany(set, assetIds, (prev) => replaceLook(prev, look, amount, lookup)),
      ),

      syncDevelop: discrete(
        (fromAssetId: string, toAssetIds: readonly string[], sections: readonly DevelopSyncSection[]) => {
          if (!hasPhoto(get(), fromAssetId) || sections.length === 0) return 0;
          const source = assetDevelop(get(), fromAssetId) ?? createDevelop();
          // Sync never copies the crop (`copySectionsOf` has no `crop`).
          const copied = copySectionsOf(sections);
          return writeDevelopMany(
            set,
            toAssetIds.filter((id) => id !== fromAssetId),
            (prev, meta) => pasteSections(source, prev, copied, meta),
          );
        },
      ),

      resetDevelopMany: discrete((assetIds: readonly string[]) =>
        writeDevelopMany(set, assetIds, () => createDevelop()),
      ),

      showVersion: (id, version) => {
        const own = get().book?.assets[id]?.version ?? null;
        const next = version === own ? null : { id, version };
        const now = get().developVersion;
        if (next === now || (next && now && next.id === now.id && next.version === now.version)) return;
        withoutHistory(() => set({ developVersion: next }));
      },

      createVersion: (id, name) => {
        const state = get();
        const place = photoEntryPlace(state, id);
        if (!place || !hasPhoto(state, id)) {
          devLog('library', 'version not made', { photo: id, reason: 'no library entry' });
          return null;
        }
        const develop = structuredClone(assetDevelop(state, id) ?? createDevelop());
        const versionId = newId();
        withoutHistory(() =>
          set((s) =>
            patchPhotoDraft(s, place.folder, place.hash, (photo) => {
              const label = name?.trim() || nextVersionName(photo);
              photo.versions[versionId] = { name: label, develop };
            }),
          ),
        );
        devLog('library', 'version made', { photo: id, version: versionId });
        return versionId;
      },

      renameVersion: (id, versionId, name) => {
        const label = name.trim();
        const place = photoEntryPlace(get(), id);
        if (!label || !place) return;
        withoutHistory(() =>
          set((s) => {
            const version = s.libraries[place.folder]?.photos[place.hash]?.versions[versionId];
            if (version && version.name !== label) version.name = label;
          }),
        );
      },

      deleteVersion: async (id, versionId) => {
        const blockers = await versionBlockers(versionId);
        if (blockers.length > 0) {
          devLog('library', 'version kept: projects use it', {
            photo: id,
            version: versionId,
            projects: blockers.length,
          });
          return blockers;
        }
        const place = photoEntryPlace(get(), id);
        if (!place) return [];
        withoutHistory(() =>
          set((s) => {
            const photo = s.libraries[place.folder]?.photos[place.hash];
            if (photo && Object.hasOwn(photo.versions, versionId)) delete photo.versions[versionId];
            if (s.developVersion?.version === versionId) s.developVersion = null;
          }),
        );
        devLog('library', 'version deleted', { photo: id, version: versionId });
        return [];
      },

      setAssetVersion: (assetId, versionId) => {
        const state = get();
        const asset = state.book?.assets[assetId];
        if (!asset || (asset.version ?? null) === versionId) return;
        if (versionId !== null && !Object.hasOwn(libraryEntryOf(state, assetId)?.versions ?? {}, versionId)) return;
        withoutHistory(() =>
          set((s) => {
            const draft = s.book?.assets[assetId];
            if (!draft) return;
            if (versionId === null) delete draft.version;
            else draft.version = versionId;
            // The project now uses what Develop showed: no choice left to remember.
            if (s.developVersion?.id === assetId && s.developVersion.version === versionId) s.developVersion = null;
          }),
        );
        devLog('library', 'project version chosen', { assetId, version: versionId });
      },

      importXmp: discrete(
        (
          assetId: string,
          imported: XmpImport,
          options: { applyOrientation: boolean; orientationChange?: OrientationChange | null },
        ) => get().importXmpMany([{ assetId, imported, orientationChange: options.orientationChange }], options) > 0,
      ),

      importXmpMany: discrete(
        (
          items: readonly { assetId: string; imported: XmpImport; orientationChange?: OrientationChange | null }[],
          options: { applyOrientation: boolean },
        ) => {
          const byId = new Map(items.map((item) => [item.assetId, item]));
          return writeDevelopMany(set, [...byId.keys()], (prev, _meta, id) => {
            const item = byId.get(id);
            if (!item) return prev;
            return importedDevelop(prev, item.imported.settings, item.orientationChange, options.applyOrientation);
          });
        },
      ),

      savePresetFromAsset: async (assetId: string, name: string, sections: readonly DevelopSectionKey[]) => {
        if (!hasPhoto(get(), assetId)) throw new Error('This photo is not in the project');
        const preset = makePreset(name, assetDevelop(get(), assetId) ?? createDevelop(), sections);
        await savePreset(preset);
        devLog('develop', 'saved preset', { id: preset.id, sections: preset.sections.length });
        return preset;
      },
    })),
    {
      partialize: (s): HistoryState => ({ book: s.book, libraries: s.libraries }),
      limit: 200,
      equality: (a, b) => a.book === b.book && a.libraries === b.libraries,
      handleSet: (handleSet) => {
        const push = handleSet as unknown as (
          past: HistoryState,
          replace: undefined,
          current: HistoryState,
          delta: null,
        ) => void;
        recordHistory = (past, current) => push(past, undefined, current, null);
        return handleSet;
      },
    },
  ),
);

// History helpers ------------------------------------------------------------------------------

let pauseDepth = 0;

function pauseHistory() {
  pauseDepth += 1;
  if (pauseDepth === 1) useBookStore.temporal.getState().pause();
}

function resumeHistory() {
  if (pauseDepth === 0) return;
  pauseDepth -= 1;
  if (pauseDepth === 0) useBookStore.temporal.getState().resume();
}

/** Run `fn` without recording undo history (nests with gestures). */
export function withoutHistory<T>(fn: () => T): T {
  pauseHistory();
  try {
    return fn();
  } finally {
    resumeHistory();
  }
}

let gesture: { depth: number; start: HistoryState } | null = null;

const historyState = (): HistoryState => {
  const { book, libraries } = useBookStore.getState();
  return { book, libraries };
};

/**
 * Start a continuous gesture: changes until the matching `endGesture()` become one undo step.
 * Calls nest; only the outermost pair records.
 */
export function beginGesture(): void {
  if (gesture) {
    gesture.depth += 1;
    return;
  }
  gesture = { depth: 1, start: historyState() };
  pauseHistory();
}

/** End a gesture and record it as a single undo step if the book changed. */
export function endGesture(): void {
  if (!gesture) return;
  gesture.depth -= 1;
  if (gesture.depth > 0) return;
  const { start } = gesture;
  gesture = null;
  resumeHistory();
  const now = historyState();
  // With a project open both states hold it; in the library (no project) only the libraries change.
  const sameDocument = start.book && now.book ? start.book.id === now.book.id : !start.book && !now.book;
  if (sameDocument && (start.book !== now.book || start.libraries !== now.libraries)) {
    recordHistory?.(start, now);
  }
}

export const isGestureActive = (): boolean => gesture !== null;

/**
 * The asset's crop when the open gesture began (null: none), or undefined outside a gesture. A straighten drag
 * measures every step from it, so the crop shrinks and regrows with the angle instead of only shrinking.
 */
function gestureStartCrop(assetId: string): DevelopCrop | null | undefined {
  if (!gesture) return undefined;
  const { folder, developVersion } = useBookStore.getState();
  const start: LibraryView = { ...gesture.start, folder, developVersion };
  return assetDevelop(start, assetId)?.geometry.crop ?? null;
}

/**
 * Pointer down on a develop slider, curve point or split handle: until `endDevelopDrag()` every
 * `setAssetDevelop` joins one undo step. The same pair as `beginGesture` / `endGesture` (they nest).
 */
export const beginDevelopDrag = beginGesture;
/** Pointer up: records the whole drag as a single undo step if the settings changed. */
export const endDevelopDrag = endGesture;

/** End functions of the idle gestures that are open right now. */
const openIdleGestures = new Set<() => void>();

export interface IdleGesture {
  /** Call before each change; opens the gesture on the first call. */
  touch: () => void;
  /** End the gesture now (no-op when none is open). */
  end: () => void;
}

/**
 * A gesture with no clear end (pinch wheel events, the native color picker): it ends `idleMs`
 * after the last `touch()`, or earlier through `flushIdleGestures()`. `onEnd` runs after each
 * gesture is recorded (canvas nudges: the custom-page notice, workflow plan 29).
 */
export function createIdleGesture(idleMs: number, onEnd?: () => void): IdleGesture {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const end = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    openIdleGestures.delete(end);
    endGesture();
    onEnd?.();
  };
  const touch = () => {
    if (timer) clearTimeout(timer);
    else {
      beginGesture();
      openIdleGestures.add(end);
    }
    timer = setTimeout(end, idleMs);
  };
  return { touch, end };
}

/** End every open idle gesture now, recording each as its own undo step. */
export function flushIdleGestures(): void {
  for (const end of [...openIdleGestures]) end();
}

function applyHistory(kind: 'undo' | 'redo'): boolean {
  flushIdleGestures();
  if (gesture) return false;
  const t = useBookStore.temporal.getState();
  if ((kind === 'undo' ? t.pastStates : t.futureStates).length === 0) return false;
  const { book: before, libraries: librariesBefore } = useBookStore.getState();
  t[kind]();
  const { book: after, libraries: librariesAfter } = useBookStore.getState();
  // Scan metadata is not history: keep the newest entries over the restored ones.
  const sameBook = before && after && before.id === after.id;
  if (!before && !after && librariesBefore !== librariesAfter) {
    // The library with no project open: newest ratings and flags, the restored develop (`mergeLibrariesForHistory`).
    withoutHistory(() =>
      useBookStore.setState((s) => {
        s.libraries = mergeLibrariesForHistory(librariesBefore, librariesAfter, null, s.folder);
      }),
    );
  } else if (sameBook && (before.assets !== after.assets || librariesBefore !== librariesAfter)) {
    withoutHistory(() =>
      useBookStore.setState((s) => {
        if (!s.book) return;
        const merged: Record<string, Asset> = { ...after.assets, ...before.assets };
        // Develop settings are the exception: they are the edit being undone or redone.
        for (const [id, restored] of Object.entries(after.assets)) {
          const kept = merged[id];
          if (!kept || kept.develop === restored.develop) continue;
          const { develop: _newest, ...rest } = kept;
          merged[id] = restored.develop ? { ...rest, develop: restored.develop } : rest;
        }
        s.book.assets = merged;
        // Folders a relink added after the restored state are kept: the newest assets may live in them.
        s.book.folders = { ...after.folders, ...before.folders };
        // The library likewise: newest ratings and flags, the restored develop; then the mirror follows the library.
        s.libraries = mergeLibrariesForHistory(librariesBefore, librariesAfter, { ...after, assets: merged }, s.folder);
        for (const id of Object.keys(merged)) reconcileAsset(s, id);
      }),
    );
  }
  const next = useBookStore.temporal.getState();
  devLog('history', kind, { past: next.pastStates.length, future: next.futureStates.length });
  return true;
}

export const undo = (): boolean => applyHistory('undo');
export const redo = (): boolean => applyHistory('redo');

/** canUndo / canRedo for the top bar buttons. */
export function useHistoryAvailability(): { canUndo: boolean; canRedo: boolean } {
  const canUndo = useStore(useBookStore.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(useBookStore.temporal, (s) => s.futureStates.length > 0);
  return { canUndo, canRedo };
}
