/**
 * Stable JSON: object keys sorted at every level (by UTF-16 code unit), arrays in order, `undefined`
 * properties left out, numbers as `JSON.stringify` writes them. Used by the publish fingerprint and
 * `developHash`; `crates/develop` has a byte-identical Rust port (`canonical_json`).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
