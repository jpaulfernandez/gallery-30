import { ulid } from 'ulidx';

/** Stable id for books, pages, elements and assets. Never regenerate on reorder. */
export function newId(): string {
  return ulid();
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short random lowercase token, used for slug suffixes and the R2 prefix. */
export function randomToken(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || 'book';
}
