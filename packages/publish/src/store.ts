/**
 * The bucket as the publish pipeline sees it. `S3Store` (R2's S3 API) is the real one;
 * `WranglerStore` is a slower fallback through the logged-in wrangler CLI; `MemoryStore` is for tests.
 */
export interface PutOptions {
  contentType: string;
  cacheControl: string;
}

export interface ObjectStore {
  readonly name: string;
  /** True when the key exists (HEAD). */
  exists(key: string): Promise<boolean>;
  put(key: string, body: Uint8Array, options: PutOptions): Promise<void>;
  /** Body, or null for a missing key. */
  get(key: string): Promise<Uint8Array | null>;
  /** Every key under `prefix`. Throws `UnsupportedError` when the transport cannot list. */
  list(prefix: string): Promise<string[]>;
  delete(keys: string[]): Promise<void>;
}

export class UnsupportedError extends Error {}

export const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
export const CACHE_NONE = 'no-cache';

export const CONTENT_TYPES = {
  jpg: 'image/jpeg',
  avif: 'image/avif',
  webp: 'image/webp',
  png: 'image/png',
  json: 'application/json',
} as const;

export class MemoryStore implements ObjectStore {
  readonly name = 'memory';
  readonly objects = new Map<string, { body: Uint8Array; options: PutOptions }>();
  /** Operation log for assertions. */
  readonly ops: string[] = [];

  async exists(key: string): Promise<boolean> {
    this.ops.push(`head ${key}`);
    return this.objects.has(key);
  }
  async put(key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    this.ops.push(`put ${key}`);
    this.objects.set(key, { body, options });
  }
  async get(key: string): Promise<Uint8Array | null> {
    this.ops.push(`get ${key}`);
    return this.objects.get(key)?.body ?? null;
  }
  async list(prefix: string): Promise<string[]> {
    this.ops.push(`list ${prefix}`);
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async delete(keys: string[]): Promise<void> {
    for (const k of keys) {
      this.ops.push(`delete ${k}`);
      this.objects.delete(k);
    }
  }
  json(key: string): unknown {
    const obj = this.objects.get(key);
    return obj ? JSON.parse(new TextDecoder().decode(obj.body)) : null;
  }
}
