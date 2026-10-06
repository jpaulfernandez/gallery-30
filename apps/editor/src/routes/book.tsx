import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Canvas } from '../components/editor/Canvas';
import { EditorDnd } from '../components/editor/EditorDnd';
import { Inspector } from '../components/editor/Inspector';
import { LayoutPicker } from '../components/editor/LayoutPicker';
import { LeftPanel } from '../components/editor/LeftPanel';
import { OriginalModal } from '../components/editor/OriginalModal';
import { PageStrip } from '../components/editor/PageStrip';
import { TopBar } from '../components/editor/TopBar';
import { useEditorShortcuts } from '../components/editor/useEditorShortcuts';
import { useAssetsStore } from '../store/assets';
import { useBookStore } from '../store/book';

/**
 * Editor shell (DESIGN_NOTES "Editor shell"): 44 px top bar, 280 px left panel (Photos / Layouts
 * tabs), canvas, 300 px inspector, 120 px page strip. One DndContext spans all of them.
 */
export function BookRoute() {
  const hasBook = useBookStore((s) => s.book !== null);
  const close = useBookStore((s) => s.close);
  const folder = useBookStore((s) => s.folder);
  const navigate = useNavigate();
  useEditorShortcuts();

  // Scan, hash and thumbnail the book's folder whenever a book is opened. Remounting (back from
  // preview) does not rescan a folder whose scan already finished; Rescan forces one.
  useEffect(() => {
    if (folder) void useAssetsStore.getState().scan(folder);
  }, [folder]);

  if (!hasBook) return null;

  async function closeBook() {
    await close();
    void navigate({ to: '/' });
  }

  return (
    <EditorDnd>
      <div className="grid h-full grid-cols-[280px_minmax(0,1fr)_300px] grid-rows-[44px_minmax(0,1fr)_120px]">
        <TopBar onClose={closeBook} />

        <LeftPanel />

        <Canvas />
        <Inspector />

        <div className="col-span-3 min-h-0">
          <PageStrip />
        </div>
      </div>
      <LayoutPicker />
      <OriginalModal />
    </EditorDnd>
  );
}
