import type { CaptionFix, CaptionVariant, ElementCaptionResult } from '../../lib/jobs/aiCaption';

/**
 * The Write popover's state machine (workflow plan 34), pure so it is tested without React:
 *
 * closed ─open→ loading ─ok→ ready ─fix→ loading (keeps the variants on screen, dimmed)
 *                  │  └refused→ refused (the text box is untouched)
 *                  └error→ error           ─retry→ loading
 * nokey (no API key) and every state ─close→ closed. A result that arrives after close, or for an older request, is
 * ignored (`request` numbers them).
 */

export interface WriteMeta {
  model: string;
  servedBy: string;
  fellBack: boolean;
  usd: number;
}

export type WriteState =
  | { phase: 'closed'; request: number }
  | { phase: 'nokey'; request: number }
  | { phase: 'loading'; request: number; fix?: CaptionFix; variants: CaptionVariant[] }
  | { phase: 'ready'; request: number; variants: CaptionVariant[]; meta: WriteMeta }
  | { phase: 'refused'; request: number; message: string; variants: CaptionVariant[] }
  | { phase: 'error'; request: number; message: string; variants: CaptionVariant[] };

export type WriteEvent =
  | { type: 'nokey' }
  /** Request number `request` starts (the first, a chip, or Try again); numbers only grow. */
  | { type: 'request'; request: number; fix?: CaptionFix }
  | { type: 'result'; request: number; result: ElementCaptionResult }
  | { type: 'close' };

export const INITIAL_WRITE: WriteState = { phase: 'closed', request: 0 };

const variantsOf = (state: WriteState): CaptionVariant[] => ('variants' in state ? state.variants : []);

export function writeReducer(state: WriteState, event: WriteEvent): WriteState {
  switch (event.type) {
    case 'nokey':
      return { phase: 'nokey', request: state.request };
    case 'request':
      return {
        phase: 'loading',
        request: event.request,
        variants: variantsOf(state),
        ...(event.fix ? { fix: event.fix } : {}),
      };
    case 'close':
      return { phase: 'closed', request: state.request };
    case 'result': {
      if (state.phase !== 'loading' || event.request !== state.request) return state;
      const { result } = event;
      const variants = state.variants;
      switch (result.status) {
        case 'ok':
          return {
            phase: 'ready',
            request: state.request,
            variants: result.variants,
            meta: { model: result.model, servedBy: result.servedBy, fellBack: result.fellBack, usd: result.usd },
          };
        case 'refused':
          return { phase: 'refused', request: state.request, message: result.message, variants };
        case 'error':
          return { phase: 'error', request: state.request, message: result.message, variants };
        case 'cancelled':
          return { phase: 'error', request: state.request, message: 'Stopped before the captions came.', variants };
      }
    }
  }
  return state;
}

/** The previous captions a fix-up tells the model not to repeat. */
export const previousTexts = (state: WriteState): string[] => variantsOf(state).map((v) => v.text);
