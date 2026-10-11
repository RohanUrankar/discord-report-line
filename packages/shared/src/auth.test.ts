import { describe, expect, it } from 'vitest';

import { LoginRequest, SessionInfo } from './index.js';

describe('LoginRequest', () => {
  it('WHEN the email has stray spaces or capitals THE SYSTEM SHALL normalise it', () => {
    const parsed = LoginRequest.parse({ email: '  Admin@Example.TEST ', password: 'x' });

    expect(parsed.email).toBe('admin@example.test');
  });

  it.each([
    ['an unknown key', { email: 'a@example.test', password: 'x', role: 'admin' }],
    ['an empty password', { email: 'a@example.test', password: '' }],
    ['a password over 256 characters', { email: 'a@example.test', password: 'x'.repeat(257) }],
    ['an email that is not one', { email: 'nope', password: 'x' }],
    ['an email over 254 characters', { email: `${'a'.repeat(250)}@example.test`, password: 'x' }],
    ['no body', undefined],
  ])('WHEN the body has %s THE SYSTEM SHALL reject it', (_name, body) => {
    expect(LoginRequest.safeParse(body).success).toBe(false);
  });
});

describe('SessionInfo', () => {
  it('WHEN the response carries anything beyond the admin and the CSRF token THE SYSTEM SHALL reject it', () => {
    const base = {
      admin: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', email: 'a@example.test' },
      csrfToken: 't',
    };

    expect(SessionInfo.safeParse(base).success).toBe(true);
    expect(SessionInfo.safeParse({ ...base, passwordHash: 'x' }).success).toBe(false);
  });
});
