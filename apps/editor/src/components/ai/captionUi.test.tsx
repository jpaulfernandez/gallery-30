// @vitest-environment jsdom
import { type Book, createEmptyBook, createEmptyPage, emptyLibrary } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCaptionRequest, AiImageRef } from '../../lib/tauri';
import { useAiStore } from '../../store/ai';
import { useBookStore } from '../../store/book';
import { resetJobs } from '../../store/jobs';

const mocks = vi.hoisted(() => ({
  aiCaption: vi.fn(),
  aiDescribe: vi.fn(),
  aiCancel: vi.fn(async () => true),
  readAiSettings: vi.fn(),
  readLibrary: vi.fn(async () => null),
  readLibraryBackup: vi.fn(async () => null),
  photoCaptureInfo: vi.fn(async () => []),
}));
vi.mock('../../lib/tauri', () => ({ ...mocks }));

const { CaptionBookDialogHost, openCaptionBook, useCaptionBookDialog } = await import('./CaptionBookDialog');
const { CaptionPageSheetHost, openCaptionPage, useCaptionPageSheet } = await import('./CaptionPageSheet');
const { useBookCaptions } = await import('../../lib/jobs/aiBookCaption');

type El = Book['pages'][number]['elements'][number];
const PATH = '/photos/lisbon';
const hashOf = (n: number) => n.toString(16).padStart(64, '0');
const usage = { inputTokens: 1200, outputTokens: 400, cacheCreationInputTokens: 0, cacheReadInputTokens: 1800 };
const meta = {
  model: 'claude-opus-5-5',
  servedBy: 'claude-opus-5-5',
  fellBack: false,
  usage,
  attempts: [{ model: 'claude-opus-5-5', usage }],
};
const BRIEF = {
  about: 'A week in Lisbon with friends',
  photographer: '',
  placeTime: '',
  people: [],
  voice: 'editorial' as const,
  avoid: '',
  examples: [],
  useExisting: false,
};

function answer(request: AiCaptionRequest) {
  const pageMode = request.targets.includes('page');
  return {
    status: 'ok' as const,
    ...meta,
    captions: request.targets.map((target) => ({
      target,
      text: target === 'page' || !pageMode ? `New words for ${target}.` : '',
      alt: target === 'page' ? '' : `Alt of ${target}.`,
    })),
  };
}

/** Three pages with one photo and an empty caption slot each; page 2 has two photos and two slots. */
function seed() {
  const book = createEmptyBook({ title: 'Lisbon', folders: { F1: { path: PATH } } });
  book.assets = Object.fromEntries(
    [1, 2, 3, 4].map((n) => [
      `a${n}`,
      { path: `IMG_${n}.jpg`, hash: hashOf(n), folder: 'F1', width: 6000, height: 4000 },
    ]),
  ) as Book['assets'];
  const photo = (id: string, asset: string, x: number) =>
    ({
      type: 'photo',
      id,
      asset,
      frame: { x, y: 0.1, w: 0.4, h: 0.5 },
      crop: { x: 0, y: 0, scale: 1 },
      rotate: 0,
      filter: 'none',
    }) as El;
  const slot = (id: string, x: number, w = 0.4) =>
    ({ type: 'text', id, text: '', style: 'caption', frame: { x, y: 0.62, w, h: 0.05 }, align: 'left' }) as El;
  const p1 = createEmptyPage();
  p1.elements = [photo('e1', 'a1', 0.1), slot('t1', 0.1, 0.8)];
  const p2 = createEmptyPage();
  p2.elements = [photo('e2', 'a2', 0.05), photo('e3', 'a3', 0.55), slot('t2', 0.05), slot('t3', 0.55)];
  const p3 = createEmptyPage();
  p3.elements = [photo('e4', 'a4', 0.1), slot('t4', 0.1, 0.8)];
  book.pages = [p1, p2, p3];
  book.captions = { brief: BRIEF };
  useBookStore.setState({
    book,
    projectId: 'P1',
    folder: PATH,
    libraries: { [PATH]: emptyLibrary() },
    developVersion: null,
  });
  useBookStore.temporal.getState().clear();
}

const book = () => useBookStore.getState().book as Book;
const textOf = (id: string) => {
  for (const page of book().pages) {
    const el = page.elements.find((e) => e.id === id);
    if (el?.type === 'text') return el.text;
  }
  return undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
  useBookCaptions.getState().reset();
  useCaptionBookDialog.setState({ open: false });
  useCaptionPageSheet.setState({ pageId: null });
  mocks.aiCaption.mockImplementation(async (request: AiCaptionRequest) => answer(request));
  mocks.aiDescribe.mockImplementation(async (refs: AiImageRef[]) => ({
    status: 'ok',
    ...meta,
    entries: refs.map((r) => ({
      id: r.id,
      description: 'A street.',
      people: 1,
      setting: 'street',
      timeOfDay: 'evening',
      mood: 'calm',
    })),
    missing: [],
  }));
  useAiStore.setState({
    settings: {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      indexModel: 'claude-haiku-5-5',
      hasKey: true,
      keyHint: '…abcd',
    },
  });
  seed();
});

afterEach(() => cleanup());

describe('Caption book dialog', () => {
  it('shows the cost before anything is sent, then reviews every page before it lands', async () => {
    render(<CaptionBookDialogHost />);
    act(() => openCaptionBook());
    const dialog = await screen.findByRole('dialog', { name: 'Caption book' });
    expect(within(dialog).getByText(/A week in Lisbon with friends/)).toBeTruthy();
    expect(within(dialog).getByText('Pages without captions (3)', { exact: false })).toBeTruthy();
    const status = await within(dialog).findByRole('status');
    expect(status.textContent).toMatch(/First, describe 4 photos for the photo index: about [\d,]+ tokens/);
    expect(status.textContent).toMatch(
      /3 pages, one request each: about [\d,]+ tokens, roughly \$\d+\.\d\d on Claude Opus 5\.5/,
    );
    expect(mocks.aiCaption).not.toHaveBeenCalled();
    expect(mocks.aiDescribe).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Caption 3 pages' }));
    const pages = await screen.findByRole('list', { name: 'Pages' });
    await waitFor(() => expect(within(pages).getAllByRole('button', { name: 'Accept' })).toHaveLength(3));
    expect(mocks.aiDescribe).toHaveBeenCalledTimes(1);
    expect(mocks.aiCaption).toHaveBeenCalledTimes(3);
    // Page 2 fits its layout: one caption per photo, each into the slot under its photo.
    const page2 = within(pages).getByRole('listitem', { name: 'Page 2' });
    expect(within(page2).getByText('New words for Photo 2.')).toBeTruthy();
    expect(within(page2).getAllByText('→ Into the empty caption box')).toHaveLength(2);
    expect(textOf('t1')).toBe('');

    // Edit page 1, skip page 3, accept all.
    const page1 = within(pages).getByRole('listitem', { name: 'Page 1' });
    fireEvent.click(within(page1).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(page1).getByRole('textbox', { name: 'Caption: The page' }), {
      target: { value: 'We arrive.' },
    });
    fireEvent.click(within(page1).getByRole('button', { name: 'Done' }));
    fireEvent.click(
      within(within(pages).getByRole('listitem', { name: 'Page 3' })).getByRole('button', { name: 'Skip' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Accept all (2)' }));
    expect(textOf('t1')).toBe('We arrive.');
    expect(textOf('t2')).toBe('New words for Photo 2.');
    expect(textOf('t3')).toBe('New words for Photo 3.');
    expect(textOf('t4')).toBe('');
    expect(book().assets.a2?.alt).toBe('Alt of Photo 2.');
    expect(screen.getByRole('status').textContent).toMatch(/3 pages answered/);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before dropping pages not accepted, on Esc, Cancel and Close', async () => {
    render(<CaptionBookDialogHost />);
    act(() => openCaptionBook());
    const dialog = await screen.findByRole('dialog', { name: 'Caption book' });
    await within(dialog).findByText(/3 pages, one request each/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Caption 3 pages' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Accept' })).toHaveLength(3));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Caption book' }), { key: 'Escape' });
    expect(screen.getByRole('alert').textContent).toMatch(/Drop 3 pages you have not accepted\?/);
    fireEvent.click(screen.getByRole('button', { name: 'Keep reviewing' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Caption book' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Drop them' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(textOf('t1')).toBe('');
    expect(useBookCaptions.getState().status).toBe('idle');
  });

  it('warns before an all-pages run that would replace captions', async () => {
    useBookStore.setState((s) => {
      const el = s.book?.pages[0]?.elements.find((e) => e.id === 't1');
      if (el?.type === 'text') el.text = 'Mine already.';
    });
    render(<CaptionBookDialogHost />);
    act(() => openCaptionBook());
    const dialog = await screen.findByRole('dialog', { name: 'Caption book' });
    expect(within(dialog).queryByText(/captions already/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: /All pages with photos/ }));
    expect(within(dialog).getByText(/1 of these pages has captions already/)).toBeTruthy();
  });

  it('closes, and stays closed, when the project closes', async () => {
    render(<CaptionBookDialogHost />);
    act(() => openCaptionBook());
    await screen.findByRole('dialog', { name: 'Caption book' });
    act(() => useBookStore.setState({ book: null }));
    await waitFor(() => expect(useCaptionBookDialog.getState().open).toBe(false));
    act(() => seed());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the brief first when the project has none', () => {
    useBookStore.setState((s) => {
      if (s.book) s.book.captions = {};
    });
    render(<CaptionBookDialogHost />);
    act(() => openCaptionBook());
    expect(screen.queryByRole('dialog', { name: 'Caption book' })).toBeNull();
  });
});

describe('Caption this page', () => {
  const pageId = () => book().pages[1]?.id as string;

  it('sends nothing until Generate, reviews, and applies in one undo step', async () => {
    render(<CaptionPageSheetHost />);
    act(() => openCaptionPage(pageId()));
    const sheet = await screen.findByRole('dialog', { name: 'Caption this page · Page 2' });
    expect((within(sheet).getByRole('radio', { name: 'One caption per photo' }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(mocks.aiCaption).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Generate' }));
    await within(sheet).findByRole('button', { name: 'Apply' });
    const request = mocks.aiCaption.mock.calls[0]?.[0] as AiCaptionRequest;
    expect(request.images.map((i) => (i.kind === 'photo' ? i.hash : i.path))).toEqual([hashOf(2), hashOf(3)]);
    expect(request.options?.maxEdge).toBe(640);
    fireEvent.change(within(sheet).getByRole('textbox', { name: 'Caption: Photo 2 · IMG_2.jpg' }), {
      target: { value: 'Mine instead.' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Apply' }));
    expect(textOf('t2')).toBe('Mine instead.');
    expect(textOf('t3')).toBe('New words for Photo 3.');
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a refusal with its reason and changes nothing', async () => {
    mocks.aiCaption.mockResolvedValueOnce({
      status: 'refused',
      ...meta,
      message: 'The model declined this page: policy',
      reason: 'policy',
      category: null,
    });
    render(<CaptionPageSheetHost />);
    act(() => openCaptionPage(pageId()));
    const sheet = await screen.findByRole('dialog', { name: /Caption this page/ });
    fireEvent.click(within(sheet).getByRole('radio', { name: 'One caption for the page' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Generate' }));
    expect((await within(sheet).findByRole('alert')).textContent).toBe('The model declined this page: policy');
    expect(within(sheet).queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(textOf('t2')).toBe('');
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(0);
  });
});
