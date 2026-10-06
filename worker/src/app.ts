import {
  ACTIVITY_LIMIT,
  type ActivityResponse,
  DeviceIdSchema,
  EventRequestSchema,
  type EventResponse,
  type LikesResponse,
  LikeToggleRequestSchema,
  type LikeToggleResponse,
  likeKey,
  SOCIAL_API_VERSION,
  type SocialEvent,
  type SocialLike,
  socialRoutes,
} from '@photobook/shared/social';
import { errorResponse, json, preflight, readJson, safeEqual } from './http.js';

export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
}

const BOOK_LIKES = /^\/v1\/books\/([^/]+)\/likes$/;
const BOOK_ACTIVITY = /^\/v1\/admin\/books\/([^/]+)\/activity$/;

function bookIdFrom(match: RegExpMatchArray): string | null {
  try {
    const id = decodeURIComponent(match[1] ?? '');
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

const issueText = (error: { issues: { path: PropertyKey[]; message: string }[] }): string =>
  error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? `${i.path.map(String).join('.')}: ` : ''}${i.message}`)
    .join('; ');

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === 'OPTIONS') return preflight();

  try {
    if (pathname === socialRoutes.health) {
      if (method !== 'GET') return methodNotAllowed('GET');
      return json({ ok: true, version: SOCIAL_API_VERSION });
    }
    if (pathname === socialRoutes.like) {
      if (method !== 'POST') return methodNotAllowed('POST');
      return await toggleLike(request, env);
    }
    if (pathname === socialRoutes.events) {
      if (method !== 'POST') return methodNotAllowed('POST');
      return await logEvent(request, env);
    }
    const likes = BOOK_LIKES.exec(pathname);
    if (likes) {
      if (method !== 'GET') return methodNotAllowed('GET');
      const bookId = bookIdFrom(likes);
      if (!bookId) return errorResponse(400, 'invalid book id');
      return await getLikes(bookId, url.searchParams.get('device'), env);
    }
    const activity = BOOK_ACTIVITY.exec(pathname);
    if (activity) {
      if (method !== 'GET') return methodNotAllowed('GET');
      if (!(await isAdmin(request, env))) {
        return errorResponse(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
      }
      const bookId = bookIdFrom(activity);
      if (!bookId) return errorResponse(400, 'invalid book id');
      return await getActivity(bookId, env);
    }
    return errorResponse(404, 'not found');
  } catch (error) {
    console.error('unhandled error', error);
    return errorResponse(500, 'internal error');
  }
}

const methodNotAllowed = (allow: string): Response =>
  errorResponse(405, 'method not allowed', { Allow: `${allow}, OPTIONS` });

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  // An unset secret must never authorize anyone.
  if (!match || !env.ADMIN_TOKEN) return false;
  return safeEqual(match[1] ?? '', env.ADMIN_TOKEN);
}

async function toggleLike(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = LikeToggleRequestSchema.safeParse(body.value);
  if (!parsed.success) return errorResponse(400, issueText(parsed.error));
  const { bookId, targetType, targetId, deviceId, displayName, liked } = parsed.data;

  const write = liked
    ? env.DB.prepare(
        `INSERT INTO likes (book_id, target_type, target_id, device_id, display_name, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (book_id, target_type, target_id, device_id)
         DO UPDATE SET display_name = COALESCE(excluded.display_name, likes.display_name)`,
      ).bind(bookId, targetType, targetId, deviceId, displayName, new Date().toISOString())
    : env.DB.prepare(
        'DELETE FROM likes WHERE book_id = ?1 AND target_type = ?2 AND target_id = ?3 AND device_id = ?4',
      ).bind(bookId, targetType, targetId, deviceId);
  const count = env.DB.prepare(
    'SELECT COUNT(*) AS n FROM likes WHERE book_id = ?1 AND target_type = ?2 AND target_id = ?3',
  ).bind(bookId, targetType, targetId);

  const [, counted] = await env.DB.batch<{ n: number }>([write, count]);
  const response: LikeToggleResponse = { liked, count: counted?.results[0]?.n ?? 0 };
  return json(response);
}

async function getLikes(bookId: string, device: string | null, env: Env): Promise<Response> {
  const counts = await env.DB.prepare(
    'SELECT target_type, target_id, COUNT(*) AS n FROM likes WHERE book_id = ?1 GROUP BY target_type, target_id',
  )
    .bind(bookId)
    .all<{ target_type: 'page' | 'photo'; target_id: string; n: number }>();

  const response: LikesResponse = { counts: {}, mine: [] };
  for (const row of counts.results) response.counts[likeKey(row.target_type, row.target_id)] = row.n;

  const deviceId = device ? DeviceIdSchema.safeParse(device) : null;
  if (deviceId?.success) {
    const mine = await env.DB.prepare('SELECT target_type, target_id FROM likes WHERE book_id = ?1 AND device_id = ?2')
      .bind(bookId, deviceId.data)
      .all<{ target_type: 'page' | 'photo'; target_id: string }>();
    response.mine = mine.results.map((row) => likeKey(row.target_type, row.target_id));
  }
  return json(response);
}

async function logEvent(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = EventRequestSchema.safeParse(body.value);
  if (!parsed.success) return errorResponse(400, issueText(parsed.error));
  const { bookId, targetType, targetId, action, displayName, deviceId, pageId } = parsed.data;

  // A collection stores its asset ids as a JSON array; every other target is a single id.
  let storedTarget: string;
  if (targetType === 'collection') {
    storedTarget = JSON.stringify(Array.isArray(targetId) ? targetId : [targetId]);
  } else if (Array.isArray(targetId)) {
    return errorResponse(400, 'targetId must be a single id unless targetType is collection');
  } else {
    storedTarget = targetId;
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO downloads (id, book_id, target_type, target_id, action, display_name, device_id, page_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(id, bookId, targetType, storedTarget, action, displayName, deviceId, pageId, new Date().toISOString())
    .run();
  const response: EventResponse = { id };
  return json(response, 201);
}

interface EventRow {
  id: string;
  book_id: string;
  target_type: SocialEvent['targetType'];
  target_id: string;
  action: SocialEvent['action'];
  display_name: string;
  device_id: string;
  page_id: string | null;
  created_at: string;
}

function toEvent(row: EventRow): SocialEvent {
  let targetId: string | string[] = row.target_id;
  if (row.target_type === 'collection') {
    try {
      const parsed: unknown = JSON.parse(row.target_id);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) targetId = parsed;
      else targetId = [row.target_id];
    } catch {
      targetId = [row.target_id];
    }
  }
  return {
    id: row.id,
    bookId: row.book_id,
    targetType: row.target_type,
    targetId,
    action: row.action,
    displayName: row.display_name,
    deviceId: row.device_id,
    pageId: row.page_id,
    createdAt: row.created_at,
  };
}

async function getActivity(bookId: string, env: Env): Promise<Response> {
  const [events, likes] = await env.DB.batch<unknown>([
    env.DB.prepare('SELECT * FROM downloads WHERE book_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2').bind(
      bookId,
      ACTIVITY_LIMIT + 1,
    ),
    env.DB.prepare(
      `SELECT target_type, target_id, device_id, display_name, created_at FROM likes
       WHERE book_id = ?1 ORDER BY created_at DESC, target_id`,
    ).bind(bookId),
  ]);
  const eventRows = (events?.results ?? []) as EventRow[];
  const likeRows = (likes?.results ?? []) as {
    target_type: SocialLike['targetType'];
    target_id: string;
    device_id: string;
    display_name: string | null;
    created_at: string;
  }[];
  const response: ActivityResponse = {
    bookId,
    events: eventRows.slice(0, ACTIVITY_LIMIT).map(toEvent),
    likes: likeRows.map((row) => ({
      targetType: row.target_type,
      targetId: row.target_id,
      deviceId: row.device_id,
      displayName: row.display_name,
      createdAt: row.created_at,
    })),
    truncated: eventRows.length > ACTIVITY_LIMIT,
  };
  return json(response);
}
