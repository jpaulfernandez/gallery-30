import {
  findOutput,
  frameCapMessage,
  locatePage,
  SOCIAL_TEMPLATES,
  type SocialNetwork,
  uniqueOutputName,
} from '@photobook/shared';
import { create } from 'zustand';
import { useBookStore } from '../../store/book';
import { postFull } from '../../store/outputs';
import { useUiStore } from '../../store/ui';
import { showToast } from '../editor/Toast';

/**
 * Social post actions with their messages (workflow plan 14): the book store refuses a frame over the network's limit
 * (`postFull`) and these say why in the canvas toast; a page sent to a post says where it went, with Show.
 */

/** Open document `outputId` on the Design stage at frame `index` (hash routes, like Open in preview). */
export function showPostFrame(outputId: string, index: number): void {
  const projectId = useBookStore.getState().projectId;
  if (!projectId) return;
  useUiStore.setState((s) => ({
    design: { ...s.design, pageIndexes: { ...s.design.pageIndexes, [outputId]: index } },
  }));
  if (useUiStore.getState().design.outputId === outputId) useUiStore.getState().setPageIndex(index);
  else window.location.hash = `#/project/${projectId}/design/${outputId}`;
}

/** Add a blank frame to post `outputId` and show it; at the limit, say so. Returns the new frame's id. */
export function addFrameToPost(outputId: string): string | null {
  const book = useBookStore.getState().book;
  const output = book ? findOutput(book, outputId) : undefined;
  if (!book || output?.kind !== 'social') return null;
  if (postFull(book, outputId)) {
    showToast(frameCapMessage(output.network));
    return null;
  }
  const id = useBookStore.getState().addPostFrame(outputId);
  const frames = findOutput(useBookStore.getState().book ?? book, outputId);
  if (id && frames?.kind === 'social') useUiStore.getState().setPageIndex(frames.frames.length - 1);
  return id;
}

/** Copy page `pageId` to the end of post `outputId`; the toast says where it went (Show opens it). */
export function sendPageToPost(pageId: string, outputId: string): string | null {
  const book = useBookStore.getState().book;
  const output = book ? findOutput(book, outputId) : undefined;
  if (!book || output?.kind !== 'social') return null;
  if (postFull(book, outputId)) {
    showToast(frameCapMessage(output.network));
    return null;
  }
  const id = useBookStore.getState().sendPageToOutput(pageId, outputId);
  if (!id) return null;
  const index = output.frames.length;
  showToast(`Sent to “${output.name}” as frame ${index + 1}`, {
    action: { label: 'Show', run: () => showPostFrame(outputId, index) },
  });
  return id;
}

/** Make a new post on `network` whose first frame is page `pageId`, and say so. Returns the post's id. */
export function sendPageToNewPost(pageId: string, network: SocialNetwork): string | null {
  const book = useBookStore.getState().book;
  if (!book || !locatePage(book, pageId)) return null;
  const name = uniqueOutputName(book, SOCIAL_TEMPLATES[network].label);
  const id = useBookStore.getState().addOutput('social', name, { network, firstPage: pageId });
  if (id) {
    showToast(`Sent to the new post “${name}”`, { action: { label: 'Show', run: () => showPostFrame(id, 0) } });
  }
  return id;
}

/** The Send page to post dialog: which page it sends (null: closed). */
export const useSendPageStore = create<{ pageId: string | null }>()(() => ({ pageId: null }));

export function openSendPage(pageId: string): void {
  useSendPageStore.setState({ pageId });
}

export function closeSendPage(): void {
  useSendPageStore.setState({ pageId: null });
}
