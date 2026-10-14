import { locatePage, SOCIAL_NETWORKS, SOCIAL_TEMPLATES, type SocialOutput, socialTemplate } from '@photobook/shared';
import { useState } from 'react';
import { useBookStore } from '../../store/book';
import { buttonClass as buttonLook } from '../ui/Button';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { closeSendPage, sendPageToNewPost, sendPageToPost, useSendPageStore } from './postActions';

// Plan 45: the look of a `Button` (components/ui) on these plain buttons.
const rowClass = `${buttonLook({ size: 'md' })} w-full gap-2 text-left`;

/**
 * Send page to post… (workflow plan 14), from the page strip's menu and the page inspector: the project's posts
 * (except the one the page is in) with their network and frame count, full ones greyed, or a new post on a network.
 * The page is copied to the end of the post, re-fitted to its page size (`sendPageToOutput`). Mounted once by the
 * page strip; opened with `openSendPage(pageId)`.
 */
export function SendPageDialog() {
  const pageId = useSendPageStore((s) => s.pageId);
  if (!pageId) return null;
  return <SendPageDialogOpen pageId={pageId} />;
}

function SendPageDialogOpen({ pageId }: { pageId: string }) {
  const book = useBookStore((s) => s.book);
  const [picking, setPicking] = useState(false);
  const at = book ? locatePage(book, pageId) : undefined;
  if (!book || !at) return null;
  const posts = book.outputs.filter((o): o is SocialOutput => o.kind === 'social' && o.id !== at.outputId);
  const pageLabel = `${at.outputId === 'book' ? 'page' : 'frame'} ${at.index + 1}`;

  const done = (id: string | null) => {
    if (id) closeSendPage();
  };

  return (
    <DialogShell title={`Send ${pageLabel} to a post`} onClose={closeSendPage} widthClass="w-[24rem]">
      <DialogBody>
        {picking ? (
          <div className="flex flex-col gap-1">
            <p className="text-fg-muted">A new post for</p>
            {SOCIAL_NETWORKS.map((network, i) => {
              const t = SOCIAL_TEMPLATES[network];
              return (
                <button
                  key={network}
                  type="button"
                  className={rowClass}
                  {...(i === 0 ? { 'data-autofocus': true } : {})}
                  onClick={() => done(sendPageToNewPost(pageId, network))}
                >
                  <span className="truncate">{t.label}</span>
                  <span className="ml-auto shrink-0 text-fg-muted tabular-nums">
                    {t.ratio} · {t.maxFrames} max
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {posts.length === 0 && <p className="text-fg-muted">This project has no post yet.</p>}
            {posts.map((post, i) => {
              const t = socialTemplate(post.network);
              const full = post.frames.length >= t.maxFrames;
              return (
                <button
                  key={post.id}
                  type="button"
                  className={rowClass}
                  disabled={full}
                  title={full ? `A ${t.label} post holds up to ${t.maxFrames} frames` : undefined}
                  {...(i === 0 ? { 'data-autofocus': true } : {})}
                  onClick={() => done(sendPageToPost(pageId, post.id))}
                >
                  <span className="truncate">{post.name}</span>
                  <span className="ml-auto shrink-0 text-fg-muted tabular-nums">
                    {t.ratio} · {post.frames.length}/{t.maxFrames}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              className={rowClass}
              {...(posts.length === 0 ? { 'data-autofocus': true } : {})}
              onClick={() => setPicking(true)}
            >
              New post…
            </button>
          </div>
        )}
      </DialogBody>
      <DialogFooter note="The page is copied and fitted to the post's size.">
        {picking && <DialogButton onClick={() => setPicking(false)}>Back</DialogButton>}
        <DialogButton onClick={closeSendPage}>Cancel</DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}
