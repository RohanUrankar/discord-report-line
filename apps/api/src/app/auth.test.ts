import { describe, expect, it } from 'vitest';

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  addAdmin,
  makeAuthKit,
  TEST_TTL_MS,
  type AuthKit,
} from '../../test/helpers/authFakes.js';
import type { LoginResult } from './auth.js';

const login = (kit: AuthKit, password = ADMIN_PASSWORD, ip = '1.1.1.1'): Promise<LoginResult> =>
  kit.auth.login({ email: ADMIN_EMAIL, password, ip });

async function signedInKit(): Promise<{ kit: AuthKit; sessionId: string }> {
  const kit = makeAuthKit();
  await addAdmin(kit);
  const result = await login(kit);
  expect(result.kind).toBe('signed_in');
  return { kit, sessionId: result.kind === 'signed_in' ? result.sessionId : '' };
}

describe('AuthService', () => {
  it('WHEN a session reaches its expiry instant THE SYSTEM SHALL treat it as expired, once, then as gone', async () => {
    const { kit, sessionId } = await signedInKit();

    kit.clock.advance(TEST_TTL_MS - 1);
    expect((await kit.auth.authenticate(sessionId)).kind).toBe('ok');
    kit.clock.advance(1);
    expect((await kit.auth.authenticate(sessionId)).kind).toBe('expired');
    expect((await kit.auth.authenticate(sessionId)).kind).toBe('none');
  });

  it('WHEN an admin logs in THE SYSTEM SHALL sweep sessions that have already expired', async () => {
    const { kit } = await signedInKit();
    kit.clock.advance(TEST_TTL_MS + 1);

    await login(kit, ADMIN_PASSWORD, '2.2.2.2');

    expect(kit.sessions.byHash.size).toBe(1);
  });

  it('WHEN the email is unknown THE SYSTEM SHALL hash the dummy password once per process and verify every time', async () => {
    const kit = makeAuthKit();
    let hashes = 0;
    const original = kit.hasher.hash.bind(kit.hasher);
    kit.hasher.hash = (password: string) => {
      hashes += 1;
      return original(password);
    };

    await kit.auth.login({ email: 'a@example.test', password: 'x', ip: '1.1.1.1' });
    await kit.auth.login({ email: 'b@example.test', password: 'x', ip: '1.1.1.1' });

    expect(hashes).toBe(1);
    expect(kit.hasher.verifyCalls).toHaveLength(2);
  });

  it('WHEN logout gets an undefined or malformed id THE SYSTEM SHALL change nothing', async () => {
    const { kit } = await signedInKit();

    await kit.auth.logout(undefined);
    await kit.auth.logout('garbage');

    expect(kit.sessions.byHash.size).toBe(1);
  });
});
