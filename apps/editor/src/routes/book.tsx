import { BOOK_OUTPUT_ID, hasOutput } from '@photobook/shared';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { NextChooser } from '../components/design/NextChooser';
import { CopySettingsDialog } from '../components/develop/CopySettingsDialog';
import { DevelopMode } from '../components/develop/DevelopMode';
import { SyncDialog } from '../components/develop/SyncDialog';
import { XmpImportDialog } from '../components/develop/XmpImportDialog';
import { Canvas } from '../components/editor/Canvas';
import { EditorDnd } from '../components/editor/EditorDnd';
import { Inspector } from '../components/editor/Inspector';
import { LayoutPicker } from '../components/editor/LayoutPicker';
import { LeftPanel } from '../components/editor/LeftPanel';
import { OriginalModal } from '../components/editor/OriginalModal';
import { PageStrip } from '../components/editor/PageStrip';
import { TopBar } from '../components/editor/TopBar';
import { useEditorShortcuts } from '../components/editor/useEditorShortcuts';
import { ReviewMode } from '../components/review/ReviewMode';
import { PaneShell } from '../components/shell/Panes';
import { useAssetsStore } from '../store/assets';
import { useBookStore } from '../store/book';
import { useUiStore } from '../store/ui';

/**
 * The Design stage (`/project/$id/design/$outputId`, DESIGN_NOTES "Shell"): one document of the project on the canvas,
 * the book (`book`) or an output such as a post (workflow plan 13). 44 px top bar with the stage tabs, 280 px left panel
 * (Project / Library / Layouts tabs), canvas, 300 px inspector, 120 px page strip. One DndContext spans all of them.
 * Review (R, double-click) and Develop (D) open over it on the project's photos. Plan 51: the panes and the page strip
 * follow `ui.panes.design` (Tab, Shift+Tab in `useEditorShortcuts`).
 */
export function BookRoute() {
  const hasBook = useBookStore((s) => s.book !== null);
  const folder = useBookStore((s) => s.folder);
  const projectId = useBookStore((s) => s.projectId);
  const navigate = useNavigate();
  const outputId = useParams({ strict: false }).outputId ?? BOOK_OUTPUT_ID;
  const outputExists = useBookStore((s) => s.book !== null && hasOutput(s.book, outputId));
  useEditorShortcuts();

  // The route's document is the one on the canvas; one that is gone (deleted, or its creation undone) goes to the book.
  useEffect(() => {
    if (!hasBook || !projectId) return;
    if (outputExists) useUiStore.getState().setDesignOutput(outputId);
    else void navigate({ to: '/project/$id/design/$outputId', params: { id: projectId, outputId: BOOK_OUTPUT_ID } });
  }, [hasBook, projectId, outputId, outputExists, navigate]);

  // Attach the project whenever one is opened: its folders are scanned (the library store, with the folder index) and
  // its assets relinked and filled in. Remounting (back from preview) does not attach again; Rescan forces it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another project on the same folder scans again
  useEffect(() => {
    if (folder) void useAssetsStore.getState().scan(folder);
  }, [folder, projectId]);

  if (!hasBook) return null;

  // The Project menu has closed the project: back Home.
  const closeBook = () => void navigate({ to: '/' });

  return (
    <EditorDnd>
      <PaneShell
        stage="design"
        top={<TopBar onClose={closeBook} />}
        left={<LeftPanel />}
        leftWidth={280}
        right={<Inspector />}
        strip={
          <div className="h-[120px] min-h-0">
            <PageStrip />
          </div>
        }
      >
        <Canvas />
      </PaneShell>
      <LayoutPicker />
      {/* Plan 56: "What's next?" over the canvas (first open of a project with only the book, and New…). */}
      <NextChooser />
      <OriginalModal />
      <ReviewMode />
      <DevelopMode />
      <SyncDialog />
      <CopySettingsDialog />
      <XmpImportDialog />
    </EditorDnd>
  );
}
