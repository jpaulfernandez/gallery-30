import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVITY_LIMIT,
  ActivityResponseSchema,
  EventResponseSchema,
  LikesResponseSchema,
  LikeToggleResponseSchema,
  likeKey,
  SOCIAL_API_VERSION,
  socialRoutes,
} from '@photobook/shared/social';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Unstable_DevWorker, unstable_dev } from 'wrangler';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-admin-token';
const DEVICE_A = 'device-aaaaaaaa';
const DEVICE_B = 'device-bbbbbbbb';

let worker: Unstable_DevWorker;
let persistTo: string;

const post = (path: string, body: unknown, init: Parameters<Unstable_DevWorker['fetch']>[1] = {}) =>
  worker.fetch(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...init });
const admin = (bookId: string, token: string | null = TOKEN) =>
  worker.fetch(socialRoutes.adminActivity(bookId), token ? { headers: { Authorization: `Bearer ${token}` } } : {});

const like = (bookId: string, targetId: string, deviceId: string, liked: boolean, displayName: string | null = null) =>
  post(socialRoutes.like, { bookId, targetType: 'photo', targetId, deviceId, displayName, liked });

beforeAll(async () => {
  persistTo = mkdtempSync(join(tmpdir(), 'photobook-worker-test-'));
  execFileSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'photobook-social', '--local', '--persist-to', persistTo],
    { cwd: root, stdio: 'pipe' },
  );
  worker = await unstable_dev(join(root, 'src/index.ts'), {
    config: join(root, 'wrangler.toml'),
    persistTo,
    vars: { ADMIN_TOKEN: TOKEN },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    logLevel: 'error',
    local: true,
  });
});

afterAll(async () => {
  await worker?.stop();
  if (persistTo) rmSync(persistTo, { recursive: true, force: true });
});

describe('basics', () => {
  it('reports health with CORS and no-store', async () => {
    const res = await worker.fetch(socialRoutes.health);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: SOCIAL_API_VERSION });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers preflight', async () => {
    const res = await worker.fetch(socialRoutes.like, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type, Authorization');
    expect(res.headers.get('access-control-max-age')).toBe('86400');
  });

  it('404s unknown routes as JSON with CORS', async () => {
    const res = await worker.fetch('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('rejects invalid JSON, schema failures and oversized bodies with 400/413', async () => {
    const bad = await post(socialRoutes.like, '{nope');
    expect(bad.status).toBe(400);
    const schema = await post(socialRoutes.like, { bookId: 'b', targetType: 'photo', targetId: 'x', liked: true });
    expect(schema.status).toBe(400);
    expect(await schema.json()).toHaveProperty('error');
    const big = await post(socialRoutes.events, JSON.stringify({ pad: 'x'.repeat(70 * 1024) }));
    expect(big.status).toBe(413);
  });
});

describe('likes', () => {
  const book = 'likes-book';

  it('toggles idempotently and counts per device', async () => {
    let res = await like(book, 'a1', DEVICE_A, true, 'Ana');
    expect(LikeToggleResponseSchema.parse(await res.json())).toEqual({ liked: true, count: 1 });
    res = await like(book, 'a1', DEVICE_A, true);
    expect(await res.json()).toEqual({ liked: true, count: 1 });
    res = await like(book, 'a1', DEVICE_B, true, 'Ben');
    expect(await res.json()).toEqual({ liked: true, count: 2 });
    await post(socialRoutes.like, {
      bookId: book,
      targetType: 'page',
      targetId: 'p1',
      deviceId: DEVICE_A,
      liked: true,
    });

    const list = LikesResponseSchema.parse(
      await (await worker.fetch(`${socialRoutes.likes(book)}?device=${DEVICE_A}`)).json(),
    );
    expect(list.counts).toEqual({ [likeKey('photo', 'a1')]: 2, [likeKey('page', 'p1')]: 1 });
    expect([...list.mine].sort()).toEqual([likeKey('page', 'p1'), likeKey('photo', 'a1')]);

    const other = LikesResponseSchema.parse(
      await (await worker.fetch(`${socialRoutes.likes(book)}?device=${DEVICE_B}`)).json(),
    );
    expect(other.mine).toEqual([likeKey('photo', 'a1')]);

    res = await like(book, 'a1', DEVICE_A, false);
    expect(await res.json()).toEqual({ liked: false, count: 1 });
    res = await like(book, 'a1', DEVICE_A, false);
    expect(await res.json()).toEqual({ liked: false, count: 1 });
  });

  it('returns empty mine for a missing or invalid device and isolates books', async () => {
    for (const q of ['', '?device=x', '?device=has space!!!!']) {
      const res = await worker.fetch(`${socialRoutes.likes(book)}${q}`);
      expect(res.status).toBe(200);
      const parsed = LikesResponseSchema.parse(await res.json());
      expect(parsed.mine).toEqual([]);
      expect(parsed.counts[likeKey('photo', 'a1')]).toBe(1);
    }
    const empty = LikesResponseSchema.parse(await (await worker.fetch(socialRoutes.likes('another-book'))).json());
    expect(empty).toEqual({ counts: {}, mine: [] });
  });
});

describe('events and admin activity', () => {
  const book = 'events-book';
  const base = { bookId: book, displayName: 'Ana', deviceId: DEVICE_A };

  it('requires the admin bearer token', async () => {
    expect((await admin(book, null)).status).toBe(401);
    expect((await admin(book, 'wrong')).status).toBe(401);
    expect((await admin(book, `${TOKEN}x`)).status).toBe(401);
    const noAuthHeader = await worker.fetch(socialRoutes.adminActivity(book), { headers: { Authorization: TOKEN } });
    expect(noAuthHeader.status).toBe(401);
  });

  it('logs events and returns them newest first with collection ids parsed', async () => {
    const photo = await post(socialRoutes.events, {
      ...base,
      targetType: 'photo',
      targetId: 'a1',
      action: 'download',
      pageId: 'p1',
    });
    expect(photo.status).toBeLessThan(300);
    const photoId = EventResponseSchema.parse(await photo.json()).id;
    await new Promise((r) => setTimeout(r, 5));
    const zip = await post(socialRoutes.events, {
      ...base,
      targetType: 'collection',
      targetId: ['a1', 'a2', 'a3'],
      action: 'zip',
    });
    const zipId = EventResponseSchema.parse(await zip.json()).id;
    expect(zipId).not.toBe(photoId);
    await like(book, 'a1', DEVICE_B, true, 'Ben');

    const res = await admin(book);
    expect(res.status).toBe(200);
    const activity = ActivityResponseSchema.parse(await res.json());
    expect(activity.bookId).toBe(book);
    expect(activity.truncated).toBe(false);
    expect(activity.events.map((e) => e.id)).toEqual([zipId, photoId]);
    expect(activity.events[0]).toMatchObject({ targetType: 'collection', targetId: ['a1', 'a2', 'a3'], pageId: null });
    expect(activity.events[1]).toMatchObject({ targetType: 'photo', targetId: 'a1', pageId: 'p1', displayName: 'Ana' });
    expect(activity.likes).toHaveLength(1);
    expect(activity.likes[0]).toMatchObject({
      targetType: 'photo',
      targetId: 'a1',
      deviceId: DEVICE_B,
      displayName: 'Ben',
    });
  });

  it('rejects invalid events', async () => {
    const noName = await post(socialRoutes.events, {
      ...base,
      displayName: '',
      targetType: 'photo',
      targetId: 'a',
      action: 'download',
    });
    expect(noName.status).toBe(400);
    const badAction = await post(socialRoutes.events, { ...base, targetType: 'photo', targetId: 'a', action: 'steal' });
    expect(badAction.status).toBe(400);
    const arrayOnPhoto = await post(socialRoutes.events, {
      ...base,
      targetType: 'photo',
      targetId: ['a', 'b'],
      action: 'download',
    });
    expect(arrayOnPhoto.status).toBe(400);
  });

  it('exposes the cap the contract promises', () => {
    expect(ACTIVITY_LIMIT).toBeGreaterThan(0);
  });
});
