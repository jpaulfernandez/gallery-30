import { z } from 'zod';

/**
 * The social API (likes and the download log) served by the Cloudflare Worker in `worker/`.
 * Shared so the Worker (server), the viewer (client) and the editor's Downloads tab (admin client)
 * agree on paths and payloads. Nothing a viewer types is shown to other viewers; the only text they
 * enter is a display name.
 */

export const SOCIAL_API_VERSION = 1 as const;

export const DISPLAY_NAME_MAX = 40;

/** Random per-device identifier the viewer keeps in local storage (never a user id). */
export const DeviceIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'device id must be 8 to 64 url-safe characters');

/** Self-reported; trimmed, 1 to 40 characters. */
export const DisplayNameSchema = z.string().trim().min(1).max(DISPLAY_NAME_MAX);

export const LikeTargetTypeSchema = z.enum(['page', 'photo']);
export const EventTargetTypeSchema = z.enum(['page', 'photo', 'collection']);
export const EventActionSchema = z.enum(['download', 'share', 'zip', 'page_share']);

export type DeviceId = z.infer<typeof DeviceIdSchema>;
export type LikeTargetType = z.infer<typeof LikeTargetTypeSchema>;
export type EventTargetType = z.infer<typeof EventTargetTypeSchema>;
export type EventAction = z.infer<typeof EventActionSchema>;

/** Key of a like target in `LikesResponse.counts` and `.mine`: `"photo:<assetId>"` or `"page:<pageId>"`. */
export const likeKey = (type: LikeTargetType, id: string): string => `${type}:${id}`;

export function parseLikeKey(key: string): { type: LikeTargetType; id: string } | null {
  const i = key.indexOf(':');
  if (i <= 0) return null;
  const type = key.slice(0, i);
  if (type !== 'page' && type !== 'photo') return null;
  return { type, id: key.slice(i + 1) };
}

/** POST `socialRoutes.like`: set or clear one device's like on a target. Idempotent. */
export const LikeToggleRequestSchema = z.object({
  bookId: z.string().min(1),
  targetType: LikeTargetTypeSchema,
  targetId: z.string().min(1),
  deviceId: DeviceIdSchema,
  displayName: DisplayNameSchema.nullable().default(null),
  liked: z.boolean(),
});
export const LikeToggleResponseSchema = z.object({
  liked: z.boolean(),
  /** Total likes on the target after the change. */
  count: z.number().int().nonnegative(),
});

/** GET `socialRoutes.likes(bookId)?device=<deviceId>`: every count in the book plus this device's likes. */
export const LikesResponseSchema = z.object({
  /** `likeKey` -> count; targets with no likes are absent. */
  counts: z.record(z.string(), z.number().int().nonnegative()),
  /** `likeKey`s the requesting device has liked (empty without `device`). */
  mine: z.array(z.string()),
});

/** POST `socialRoutes.events`: log a download, share, zip or page share. */
export const EventRequestSchema = z.object({
  bookId: z.string().min(1),
  targetType: EventTargetTypeSchema,
  /** Asset id, page id, or the asset ids of a collection (zip, share all). */
  targetId: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(500)]),
  action: EventActionSchema,
  displayName: DisplayNameSchema,
  deviceId: DeviceIdSchema,
  /** Page the photo was on, for the per-page counts; null for collections. */
  pageId: z.string().min(1).nullable().default(null),
});
export const EventResponseSchema = z.object({ id: z.string().min(1) });

/** One logged event as the admin endpoint returns it. */
export const SocialEventSchema = z.object({
  id: z.string().min(1),
  bookId: z.string().min(1),
  targetType: EventTargetTypeSchema,
  targetId: z.union([z.string(), z.array(z.string())]),
  action: EventActionSchema,
  displayName: z.string(),
  deviceId: z.string(),
  pageId: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const SocialLikeSchema = z.object({
  targetType: LikeTargetTypeSchema,
  targetId: z.string().min(1),
  deviceId: z.string(),
  displayName: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

/**
 * GET `socialRoutes.adminActivity(bookId)` with `Authorization: Bearer <admin token>`: the whole
 * download log of a book, newest first, and every like. The editor derives counts per photo and
 * per page and the top-photos list from this.
 */
export const ActivityResponseSchema = z.object({
  bookId: z.string().min(1),
  events: z.array(SocialEventSchema),
  likes: z.array(SocialLikeSchema),
  /** True when more events exist than `events` holds (the newest `ACTIVITY_LIMIT` are returned). */
  truncated: z.boolean(),
});

export const ACTIVITY_LIMIT = 2000;

export type LikeToggleRequest = z.input<typeof LikeToggleRequestSchema>;
export type LikeToggleResponse = z.infer<typeof LikeToggleResponseSchema>;
export type LikesResponse = z.infer<typeof LikesResponseSchema>;
export type EventRequest = z.input<typeof EventRequestSchema>;
export type EventResponse = z.infer<typeof EventResponseSchema>;
export type SocialEvent = z.infer<typeof SocialEventSchema>;
export type SocialLike = z.infer<typeof SocialLikeSchema>;
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

/** Paths on the Worker, relative to its origin (`site.api`). */
export const socialRoutes = {
  health: '/v1/health',
  like: '/v1/likes',
  events: '/v1/events',
  likes: (bookId: string): string => `/v1/books/${encodeURIComponent(bookId)}/likes`,
  adminActivity: (bookId: string): string => `/v1/admin/books/${encodeURIComponent(bookId)}/activity`,
} as const;

/** Join the API origin (with or without a trailing slash) and a route. */
export function socialUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}
