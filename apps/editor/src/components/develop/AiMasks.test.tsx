// @vitest-environment jsdom
import type { DevelopMask, DevelopMaskComponent } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AiComponent, newAi, newMask } from '../../lib/develop/masks';
import type { AiMaskProgressEvent, AiMaskResult, AiModelInfo, ModelInfo } from '../../lib/tauri';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { undo, useBookStore } from '../../store/book';
import { DEFAULT_BRUSH, DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { resetAiMasks } from './useAiMask';
import { resetPreviewWarnings } from './usePreview';

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  overlay: vi.fn(),
  commit: vi.fn(),
  listModels: vi.fn(),
  status: vi.fn(),
  generate: vi.fn(),
  refine: vi.fn(),
  release: vi.fn(),
  download: vi.fn(),
  cancelDownload: vi.fn(),
  progress: { handler: null as ((e: AiMaskProgressEvent) => void) | null },
}));
vi.mock('../../lib/tauri', async (original) => ({
  ...(await original<typeof import('../../lib/tauri')>()),
  renderDevelopPreview: mocks.render,
  developMaskOverlay: mocks.overlay,
  listModels: mocks.listModels,
  aiMaskStatus: mocks.status,
  generateAiMask: mocks.generate,
  samRefineMask: mocks.refine,
  releaseAiMasks: mocks.release,
  downloadModel: mocks.download,
  cancelModelDownload: mocks.cancelDownload,
  onAiMaskProgress: async (handler: (e: AiMaskProgressEvent) => void) => {
    mocks.progress.handler = handler;
    return () => {
      mocks.progress.handler = null;
    };
  },
  onModelProgress: async () => () => {},
  openModelLink: async () => {},
}));
vi.mock('./commit', () => ({ commitDevelop: mocks.commit }));

import { DevelopMode } from './DevelopMode';

// f1 is 1200 × 800. The box is 648 × 448, so the picture (less the 24 px margin) is 600 × 400 at (24, 24).
const BOX = { left: 0, top: 0, width: 648, height: 448 };
const at = (u: number, v: number): [number, number] => [24 + 600 * u, 24 + 400 * v];
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

const REGISTRY: Array<Pick<ModelInfo, 'name' | 'version' | 'task'>> = [
  { name: 'birefnet-lite', version: '1', task: 'subject' },
  { name: 'skywater-seg', version: '2', task: 'sky' },
  { name: 'rtdetr-v2', version: '1', task: 'people-detect' },
  { name: 'sam2.1-tiny-encoder', version: '1', task: 'sam-encoder' },
  { name: 'sam2.1-tiny-decoder', version: '1', task: 'sam-decoder' },
  { name: 'depth-anything-v2-small', version: '1', task: 'depth' },
];
const MODEL_OF: Record<string, string> = {
  subject: 'birefnet-lite',
  background: 'birefnet-lite',
  sky: 'skywater-seg',
  people: 'rtdetr-v2',
  depth: 'depth-anything-v2-small',
};

/** The component as the Rust side stamps it. */
function stamp(c: DevelopMaskComponent): DevelopMaskComponent {
  if (c.kind !== 'ai') return c;
  const model = c.prompts.length > 0 ? 'sam2.1-tiny-encoder' : (MODEL_OF[c.target] ?? '');
  const version = REGISTRY.find((m) => m.name === model)?.version ?? '';
  return { ...c, model, modelVersion: version };
}

function result(c: DevelopMaskComponent, extra: Partial<AiMaskResult> = {}): AiMaskResult {
  const component = stamp(c);
  return {
    componentHash: 'abc',
    path: '/cache/abc.png',
    width: 1600,
    height: 1067,
    modelVersion: component.kind === 'ai' ? component.modelVersion : '',
    component,
    missingModels: [],
    people: [],
    coverage: 0.3,
    elapsedMs: 100,
    ...extra,
  };
}

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const file = (): AssetFile => ({
  relPath: 'fixture/f1.jpg',
  assetId: 'f1',
  size: 1,
  mtime: 1,
  kind: 'jpeg',
  hash: 'hash-f1',
  status: 'ready',
  proxyUrl: 'asset://proxy/f1.jpg',
  thumbUrl: 'asset://thumb/f1.jpg',
});

const masks = (): DevelopMask[] => useBookStore.getState().book?.assets.f1?.develop?.masks ?? [];
const steps = () => useBookStore.temporal.getState().pastStates.length;
const tools = () => screen.getByTestId('mask-tools');
const key = (k: string, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(screen.getByRole('dialog'), { key: k, ...init });

function open() {
  act(() => useUiStore.getState().openDevelop(['f1', 'f2'], 0));
  render(<DevelopMode />);
  key('m');
}

function pick(label: string, menu = 'Create new mask', scope: HTMLElement = document.body) {
  fireEvent.click(within(scope).getByRole('button', { name: menu }));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
}

/** A mask already holding `c` (stamped), selected. */
function seed(c: AiComponent): DevelopMask {
  const m = newMask('Mask 1', c);
  act(() => {
    useBookStore.getState().addMask('f1', m);
    useBookStore.temporal.getState().clear();
  });
  return m;
}

function selectComponent(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Mask 1' }));
  const list = screen.getByRole('list', { name: 'Components' });
  fireEvent.click(within(list).getByRole('button', { name }));
  // Plan 54: a component's range and Refine are behind the ▸ in Basic.
  const more = screen.queryByRole('button', { name: /^Range & refine/ });
  if (more?.getAttribute('aria-expanded') === 'false') fireEvent.click(more);
}

function press(x: number, y: number, init: Partial<PointerEventInit> = {}) {
  fireEvent.pointerDown(tools(), { pointerId: 1, button: 0, clientX: x, clientY: y, ...init });
  fireEvent.pointerUp(tools(), { pointerId: 1, clientX: x, clientY: y, ...init });
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:overlay');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...BOX,
    x: 0,
    y: 0,
    right: BOX.width,
    bottom: BOX.height,
    toJSON: () => BOX,
  } as DOMRect);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  for (const m of [mocks.render, mocks.overlay, mocks.commit, mocks.generate, mocks.refine, mocks.release]) {
    m.mockReset();
  }
  mocks.render.mockImplementation(async () => jpeg());
  mocks.overlay.mockImplementation(async () => jpeg());
  mocks.release.mockResolvedValue(undefined);
  mocks.listModels.mockReset();
  mocks.listModels.mockResolvedValue(REGISTRY);
  mocks.status.mockReset();
  mocks.status.mockImplementation(async (_hash: string, components: unknown[]) => components.map(() => true));
  mocks.generate.mockImplementation(async (...args: unknown[]) => result(args[4] as DevelopMaskComponent));
  mocks.refine.mockImplementation(async (...args: unknown[]) => result(args[4] as DevelopMaskComponent));
  mocks.download.mockReset();
  mocks.cancelDownload.mockReset();
  mocks.progress.handler = null;
  resetAiMasks();
  const doc = structuredClone(fixtureBook);
  const asset = doc.assets.f1;
  if (asset) asset.hash = 'hash-f1';
  useBookStore.setState({ book: doc, folder: '/photos' });
  useBookStore.temporal.getState().clear();
  useAssetsStore.setState({ files: { 'fixture/f1.jpg': file() } });
  useUiStore.setState({
    develop: null,
    developBeforeAfter: false,
    filmstrip: DEFAULT_FILMSTRIP,
    maskOverlay: true,
    maskBrush: { ...DEFAULT_BRUSH },
  });
  resetPreviewWarnings();
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  act(() => useUiStore.getState().closeDevelop());
  await useBookStore.getState().close();
  useAssetsStore.setState({ files: {} });
});

describe('AI masks', () => {
  it('adds the component at once when its raster is cached (stamped from the registry)', async () => {
    open();
    pick('Sky');
    await waitFor(() => expect(masks()).toHaveLength(1));
    expect(mocks.generate).not.toHaveBeenCalled();
    const [hash, [checked]] = mocks.status.mock.calls[0] ?? [];
    expect(hash).toBe('hash-f1');
    expect(checked).toMatchObject({ kind: 'ai', target: 'sky', model: 'skywater-seg', modelVersion: '2' });
    const c = masks()[0]?.components[0];
    expect(c).toMatchObject({ kind: 'ai', target: 'sky', model: 'skywater-seg', modelVersion: '2', prompts: [] });
    expect(masks()[0]?.name).toBe('Mask 1');
    expect(useUiStore.getState().developMaskTool).toMatchObject({ maskId: masks()[0]?.id, componentId: c?.id });
    expect(steps()).toBe(1);
  });

  it('generates a missing raster under a busy row, then adds the stamped component', async () => {
    mocks.status.mockResolvedValue([false]);
    const pending = deferred<AiMaskResult>();
    mocks.generate.mockImplementation(async () => pending.promise);
    open();
    pick('Subject');
    const busy = await screen.findByRole('status', { name: 'AI mask in progress' });
    expect(busy.textContent).toMatch(/Finding the subject… starting/);
    expect(screen.getByTestId('ai-generating')).toBeTruthy();
    const [folder, relPath, hash, geometry, sent, job] = mocks.generate.mock.calls[0] ?? [];
    expect([folder, relPath, hash]).toEqual(['/photos', 'fixture/f1.jpg', 'hash-f1']);
    expect(geometry).toMatchObject({ rotate: 0 });
    // Not committed before its raster exists; model and version left for the command to stamp.
    expect(masks()).toEqual([]);
    expect(sent).toMatchObject({ kind: 'ai', target: 'subject', model: '', modelVersion: '' });
    act(() => mocks.progress.handler?.({ job, stage: 'loading' }));
    expect(busy.textContent).toMatch(/loading model/);
    act(() => mocks.progress.handler?.({ job, stage: 'refining' }));
    expect(busy.textContent).toMatch(/refining/);
    await act(async () => pending.resolve(result(sent)));
    await waitFor(() => expect(masks()).toHaveLength(1));
    expect(masks()[0]?.components[0]).toMatchObject({ target: 'subject', model: 'birefnet-lite', modelVersion: '1' });
    expect(screen.queryByRole('status', { name: 'AI mask in progress' })).toBeNull();
    expect(screen.queryByTestId('ai-generating')).toBeNull();
  });

  it('Cancel abandons the job: the result is dropped', async () => {
    mocks.status.mockResolvedValue([false]);
    const pending = deferred<AiMaskResult>();
    mocks.generate.mockImplementation(async () => pending.promise);
    open();
    pick('Sky');
    const busy = await screen.findByRole('status', { name: 'AI mask in progress' });
    fireEvent.click(within(busy).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('status', { name: 'AI mask in progress' })).toBeNull();
    const sent = mocks.generate.mock.calls[0]?.[4];
    await act(async () => pending.resolve(result(sent)));
    expect(masks()).toEqual([]);
  });

  it('shows errors inline', async () => {
    mocks.status.mockResolvedValue([false]);
    mocks.generate.mockRejectedValue('offline: no network');
    open();
    pick('Sky');
    expect((await screen.findByRole('alert')).textContent).toMatch(/offline: no network/);
    expect(masks()).toEqual([]);
  });

  it('asks to download a missing model, downloads it, then generates again', async () => {
    mocks.status.mockResolvedValue([false]);
    const missing: AiModelInfo = {
      name: 'skywater-seg',
      title: 'SkyWater-Seg',
      version: '2',
      bytes: 42_000_000,
      licence: 'MIT',
      licenceUrl: 'https://example.org/licence',
      status: { state: 'missing' },
    };
    mocks.generate
      .mockImplementationOnce(async (...args: unknown[]) => ({
        ...result(args[4] as DevelopMaskComponent),
        path: null,
        missingModels: [missing],
      }))
      .mockImplementation(async (...args: unknown[]) => result(args[4] as DevelopMaskComponent));
    mocks.download.mockImplementation(async (name: string) => ({ name, version: '2', status: { state: 'installed' } }));
    open();
    pick('Sky');
    const dialog = await screen.findByRole('dialog', { name: 'Download the models for Sky' });
    expect(within(dialog).getByRole('listitem', { name: 'SkyWater-Seg' }).textContent).toMatch(/42\.0 MB/);
    expect(within(dialog).getByRole('button', { name: 'SkyWater-Seg licence: MIT' })).toBeTruthy();
    expect(dialog.textContent).toMatch(/Total: 42\.0 MB/);
    expect(masks()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
    expect(mocks.download).toHaveBeenCalledWith('skywater-seg', expect.any(Number));
    await waitFor(() => expect(masks()).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: 'Download the models for Sky' })).toBeNull();
    expect(mocks.listModels).toHaveBeenCalledTimes(2);
  });

  it('Cancel in the download prompt drops the job', async () => {
    mocks.status.mockResolvedValue([false]);
    mocks.generate.mockImplementation(async (...args: unknown[]) => ({
      ...result(args[4] as DevelopMaskComponent),
      missingModels: [
        {
          name: 'depth-anything-v2-small',
          title: 'Depth Anything V2 Small',
          version: '1',
          bytes: 99_000_000,
          licence: 'Apache-2.0',
          licenceUrl: '',
          status: { state: 'missing' },
        },
      ],
    }));
    open();
    pick('Depth range');
    const dialog = await screen.findByRole('dialog', { name: 'Download the models for Depth range' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: /Download the models/ })).toBeNull();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(masks()).toEqual([]);
  });

  it('People with several people offers one component per person (one undo step)', async () => {
    mocks.status.mockResolvedValue([false]);
    const boxes: [[number, number], [number, number]][] = [
      [
        [0.1, 0.2],
        [0.3, 0.9],
      ],
      [
        [0.6, 0.2],
        [0.8, 0.9],
      ],
    ];
    mocks.generate.mockImplementation(async (...args: unknown[]) =>
      result(args[4] as DevelopMaskComponent, { people: boxes }),
    );
    open();
    pick('People');
    const offer = await screen.findByRole('group', { name: 'People' });
    expect(offer.textContent).toMatch(/Found 2 people/);
    expect(within(offer).getByRole('button', { name: 'All people' }).getAttribute('aria-pressed')).toBe('true');
    expect(masks()[0]?.components).toHaveLength(1);
    const before = steps();
    fireEvent.click(within(offer).getByRole('button', { name: 'One per person' }));
    await waitFor(() => expect(masks()[0]?.components).toHaveLength(2));
    expect(mocks.refine).toHaveBeenCalledTimes(2);
    const sent = mocks.refine.mock.calls.map((c) => c[4]);
    expect(sent[0]).toMatchObject({ target: 'people', prompts: [{ kind: 'box', box: boxes[0], positive: true }] });
    expect(sent[1]).toMatchObject({ prompts: [{ kind: 'box', box: boxes[1], positive: true }] });
    expect(masks()[0]?.components[0]).toMatchObject({ model: 'sam2.1-tiny-encoder' });
    const list = screen.getByRole('list', { name: 'Components' });
    expect(within(list).getByRole('button', { name: 'Person 1' })).toBeTruthy();
    expect(within(list).getByRole('button', { name: 'Person 2' })).toBeTruthy();
    expect(steps()).toBe(before + 1);
    undo();
    expect(masks()[0]?.components).toHaveLength(1);
  });

  it('adds an AI component into the selected mask through Subtract', async () => {
    seed(stamp(newAi('subject')) as AiComponent);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Mask 1' }));
    const detail = screen.getByRole('group', { name: 'Mask Mask 1' });
    pick('Sky', 'Subtract', detail);
    await waitFor(() => expect(masks()[0]?.components).toHaveLength(2));
    expect(masks()[0]?.components[1]).toMatchObject({ kind: 'ai', target: 'sky', mode: 'subtract' });
    expect(masks()).toHaveLength(1);
  });

  it('Refine: click adds a positive point, Alt-click a negative one, a drag a box; Delete takes the last back', async () => {
    const m = seed(stamp(newAi('subject')) as AiComponent);
    open();
    selectComponent('Subject');
    fireEvent.click(screen.getByRole('button', { name: 'Refine' }));
    expect(useUiStore.getState().developMaskTool).toMatchObject({ tool: 'refine', maskId: m.id });

    press(...at(0.5, 0.5));
    await waitFor(() => expect(mocks.refine).toHaveBeenCalledTimes(1));
    expect(mocks.refine.mock.calls[0]?.[4]).toMatchObject({
      target: 'subject',
      prompts: [{ kind: 'point', point: [0.5, 0.5], positive: true }],
    });
    await waitFor(() => expect(masks()[0]?.components[0]).toMatchObject({ model: 'sam2.1-tiny-encoder' }));
    const c = masks()[0]?.components[0];
    expect(c?.kind === 'ai' && c.prompts).toHaveLength(1);

    press(...at(0.25, 0.5), { altKey: true });
    await waitFor(() => expect(mocks.refine).toHaveBeenCalledTimes(2));
    expect(mocks.refine.mock.calls[1]?.[4].prompts[1]).toMatchObject({ kind: 'point', positive: false });

    const [x0, y0] = at(0.1, 0.1);
    const [x1, y1] = at(0.4, 0.6);
    fireEvent.pointerDown(tools(), { pointerId: 1, button: 0, clientX: x1, clientY: y1 });
    fireEvent.pointerMove(tools(), { pointerId: 1, clientX: x0, clientY: y0 });
    expect(screen.getByTestId('refine-box')).toBeTruthy();
    fireEvent.pointerUp(tools(), { pointerId: 1, clientX: x0, clientY: y0 });
    await waitFor(() => expect(mocks.refine).toHaveBeenCalledTimes(3));
    const box = mocks.refine.mock.calls[2]?.[4].prompts[2];
    expect(box.kind).toBe('box');
    expect(box.positive).toBe(true);
    expect(box.box[0][0]).toBeCloseTo(0.1);
    expect(box.box[0][1]).toBeCloseTo(0.1);
    expect(box.box[1][0]).toBeCloseTo(0.4);
    expect(box.box[1][1]).toBeCloseTo(0.6);
    await waitFor(() => {
      const now = masks()[0]?.components[0];
      expect(now?.kind === 'ai' && now.prompts).toHaveLength(3);
    });
    const marks = screen.getByTestId('refine-prompts');
    expect(marks.querySelectorAll('[data-prompt="positive"]')).toHaveLength(1);
    expect(marks.querySelectorAll('[data-prompt="negative"]')).toHaveLength(1);
    expect(marks.querySelectorAll('[data-prompt="box"]')).toHaveLength(1);

    key('Delete');
    await waitFor(() => expect(mocks.refine).toHaveBeenCalledTimes(4));
    expect(mocks.refine.mock.calls[3]?.[4].prompts).toHaveLength(2);
    // The component stays (Delete does not remove it while refining).
    await waitFor(() => {
      const now = masks()[0]?.components[0];
      expect(now?.kind === 'ai' && now.prompts).toHaveLength(2);
    });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('hides the stale tint of a mask being refined', async () => {
    seed(stamp(newAi('subject')) as AiComponent);
    const pending = deferred<AiMaskResult>();
    mocks.refine.mockImplementation(async () => pending.promise);
    open();
    selectComponent('Subject');
    fireEvent.click(screen.getByRole('button', { name: 'Refine' }));
    await waitFor(() => expect(screen.getByTestId('mask-overlay').getAttribute('data-source')).toBe('rendered'));
    press(...at(0.5, 0.5));
    await waitFor(() => expect(screen.getByTestId('mask-overlay').getAttribute('data-source')).toBe('none'));
    expect(screen.getByTestId('ai-generating')).toBeTruthy();
    // The pending prompt already shows.
    expect(screen.getByTestId('refine-prompts').querySelectorAll('[data-prompt="positive"]')).toHaveLength(1);
    await act(async () => pending.resolve(result(mocks.refine.mock.calls[0]?.[4])));
    await waitFor(() => expect(screen.queryByTestId('ai-generating')).toBeNull());
  });

  it('the depth range slider updates depthRange without running a model', async () => {
    seed(stamp(newAi('depth')) as AiComponent);
    open();
    selectComponent('Depth range');
    expect(screen.getByText('Near ←')).toBeTruthy();
    const high = screen.getByRole('slider', { name: 'Depth range high' });
    expect(high.getAttribute('aria-valuenow')).toBe('0.35');
    fireEvent.keyDown(high, { key: 'ArrowRight', shiftKey: true });
    const c = masks()[0]?.components[0];
    expect(c?.kind === 'ai' && c.depthRange).toEqual([0, 0.45]);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.refine).not.toHaveBeenCalled();
  });

  it('offers Regenerate when the raster is missing on this computer, and replaces the component', async () => {
    const original = stamp(newAi('sky')) as AiComponent;
    seed(original);
    mocks.status.mockResolvedValue([false]);
    open();
    selectComponent('Sky');
    expect(await screen.findByText('Mask not generated on this computer')).toBeTruthy();
    mocks.status.mockResolvedValue([true]);
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate Sky' }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    expect(mocks.generate.mock.calls[0]?.[4]).toMatchObject({ id: original.id, target: 'sky' });
    await waitFor(() => expect(masks()[0]?.components[0]?.id).not.toBe(original.id));
    expect(masks()[0]?.components[0]).toMatchObject({ target: 'sky', model: 'skywater-seg', modelVersion: '2' });
    // The replacement stays selected; the note goes once the raster exists.
    expect(useUiStore.getState().developMaskTool?.componentId).toBe(masks()[0]?.components[0]?.id);
    await waitFor(() => expect(screen.queryByText('Mask not generated on this computer')).toBeNull());
  });

  it('offers Regenerate when the model has a newer version', async () => {
    seed({ ...(stamp(newAi('sky')) as AiComponent), modelVersion: '1' });
    open();
    selectComponent('Sky');
    expect(await screen.findByText('A newer model version is available')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate Sky' }));
    await waitFor(() => expect(masks()[0]?.components[0]).toMatchObject({ modelVersion: '2' }));
  });

  it('releases the AI mask models when the Develop view closes', () => {
    open();
    expect(mocks.release).not.toHaveBeenCalled();
    act(() => useUiStore.getState().closeDevelop());
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
