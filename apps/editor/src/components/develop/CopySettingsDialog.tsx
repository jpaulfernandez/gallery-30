import { useState } from 'react';
import { COPY_SECTION_LABELS, COPY_SECTIONS, COPY_WARNINGS, type DevelopCopySection } from '../../lib/develop/sync';
import { basename } from '../../lib/path';
import { usePhotoLookup } from '../../store/assets';
import { useUiStore } from '../../store/ui';
import { DialogBody, DialogButton, DialogFooter, DialogShell } from '../ui/DialogShell';
import { copySettings } from './copyPaste';
import { SectionChecklist } from './SectionChecklist';

/**
 * Copy Settings (workflow plan 10; Shift+Cmd+Alt+C, the panel's Copy…, the Cull grid's menu): Sync's section checklist
 * (`SectionChecklist`) without the photo grid. It opens on the remembered choice (`ui.copySections`); Copy puts the
 * chosen sections on the clipboard and, with Remember on, makes them what Cmd+Shift+C copies from then on.
 */
export function CopySettingsDialog() {
  const dialog = useUiStore((s) => s.copyDialog);
  if (!dialog) return null;
  return <CopySettingsBody sourceId={dialog.sourceId} />;
}

function CopySettingsBody({ sourceId }: { sourceId: string }) {
  const close = useUiStore((s) => s.closeCopyDialog);
  const lookup = usePhotoLookup();
  const [sections, setSections] = useState<DevelopCopySection[]>(() => [...useUiStore.getState().copySections]);
  const [remember, setRemember] = useState(true);
  const name = basename(lookup.path(sourceId) || sourceId);

  const copy = () => {
    if (remember) useUiStore.getState().setCopySections(sections);
    copySettings(sourceId, sections);
    close();
  };

  return (
    <DialogShell title={`Copy settings from ${name}`} onClose={close}>
      <DialogBody>
        <SectionChecklist
          legend="Sections to copy"
          sections={COPY_SECTIONS}
          labels={COPY_SECTION_LABELS}
          warnings={COPY_WARNINGS}
          checked={sections}
          onChange={setSections}
          bulk
          footnote="Rotation and flips are never copied."
        />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this choice for Cmd+Shift+C
        </label>
      </DialogBody>
      <DialogFooter>
        <DialogButton onClick={close}>Cancel</DialogButton>
        <DialogButton primary onClick={copy} disabled={sections.length === 0}>
          Copy
        </DialogButton>
      </DialogFooter>
    </DialogShell>
  );
}
