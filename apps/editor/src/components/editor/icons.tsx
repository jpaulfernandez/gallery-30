import type { ReactNode } from 'react';

function Icon({ children, className = 'size-4' }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const UndoIcon = () => (
  <Icon>
    <path d="M5.5 3.5L2.5 6.5l3 3" />
    <path d="M2.5 6.5h7a4 4 0 010 8H7" />
  </Icon>
);

export const RedoIcon = () => (
  <Icon>
    <path d="M10.5 3.5l3 3-3 3" />
    <path d="M13.5 6.5h-7a4 4 0 000 8H9" />
  </Icon>
);

export const RotateIcon = () => (
  <Icon>
    <path d="M13 8a5 5 0 11-1.5-3.6" />
    <path d="M13 2.5v2.5h-2.5" />
  </Icon>
);

export const ReplaceIcon = () => (
  <Icon>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M2.5 11l3.5-3.5 3 3 2-2 2.5 2.5" />
  </Icon>
);

export const MoveIcon = () => (
  <Icon>
    <path d="M8 1.5v13M1.5 8h13" />
    <path d="M6 3.5l2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2" />
  </Icon>
);

export const ExpandIcon = () => (
  <Icon>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" />
  </Icon>
);

export const TrashIcon = () => (
  <Icon>
    <path d="M2.5 4.5h11M6.5 4.5v-2h3v2M4 4.5l.7 9h6.6l.7-9" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon className="size-5">
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const MoreIcon = () => (
  <Icon className="size-3.5">
    <circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
    <circle cx="8" cy="8" r="0.6" fill="currentColor" />
    <circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
  </Icon>
);

export const TextIcon = () => (
  <Icon>
    <path d="M3.5 4V3h9v1" />
    <path d="M8 3v10" />
    <path d="M6 13h4" />
  </Icon>
);

export const LayoutIcon = ({ className = 'size-3.5' }: { className?: string }) => (
  <Icon className={className}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
    <path d="M2.5 9h11M8 2.5V9" />
  </Icon>
);

export const CursorIcon = () => (
  <Icon>
    <path d="M3.5 2.5l9 5-4 1-2 4z" />
  </Icon>
);

export const FrameIcon = () => (
  <Icon>
    <path d="M4.5 1.5v13M11.5 1.5v13M1.5 4.5h13M1.5 11.5h13" />
  </Icon>
);

export const MergeIcon = () => (
  <Icon>
    <rect x="2" y="2" width="12" height="12" rx="1" />
    <path d="M8 2v3.5M8 10.5V14M5.5 8h5M8.5 6.5L10 8l-1.5 1.5M7.5 6.5L6 8l1.5 1.5" />
  </Icon>
);

/** Split with a horizontal cut: top and bottom frames. */
export const SplitRowsIcon = () => (
  <Icon>
    <rect x="2.5" y="2" width="11" height="5" rx="0.75" />
    <rect x="2.5" y="9" width="11" height="5" rx="0.75" />
  </Icon>
);

/** Split with a vertical cut: left and right frames. */
export const SplitColumnsIcon = () => (
  <Icon>
    <rect x="2" y="2.5" width="5" height="11" rx="0.75" />
    <rect x="9" y="2.5" width="5" height="11" rx="0.75" />
  </Icon>
);

export const LockIcon = ({ open = false }: { open?: boolean }) => (
  <Icon className="size-3.5">
    <rect x="3.5" y="7" width="9" height="7" rx="1" />
    <path d={open ? 'M5.5 7V5a2.5 2.5 0 014.9-.7' : 'M5.5 7V5a2.5 2.5 0 015 0v2'} />
  </Icon>
);

export const GridIcon = () => (
  <Icon>
    <rect x="2" y="2" width="5" height="5" rx="0.75" />
    <rect x="9" y="2" width="5" height="5" rx="0.75" />
    <rect x="2" y="9" width="5" height="5" rx="0.75" />
    <rect x="9" y="9" width="5" height="5" rx="0.75" />
  </Icon>
);
