import { type ActivityResponse, ActivityResponseSchema, socialRoutes, socialUrl } from '@photobook/shared';

/**
 * The editor's side of the social Worker (contract: `packages/shared/src/publish/social.ts`):
 * the admin activity read behind the Downloads tab, and the health probe behind Settings' Test
 * button. Both reject with a message fit to show as is. The webview CSP allows `https:` for
 * `connect-src`, and the Worker answers CORS `*`.
 */

type FetchLike = typeof fetch;

export interface SocialApiOptions {
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

const TIMEOUT_MS = 20_000;

/** `fetch` with a timeout, also aborted by the caller's signal (no `AbortSignal.any`: older WebKit lacks it). */
async function request(url: string, init: RequestInit, { fetchImpl, signal }: SocialApiOptions): Promise<Response> {
  const doFetch = fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (timedOut) throw new Error(`The Worker at ${safeOrigin(url)} did not answer in ${TIMEOUT_MS / 1000} s`);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach ${safeOrigin(url)}: ${detail}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Reject early on a value that is not an http(s) URL, with a message that names the setting. */
export function assertApiUrl(base: string): void {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error('SOCIAL_API_URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new Error('SOCIAL_API_URL must be an http(s) URL');
}

/** GET `/v1/admin/books/<bookId>/activity` with the admin token; the response is validated. */
export async function fetchActivity(
  base: string,
  token: string,
  bookId: string,
  options: SocialApiOptions = {},
): Promise<ActivityResponse> {
  assertApiUrl(base);
  const url = socialUrl(base, socialRoutes.adminActivity(bookId));
  const res = await request(
    url,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    options,
  );
  if (res.status === 401 || res.status === 403) {
    throw new Error('The Worker rejected the admin token. Check SOCIAL_ADMIN_TOKEN in Settings.');
  }
  if (res.status === 404) {
    throw new Error(
      'The Worker has no activity route. Is SOCIAL_API_URL the photobook Worker, deployed with the admin route?',
    );
  }
  if (!res.ok) throw new Error(`The Worker answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('The Worker answered with something that is not JSON. Check SOCIAL_API_URL.');
  }
  const parsed = ActivityResponseSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
    throw new Error(`Unexpected activity response${where}: ${issue?.message ?? 'invalid'}`);
  }
  return parsed.data;
}

/** GET `/v1/health`; resolves when the Worker answers 2xx, rejects with the reason otherwise. */
export async function checkHealth(base: string, options: SocialApiOptions = {}): Promise<void> {
  assertApiUrl(base);
  const res = await request(socialUrl(base, socialRoutes.health), { headers: { Accept: 'application/json' } }, options);
  if (!res.ok) throw new Error(`The Worker answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
}
