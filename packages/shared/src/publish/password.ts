import type { AccessPassword } from '../schema.js';

/**
 * Soft passwords (one per book): SHA-256 over `salt + word`, hex. Web Crypto only, so the publish CLI
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
export async function verifyPassword(word: string, password: AccessPassword): Promise<boolean> {
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

/**
 * The `version` for a password set now, replacing `previous` (or the last one before it was turned
 * off). Seconds since the epoch, and always above the previous version, so a device granted an
 * earlier word is asked again even after the password was removed and set anew.
 */
export function nextPasswordVersion(previous: AccessPassword | null, now = new Date()): number {
  return Math.max((previous?.version ?? 0) + 1, Math.floor(now.getTime() / 1000));
}

/** A new password record for `word` (trimmed), with a fresh salt. */
export async function createPassword(
  word: string,
  previous: AccessPassword | null,
  expiresAt: string | null = previous?.expiresAt ?? null,
): Promise<AccessPassword> {
  const salt = newSalt();
  return { hash: await hashPassword(word.trim(), salt), salt, version: nextPasswordVersion(previous), expiresAt };
}

/** True when a stored grant still opens the book: same version, and not past `expiresAt`. */
export function grantIsValid(
  grant: AccessGrant | null | undefined,
  password: AccessPassword | null,
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
