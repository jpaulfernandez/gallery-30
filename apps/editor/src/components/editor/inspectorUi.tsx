import type { ReactNode } from 'react';
import { FieldSurfaceContext, textFieldClass } from '../ui/Field';

/** Building blocks of the inspector panels. */

/**
 * One inspector section, a card like the Develop panel's (plan 48): `panel-2`, `md` radius (8 px), 8 px apart, with a
 * sentence-case title. The `components/ui` fields inside take the card look (`FieldSurfaceContext`).
 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mx-2 mt-2 rounded-md bg-panel-2 p-3 shadow-raised last:mb-2">
      <h3 className="section-title mb-2.5">{title}</h3>
      <FieldSurfaceContext.Provider value="card">
        <div className="space-y-3">{children}</div>
      </FieldSurfaceContext.Provider>
    </section>
  );
}

/** A row of a section: the label (`fg-2`) at the left, the control at the right. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-fg-2 text-xs">{label}</span>
      {children}
    </div>
  );
}

export const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** `<input type=color>` only takes #rrggbb. */
export function toHex6(color: string): string {
  if (/^#[0-9a-fA-F]{3,4}$/.test(color)) {
    const [r, g, b] = color.slice(1, 4);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{6}/.test(color)) return color.slice(0, 7).toLowerCase();
  return '#ffffff';
}

/**
 * A text field's look for the fields that cannot be `ui/Input` (a `<textarea>`, a field sized by its padding), from
 * `ui/Field`: the card surface (`panel`, one step under the `panel-2` cards, dialogs and sheets) without the fixed
 * 26 px height. Also used by the export sheets, the frame popovers and the alt text field.
 */
export const inputClass = textFieldClass('card', { fixedHeight: false });
