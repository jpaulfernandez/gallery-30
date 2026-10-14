import type { Book } from '@photobook/shared';
import { fixtureBook, fixtureResolve } from '@photobook/shared/fixtures';
import { type ReactNode, useLayoutEffect, useState } from 'react';
import { type AssetFile, useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { ChooserSheet } from '../design/NextChooser';
import { Canvas } from '../editor/Canvas';
import { CUSTOM_PAGE_MESSAGE } from '../editor/customPageNotice';
import { EditorDnd } from '../editor/EditorDnd';
import { Inspector } from '../editor/Inspector';
import { PageStrip } from '../editor/PageStrip';
import { useSnapGuides } from '../editor/snap';
import { showToast } from '../editor/Toast';
import { Button } from '../ui/Button';

/**
 * Plan 48: the Design canvas chrome on the renderer fixture book, drawn by the real `Canvas`, `Inspector` and
 * `PageStrip` (no `invoke`; the photos come from the fixture's stand-in resolver): the desk's fainter dot grid, the
 * floating tool group and zoom HUD pills, the selection handles and the photo toolbar, the alignment toolbar over a
 * multi-selection, snap lines (accent) beside ruler guides (guide blue), the inspector cards, the page strip tiles and
 * the custom-page toast in the host. While it shows it holds the book and assets stores; it puts them back on leave.
 */

/** The fixture's photos as asset files, at the sizes the canvas and the strip ask for. */
function fixtureFiles(book: Book): Record<string, AssetFile> {
  const files: Record<string, AssetFile> = {};
  for (const [assetId, asset] of Object.entries(book.assets)) {
    files[asset.path] = {
      assetId,
      relPath: asset.path,
      size: 0,
      mtime: 0,
      kind: 'jpeg',
      status: 'ready',
      width: asset.width,
      height: asset.height,
      thumbUrl: fixtureResolve(assetId, 240)?.src,
      proxyUrl: fixtureResolve(assetId, 1200)?.src,
    } as AssetFile;
  }
  return files;
}

export function DesignSink() {
  const [ready, setReady] = useState(false);
  /** Plan 56: the "What's next" sheet over the sink (no project: a card would leave the sink, so look, then Skip). */
  const [chooser, setChooser] = useState(false);

  useLayoutEffect(() => {
    const before = { book: useBookStore.getState(), files: useAssetsStore.getState().files };
    const book = structuredClone(fixtureBook);
    useBookStore.setState({ book, folder: '/fixture', projectId: null });
    useBookStore.temporal.getState().clear();
    useAssetsStore.setState({ files: fixtureFiles(book) });
    useUiStore.setState({ pageIndex: 0, showRulers: true, showMargins: true });
    useUiStore.getState().select(null);
    setReady(true);
    return () => {
      useSnapGuides.setState({ pageId: null, guides: [], badges: [] });
      useBookStore.setState({
        book: before.book.book,
        folder: before.book.folder,
        projectId: before.book.projectId,
      });
      useAssetsStore.setState({ files: before.files });
    };
  }, []);

  if (!ready) return null;
  const ui = () => useUiStore.getState();
  const page = () => useBookStore.getState().book?.pages[ui().pageIndex];

  /** The page's photo frames, filled ones first. */
  const photoIdsOn = (): string[] => {
    const p = page();
    if (!p) return [];
    const photos = p.elements.filter((e) => e.type === 'photo');
    return [...photos.filter((e) => e.asset !== null), ...photos.filter((e) => e.asset === null)].map((e) => e.id);
  };
  const selectOne = () => {
    const [first] = photoIdsOn();
    if (first) ui().select(first);
  };
  const selectTwo = () => {
    const ids = photoIdsOn();
    if (ids.length < 2) return;
    ui().select(ids[0] ?? null);
    ui().toggleSelection(ids[1] ?? '');
  };
  const snap = () => {
    const p = page();
    if (!p) return;
    useSnapGuides.setState({
      pageId: p.id,
      guides: [
        { axis: 'x', value: 0.5, kind: 'center' },
        { axis: 'y', value: 0.5, kind: 'frame' },
      ],
      badges: [{ x: 0.5, y: 0.08, label: 'gutter · 0.20 in' }],
    });
  };
  const guide = () => {
    const p = page();
    if (!p) return;
    useBookStore.getState().updatePage(p.id, (d) => {
      d.guides = [{ axis: 'x', value: 0.25 }];
    });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="design-sink">
      <div className="flex flex-wrap gap-2">
        <SinkButton onClick={selectOne}>Select a photo frame</SinkButton>
        <SinkButton onClick={selectTwo}>Select two frames</SinkButton>
        <SinkButton onClick={() => ui().setAdjusting(photoIdsOn()[0] ?? null)}>Adjust photo</SinkButton>
        <SinkButton onClick={snap}>Show snap lines</SinkButton>
        <SinkButton onClick={() => useSnapGuides.setState({ pageId: null, guides: [], badges: [] })}>
          Hide snap lines
        </SinkButton>
        <SinkButton onClick={guide}>Add a ruler guide</SinkButton>
        <SinkButton onClick={() => showToast(CUSTOM_PAGE_MESSAGE, { action: { label: 'Undo', run: () => {} } })}>
          Show the custom-page toast
        </SinkButton>
        <SinkButton onClick={() => setChooser(true)}>Show the What's next chooser</SinkButton>
      </div>
      {chooser && <ChooserSheet projectId="fixture-sink" onClosed={() => setChooser(false)} />}
      <EditorDnd>
        <div className="grid h-[46rem] grid-cols-[minmax(0,1fr)_300px] grid-rows-[minmax(0,1fr)_120px] overflow-hidden rounded-md border border-hairline">
          <Canvas />
          <Inspector />
          <div className="col-span-2 min-h-0">
            <PageStrip />
          </div>
        </div>
      </EditorDnd>
    </div>
  );
}

function SinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button size="sm" onClick={onClick}>
      {children}
    </Button>
  );
}
