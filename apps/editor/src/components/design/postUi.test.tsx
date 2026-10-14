// @vitest-environment jsdom
import { BOOK_OUTPUT_ID, pagesOf, type SocialOutput } from '@photobook/shared';
import { fixtureBook } from '@photobook/shared/fixtures';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { PostPanel } from './PostPanel';
import { openSendPage } from './postActions';
import { SafeAreaGuides } from './SafeAreaGuides';
import { SendPageDialog } from './SendPageDialog';

const post = (id: string) =>
  useBookStore.getState().book?.outputs.find((o): o is SocialOutput => o.id === id && o.kind === 'social');

beforeEach(() => {
  useBookStore.setState({ book: structuredClone(fixtureBook), folder: '/photos', projectId: 'P' });
  useBookStore.temporal.getState().clear();
  useUiStore.getState().reset();
});
afterEach(async () => {
  cleanup();
  await useBookStore.getState().close();
});

const openOutput = (outputId: string) => useUiStore.setState((s) => ({ design: { ...s.design, outputId } }));

describe('safe-area guides', () => {
  it('draw the network’s safe area on a story, nothing on the book or a network without one', () => {
    const story = useBookStore.getState().addOutput('social', 'Story', { network: 'instagram-story' }) ?? '';
    const threads = useBookStore.getState().addOutput('social', 'Thread', { network: 'threads' }) ?? '';
    useUiStore.setState({ showMargins: true });

    openOutput(story);
    const { rerender } = render(<SafeAreaGuides width={270} height={480} />);
    const rect = screen.getByTestId('safe-area-guides').querySelector('rect');
    // 250 px of 1920 on top: 62.5 px at 480 px high.
    expect(Number(rect?.getAttribute('y'))).toBeCloseTo((250 / 1920) * 480 + 0.5, 3);
    expect(screen.getByText('Instagram safe area')).toBeTruthy();

    act(() => openOutput(threads));
    rerender(<SafeAreaGuides width={270} height={337.5} />);
    expect(screen.queryByTestId('safe-area-guides')).toBeNull();

    act(() => openOutput(BOOK_OUTPUT_ID));
    rerender(<SafeAreaGuides width={270} height={337.5} />);
    expect(screen.queryByTestId('safe-area-guides')).toBeNull();
  });

  it('draw the Instagram grid crop on the first frame only', () => {
    const carousel = useBookStore.getState().addOutput('social', 'Carousel') ?? '';
    useUiStore.setState({ showMargins: true });
    act(() => openOutput(carousel));
    useUiStore.setState({ pageIndex: 0 });
    const { rerender } = render(<SafeAreaGuides width={270} height={337.5} />);
    expect(screen.getByTestId('safe-area-guides')).toBeTruthy();
    act(() => useUiStore.setState({ pageIndex: 1 }));
    rerender(<SafeAreaGuides width={270} height={337.5} />);
    expect(screen.queryByTestId('safe-area-guides')).toBeNull();
  });
});

describe('post panel', () => {
  it('shows the network, frame count and the caption against its limit', async () => {
    const id = useBookStore.getState().addOutput('social', 'Sky', { network: 'bluesky' }) ?? '';
    render(<PostPanel post={post(id) as SocialOutput} />);
    expect(screen.getByText('Bluesky')).toBeTruthy();
    expect(screen.getByText(/1 of 4 frames/)).toBeTruthy();
    const caption = screen.getByLabelText('Post caption');
    fireEvent.focus(caption);
    fireEvent.change(caption, { target: { value: 'x'.repeat(301) } });
    expect(screen.getByText(/301 \/ 300 · 1 over Bluesky's limit/)).toBeTruthy();
    fireEvent.blur(caption);
    expect(post(id)?.caption).toHaveLength(301);
  });
});

describe('send page dialog', () => {
  it('lists the posts with their frame counts and sends the page to the one picked', () => {
    const id = useBookStore.getState().addOutput('social', 'Carousel') ?? '';
    const pageId = useBookStore.getState().book?.pages[1]?.id ?? '';
    render(<SendPageDialog />);
    act(() => openSendPage(pageId));
    expect(screen.getByRole('dialog', { name: 'Send page 2 to a post' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Carousel.*1\/20/ }));
    expect(pagesOf(useBookStore.getState().book ?? fixtureBook, id)).toHaveLength(2);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('makes a new post on a network from the page', () => {
    const pageId = useBookStore.getState().book?.pages[0]?.id ?? '';
    render(<SendPageDialog />);
    act(() => openSendPage(pageId));
    fireEvent.click(screen.getByRole('button', { name: 'New post…' }));
    fireEvent.click(screen.getByRole('button', { name: /Pinterest pin/ }));
    const created = useBookStore.getState().book?.outputs[0];
    expect(created).toMatchObject({ kind: 'social', network: 'pinterest', name: 'Pinterest pin' });
    const frames = created?.kind === 'social' ? created.frames : [];
    expect(frames).toHaveLength(1);
    expect(frames[0]?.elements.map((e) => e.id)).toEqual(
      useBookStore.getState().book?.pages[0]?.elements.map((e) => e.id),
    );
  });
});
