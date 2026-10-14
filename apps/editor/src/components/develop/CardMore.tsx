import type { DevelopSettings } from '@photobook/shared';
import { createContext, type ReactNode, useContext } from 'react';
import { Button } from '../ui/Button';
import { Tag } from '../ui/Tag';
import { cardMore } from './developCards';

/**
 * Plan 54: what the Develop panel's cards need to draw their ▸ parts: the Basic ⇄ Advanced switch
 * (`ui.developAdvanced`) and which ▸ are open in Basic (the panel's state, so a ▸ stays open while stepping through
 * photos). Without a provider (a section rendered on its own) every part shows, as in Advanced.
 */
export interface DevelopCardView {
  advanced: boolean;
  expanded: ReadonlySet<string>;
  toggle: (id: string) => void;
}

const CardViewContext = createContext<DevelopCardView>({ advanced: true, expanded: new Set(), toggle: () => {} });

export const CardViewProvider = CardViewContext.Provider;
export const useCardView = (): DevelopCardView => useContext(CardViewContext);

interface CardMoreProps {
  /** The part's id in the manifest (`developCards.ts`): its label and its `edited` test. */
  id: string;
  /** For the manifest's `edited` test; a part given `edited` itself (one mask component's) needs none. */
  settings?: DevelopSettings;
  /** Overrides the manifest's `edited`. */
  edited?: boolean;
  /** Classes of the opened content (default: a 12 px gap between controls). */
  className?: string;
  children: ReactNode;
}

/**
 * A card's ▸ part (ODDHALLS_LAYOUT_PLAN 4.1). Basic: a button with the part's label that opens it in place (the card
 * grows) and the `·edited` tag while any of its controls is off its default. Advanced: always open, the label as a
 * heading.
 */
export function CardMore({ id, settings, edited, className = 'space-y-3', children }: CardMoreProps) {
  const { advanced, expanded, toggle } = useCardView();
  const more = cardMore(id);
  const changed = edited ?? (settings ? more.edited(settings) : false);
  const open = advanced || expanded.has(id);
  return (
    <div data-more={id} className="space-y-2">
      {advanced ? (
        <p className="section-title pt-1">{more.label}</p>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          data-more-toggle=""
          aria-expanded={open}
          onClick={() => toggle(id)}
          title={open ? `Hide ${more.label.toLowerCase()}` : `Show ${more.label.toLowerCase()} here`}
          className="w-full px-1.5 text-left text-[11px]"
        >
          <svg
            viewBox="0 0 16 16"
            className={`size-3 shrink-0 text-fg-muted transition-transform duration-fast ${open ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="min-w-0 truncate">{more.label}</span>
          {changed && (
            <Tag tone="accent" className="ml-auto" title="A setting here is off its default">
              ·edited
            </Tag>
          )}
        </Button>
      )}
      {open && <div className={className}>{children}</div>}
    </div>
  );
}
