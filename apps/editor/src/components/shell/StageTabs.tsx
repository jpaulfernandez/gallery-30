import { Link } from '@tanstack/react-router';
import { useBookStore } from '../../store/book';
import type { LibrarySource } from '../../store/collections';
import { useFoldersStore } from '../../store/folders';
import { libraryFolderAt, useLibraryStore } from '../../store/library';
import { useUiStore } from '../../store/ui';
import { SegmentedTrack, segmentClass } from '../ui/Segmented';

export type Stage = 'cull' | 'develop' | 'design';

/**
 * Where Cull and Develop go: the library source on screen, else the folder they showed last, else the open project's
 * primary folder, else the first imported folder on disk. Null with no folder at all.
 */
export function useLibraryTarget(source?: LibrarySource): LibrarySource | null {
  const last = useUiStore((s) => s.libraryFolder);
  const primary = useBookStore((s) => s.folder);
  const primaryId = useLibraryStore((s) => libraryFolderAt(s, primary)?.id);
  const first = useFoldersStore((s) => s.folders.find((f) => !f.missing)?.id);
  if (source) return source;
  const id = last ?? primaryId ?? first;
  return id ? { kind: 'folder', id } : null;
}

function Disabled({ label, title }: { label: string; title: string }) {
  return (
    <span aria-disabled="true" title={title} className={segmentClass(false, true)}>
      {label}
    </span>
  );
}

function LibraryTab({ stage, target, active }: { stage: 'cull' | 'develop'; target: LibrarySource; active: boolean }) {
  const label = stage === 'cull' ? 'Cull' : 'Develop';
  const current = active ? 'page' : undefined;
  if (target.kind !== 'folder') {
    return (
      <Link
        to={stage === 'cull' ? '/library/collection/$collectionId/cull' : '/library/collection/$collectionId/develop'}
        params={{ collectionId: target.id }}
        aria-current={current}
        data-segment-active={active || undefined}
        className={segmentClass(active)}
      >
        {label}
      </Link>
    );
  }
  return (
    <Link
      to={stage === 'cull' ? '/library/$folderId/cull' : '/library/$folderId/develop'}
      params={{ folderId: target.id }}
      aria-current={current}
      data-segment-active={active || undefined}
      className={segmentClass(active)}
    >
      {label}
    </Link>
  );
}

/**
 * The stage tabs, in the order you work: Cull · Develop · Design (DESIGN_NOTES "Shell"). Cull and Develop show the
 * library (the folder or collection on screen, else the last one) and need no project; Design is the open project's
 * canvas and is disabled with no project open. On the project's own Cull (`projectCull`, its id) the Cull tab stays
 * there. Plan 45: a segmented control (links, so the window's drag region skips them) whose indicator slides to the
 * new stage, also across the route change (each stage has its own bar; the track remembers where it was).
 */
export function StageTabs({
  stage,
  source,
  projectCull,
}: {
  stage: Stage;
  source?: LibrarySource;
  projectCull?: string;
}) {
  const target = useLibraryTarget(source);
  const projectId = useBookStore((s) => s.projectId);
  const noFolder = 'Import a folder first';
  return (
    <SegmentedTrack as="nav" aria-label="Stages" activeKey={stage} memoryKey="stages">
      {projectCull ? (
        <Link
          to="/project/$id/cull"
          params={{ id: projectCull }}
          aria-current={stage === 'cull' ? 'page' : undefined}
          data-segment-active={stage === 'cull' || undefined}
          className={segmentClass(stage === 'cull')}
        >
          Cull
        </Link>
      ) : target ? (
        <LibraryTab stage="cull" target={target} active={stage === 'cull'} />
      ) : (
        <Disabled label="Cull" title={noFolder} />
      )}
      {target ? (
        <LibraryTab stage="develop" target={target} active={stage === 'develop'} />
      ) : (
        <Disabled label="Develop" title={noFolder} />
      )}
      {projectId ? (
        <Link
          to="/project/$id/design"
          params={{ id: projectId }}
          aria-current={stage === 'design' ? 'page' : undefined}
          data-segment-active={stage === 'design' || undefined}
          className={segmentClass(stage === 'design')}
        >
          Design
        </Link>
      ) : (
        <Disabled label="Design" title="Open or start a project to design it" />
      )}
    </SegmentedTrack>
  );
}
