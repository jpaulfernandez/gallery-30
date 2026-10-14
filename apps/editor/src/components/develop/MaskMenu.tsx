import type { DevelopMask, DevelopMaskComponent } from '@photobook/shared';
import { useState } from 'react';
import {
  type ComponentMode,
  type LinearComponent,
  MASK_TOOL_LABEL,
  MASK_TOOLS,
  type MaskTool,
  maskDisplayName,
  newColor,
  newLuminance,
  type RadialComponent,
} from '../../lib/develop/masks';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { Input } from '../ui/Field';
import { Menu, MenuItem, MenuLabel, MenuSeparator, useContextMenu, useMenu } from '../ui/Menu';

/** What a mask right-click is on: a mask, or one component of it. */
export interface MaskMenuTarget {
  maskId: string;
  componentId?: string;
}

/** The state of the mask context menu (`Menu.Context` through `useContextMenu`). */
export const useMaskContextMenu = () => useContextMenu<MaskMenuTarget>();

/**
 * Start a new component in mask `maskId` with `mode`: the range kinds are created at once (and selected with their
 * tool); the drawing tools wait for a drag or a stroke on the photo. True when a range component was created.
 */
export function startComponent(assetId: string, maskId: string, mode: ComponentMode, kind: MaskTool): boolean {
  const ui = useUiStore.getState();
  if (kind === 'luminance' || kind === 'color') {
    const c = kind === 'luminance' ? newLuminance(undefined, mode) : newColor([], mode);
    useBookStore.getState().addMaskComponent(assetId, maskId, c);
    ui.setDevelopMaskTool({ maskId, componentId: c.id, tool: kind });
    return true;
  }
  ui.setDevelopMaskTool({ maskId, tool: kind, create: mode });
  return false;
}

/**
 * The other gradient in place of `c` (Convert to…), keeping its id, mode and invert: a linear becomes a radial
 * centred on its full end (`to`) reaching to its fading end, fully feathered so it fades the same way; a radial
 * becomes a linear full at its centre, fading out across its vertical radius. Null for the other kinds.
 */
export function convertGradient(c: DevelopMaskComponent): DevelopMaskComponent | null {
  if (c.kind === 'linear') {
    const r = Math.max(Math.hypot(c.from[0] - c.to[0], c.from[1] - c.to[1]), 0.01);
    const radial: RadialComponent = {
      id: c.id,
      mode: c.mode,
      invert: c.invert,
      kind: 'radial',
      center: [c.to[0], c.to[1]],
      radii: [r, r],
      angle: 0,
      feather: 100,
    };
    return radial;
  }
  if (c.kind === 'radial') {
    const linear: LinearComponent = {
      id: c.id,
      mode: c.mode,
      invert: c.invert,
      kind: 'linear',
      from: [c.center[0], c.center[1] + c.radii[1]],
      to: [c.center[0], c.center[1]],
    };
    return linear;
  }
  return null;
}

type View = 'main' | 'rename' | 'add' | 'convert';

export interface MaskContextMenuProps {
  assetId: string;
  masks: readonly DevelopMask[];
  menu: { x: number; y: number; data: MaskMenuTarget };
  onClose: () => void;
  /** A range component was created through *Add to this mask* (the Masks section opens its range ▸). */
  onRange?: () => void;
}

/**
 * Plan 56 (ODDHALLS_LAYOUT_PLAN 4.4): the right-click menu of a mask or of one of its components, on the mask rows,
 * the component rows and the picture under the mask tools. Delete · Duplicate · Invert · Rename… · Add to this mask ▸
 * (subtract / intersect, any tool) · Convert to… (linear ⇄ radial). Delete, Invert and Convert act on the component
 * when the menu is on one (Delete removes the mask with its last component); Duplicate and Rename act on the mask.
 * Every item is one undo step through the book store's discrete mask actions.
 */
export function MaskContextMenu({ assetId, masks, menu, onClose, onRange }: MaskContextMenuProps) {
  const index = masks.findIndex((m) => m.id === menu.data.maskId);
  const mask = masks[index];
  if (!mask) return null;
  return (
    <Menu.Context at={{ x: menu.x, y: menu.y }} label={`${maskDisplayName(mask, index)} actions`} onClose={onClose}>
      <MaskMenuItems assetId={assetId} mask={mask} index={index} target={menu.data} onRange={onRange} />
    </Menu.Context>
  );
}

function MaskMenuItems({
  assetId,
  mask,
  index,
  target,
  onRange,
}: {
  assetId: string;
  mask: DevelopMask;
  index: number;
  target: MaskMenuTarget;
  onRange?: () => void;
}) {
  const { close, focusFirst } = useMenu();
  const [view, setView] = useState<View>('main');
  const name = maskDisplayName(mask, index);
  const [draft, setDraft] = useState(name);
  const store = () => useBookStore.getState();
  const ui = () => useUiStore.getState();
  const component = target.componentId ? mask.components.find((c) => c.id === target.componentId) : undefined;
  const converted = component ? convertGradient(component) : null;
  const go = (next: View) => {
    setView(next);
    // The new list's first item takes the focus once it is drawn.
    requestAnimationFrame(focusFirst);
  };

  const remove = () => {
    const tool = ui().developMaskTool;
    if (component && mask.components.length > 1) {
      store().removeMaskComponent(assetId, mask.id, component.id);
      if (tool?.maskId === mask.id && tool.componentId === component.id) {
        ui().setDevelopMaskTool({ maskId: mask.id, tool: null });
      }
    } else {
      store().removeMask(assetId, mask.id);
      if (tool?.maskId === mask.id) ui().setDevelopMaskTool(null);
    }
  };

  if (view === 'rename') {
    const commit = () => {
      if (draft.trim() && draft.trim() !== mask.name) store().renameMask(assetId, mask.id, draft.trim());
      close();
    };
    return (
      <div className="p-1.5">
        <Input
          autoFocus
          aria-label="Mask name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          className="w-full"
        />
      </div>
    );
  }

  if (view === 'add') {
    return (
      <>
        {(['subtract', 'intersect'] as const).map((mode) => (
          <div key={mode} className="flex flex-col">
            <MenuLabel>{mode === 'subtract' ? 'Subtract' : 'Intersect'}</MenuLabel>
            {MASK_TOOLS.map((t) => (
              <MenuItem
                key={t}
                onSelect={() => {
                  ui().setDevelopMasks(true);
                  if (startComponent(assetId, mask.id, mode, t)) onRange?.();
                }}
              >
                {MASK_TOOL_LABEL[t]}
              </MenuItem>
            ))}
          </div>
        ))}
      </>
    );
  }

  if (view === 'convert' && converted) {
    return (
      <MenuItem
        onSelect={() => {
          store().replaceMaskComponent(assetId, mask.id, converted.id, [converted]);
          const tool = ui().developMaskTool;
          if (tool?.maskId === mask.id && tool.componentId === converted.id && tool.tool) {
            ui().setDevelopMaskTool({ ...tool, tool: converted.kind === 'linear' ? 'linear' : 'radial' });
          }
        }}
      >
        {converted.kind === 'linear' ? 'Linear gradient' : 'Radial gradient'}
      </MenuItem>
    );
  }

  const inverted = component ? component.invert : mask.invert;
  return (
    <>
      <MenuItem danger shortcut="⌫" onSelect={remove}>
        Delete
      </MenuItem>
      <MenuItem
        onSelect={() => {
          const id = store().duplicateMask(assetId, mask.id);
          if (id) ui().setDevelopMaskTool({ maskId: id, tool: null });
        }}
      >
        Duplicate
      </MenuItem>
      <MenuItem
        checked={inverted}
        keepOpen={false}
        onSelect={() =>
          component
            ? store().setComponentInvert(assetId, mask.id, component.id, !component.invert)
            : store().setMaskInvert(assetId, mask.id, !mask.invert)
        }
      >
        Invert
      </MenuItem>
      <MenuItem keepOpen onSelect={() => go('rename')}>
        Rename…
      </MenuItem>
      <MenuSeparator />
      <MenuItem keepOpen onSelect={() => go('add')}>
        Add to this mask ▸
      </MenuItem>
      <MenuItem
        keepOpen
        disabled={!converted}
        title={converted ? undefined : 'Only a linear or radial gradient converts'}
        onSelect={() => go('convert')}
      >
        Convert to…
      </MenuItem>
    </>
  );
}
