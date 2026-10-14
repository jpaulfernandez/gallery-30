/**
 * Alt text (plan 35): one plain sentence for screen readers. Every writer (the AI captions, the photo inspector) and
 * every reader that publishes it (the manifest, the publish fingerprint) goes through `normalizeAlt`, so the text that
 * is saved, published and fingerprinted is the same.
 */

/** Alt text is at most this many characters (cut at a word). */
export const ALT_MAX = 125;

/** `alt` on one line (runs of spaces and newlines become one space), trimmed, cut to `ALT_MAX` at a word. */
export function normalizeAlt(alt: string | null | undefined): string {
  const text = (alt ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= ALT_MAX) return text;
  const cut = text.slice(0, ALT_MAX);
  const space = cut.lastIndexOf(' ');
  return (space > ALT_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '');
}
