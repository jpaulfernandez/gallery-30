import { captionLength, type SocialOutput, socialTemplate } from '@photobook/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBookStore } from '../../store/book';
import { inputClass, Section } from '../editor/inspectorUi';
import { buttonClass as buttonLook } from '../ui/Button';
import { addFrameToPost, openSendPage } from './postActions';

// Plan 45: the look of a `Button` (components/ui) on these plain buttons.
const buttonClass = `${buttonLook({ size: 'sm' })} w-full justify-between text-left`;

/**
 * The inspector with nothing selected on a social post (workflow plan 14): the network and its limits, Add frame, and
 * the caption with the network's length limit (exported as `caption.txt`). Typing is committed after a pause, on blur
 * and when the post changes, so a burst is one undo step.
 */
export function PostPanel({ post }: { post: SocialOutput }) {
  const t = socialTemplate(post.network);
  const setCaption = useBookStore((s) => s.setPostCaption);
  const [draft, setDraft] = useState(post.caption);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(post.caption);
  }, [post.caption]);
  const postId = post.id;
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const value = pending.current;
    pending.current = null;
    if (value !== null) setCaption(postId, value);
  }, [postId, setCaption]);
  useEffect(() => flush, [flush]);

  const length = captionLength(draft);
  const over = length > t.captionLimit;
  const full = post.frames.length >= t.maxFrames;

  return (
    <>
      <Section title="Post">
        <div className="space-y-1 text-xs">
          <p className="text-fg">{t.label}</p>
          <p className="text-fg-muted tabular-nums">
            {t.width} × {t.height} px ({t.ratio}) · {post.frames.length} of {t.maxFrames} frames
          </p>
        </div>
        <button
          type="button"
          className={buttonClass}
          disabled={full}
          title={full ? `A ${t.label} post holds up to ${t.maxFrames} frames` : 'Add a blank frame at the end'}
          onClick={() => addFrameToPost(post.id)}
        >
          <span>Add frame</span>
          <span className="text-fg-muted">+</span>
        </button>
        <p className="text-[11px] text-fg-muted leading-relaxed">
          The shaded edges are the network's safe area. Limits checked {t.checked}.
        </p>
      </Section>
      <Section title="Caption">
        <textarea
          value={draft}
          onFocus={() => {
            editing.current = true;
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            pending.current = e.target.value;
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(flush, 500);
          }}
          onBlur={() => {
            editing.current = false;
            flush();
          }}
          rows={6}
          placeholder="The caption to post with it (exported as caption.txt)"
          aria-label="Post caption"
          aria-describedby="post-caption-count"
          className={`${inputClass} w-full resize-y select-text ${over ? 'border-danger' : ''}`}
        />
        <p
          id="post-caption-count"
          className={`text-right text-[11px] tabular-nums ${over ? 'text-danger' : 'text-fg-muted'}`}
        >
          {length} / {t.captionLimit}
          {over ? ` · ${length - t.captionLimit} over ${t.service}'s limit` : ''}
        </p>
      </Section>
    </>
  );
}

/** Send page to post… for the page on the canvas (the page inspector's entry; the page strip's menu has the other). */
export function SendToPostSection({ pageId }: { pageId: string }) {
  return (
    <Section title="Share">
      <button type="button" className={buttonClass} onClick={() => openSendPage(pageId)}>
        <span>Send page to post…</span>
      </button>
    </Section>
  );
}
