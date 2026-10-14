import type { DevelopLook } from '@photobook/shared';
import { useEffect } from 'react';
import { lookNameOf, useLooksStore } from '../../store/looks';

/**
 * Workflow plan 20: the name of the photo's look (the applied look, else its LUT) as a small badge across the top of a
 * filmstrip cell, shown while the pointer is over the cell (`group-hover`). Lists the looks once when a cell needs a name.
 */
export function LookBadge({ look }: { look: DevelopLook | undefined }) {
  const wanted = look?.applied != null;
  const loaded = useLooksStore((s) => s.loaded);
  const name = useLooksStore((s) => lookNameOf(s.saved, look));
  useEffect(() => {
    if (wanted && !loaded) void useLooksStore.getState().load();
  }, [wanted, loaded]);
  if (!name) return null;
  return (
    <span
      data-testid="look-badge"
      title={`Look: ${name}`}
      className="pointer-events-none absolute inset-x-6 top-1 truncate rounded-sm bg-stage/70 px-1 text-center text-[9px] text-fg leading-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {name}
    </span>
  );
}
