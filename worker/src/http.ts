export const MAX_BODY_BYTES = 64 * 1024;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

export const errorResponse = (status: number, message: string, extra: Record<string, string> = {}): Response =>
  json({ error: message }, status, extra);

export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' } });
}

export type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

/** Read a JSON body of at most `MAX_BODY_BYTES` bytes. */
export async function readJson(request: Request): Promise<BodyResult> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse(413, 'request body too large') };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: errorResponse(400, 'could not read request body') };
  }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse(413, 'request body too large') };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: errorResponse(400, 'invalid JSON') };
  }
}

/** Constant-time string comparison: both sides are hashed to equal length first. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= (va[i] ?? 0) ^ (vb[i] ?? 0);
  return diff === 0;
}
