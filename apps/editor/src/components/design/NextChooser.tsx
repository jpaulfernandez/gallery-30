import {
  type Asset,
  BOOK_OUTPUT_ID,
  type Book,
  nextOutputName,
  type OutputKind,
  SOCIAL_NETWORKS,
  SOCIAL_TEMPLATES,
  type SocialNetwork,
  uniqueOutputName,
} from '@photobook/shared';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { devError, devLog } from '../../lib/log';
import { useAssetsStore } from '../../store/assets';
import { useBookStore } from '../../store/book';
import { useExportsStore } from '../../store/exports';
import { resolvedAssets } from '../../store/library';
import { DEFAULT_FILMSTRIP, useUiStore } from '../../store/ui';
import { describePhotosAction } from '../ai/DescribePhotos';
import { openExport } from '../export/entryPoints';
import { visibleItems } from '../filmstrip/visible';
import { Button, focusRing } from '../ui/Button';
import { DialogShell } from '../ui/DialogShell';

/**
 * Plan 56 (ODDHALLS_LAYOUT_PLAN 5): "What's next?", a sheet over the Design canvas instead of a blank page. It opens
 * on the first open of a project whose `outputs` is empty (only the book), unless it was skipped or used for that
 * project on this machine (`localStorage`, keyed by the project id), and from New… in the document drop-down at any
 * time. Five cards, each through a path that already exists: Export full quality and Export for social (the Export
 * dialog on the keepers with plan 11's preset chosen), Carousel (`addPhotoPost`: a 4:5 post, one photo per frame in
 * book order), Photobook (the book, with the Layouts tab to lay its pages from templates) and Social post (plan 14's
 * network picker, the ratio first). Also: Print, Slideshow, Describe photos (AI). Skip (or Escape) goes to the book.
 */

/** Per machine: the chooser was skipped or used for this project, so it never opens by itself again. */
export const chooserSeenKey = (projectId: string): string => `photobook.design.chooserSeen.${projectId}`;

export function chooserSeen(projectId: string): boolean {
  try {
    return globalThis.localStorage?.getItem(chooserSeenKey(projectId)) === '1';
  } catch {
    return false;
  }
}

function markChooserSeen(projectId: string): void {
  try {
    globalThis.localStorage?.setItem(chooserSeenKey(projectId), '1');
  } catch {
    // Without storage the chooser shows again next time; nothing else depends on it.
  }
}

/** Whether the chooser opens by itself for this project: only the book, and not skipped or used here before. */
export const chooserDue = (book: Pick<Book, 'outputs'>, projectId: string): boolean =>
  book.outputs.length === 0 && !chooserSeen(projectId);

/** `auto`: it opened by itself (first open), so Skip goes to the book; from New… Skip just closes it. */
const useChooser = create<{ open: boolean; auto: boolean }>(() => ({ open: false, auto: false }));

/** Open the chooser (New… in the document drop-down). */
export const openNextChooser = (): void => useChooser.setState({ open: true, auto: false });

/**
 * The project's keepers in book order: its photos flagged Keep (every photo but the rejects when none is), first in
 * the order the book's pages place them, then the rest by capture time (the filmstrip's default order).
 */
export function keeperIds(book: Book, assets: Record<string, Asset>, byTime: readonly string[]): string[] {
  const ids = Object.keys(book.assets).filter((id) => assets[id]?.flag !== 'reject');
  const picks = ids.filter((id) => assets[id]?.flag === 'pick');
  const pool = new Set(picks.length > 0 ? picks : ids);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const take = (id: string) => {
    if (pool.has(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };
  for (const page of book.pages) {
    for (const el of page.elements) if (el.type === 'photo' && el.asset) take(el.asset);
  }
  for (const id of byTime) take(id);
  for (const id of pool) take(id);
  return ordered;
}

const NO_ASSETS: Record<string, Asset> = {};

/** The network picker's ratios, in the order Layout 5 lists them (a ratio no network has is left out). */
const RATIOS = ['4:5', '3:2', '9:16', '1:1', '2:3'];

/** The sheet, mounted by the Design route: opens by itself when `chooserDue`, and from New…. */
export function NextChooser() {
  const projectId = useBookStore((s) => s.projectId);
  const hasBook = useBookStore((s) => s.book !== null);
  const open = useChooser((s) => s.open);

  // First open of a project with only the book (per machine), once the book has loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `hasBook` re-runs it when the book arrives
  useEffect(() => {
    const book = useBookStore.getState().book;
    if (!projectId || !book) return;
    if (chooserDue(book, projectId)) {
      devLog('book', 'next chooser shown', { project: projectId });
      useChooser.setState({ open: true, auto: true });
    }
  }, [projectId, hasBook]);

  // Leaving the project closes it.
  useEffect(() => () => useChooser.setState({ open: false }), []);

  if (!open || !projectId || !hasBook) return null;
  return <ChooserSheet projectId={projectId} />;
}

/** The sheet itself (the kitchen sink shows it with `onClosed`, outside a project). */
export function ChooserSheet({ projectId, onClosed }: { projectId: string; onClosed?: () => void }) {
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const book = useBookStore((s) => s.book);
  const assets = useBookStore((s) => resolvedAssets(s));
  const files = useAssetsStore((s) => s.files);
  const all = assets ?? NO_ASSETS;
  const byTime = useMemo(
    () =>
      visibleItems(files, {}, all, new Set(), DEFAULT_FILMSTRIP).flatMap((item) =>
        item.kind === 'file' ? [item.file.assetId] : [],
      ),
    [files, all],
  );
  if (!book) return null;
  const keepers = keeperIds(book, all, byTime);
  const picked = keepers.some((id) => all[id]?.flag === 'pick');
  const noun = picked ? (keepers.length === 1 ? 'keeper' : 'keepers') : keepers.length === 1 ? 'photo' : 'photos';
  const none = keepers.length === 0;

  /** Close for good on this machine (Skip, Escape or any choice). */
  const done = () => {
    markChooserSeen(projectId);
    useChooser.setState({ open: false });
    onClosed?.();
  };
  const show = (outputId: string) =>
    navigate({ to: '/project/$id/design/$outputId', params: { id: projectId, outputId } }).catch((err) =>
      devError('book', 'open output', err),
    );

  const exportWith = (presetId: string) => {
    done();
    useExportsStore.getState().setLastPreset(presetId);
    openExport(keepers, `${keepers.length} ${noun}`);
  };
  const carousel = () => {
    const id = useBookStore.getState().addPhotoPost(uniqueOutputName(book, 'Carousel'), keepers);
    done();
    if (id) void show(id);
  };
  const photobook = () => {
    done();
    useUiStore.getState().setPref('leftTab', 'layouts');
    void show(BOOK_OUTPUT_ID);
  };
  const post = (network: SocialNetwork) => {
    const id = useBookStore.getState().addOutput('social', uniqueOutputName(book, SOCIAL_TEMPLATES[network].label), {
      network,
    });
    done();
    if (id) void show(id);
  };
  const make = (kind: Exclude<OutputKind, 'social'>) => {
    const id = useBookStore.getState().addOutput(kind, nextOutputName(book, kind));
    done();
    if (id) void show(id);
  };
  const skip = () => {
    const auto = useChooser.getState().auto;
    done();
    // Opened by itself: the blank book. From New… (or the kitchen sink): stay on the document shown.
    if (auto && !onClosed) void show(BOOK_OUTPUT_ID);
  };

  return (
    <DialogShell title={`What's next for ${keepers.length} ${noun}?`} onClose={skip} widthClass="w-[46rem]">
      <div className="flex flex-col gap-4 p-5 pt-3" data-next-chooser="">
        {picking ? (
          <NetworkPicker onPick={post} onBack={() => setPicking(false)} />
        ) : (
          <div className="grid grid-cols-5 gap-2">
            <Card
              icon="⤓"
              title="Export full quality"
              detail="Full size, all metadata"
              disabled={none}
              onClick={() => exportWith('full-quality')}
            />
            <Card
              icon="⤓"
              title="Export for social"
              detail="2048 px sRGB JPEG"
              disabled={none}
              onClick={() => exportWith('social')}
            />
            <Card icon="▦" title="Carousel" detail="4:5 frames, one per photo" disabled={none} onClick={carousel} />
            <Card icon="▤" title="Photobook" detail="Pages from templates" onClick={photobook} />
            <Card
              icon="▣"
              title="Social post"
              detail="4:5 · 9:16 · 1:1 · 2:3, then the network"
              onClick={() => setPicking(true)}
            />
          </div>
        )}
        <div className="flex items-center gap-1 text-fg-muted text-xs">
          <span className="pr-1">Also:</span>
          <Button variant="ghost" size="sm" onClick={() => make('print')}>
            Print
          </Button>
          <Button variant="ghost" size="sm" onClick={() => make('slideshow')}>
            Slideshow
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={none}
            onClick={() => {
              done();
              void describePhotosAction(keepers, { ask: true });
            }}
          >
            Describe photos (AI)
          </Button>
          <Button variant="soft" size="sm" className="ml-auto" onClick={skip}>
            Skip
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

/** One of the five cards: an icon, a title and a line of detail. */
function Card({
  icon,
  title,
  detail,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'No photos in this project yet' : undefined}
      className={`flex min-h-28 flex-col items-start gap-1 rounded-md bg-fg/6 p-3 text-left transition-colors duration-fast ease-out hover:bg-fg/10 disabled:pointer-events-none disabled:opacity-40 ${focusRing}`}
    >
      <span aria-hidden="true" className="text-[15px] text-fg-2">
        {icon}
      </span>
      <span className="font-medium text-fg text-xs">{title}</span>
      <span className="text-[11px] text-fg-muted leading-snug">{detail}</span>
    </button>
  );
}

/** Plan 14's networks with the ratio first: pick a ratio, then the network. */
function NetworkPicker({ onPick, onBack }: { onPick: (network: SocialNetwork) => void; onBack: () => void }) {
  const ratios = RATIOS.filter((r) => SOCIAL_NETWORKS.some((n) => SOCIAL_TEMPLATES[n].ratio === r));
  const [ratio, setRatio] = useState(ratios[0] ?? '4:5');
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="m-0 flex min-w-0 items-center gap-1 border-0 p-0" aria-label="Ratio">
        {ratios.map((r) => (
          <Button
            key={r}
            variant="toggle"
            size="sm"
            pressed={r === ratio}
            onClick={() => setRatio(r)}
            className="font-mono"
          >
            {r}
          </Button>
        ))}
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onBack}>
          Back
        </Button>
      </fieldset>
      <div className="grid grid-cols-3 gap-2">
        {SOCIAL_NETWORKS.filter((n) => SOCIAL_TEMPLATES[n].ratio === ratio).map((n) => {
          const t = SOCIAL_TEMPLATES[n];
          return (
            <Card
              key={n}
              icon={<span className="font-mono text-[11px]">{t.ratio}</span>}
              title={t.label}
              detail={`${t.width} × ${t.height} px, up to ${t.maxFrames} frames`}
              onClick={() => onPick(n)}
            />
          );
        })}
      </div>
    </div>
  );
}
