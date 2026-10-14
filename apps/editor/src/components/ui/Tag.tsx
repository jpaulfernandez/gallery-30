import type { ReactNode } from 'react';

/**
 * Plan 45: a tag or badge (ODDHALLS_UI_PLAN 4.1): 10 px mono uppercase, the one place uppercase is allowed (file-size
 * and `v2` tags, "Edited", "In the book"). `xs` radius on a 6 % wash; a tone colours the label.
 */
export type TagTone = 'default' | 'accent' | 'ok' | 'warn' | 'danger';

const TONE: Record<TagTone, string> = {
  default: '',
  accent: 'text-accent',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
};

export function Tag({
  children,
  tone = 'default',
  title,
  className = '',
}: {
  children: ReactNode;
  tone?: TagTone;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`tag inline-flex items-center rounded-xs bg-fg/6 px-1 py-px ${TONE[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
