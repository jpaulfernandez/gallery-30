import type { ReactNode } from 'react';

/** Building blocks of the inspector panels. */

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-line border-b px-3 py-3">
      <h3 className="label mb-2">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-fg-muted text-xs">{label}</span>
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

export const inputClass =
  'rounded-md border border-line bg-panel-2 px-2 py-1 text-fg text-xs outline-none focus:border-accent';
