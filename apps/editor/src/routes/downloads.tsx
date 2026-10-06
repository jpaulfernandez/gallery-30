import type { ActivityResponse } from '@photobook/shared';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBookLookup } from '../components/downloads/lookup';
import { ActivityList, Card, LikesList, PageCounts, PhotoGrid, TopPhotoList } from '../components/downloads/sections';
import { likeGroups, newestFirst, pageStats, photoStats, summarize, topPhotos } from '../lib/activity';
import { errorMessage } from '../lib/errors';
import { devError, devLog } from '../lib/log';
import { fetchActivity } from '../lib/socialApi';
import { readPublishSettings } from '../lib/tauri';
import { useBookStore } from '../store/book';

type State =
  | { status: 'loading' }
  | { status: 'unconfigured'; missing: string[] }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ActivityResponse; at: number };

/**
 * The designer's view of the Worker's likes and download log for the open book. The data
 * comes from `GET <SOCIAL_API_URL>/v1/admin/books/<id>/activity` with the admin token from the
 * publish settings (`lib/socialApi.ts`); counts and the top list are `lib/activity.ts`. Asset and page
 * ids are looked up in the open book and the assets store; ids no longer there show placeholders.
 */
export function DownloadsRoute() {
  const book = useBookStore((s) => s.book);
  const [state, setState] = useState<State>({ status: 'loading' });
  const run = useRef(0);

  const load = useCallback(async () => {
    const bookId = useBookStore.getState().book?.id;
    if (!bookId) return;
    const mine = ++run.current;
    const stale = () => mine !== run.current;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    try {
      const settings = await readPublishSettings();
      const url = settings.SOCIAL_API_URL?.trim() ?? '';
      const token = settings.SOCIAL_ADMIN_TOKEN?.trim() ?? '';
      const missing = [url ? null : 'SOCIAL_API_URL', token ? null : 'SOCIAL_ADMIN_TOKEN'].filter(
        (k): k is string => k !== null,
      );
      if (missing.length > 0) {
        if (!stale()) setState({ status: 'unconfigured', missing });
        return;
      }
      const data = await fetchActivity(url, token, bookId);
      if (stale()) return;
      devLog('downloads', 'loaded', {
        events: data.events.length,
        likes: data.likes.length,
        truncated: data.truncated,
      });
      setState({ status: 'ready', data, at: Date.now() });
    } catch (err) {
      if (stale()) return;
      devError('downloads', 'load failed', err);
      setState({ status: 'error', message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      run.current += 1;
    };
  }, [load]);

  if (!book) return null;
  const refreshing = state.status === 'loading';

  return (
    <div className="flex h-full flex-col bg-stage">
      <header className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 px-4">
        <div className="flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={() => void load()}
            disabled={refreshing}
            className="rounded-md border border-line px-3 py-1.5 text-fg hover:bg-panel disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {state.status === 'ready' && (
            <span className="text-fg-muted">Updated {new Date(state.at).toLocaleTimeString()}</span>
          )}
        </div>
        <h1 className="m-0 max-w-[40vw] truncate font-serif text-[15px] font-normal text-fg">
          {book.title} <span className="text-fg-muted">· Downloads</span>
        </h1>
        <div className="flex justify-end">
          <Link
            to="/book"
            className="rounded-md border border-line px-3 py-1.5 text-fg no-underline hover:bg-panel focus-visible:outline-2 focus-visible:outline-accent"
          >
            Back to editor
          </Link>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        <div className="mx-auto max-w-6xl">
          {state.status === 'loading' && <p className="text-fg-muted">Loading activity…</p>}
          {state.status === 'unconfigured' && <SetupHelp missing={state.missing} />}
          {state.status === 'error' && (
            <div role="alert" className="max-w-xl rounded-lg border border-red-400/40 bg-panel p-4">
              <p className="m-0 text-red-400">Could not load the activity.</p>
              <p className="mt-1 mb-3 whitespace-pre-wrap text-fg-muted text-xs">{state.message}</p>
              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => void load()}
                  className="rounded-md border border-line px-3 py-1.5 hover:border-accent"
                >
                  Try again
                </button>
                <Link
                  to="/settings"
                  className="rounded-md border border-line px-3 py-1.5 text-fg no-underline hover:border-accent"
                >
                  Open Settings
                </Link>
              </div>
            </div>
          )}
          {state.status === 'ready' && <Activity data={state.data} now={state.at} />}
        </div>
      </main>
    </div>
  );
}

function SetupHelp({ missing }: { missing: string[] }) {
  return (
    <div className="max-w-xl rounded-lg border border-line bg-panel p-5">
      <h2 className="m-0 font-medium text-sm">Connect the likes and downloads Worker</h2>
      <p className="mt-2 text-fg-muted text-xs leading-relaxed">
        Friends' likes and downloads are recorded by a small Cloudflare Worker (the <code>worker/</code> folder). This
        tab reads its log, so the app needs the Worker's address and its admin token:
      </p>
      <ol className="mt-2 mb-3 list-decimal pl-5 text-fg-muted text-xs leading-relaxed">
        <li>
          Deploy the Worker and set its <code>ADMIN_TOKEN</code> secret (docs/PUBLISHING.md, "Likes and the download
          log").
        </li>
        <li>
          In Settings, under Likes and downloads, enter <code>SOCIAL_API_URL</code> and <code>SOCIAL_ADMIN_TOKEN</code>.
        </li>
        <li>Publish the book again so the viewer starts sending likes and downloads to it.</li>
      </ol>
      <p className="mb-3 text-fg-muted text-xs">Missing in Settings: {missing.join(', ')}.</p>
      <Link
        to="/settings"
        className="rounded-md bg-accent px-3 py-1.5 text-white text-xs no-underline hover:brightness-110"
      >
        Open Settings
      </Link>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="font-medium text-xl tabular-nums">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function Activity({ data, now }: { data: ActivityResponse; now: number }) {
  const book = useBookStore((s) => s.book);
  const lookup = useBookLookup(book ?? { assets: {}, pages: [] });
  const derived = useMemo(() => {
    const photos = photoStats(data);
    return {
      summary: summarize(data),
      events: newestFirst(data.events),
      photos,
      top: topPhotos(photos, 5),
      pages: pageStats(data),
      likes: likeGroups(data.likes),
    };
  }, [data]);
  const { summary } = derived;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-4 gap-3">
        <Stat value={summary.events} label="Saves and shares" />
        <Stat value={summary.devices} label="Devices" />
        <Stat value={summary.photosSaved} label="Photos saved" />
        <Stat value={summary.likes} label="Likes" />
      </div>
      {data.truncated && (
        <p className="m-0 text-amber-300 text-xs">
          The log holds more events than the Worker returns; the counts cover the newest {data.events.length}.
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start gap-4">
        <Card title="Activity" hint="Newest first" className="min-w-0">
          <ActivityList events={derived.events} lookup={lookup} now={now} />
        </Card>
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Top photos" hint="Most saved and liked">
            <TopPhotoList photos={derived.top} lookup={lookup} />
          </Card>
          <Card title="By page">
            <PageCounts pages={derived.pages} lookup={lookup} />
          </Card>
          <Card title="Likes" hint="Who liked what">
            <LikesList groups={derived.likes} lookup={lookup} now={now} />
          </Card>
        </div>
      </div>

      <Card title="By photo" hint="In book order; saved = downloads, shares and zips">
        <PhotoGrid photos={derived.photos} lookup={lookup} />
      </Card>
    </div>
  );
}
