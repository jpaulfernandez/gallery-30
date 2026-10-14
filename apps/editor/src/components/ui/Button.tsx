import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';

/**
 * Plan 45: the buttons of ODDHALLS_UI_PLAN 4.1. Every button in the editor is one of five variants in two sizes; a
 * component outside `components/ui` never writes its own button chrome again (`scripts/check-palette.mjs` fails on
 * the old `rounded-md border border-line` button).
 */

export type ButtonVariant = 'primary' | 'soft' | 'ghost' | 'danger' | 'toggle';
export type ButtonSize = 'sm' | 'md' | 'lg';
/** `pill` rounds the button fully (the zoom HUD); the default is the `sm` radius (6 px). */
export type ButtonShape = 'default' | 'pill';

/** The focus ring with a gap (`0 0 0 2px panel, 0 0 0 4px accent`), never a border colour change. */
export const focusRing =
  'outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent font-medium text-accent-ink hover:brightness-105 active:brightness-95',
  soft: 'bg-fg/6 text-fg hover:bg-fg/10 active:bg-fg/4',
  ghost: 'text-fg-2 hover:bg-fg/6 hover:text-fg active:bg-fg/4',
  danger: 'text-danger hover:bg-danger/12 active:bg-danger/8',
  toggle: 'bg-fg/6 text-fg hover:bg-fg/10 active:bg-fg/4',
};
/** A toggle that is on: the accent wash and the accent label. */
const TOGGLE_ON = 'bg-accent-soft text-accent hover:bg-accent-soft active:bg-accent-soft';

const SIZE: Record<ButtonSize, { text: string; square: string }> = {
  sm: { text: 'h-6 gap-1 px-2 text-xs', square: 'size-6' },
  md: { text: 'h-7 gap-1.5 px-3 text-[13px]', square: 'size-7' },
  /** Plan 48: the canvas toolbars' 32 px icon buttons. */
  lg: { text: 'h-8 gap-1.5 px-3 text-[13px]', square: 'size-8' },
};

/**
 * The classes of a button: for a `<Link>` or a popover trigger that must look like one. `iconOnly` makes it square.
 * Radius `sm` (6 px), or full with `shape: 'pill'`; a press moves it half a pixel down; disabled is 40 % with no hover.
 */
export function buttonClass({
  variant = 'soft',
  size = 'md',
  shape = 'default',
  pressed = false,
  iconOnly = false,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  pressed?: boolean;
  iconOnly?: boolean;
} = {}): string {
  const look = variant === 'toggle' && pressed ? TOGGLE_ON : VARIANT[variant];
  const box = iconOnly ? `${SIZE[size].square} justify-center` : SIZE[size].text;
  return `inline-flex shrink-0 items-center whitespace-nowrap ${shape === 'pill' ? 'rounded-pill' : 'rounded-sm'} transition-[background-color,color,filter,translate] duration-fast ease-out active:translate-y-[0.5px] disabled:pointer-events-none disabled:opacity-40 aria-disabled:pointer-events-none aria-disabled:opacity-40 ${focusRing} ${box} ${look}`;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  /** An icon before the label (alone, the button is square: use `IconButton` for that). */
  icon?: ReactNode;
  /** A `toggle` that is on (`aria-pressed`). */
  pressed?: boolean;
}

/** A button. `variant` defaults to `soft` (nearly every button), `size` to `md` (28 px). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'soft', size = 'md', shape, icon, pressed, className = '', type = 'button', children, ...rest },
  ref,
) {
  const toggle = variant === 'toggle';
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={toggle ? Boolean(pressed) : undefined}
      className={`${buttonClass({ variant, size, shape, pressed, iconOnly: children === undefined && icon !== undefined })} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children'> {
  icon: ReactNode;
  /** The accessible name, also the tooltip. */
  label: string;
  /** The key that does the same, shown in the tooltip in mono ("⌘Z"). */
  shortcut?: string;
}

/** A square icon button (`ghost` by default) with a tooltip naming it and its shortcut. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, shortcut, variant = 'ghost', ...rest },
  ref,
) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <Button ref={ref} variant={variant} icon={icon} aria-label={label} {...rest} />
    </Tooltip>
  );
});
