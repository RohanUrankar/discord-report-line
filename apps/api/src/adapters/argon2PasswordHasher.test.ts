import { describe, expect, it } from 'vitest';

import { Argon2PasswordHasher } from './argon2PasswordHasher.js';

const hasher = new Argon2PasswordHasher();

describe('Argon2PasswordHasher', () => {
  it('WHEN a password is hashed THE SYSTEM SHALL produce an argon2id hash that verifies only that password', async () => {
    const hash = await hasher.hash('a throwaway password');

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(hash).not.toContain('throwaway');
    expect(await hasher.verify(hash, 'a throwaway password')).toBe(true);
    expect(await hasher.verify(hash, 'a throwaway passwore')).toBe(false);
  });

  it('WHEN the same password is hashed twice THE SYSTEM SHALL salt each hash differently', async () => {
    expect(await hasher.hash('same')).not.toBe(await hasher.hash('same'));
  });

  it('WHEN the stored hash is malformed THE SYSTEM SHALL answer "no match" instead of throwing', async () => {
    expect(await hasher.verify('not-a-hash', 'anything')).toBe(false);
    expect(await hasher.verify('', 'anything')).toBe(false);
  });
});
