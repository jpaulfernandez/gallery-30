import { describe, expect, it, vi } from 'vitest';
import { checkHealth, fetchActivity } from './socialApi';

const activity = {
  bookId: 'book 1',
  events: [
    {
      id: 'e1',
      bookId: 'book 1',
      targetType: 'photo',
      targetId: 'A',
      action: 'download',
      displayName: 'Ana',
      deviceId: 'device-ana',
      pageId: 'P1',
      createdAt: '2026-10-05T10:00:00Z',
    },
  ],
  likes: [
    { targetType: 'page', targetId: 'P1', deviceId: 'device-bo', displayName: null, createdAt: '2026-10-05T11:00:00Z' },
  ],
  truncated: false,
};

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('fetchActivity', () => {
  it('GETs the admin route with the bearer token and validates the answer', async () => {
    const fetchImpl = vi.fn(async () => json(activity));
    const result = await fetchActivity('https://api.example.com/', 'secret', 'book 1', { fetchImpl });
    expect(result.events).toHaveLength(1);
    expect(result.likes[0]?.displayName).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/admin/books/book%201/activity');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });

  it('explains a rejected token', async () => {
    const fetchImpl = async () => new Response('no', { status: 401 });
    await expect(fetchActivity('https://api.example.com', 'bad', 'b', { fetchImpl })).rejects.toThrow(/admin token/);
  });

  it('reports other statuses', async () => {
    const fetchImpl = async () => new Response('boom', { status: 500, statusText: 'Server Error' });
    await expect(fetchActivity('https://api.example.com', 't', 'b', { fetchImpl })).rejects.toThrow(
      'The Worker answered 500 Server Error',
    );
    const missing = async () => new Response('', { status: 404 });
    await expect(fetchActivity('https://api.example.com', 't', 'b', { fetchImpl: missing })).rejects.toThrow(
      /no activity route/,
    );
  });

  it('rejects an answer that does not match the contract, naming where', async () => {
    const fetchImpl = async () => json({ ...activity, events: [{ id: 'x' }] });
    await expect(fetchActivity('https://api.example.com', 't', 'b', { fetchImpl })).rejects.toThrow(
      /Unexpected activity response at events/,
    );
  });

  it('rejects an answer that is not JSON', async () => {
    const fetchImpl = async () => new Response('<html>', { status: 200 });
    await expect(fetchActivity('https://api.example.com', 't', 'b', { fetchImpl })).rejects.toThrow(/not JSON/);
  });

  it('wraps network failures with the origin', async () => {
    const fetchImpl = async () => {
      throw new TypeError('Load failed');
    };
    await expect(fetchActivity('https://api.example.com/x', 't', 'b', { fetchImpl })).rejects.toThrow(
      'Could not reach https://api.example.com: Load failed',
    );
  });

  it('rejects a bad base URL before fetching', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchActivity('not a url', 't', 'b', { fetchImpl })).rejects.toThrow(/SOCIAL_API_URL/);
    await expect(fetchActivity('ftp://x.example.com', 't', 'b', { fetchImpl })).rejects.toThrow(/http\(s\)/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes a caller abort through untouched', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return json(activity);
    };
    await expect(
      fetchActivity('https://api.example.com', 't', 'b', { fetchImpl, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('checkHealth', () => {
  it('resolves on 2xx and hits /v1/health', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    await expect(checkHealth('https://api.example.com/', { fetchImpl })).resolves.toBeUndefined();
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://api.example.com/v1/health');
  });

  it('rejects otherwise', async () => {
    const fetchImpl = async () => new Response('', { status: 503 });
    await expect(checkHealth('https://api.example.com', { fetchImpl })).rejects.toThrow('answered 503');
  });
});
