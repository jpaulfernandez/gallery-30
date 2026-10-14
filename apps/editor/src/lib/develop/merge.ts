/** Plain-data helpers for editing develop settings in the store. */

/** Any subset of `T`, recursively. Arrays are replaced as a whole, never merged element by element. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `base` with `patch` laid over it: objects merge key by key, everything else (numbers, strings, arrays
 * such as curve points) is replaced. `undefined` in the patch leaves the base value alone. Returns new
 * objects along the patched paths and shares the rest (the inputs may be frozen).
 */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = deepMerge(out[key], value as DeepPartial<unknown>);
  }
  return out as T;
}

/** Structural equality for JSON-like values (key order does not matter). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}
