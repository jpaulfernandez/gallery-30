// @vitest-environment jsdom
import { type Book, createEmptyBook, createEmptyPage, emptyLibrary, serializeBook } from '@photobook/shared';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiStore } from '../../store/ai';
import { undo, useBookStore } from '../../store/book';
import { resetJobs } from '../../store/jobs';
import { bookForDisk } from '../../store/library';

const mocks = vi.hoisted(() => ({
  aiCaption: vi.fn(),
  aiCancel: vi.fn(async () => true),
  readAiSettings: vi.fn(),
  photoCaptureInfo: vi.fn(async (_folder: string, paths: string[]) =>
    paths.map((path) => ({ path, taken: '2026-06-03T10:00:00', lat: 38.71, lon: -9.14 })),
  ),
}));
vi.mock('../../lib/tauri', () => ({ ...mocks }));

const { WriteButton } = await import('./WritePopover');
const { BriefDialogHost, useBriefDialog } = await import('./BriefDialog');

type El = Book['pages'][number]['elements'][number];
const FOLDER = '/photos/lisbon';
const HASH = 'a'.repeat(64);
const usage = { inputTokens: 900, outputTokens: 300, cacheCreationInputTokens: 2000, cacheReadInputTokens: 0 };
const meta = {
  model: 'claude-opus-5-5',
  servedBy: 'claude-opus-5-5',
  fellBack: false,
  usage,
  attempts: [{ model: 'claude-opus-5-5', usage }],
};
const answer = (prefix = '') => ({
  status: 'ok',
  ...meta,
  captions: [
    { target: 'what', text: `${prefix}We wait for the 28 tram.`, alt: 'People at a tram stop.' },
    { target: 'where', text: `${prefix}Alfama, the evening light on the hill.`, alt: 'A street on a hill at dusk.' },
    { target: 'detail', text: `${prefix}A paper ticket in Ana’s hand.`, alt: 'A hand holding a ticket.' },
  ],
});

let pageId = '';

function seed(withBrief = false) {
  const book = createEmptyBook({ title: 'Lisbon', folders: { F1: { path: FOLDER } } });
  book.assets = { a1: { id: 'a1', path: 'IMG_1.jpg', hash: HASH, folder: 'F1' } } as unknown as Book['assets'];
  const page = createEmptyPage();
  page.elements = [
    {
      type: 'photo',
      id: 'e1',
      asset: 'a1',
      frame: { x: 0.1, y: 0.1, w: 0.8, h: 0.5 },
      crop: { x: 0, y: 0, scale: 1 },
      rotate: 0,
      filter: 'none',
    } as El,
    {
      type: 'text',
      id: 't1',
      text: 'Old caption here',
      style: 'caption',
      frame: { x: 0.1, y: 0.62, w: 0.8, h: 0.05 },
      align: 'left',
    } as El,
  ];
  book.pages = [page];
  if (withBrief) book.captions = { brief: { ...briefOf('Lisbon') } };
  pageId = page.id;
  useBookStore.setState({
    book,
    projectId: 'P1',
    folder: FOLDER,
    libraries: { [FOLDER]: emptyLibrary() },
    developVersion: null,
  });
  useBookStore.temporal.getState().clear();
}

const briefOf = (about: string) => ({
  about,
  photographer: '',
  placeTime: '',
  people: [],
  voice: 'editorial' as const,
  avoid: '',
  examples: [],
  useExisting: false,
});

const book = () => useBookStore.getState().book as Book;
const textOf = () => {
  const el = book().pages[0]?.elements.find((e) => e.id === 't1');
  return el?.type === 'text' ? el.text : null;
};

function Harness() {
  const element = useBookStore((s) => s.book?.pages[0]?.elements.find((e) => e.id === 't1'));
  return (
    <>
      {element?.type === 'text' && <WriteButton pageId={pageId} element={element} />}
      <BriefDialogHost />
    </>
  );
}

const writeButton = () => screen.getByRole('button', { name: /Write/ });
const popover = () => screen.getByRole('dialog', { name: 'Write a caption' });

beforeEach(() => {
  vi.clearAllMocks();
  resetJobs();
  mocks.aiCaption.mockResolvedValue(answer());
  useAiStore.setState({
    settings: {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      indexModel: 'claude-haiku-5-5',
      hasKey: true,
      keyHint: '…abcd',
    },
  });
  useBriefDialog.setState({ open: null });
});

afterEach(() => {
  cleanup();
  useBookStore.setState({ book: null, projectId: null, folder: null, libraries: {} });
});

describe('✦ Write', () => {
  it('opens the brief on the first Write, then writes; the second Write goes straight to the captions', async () => {
    seed();
    render(<Harness />);
    fireEvent.click(writeButton());
    const dialog = await screen.findByRole('dialog', { name: 'Caption brief' });
    expect(mocks.aiCaption).not.toHaveBeenCalled();
    // Where and when, from the photos' Exif.
    await waitFor(() =>
      expect((within(dialog).getByLabelText('Where and when?') as HTMLInputElement).value).toBe(
        'June 3, 2026; near 38.71° N, 9.14° W',
      ),
    );
    expect(within(dialog).getByText(/to Anthropic with your key, and to nobody else/)).toBeTruthy();
    // About is required.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and write' }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/what the book is about/);
    fireEvent.change(within(dialog).getByLabelText('What is this book about?'), {
      target: { value: 'A week in Lisbon with friends' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and write' }));
    expect(screen.queryByRole('dialog', { name: 'Caption brief' })).toBeNull();
    expect(book().captions.brief?.about).toBe('A week in Lisbon with friends');
    // The pre-fill left untouched keeps its dates, not the raw coordinates.
    expect(book().captions.brief?.placeTime).toBe('June 3, 2026');
    // The brief is project data: in the project file, not in the folder's library or the browser's storage.
    expect(serializeBook(bookForDisk(useBookStore.getState(), book(), FOLDER))).toContain('A week in Lisbon');
    expect(JSON.stringify(useBookStore.getState().libraries)).not.toContain('A week in Lisbon');
    expect(Object.values({ ...localStorage }).join('\n')).not.toContain('A week in Lisbon');

    await within(popover()).findByText('We wait for the 28 tram.');
    expect(within(popover()).getAllByRole('button', { name: 'Use' })).toHaveLength(3);
    expect(within(popover()).getByText(/Alt text: People at a tram stop\./)).toBeTruthy();
    expect(
      within(popover()).getByText(/to nobody else: the brief, the photo index and one photo preview/),
    ).toBeTruthy();
    const request = mocks.aiCaption.mock.calls[0]?.[0];
    expect(request.images).toEqual([{ id: 'a1', kind: 'photo', hash: HASH, developHash: null, label: 'Photo 1' }]);
    expect(request.system).toContain('- About: A week in Lisbon with friends');

    fireEvent.click(within(popover()).getByRole('button', { name: /Keep mine/ }));
    expect(screen.queryByRole('dialog', { name: 'Write a caption' })).toBeNull();
    expect(textOf()).toBe('Old caption here');

    fireEvent.click(writeButton());
    await within(popover()).findByText('We wait for the 28 tram.');
    expect(screen.queryByRole('dialog', { name: 'Caption brief' })).toBeNull();
    expect(mocks.aiCaption).toHaveBeenCalledTimes(2);
  });

  it('Use replaces the text and records the alt text in one undo step', async () => {
    seed(true);
    render(<Harness />);
    fireEvent.click(writeButton());
    await within(popover()).findByText('Alfama, the evening light on the hill.');
    const before = useBookStore.temporal.getState().pastStates.length;
    const cards = within(popover()).getAllByRole('listitem');
    fireEvent.click(within(cards[1] as HTMLElement).getByRole('button', { name: 'Use' }));
    expect(textOf()).toBe('Alfama, the evening light on the hill.');
    expect(book().assets.a1?.alt).toBe('A street on a hill at dusk.');
    expect(useBookStore.temporal.getState().pastStates.length).toBe(before + 1);
    expect(screen.queryByRole('dialog', { name: 'Write a caption' })).toBeNull();
    act(() => {
      undo();
    });
    expect(textOf()).toBe('Old caption here');
    expect(book().captions.brief?.about).toBe('Lisbon');
  });

  it('a chip asks again with its instruction and the captions on screen', async () => {
    seed(true);
    render(<Harness />);
    fireEvent.click(writeButton());
    await within(popover()).findByText('We wait for the 28 tram.');
    mocks.aiCaption.mockResolvedValueOnce(answer('Short: '));
    fireEvent.click(within(popover()).getByRole('button', { name: 'Shorter' }));
    await within(popover()).findByText('Short: We wait for the 28 tram.');
    const prompt = mocks.aiCaption.mock.calls[1]?.[0].prompt as string;
    expect(prompt).toContain('clearly shorter');
    expect(prompt).toContain('- "We wait for the 28 tram."');
  });

  it('a refusal shows the reason and keeps the text', async () => {
    seed(true);
    mocks.aiCaption.mockResolvedValue({
      status: 'refused',
      ...meta,
      message: 'The model declined this page: it shows a minor in a private setting',
      reason: 'it shows a minor in a private setting',
      category: null,
    });
    render(<Harness />);
    fireEvent.click(writeButton());
    expect((await within(popover()).findByRole('alert')).textContent).toBe(
      'The model declined this page: it shows a minor in a private setting',
    );
    expect(textOf()).toBe('Old caption here');
    expect(within(popover()).queryAllByRole('button', { name: 'Use' })).toHaveLength(0);
    expect(within(popover()).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(useBookStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('closing while it writes cancels the request through ai_cancel', async () => {
    seed(true);
    let resolve: (v: unknown) => void = () => {};
    mocks.aiCaption.mockImplementation(() => new Promise((r) => (resolve = r)));
    mocks.aiCancel.mockImplementation(async () => {
      resolve({ status: 'cancelled' });
      return true;
    });
    render(<Harness />);
    fireEvent.click(writeButton());
    await within(popover()).findByText(/Writing three captions/);
    await waitFor(() => expect(mocks.aiCaption).toHaveBeenCalled());
    fireEvent.click(within(popover()).getByRole('button', { name: /Keep mine/ }));
    await waitFor(() => expect(mocks.aiCancel).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: 'Write a caption' })).toBeNull();
    expect(textOf()).toBe('Old caption here');
  });

  it('a brief without what the book is about opens the dialog instead of writing', async () => {
    seed();
    useBookStore.setState((s) => {
      if (s.book) s.book.captions = { brief: {} as never };
    });
    render(<Harness />);
    fireEvent.click(writeButton());
    await screen.findByRole('dialog', { name: 'Caption brief' });
    expect(mocks.aiCaption).not.toHaveBeenCalled();
  });

  it('moves the focus into the popover, to the first Use when captions arrive, keeps Tab inside, and Escape returns it', async () => {
    seed(true);
    render(<Harness />);
    fireEvent.click(writeButton());
    const uses = await within(popover()).findAllByRole('button', { name: 'Use' });
    await waitFor(() => expect(document.activeElement).toBe(uses[0]));
    const buttons = [...popover().querySelectorAll<HTMLElement>('button:not([disabled])')];
    (buttons[buttons.length - 1] as HTMLElement).focus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Write a caption' })).toBeNull();
    expect(document.activeElement).toBe(writeButton());
  });

  it('keeps an alt text the photo already has', async () => {
    seed(true);
    useBookStore.setState((s) => {
      const asset = s.book?.assets.a1;
      if (asset) asset.alt = 'My own words.';
    });
    useBookStore.temporal.getState().clear();
    render(<Harness />);
    fireEvent.click(writeButton());
    await within(popover()).findByText('We wait for the 28 tram.');
    expect(within(popover()).getAllByText(/the photo keeps its own/)).toHaveLength(3);
    fireEvent.click(within(popover()).getAllByRole('button', { name: 'Use' })[0] as HTMLElement);
    expect(textOf()).toBe('We wait for the 28 tram.');
    expect(book().assets.a1?.alt).toBe('My own words.');
  });

  it('names the file when a photo has no preview yet', async () => {
    seed(true);
    mocks.aiCaption.mockRejectedValue('No preview yet for a1; open the photo once and try again');
    render(<Harness />);
    fireEvent.click(writeButton());
    expect((await within(popover()).findByRole('alert')).textContent).toBe(
      'No preview yet for IMG_1.jpg; open the photo once and try again',
    );
  });

  it('without a key it says where to add one and sends nothing', async () => {
    seed(true);
    const settings = useAiStore.getState().settings;
    if (settings) useAiStore.setState({ settings: { ...settings, hasKey: false } });
    render(<Harness />);
    fireEvent.click(writeButton());
    expect((await within(popover()).findByRole('alert')).textContent).toMatch(/Settings → AI/);
    expect(mocks.aiCaption).not.toHaveBeenCalled();
  });
});
