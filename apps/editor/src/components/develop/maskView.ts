import { create } from 'zustand';

/**
 * Whether the Develop preview should show the sharpening mask instead of the render: true while a Sharpening
 * slider is held down with Alt. Written by `DetailSection`, read by `useMaskPreview` (and so by the image area).
 */
export const useMaskView = create<{ active: boolean; setActive: (active: boolean) => void }>((set) => ({
  active: false,
  setActive: (active) => set((s) => (s.active === active ? s : { active })),
}));
