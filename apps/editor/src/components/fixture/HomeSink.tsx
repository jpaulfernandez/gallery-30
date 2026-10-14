import { CURRENT_VERSION } from '@photobook/shared';
import { FIXTURE_PAGES, fixtureResolve } from '@photobook/shared/fixtures';
import type { Folder, ProjectSummary } from '../../lib/tauri';
import { EmptyLine, type FolderCull, FolderRows, ProjectCards, StartRow } from '../../routes/home';
import type { CoverSnapshot } from '../home/ProjectCover';

/**
 * Plan 50: Home's pieces on synthetic data (the Start row, cover cards drawn by the shared renderer from the fixture
 * pages, folder rows with every cull state and a missing folder, the empty line), so Home can be checked in a browser
 * without Tauri. Nothing here calls `invoke`: the covers are given, not read.
 */

const DAY = 86_400_000;
const now = Date.now();

const project = (
  id: string,
  title: string,
  updatedAt: number,
  patch: Partial<ProjectSummary> = {},
): ProjectSummary => ({
  id,
  path: `/appdata/projects/${id}/project.photobook.json`,
  external: false,
  title,
  folders: [],
  updatedAt,
  openedAt: updatedAt,
  coverHash: null,
  coverThumb: null,
  error: null,
  ...patch,
});

const PROJECTS: ProjectSummary[] = [
  project('p1', 'Lisbon zine', now - 2 * DAY),
  project('p2', 'Porto postcards', now - 3 * 3_600_000),
  project('p3', 'Studio tests', now - 9 * DAY),
  project('p4', 'Untitled draft', now - 40 * 60_000),
  project('p5', 'Old book', now - 45 * DAY),
  project('p6', 'Broken file', now - 60 * DAY, { error: 'Not a valid project file' }),
];

const snapshot = (index: number, pageCount: number): CoverSnapshot => {
  const fixture = FIXTURE_PAGES[index % FIXTURE_PAGES.length];
  if (!fixture) throw new Error('No fixture pages');
  const { book, page } = fixture;
  return { schema: CURRENT_VERSION, template: book.template, theme: book.theme, page, thumbs: {}, pageCount };
};

const COVERS: Record<string, CoverSnapshot | null> = {
  p1: snapshot(0, 24),
  p2: snapshot(FIXTURE_PAGES.length - 1, 6),
  p3: snapshot(2, 12),
  // A project with no pages: the empty paper.
  p4: { ...snapshot(0, 0), page: null },
  p5: snapshot(1, 40),
  p6: null,
};

const folder = (id: string, name: string, lastSeen: number, missing = false): Folder => ({
  id,
  path: `/Users/me/Pictures/${name}`,
  name,
  addedAt: 1,
  lastSeen,
  missing,
});

const FOLDERS: Folder[] = [
  folder('f1', 'Lisbon 2026', 5),
  folder('f2', 'Studio tests', 4),
  folder('f3', 'Porto weekend', 3),
  folder('f4', 'Card from the old camera', 1, true),
  folder('f5', 'Film scans', 2),
];

const CULLS: Record<string, FolderCull | null> = {
  f1: { photos: 612, kept: 58, undecided: 0, culled: true },
  f2: { photos: 84, kept: 0, undecided: 12, culled: false },
  f3: { photos: 312, kept: 40, undecided: 101, culled: false },
  f4: null,
  f5: null,
};

const noop = () => {};

export function HomeSink() {
  return (
    <div data-testid="home-sink" className="flex max-w-[60rem] flex-col gap-10 rounded-lg bg-canvas p-8">
      <StartRow disabled={false} onOpenFolder={noop} onNew={noop} onOpenFile={noop} />
      <ProjectCards
        projects={PROJECTS}
        covers={COVERS}
        resolve={fixtureResolve}
        disabled={false}
        onOpen={noop}
        onRename={noop}
        onReveal={noop}
        onDelete={noop}
      />
      <FolderRows folders={FOLDERS} culls={CULLS} disabled={false} onOpen={noop} onRemove={noop} />
      <section className="flex flex-col gap-3 border-hairline border-t pt-6">
        <h2 className="section-title">Empty state (under the Start row)</h2>
        <EmptyLine />
      </section>
    </div>
  );
}
