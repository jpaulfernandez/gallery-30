import type { ReactNode } from 'react';

export const PHONE_WIDTH = 393;
export const PHONE_HEIGHT = 852;
const BEZEL = 12;

/** An iPhone-proportioned frame: a 393 x 852 screen (47 px radius) inside a 12 px black bezel. No notch. */
export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="phone-frame"
      style={{
        width: PHONE_WIDTH + BEZEL * 2,
        height: PHONE_HEIGHT + BEZEL * 2,
        padding: BEZEL,
        borderRadius: 47 + BEZEL,
        background: '#000',
        boxShadow: '0 0 0 1px #333, 0 30px 80px rgba(0, 0, 0, 0.6)',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: PHONE_WIDTH,
          height: PHONE_HEIGHT,
          borderRadius: 47,
          overflow: 'hidden',
          isolation: 'isolate',
        }}
      >
        {children}
      </div>
    </div>
  );
}
