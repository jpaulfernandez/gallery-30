/** Line icons for the social controls (24 px grid, `currentColor`). */

type IconName = 'heart' | 'download' | 'share' | 'plus' | 'check' | 'stack' | 'close' | 'photo';

const PATHS: Record<IconName, string> = {
  heart: 'M12 20.5s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.5 2.8c0 5.5-7.5 10.1-7.5 10.1z',
  download: 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14',
  share: 'M12 15V3.5m0 0L8 7.5M12 3.5l4 4M8.5 11H6.5v9.5h11V11h-2',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  stack: 'M7 4.5h12.5V17M4.5 7h12.5v12.5H4.5z',
  close: 'M6 6l12 12M18 6L6 18',
  photo: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4',
};

export function Icon({ name, size = 22, filled = false }: { name: IconName; size?: number; filled?: boolean }) {
  return (
    <svg class="pv-icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        d={PATHS[name]}
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
