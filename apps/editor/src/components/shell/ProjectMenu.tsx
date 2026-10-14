import { useNavigate } from '@tanstack/react-router';
import { save } from '@tauri-apps/plugin-dialog';
import { useEffect } from 'react';
import { errorMessage } from '../../lib/errors';
import { devError, devLog } from '../../lib/log';
import { useBookStore } from '../../store/book';
import { useCullStore } from '../../store/cull';
import { useProjectsStore } from '../../store/projects';
import { useUiStore } from '../../store/ui';
import { openBrief } from '../ai/BriefDialog';
import { openRejectPile, useRejectPile } from '../cull/rejectPile';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui/Menu';

/** How many other projects the menu offers to open. */
const RECENT = 6;

/** Save as: pick a place for the project file in the save dialog; the project lives there from then on. */
export async function saveProjectAs(title: string): Promise<void> {
  try {
    const path = await save({
      title: 'Save project as',
      defaultPath: `${title.replace(/[\\/:]/g, '-') || 'Untitled'}.photobook.json`,
      filters: [{ name: 'Photobook project', extensions: ['json'] }],
    });
    if (typeof path !== 'string') return;
    await useBookStore.getState().saveAs(path);
  } catch (err) {
    devError('book', 'save as failed', err);
    useUiStore.getState().setSaveStatus('error', `Save as failed: ${errorMessage(err)}`);
  }
}

/**
 * The Project ▾ menu of the top bar: the open project's Rename, Save as…, Cull its photos, Preview, Downloads and Close,
 * then the most recent other projects to open, and Home (every project, New project…). `onRename` starts renaming in
 * place (Design's title); without it Rename is not offered. `onClosed` runs after Close project. Plan 45: on `Menu`.
 */
export function ProjectMenu({ onRename, onClosed }: { onRename?: () => void; onClosed?: () => void }) {
  const navigate = useNavigate();
  const projectId = useBookStore((s) => s.projectId);
  const title = useBookStore((s) => s.book?.title ?? '');
  const projects = useProjectsStore((s) => s.projects);
  // Plan 42: on the Cull stage, *Review rejects…* opens the reject pile (disabled with none).
  const onCull = useCullStore((s) => s.stages > 0);
  const rejects = useRejectPile().length;

  useEffect(() => {
    if (useProjectsStore.getState().projects.length === 0) {
      void useProjectsStore
        .getState()
        .load()
        .catch((err) => devLog('projects', 'not listed', { error: errorMessage(err) }));
    }
  }, []);

  const others = projects.filter((p) => p.id !== projectId && p.error === null).slice(0, RECENT);
  const go = (to: () => Promise<void> | void) =>
    void Promise.resolve(to()).catch((err) => devError('book', 'menu', err));

  return (
    <Menu
      label={
        <>
          <span className="max-w-48 truncate">{projectId ? 'Project' : 'No project'}</span>
          <span aria-hidden="true">▾</span>
        </>
      }
      title={projectId ? `Project: ${title || 'Untitled'}` : 'Open or start a project'}
      menuLabel="Project"
      width={240}
    >
      {projectId && (
        <>
          <MenuLabel>{title || 'Untitled'}</MenuLabel>
          {onRename && <MenuItem onSelect={onRename}>Rename…</MenuItem>}
          <MenuItem
            title="Save the project file somewhere else (it is kept in the app until then)"
            onSelect={() => void saveProjectAs(title)}
          >
            Save as…
          </MenuItem>
          {/* Workflow plan 34: the caption brief, also opened by the first ✦ Write. */}
          <MenuItem title="What the AI captions are told about this project" onSelect={openBrief}>
            Caption brief…
          </MenuItem>
          <MenuItem
            title="The project's photos in the Cull grid"
            onSelect={() => go(() => navigate({ to: '/project/$id/cull', params: { id: projectId } }))}
          >
            Cull its photos
          </MenuItem>
          <MenuItem onSelect={() => go(() => navigate({ to: '/project/$id/preview', params: { id: projectId } }))}>
            Preview
          </MenuItem>
          <MenuItem onSelect={() => go(() => navigate({ to: '/project/$id/downloads', params: { id: projectId } }))}>
            Downloads
          </MenuItem>
          <MenuItem
            onSelect={() =>
              go(async () => {
                await useBookStore.getState().close();
                onClosed?.();
              })
            }
          >
            Close project
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      {onCull && (
        <MenuItem
          disabled={rejects === 0}
          title="Every reject of this folder: rescue them or move them to the Trash"
          onSelect={openRejectPile}
        >
          Review rejects…
        </MenuItem>
      )}
      {others.length > 0 && <MenuLabel>Open</MenuLabel>}
      {others.map((p) => (
        <MenuItem
          key={p.id}
          title={p.path}
          onSelect={() => go(() => navigate({ to: '/project/$id/design', params: { id: p.id } }))}
        >
          {p.title || 'Untitled'}
        </MenuItem>
      ))}
      <MenuItem onSelect={() => go(() => navigate({ to: '/' }))}>All projects · New project…</MenuItem>
    </Menu>
  );
}
