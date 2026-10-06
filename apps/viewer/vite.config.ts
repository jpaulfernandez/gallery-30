import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defaultClientConditions, defineConfig, loadEnv, type Plugin } from 'vite';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('./dev-fixtures', import.meta.url));
/** See `src/config.ts`: what the build bakes in when `VITE_R2_PUBLIC_URL` is unset. */
const UNSET_R2_URL = 'https://unset.r2.invalid';
const DEV_R2_PREFIX = '/dev-r2/';
const DEV_API_PREFIX = '/dev-api';

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

/**
 * Dev-only stand-in for the R2 public URL: serves `dev-fixtures/` at `/dev-r2/*` with the same
 * headers R2 would send (CORS open, images immutable, json no-cache). `.env.development` points
 * `VITE_R2_PUBLIC_URL` here. Only `configureServer` is implemented, so nothing reaches the build.
 */
function devR2(): Plugin {
  return {
    name: 'photobook:dev-r2',
    apply: 'serve',
    configureServer(server) {
      if (!existsSync(join(FIXTURES_DIR, 'site.json'))) {
        server.config.logger.warn(
          '[photobook] dev-fixtures/ is missing: run `pnpm --filter viewer fixtures` to generate the demo book.',
        );
      }
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith(DEV_R2_PREFIX)) return next();
        const rel = normalize(decodeURIComponent(url.slice(DEV_R2_PREFIX.length).split('?')[0] ?? ''));
        const file = join(FIXTURES_DIR, rel);
        if (rel.startsWith('..') || !file.startsWith(FIXTURES_DIR) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end('not found');
          return;
        }
        const ext = extname(file);
        res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', ext === '.json' ? 'no-cache' : 'public, max-age=31536000, immutable');
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(file).pipe(res);
      });
    },
  };
}

// --- Dev mock of the social Worker -------------------------------------------------------------

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

interface MockLike {
  targetType: 'page' | 'photo';
  targetId: string;
  deviceId: string;
  displayName: string | null;
  createdAt: string;
}

interface MockEvent {
  id: string;
  bookId: string;
  targetType: 'page' | 'photo' | 'collection';
  targetId: string | string[];
  action: 'download' | 'share' | 'zip' | 'page_share';
  displayName: string;
  deviceId: string;
  pageId: string | null;
  createdAt: string;
}

const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const isText = (v: unknown, max = 500): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isName = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 40;

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.statusCode = status;
  for (const [k, v] of Object.entries({ ...CORS, 'Cache-Control': 'no-store', ...extra })) res.setHeader(k, v);
  if (body === null) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Dev-only, in-memory stand-in for the social Worker (`worker/`) at `/dev-api/*`, with the routes
 * and payloads of `packages/shared/src/publish/social.ts`: health, like toggle, like counts per
 * book, events, and the admin activity log (any bearer token). State lives until the dev server
 * restarts. The generated `site.json` points `api` here. Only `configureServer`: nothing reaches the build.
 */
function devApi(): Plugin {
  const likes = new Map<string, MockLike[]>(); // bookId -> likes
  const events = new Map<string, MockEvent[]>(); // bookId -> events, oldest first
  const bookOf = (pathname: string, re: RegExp): string | null => {
    const m = re.exec(pathname);
    if (!m?.[1]) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  };

  return {
    name: 'photobook:dev-api',
    apply: 'serve',
    configureServer(server) {
      const say = (msg: string) => server.config.logger.info(`[dev-api] ${msg}`, { timestamp: true });
      server.middlewares.use(async (req, res, next) => {
        const raw = req.url ?? '';
        if (!raw.startsWith(`${DEV_API_PREFIX}/`)) return next();
        const url = new URL(raw.slice(DEV_API_PREFIX.length), 'http://dev-api.local');
        const { pathname } = url;
        const method = req.method ?? 'GET';
        if (method === 'OPTIONS') return send(res, 204, null);

        try {
          if (pathname === '/v1/health') return send(res, 200, { ok: true, version: 1 });

          if (pathname === '/v1/likes') {
            if (method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST, OPTIONS' });
            const b = (await readBody(req)) as Record<string, unknown>;
            const { bookId, targetType, targetId, deviceId, displayName = null, liked } = b ?? {};
            if (
              !isText(bookId) ||
              (targetType !== 'page' && targetType !== 'photo') ||
              !isText(targetId) ||
              typeof deviceId !== 'string' ||
              !DEVICE_RE.test(deviceId) ||
              (displayName !== null && !isName(displayName)) ||
              typeof liked !== 'boolean'
            ) {
              return send(res, 400, { error: 'invalid like' });
            }
            const list = likes.get(bookId) ?? [];
            const same = (l: MockLike) => l.targetType === targetType && l.targetId === targetId;
            const rest = list.filter((l) => !(same(l) && l.deviceId === deviceId));
            if (liked) {
              rest.push({
                targetType,
                targetId,
                deviceId,
                displayName: displayName === null ? null : displayName.trim(),
                createdAt: new Date().toISOString(),
              });
            }
            likes.set(bookId, rest);
            const count = rest.filter(same).length;
            say(`${liked ? 'like' : 'unlike'} ${targetType}:${targetId} by ${displayName ?? deviceId} -> ${count}`);
            return send(res, 200, { liked, count });
          }

          if (pathname === '/v1/events') {
            if (method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST, OPTIONS' });
            const b = (await readBody(req)) as Record<string, unknown>;
            const { bookId, targetType, targetId, action, displayName, deviceId, pageId = null } = b ?? {};
            const ids = Array.isArray(targetId) ? targetId : [targetId];
            if (
              !isText(bookId) ||
              (targetType !== 'page' && targetType !== 'photo' && targetType !== 'collection') ||
              ids.length === 0 ||
              ids.length > 500 ||
              !ids.every((id) => isText(id)) ||
              (action !== 'download' && action !== 'share' && action !== 'zip' && action !== 'page_share') ||
              !isName(displayName) ||
              typeof deviceId !== 'string' ||
              !DEVICE_RE.test(deviceId) ||
              (pageId !== null && !isText(pageId))
            ) {
              return send(res, 400, { error: 'invalid event' });
            }
            const event: MockEvent = {
              id: randomUUID(),
              bookId,
              targetType,
              targetId: targetId as string | string[],
              action,
              displayName: displayName.trim(),
              deviceId,
              pageId,
              createdAt: new Date().toISOString(),
            };
            events.set(bookId, [...(events.get(bookId) ?? []), event]);
            say(
              `${action} ${targetType} ${Array.isArray(targetId) ? `[${ids.length}]` : targetId} by ${event.displayName}`,
            );
            return send(res, 200, { id: event.id });
          }

          const likesBook = bookOf(pathname, /^\/v1\/books\/([^/]+)\/likes$/);
          if (likesBook !== null) {
            if (method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET, OPTIONS' });
            const device = url.searchParams.get('device');
            const counts: Record<string, number> = {};
            const mine: string[] = [];
            for (const l of likes.get(likesBook) ?? []) {
              const key = `${l.targetType}:${l.targetId}`;
              counts[key] = (counts[key] ?? 0) + 1;
              if (device && l.deviceId === device) mine.push(key);
            }
            return send(res, 200, { counts, mine });
          }

          const activityBook = bookOf(pathname, /^\/v1\/admin\/books\/([^/]+)\/activity$/);
          if (activityBook !== null) {
            if (method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET, OPTIONS' });
            if (!/^Bearer .+/.test(req.headers.authorization ?? '')) {
              return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
            }
            return send(res, 200, {
              bookId: activityBook,
              events: [...(events.get(activityBook) ?? [])].reverse(),
              likes: [...(likes.get(activityBook) ?? [])].reverse(),
              truncated: false,
            });
          }

          return send(res, 404, { error: 'not found' });
        } catch {
          return send(res, 400, { error: 'invalid JSON' });
        }
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && !loadEnv(mode, ROOT, 'VITE_').VITE_R2_PUBLIC_URL) {
    // Without a value Vite would fold `R2_BASE === null` to true and drop the whole app from the
    // bundle (the size check would then measure nothing). Bake in a sentinel the runtime treats as
    // unset instead, so the built page still shows the configuration error.
    console.warn(
      '\n[photobook] VITE_R2_PUBLIC_URL is not set: this build shows a configuration error. ' +
        'Set it in apps/viewer/.env.local or in the Vercel project.\n',
    );
    process.env.VITE_R2_PUBLIC_URL = UNSET_R2_URL;
  }
  return {
    // reactAliasesEnabled aliases react, react-dom and react/jsx-runtime to preact/compat,
    // so the shared React renderer (packages/shared) runs unchanged in the viewer.
    plugins: [preact({ reactAliasesEnabled: true }), devR2(), devApi()],
    resolve: {
      // Consume workspace packages from source (see the "source" export condition).
      conditions: ['source', ...defaultClientConditions],
      // Shared source (outside this package) compiles its JSX to preact/jsx-runtime too; resolve that
      // and every other preact import from here so there is exactly one copy.
      dedupe: ['preact'],
    },
    // The dev fixtures bake absolute URLs on this port into the manifest, so keep it fixed.
    server: { port: 5173, strictPort: true },
    build: {
      target: 'es2022',
      rollupOptions: {
        output: {
          // Keep the shared renderer with the entry; the lightbox and the grid split on their dynamic imports.
          manualChunks: undefined,
        },
      },
    },
  };
});
