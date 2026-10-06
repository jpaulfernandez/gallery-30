import type { SitePassword } from './site.js';

/**
 * The soft site password: SHA-256 over `salt + word`, hex. Web Crypto only, so the publish CLI
 * (Node), the editor and the viewer compute the same thing. Soft by design (see the PRD).
 */

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

export function hashPassword(word: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}${word}`);
}

/** The word a viewer typed, trimmed; the password is case-sensitive apart from that. */
export async function verifyPassword(word: string, password: SitePassword): Promise<boolean> {
  return (await hashPassword(word.trim(), password.salt)) === password.hash;
}

/** 16 random bytes as hex. */
export function newSalt(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

/** What the viewer keeps in local storage after a correct word. */
export interface AccessGrant {
  version: number;
  grantedAt: string;
}

/** True when a stored grant still opens the site: same version, and not past `expiresAt`. */
export function grantIsValid(
  grant: AccessGrant | null | undefined,
  password: SitePassword | null,
  now = new Date(),
): boolean {
  if (password === null) return true;
  if (!grant || grant.version !== password.version) return false;
  if (
    password.expiresAt !== null &&
    new Date(grant.grantedAt) < new Date(password.expiresAt) &&
    now >= new Date(password.expiresAt)
  ) {
    return false;
  }
  return true;
}
