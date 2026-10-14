import { describe, expect, it } from 'vitest';
import { createPassword, grantIsValid, nextPasswordVersion, verifyPassword } from './password.js';

describe('book passwords', () => {
  it('creates a salted record that verifies the trimmed, case-sensitive word', async () => {
    const password = await createPassword(' kyoto ', null);
    expect(password.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(password.expiresAt).toBeNull();
    expect(await verifyPassword('kyoto', password)).toBe(true);
    expect(await verifyPassword(' kyoto', password)).toBe(true);
    expect(await verifyPassword('Kyoto', password)).toBe(false);
    expect((await createPassword('kyoto', null)).salt).not.toBe(password.salt);
  });

  it('always moves the version past the previous one, so old grants are asked again', async () => {
    const now = new Date('2026-10-08T00:00:00Z');
    expect(nextPasswordVersion(null, now)).toBe(Math.floor(now.getTime() / 1000));
    const ahead = { hash: '0'.repeat(64), salt: 's', version: 9_999_999_999, expiresAt: null };
    expect(nextPasswordVersion(ahead, now)).toBe(10_000_000_000);

    const first = await createPassword('kyoto', null);
    const second = await createPassword('osaka', first);
    expect(second.version).toBeGreaterThan(first.version);
    const grant = { version: first.version, grantedAt: new Date().toISOString() };
    expect(grantIsValid(grant, first)).toBe(true);
    expect(grantIsValid(grant, second)).toBe(false);
    expect(grantIsValid(null, null)).toBe(true);
  });

  it('keeps the previous expiry unless a new one is given', async () => {
    const first = await createPassword('kyoto', null, '2027-01-01T00:00:00.000Z');
    expect((await createPassword('osaka', first)).expiresAt).toBe('2027-01-01T00:00:00.000Z');
    expect((await createPassword('osaka', first, null)).expiresAt).toBeNull();
  });
});
