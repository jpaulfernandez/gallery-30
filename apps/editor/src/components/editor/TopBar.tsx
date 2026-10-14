import { BOOK_OUTPUT_ID, findOutput } from '@photobook/shared';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { redo, undo, useBookStore, useHistoryAvailability } from '../../store/book';
import { useUiStore } from '../../store/ui';
import { OutputMenu } from '../design/OutputMenu';
import { PostExportSheet } from '../design/PostExportSheet';
import { PrintExportSheet } from '../design/PrintExportSheet';
import { SlideshowExportSheet } from '../design/SlideshowExportSheet';
import { ProjectMenu } from '../shell/ProjectMenu';
import { SaveIndicator } from '../shell/SaveIndicator';
import { StageTabs } from '../shell/StageTabs';
import { Button, buttonClass, IconButton } from '../ui/Button';
import { Input } from '../ui/Field';
import { SegmentedTrack, segmentClass } from '../ui/Segmented';
import { RedoIcon, UndoIcon } from './icons';
import { PublishPanel } from './PublishPanel';
import { useUnpublishedChanges } from './UnpublishedBadge';
import { ViewMenu } from './ViewMenu';

/**
 * 44 px bar of the Design stage: title (click to rename) and the Project ▾ menu (Rename, Save as…, Preview, Downloads,
 * Close project, other projects), the stage tabs Cull · Develop · Design, then View ▾ (canvas prefs), Edit | Preview, undo and redo, save
 * status ("Saved" fades in after a write, plan 45), settings and Publish. Next to the stage tabs, the document drop-down (Book, each post, New…); an output
 * open in place of the book shows Export… instead of Publish. `onClose` runs after the project is closed from the menu.
 */
export function TopBar({ onClose }: { onClose: () => void }) {
  const title = useBookStore((s) => s.book?.title ?? '');
  const projectId = useBookStore((s) => s.projectId ?? '');
  const setTitle = useBookStore((s) => s.setTitle);
  const { canUndo, canRedo } = useHistoryAvailability();
  const [editing, setEditing] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const publishState = useUnpublishedChanges();
  const onBook = useUiStore((s) => s.design.outputId === BOOK_OUTPUT_ID);
  const outputId = useUiStore((s) => s.design.outputId);
  const onPost = useBookStore((s) => (s.book ? findOutput(s.book, outputId)?.kind === 'social' : false));
  // A print (plan 15) exports a PDF.
  const onPrint = useBookStore((s) => (s.book ? findOutput(s.book, outputId)?.kind === 'print' : false));
  // A slideshow (plan 16) exports an MP4.
  const onSlideshow = useBookStore((s) => (s.book ? findOutput(s.book, outputId)?.kind === 'slideshow' : false));
  const [exporting, setExporting] = useState(false);

  const commit = () => {
    const next = editing?.trim();
    if (next && next !== title) setTitle(next);
    setEditing(null);
  };

  return (
    // Plan 43: the window drags from anywhere in the bar except its controls (buttons, links and fields block the
    // drag); the traffic lights sit in the 78 px inset.
    <header
      data-tauri-drag-region="deep"
      className="col-span-3 grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-hairline border-b bg-panel-2 pr-3 pl-[78px]"
    >
      <div className="flex min-w-0 items-center gap-1">
        {editing !== null ? (
          <Input
            autoFocus
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setEditing(null);
              }
            }}
            aria-label="Book title"
            className="w-full max-w-80 font-medium"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(title)}
            title="Rename"
            className={`${buttonClass({ variant: 'ghost', size: 'sm' })} max-w-full font-medium text-fg`}
          >
            <span className="truncate">{title || 'Untitled'}</span>
          </button>
        )}
        <ProjectMenu onRename={() => setEditing(title)} onClosed={onClose} />
      </div>

      <div className="flex items-center gap-2">
        <StageTabs stage="design" />
        <OutputMenu />
      </div>

      <div className="flex items-center justify-end gap-1 text-xs">
        <ViewMenu />
        <SegmentedTrack as="nav" aria-label="Canvas view" activeKey="edit" className="mr-2">
          <span data-segment-active className={segmentClass(true)}>
            Edit
          </span>
          {onBook ? (
            <Link to="/project/$id/preview" params={{ id: projectId }} className={segmentClass(false)}>
              Preview
            </Link>
          ) : (
            // The phone preview shows the book only.
            <span aria-disabled="true" title="Preview shows the book" className={segmentClass(false, true)}>
              Preview
            </span>
          )}
        </SegmentedTrack>
        <IconButton icon={<UndoIcon />} label="Undo" shortcut="⌘Z" onClick={undo} disabled={!canUndo} />
        <IconButton icon={<RedoIcon />} label="Redo" shortcut="⇧⌘Z" onClick={redo} disabled={!canRedo} />
        <SaveIndicator className="ml-2 w-16" />
        <Link to="/settings" className={`${buttonClass({ variant: 'ghost', size: 'sm' })} ml-1`}>
          Settings
        </Link>
        {!onBook && (
          // Outputs are not published with the book: a post exports its frames (plan 14), a print a PDF (plan 15).
          <Button
            variant="primary"
            disabled={!onPost && !onPrint && !onSlideshow}
            onClick={() => setExporting(true)}
            title={
              onPost
                ? 'Export the frames and caption to a folder'
                : onPrint
                  ? 'Save the print as a PDF'
                  : onSlideshow
                    ? 'Make the slideshow video (MP4)'
                    : 'Exporting this comes in a later version'
            }
            className="ml-3"
          >
            {onPrint ? 'Export PDF…' : onSlideshow ? 'Export video…' : 'Export…'}
          </Button>
        )}
        <Button
          variant="primary"
          onClick={() => setPublishing(true)}
          title={
            publishState === 'changes'
              ? 'Unpublished changes'
              : publishState === 'published'
                ? 'Published and up to date'
                : 'Not published yet'
          }
          className="ml-3"
          style={onBook ? undefined : { display: 'none' }}
        >
          {publishState === 'changes' && <span title="Unpublished changes" className="size-1.5 rounded-full bg-warn" />}
          Publish
        </Button>
      </div>
      {publishing && <PublishPanel onClose={() => setPublishing(false)} />}
      {exporting && onPost && <PostExportSheet outputId={outputId} onClose={() => setExporting(false)} />}
      {exporting && onPrint && <PrintExportSheet outputId={outputId} onClose={() => setExporting(false)} />}
      {exporting && onSlideshow && <SlideshowExportSheet outputId={outputId} onClose={() => setExporting(false)} />}
    </header>
  );
}
