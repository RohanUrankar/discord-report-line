import { describe, expect, it } from 'vitest';

import { NodeSessionCrypto } from './nodeSessionCrypto.js';

const crypto = new NodeSessionCrypto('unit-test-secret-0123456789abcdefghij');

describe('NodeSessionCrypto', () => {
  it('WHEN ids are generated THE SYSTEM SHALL give distinct 256-bit well-formed values', () => {
    const ids = new Set(Array.from({ length: 50 }, () => crypto.newSessionId()));

    expect(ids.size).toBe(50);
    expect([...ids].every((id) => crypto.isWellFormed(id))).toBe(true);
  });

  it.each(['', 'short', 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}!`])(
    'WHEN the cookie value is %j THE SYSTEM SHALL treat it as malformed',
    (value) => {
      expect(crypto.isWellFormed(value)).toBe(false);
    },
  );

  it('WHEN an id is hashed THE SYSTEM SHALL not store it as is, and hash it the same way each time', () => {
    const id = crypto.newSessionId();

    expect(crypto.hashSessionId(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.hashSessionId(id)).toBe(crypto.hashSessionId(id));
    expect(crypto.hashSessionId(id)).not.toContain(id);
  });

  it('WHEN the secret differs THE SYSTEM SHALL derive a different CSRF token for the same session', () => {
    const id = crypto.newSessionId();
    const other = new NodeSessionCrypto('a-different-secret-0123456789abcdefgh');

    expect(crypto.csrfTokenFor(id)).toBe(crypto.csrfTokenFor(id));
    expect(other.csrfTokenFor(id)).not.toBe(crypto.csrfTokenFor(id));
    expect(crypto.csrfTokenFor(id)).not.toBe(crypto.hashSessionId(id));
  });

  it('WHEN tokens are compared THE SYSTEM SHALL match only identical ones and treat undefined or other lengths as a mismatch', () => {
    expect(crypto.tokensEqual('abc', 'abc')).toBe(true);
    expect(crypto.tokensEqual('abc', 'abd')).toBe(false);
    expect(crypto.tokensEqual('abc', 'abcd')).toBe(false);
    expect(crypto.tokensEqual('abc', undefined)).toBe(false);
  });
});
