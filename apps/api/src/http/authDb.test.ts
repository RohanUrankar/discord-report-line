import { createHash } from 'node:crypto';

import type { SessionInfo } from '@report-line/shared';
import request, { type Response } from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { PgAdminRepository } from '../adapters/pg/pgAdminRepository.js';
import { Argon2PasswordHasher } from '../adapters/argon2PasswordHasher.js';
import { seedAdmin } from '../app/seedAdmin.js';
import { composeAuth, composeDashboard, composeGuildConfig } from '../compose.js';
import {
  ManualClock,
  TEST_GUILD_CONFIG,
  TEST_SESSION_SECRET,
  TEST_TTL_MS,
} from '../../test/helpers/authFakes.js';
import { truncateAll, useTestDatabase } from '../../test/helpers/db.js';
import { createLogger } from './middleware.js';
import { createServer } from './server.js';
import { LogSink } from '../../test/helpers/logging.js';

const EMAIL = 'Admin@Example.test';
const PASSWORD = 'a throwaway password';
const COOKIE = '__Host-session';
const getPool = useTestDatabase();

function app(clock: ManualClock): ReturnType<typeof createServer> {
  const { auth, cookie } = composeAuth(
    {
      SESSION_SECRET: TEST_SESSION_SECRET,
      SESSION_TTL_MS: TEST_TTL_MS,
      SESSION_COOKIE_SECURE: true,
    },
    getPool(),
    clock,
  );
  return createServer({
    controller: { handle: () => Promise.resolve({ status: 401 }) },
    logger: createLogger('silent', new LogSink()),
    auth,
    dashboard: composeDashboard(getPool()),
    guildConfig: composeGuildConfig(TEST_GUILD_CONFIG, getPool()),
    cookie,
  });
}

const seed = (password = PASSWORD): Promise<{ id: string; email: string }> =>
  seedAdmin(
    { email: EMAIL, password },
    { admins: new PgAdminRepository(getPool()), hasher: new Argon2PasswordHasher() },
  );

function cookieOf(res: Response): string {
  const lines = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return (lines.find((line) => line.startsWith(`${COOKIE}=`)) ?? '').split(';')[0] ?? '';
}

beforeEach(async () => {
  await truncateAll(getPool());
});

describe('a request carrying two session cookies', () => {
  it.each([
    ['the valid one first', (valid: string) => `${valid}; ${COOKIE}=planted`],
    ['the valid one last', (valid: string) => `${COOKIE}=planted; ${valid}`],
    ['two copies of the valid one', (valid: string) => `${valid}; ${valid}`],
  ])(
    'WHEN the session cookie appears twice (%s) THE SYSTEM SHALL treat the session as absent',
    async (_name, header) => {
      const server = app(new ManualClock(Date.now()));
      await seed();
      const login = await request(server)
        .post('/api/auth/login')
        .send({ email: EMAIL, password: PASSWORD });
      const valid = cookieOf(login);

      const single = await request(server).get('/api/auth/me').set('Cookie', valid);
      const doubled = await request(server).get('/api/auth/me').set('Cookie', header(valid));

      expect(single.status).toBe(200);
      expect(doubled.status).toBe(401);
    },
  );
});

describe('dashboard sign-in against Postgres', () => {
  it('WHEN the seeded admin signs in, asks who they are and signs out THE SYSTEM SHALL keep only hashes at rest', async () => {
    const clock = new ManualClock(Date.now());
    const server = app(clock);
    await seed();

    const login = await request(server)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    const cookie = cookieOf(login);
    const { csrfToken } = login.body as SessionInfo;
    const me = await request(server).get('/api/auth/me').set('Cookie', cookie);
    const logout = await request(server)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken);
    const afterLogout = await request(server).get('/api/auth/me').set('Cookie', cookie);

    expect([login.status, me.status, logout.status, afterLogout.status]).toEqual([
      200, 200, 204, 401,
    ]);
    expect((me.body as SessionInfo).admin.email).toBe('admin@example.test');
    const admin = await getPool().query<{ password_hash: string }>(
      'SELECT password_hash FROM admin',
    );
    expect(admin.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(admin.rows)).not.toContain(PASSWORD);
  });

  it('WHEN a session is stored THE SYSTEM SHALL keep the SHA-256 of the cookie value, never the value', async () => {
    const server = app(new ManualClock(Date.now()));
    await seed();

    const login = await request(server)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: PASSWORD });

    const rawId = cookieOf(login).split('=')[1] ?? '';
    const rows = await getPool().query<{ id: string }>('SELECT id FROM session');
    expect(rows.rows.map((row) => row.id)).toEqual([
      createHash('sha256').update(rawId).digest('hex'),
    ]);
  });

  it('WHEN the session passes its expiry THE SYSTEM SHALL answer 401 and delete the row', async () => {
    const clock = new ManualClock(Date.now());
    const server = app(clock);
    await seed();
    const login = await request(server)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    clock.advance(TEST_TTL_MS + 1);

    const res = await request(server).get('/api/auth/me').set('Cookie', cookieOf(login));

    expect(res.status).toBe(401);
    expect((await getPool().query('SELECT 1 FROM session')).rowCount).toBe(0);
  });

  it('WHEN the password is wrong or the email is unknown THE SYSTEM SHALL answer an identical 401', async () => {
    const server = app(new ManualClock(Date.now()));
    await seed();

    const wrong = await request(server)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: 'nope nope nope' });
    const unknown = await request(server)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.test', password: 'nope nope nope' });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((wrong.body as { error: { code: string } }).error.code).toBe(
      (unknown.body as { error: { code: string } }).error.code,
    );
  });

  it('WHEN the admin is seeded again THE SYSTEM SHALL keep one admin, set the new password and end old sessions', async () => {
    const server = app(new ManualClock(Date.now()));
    const first = await seed();
    const login = await request(server)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: PASSWORD });

    const second = await seed('a different throwaway');

    expect(second.id).toBe(first.id);
    expect((await getPool().query('SELECT 1 FROM admin')).rowCount).toBe(1);
    expect((await request(server).get('/api/auth/me').set('Cookie', cookieOf(login))).status).toBe(
      401,
    );
    const oldPassword = await request(server)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    const newPassword = await request(server)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: 'a different throwaway' });
    expect([oldPassword.status, newPassword.status]).toEqual([401, 200]);
  });
});
