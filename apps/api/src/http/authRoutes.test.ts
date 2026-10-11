import type { SessionInfo } from '@report-line/shared';
import request, { type Response } from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  addAdmin,
  makeAuthKit,
  TEST_TTL_MS,
  unusedDashboard,
  unusedGuildConfig,
  type AuthKit,
} from '../../test/helpers/authFakes.js';
import { LogSink } from '../../test/helpers/logging.js';
import { LOGIN_LIMIT_PER_IP, LOGIN_LIMIT_PER_IP_AND_EMAIL } from '../app/auth.js';
import type { InteractionHandler } from '../app/interactions.js';
import { createLogger } from './middleware.js';
import { createServer } from './server.js';

const COOKIE_NAME = '__Host-session';
const CSRF_HEADER = 'X-CSRF-Token';
const unusedController: InteractionHandler = { handle: () => Promise.resolve({ status: 401 }) };

async function setup(options: { secure?: boolean; trustProxyHops?: number } = {}): Promise<{
  kit: AuthKit;
  sink: LogSink;
  app: ReturnType<typeof createServer>;
}> {
  const kit = makeAuthKit();
  await addAdmin(kit);
  const sink = new LogSink();
  const cookie = { ...kit.cookie, secure: options.secure ?? true };
  const app = createServer({
    controller: unusedController,
    logger: createLogger('debug', sink),
    auth: kit.auth,
    dashboard: unusedDashboard(),
    guildConfig: unusedGuildConfig(),
    cookie,
    ...(options.trustProxyHops === undefined ? {} : { trustProxyHops: options.trustProxyHops }),
  });
  return { kit, sink, app };
}

function login(app: ReturnType<typeof createServer>, body: unknown = validCredentials()) {
  return request(app)
    .post('/api/auth/login')
    .send(body as object);
}

function validCredentials(): { email: string; password: string } {
  return { email: ADMIN_EMAIL, password: ADMIN_PASSWORD };
}

/** The `name=value` pair of the session cookie from a Set-Cookie header, ready to send back. */
function cookiePair(res: Response, name = COOKIE_NAME): string {
  const header = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const found = header.find((line) => line.startsWith(`${name}=`));
  return (found ?? '').split(';')[0] ?? '';
}

function setCookieLine(res: Response): string {
  const header = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return header[0] ?? '';
}

async function signIn(app: ReturnType<typeof createServer>): Promise<{
  cookie: string;
  csrfToken: string;
}> {
  const res = await login(app);
  return { cookie: cookiePair(res), csrfToken: (res.body as SessionInfo).csrfToken };
}

describe('GET /api/auth/me', () => {
  it('WHEN there is no session cookie THE SYSTEM SHALL answer 401 UNAUTHENTICATED', async () => {
    const { app } = await setup();

    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it('WHEN the cookie holds junk THE SYSTEM SHALL answer 401, never a 500', async () => {
    const { app } = await setup();

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', [`${COOKIE_NAME}=not-a-session; other=1`]);

    expect(res.status).toBe(401);
  });

  it('WHEN the session has expired THE SYSTEM SHALL answer 401, delete it, clear the cookie and log it', async () => {
    const { app, kit, sink } = await setup();
    const { cookie } = await signIn(app);
    kit.clock.advance(TEST_TTL_MS + 1);

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);

    expect(res.status).toBe(401);
    expect(kit.sessions.byHash.size).toBe(0);
    expect(setCookieLine(res)).toMatch(/^__Host-session=;/);
    expect(sink.records().some((r) => r.event === 'auth.session.expired')).toBe(true);
  });

  it('WHEN the session is live THE SYSTEM SHALL return the admin and the CSRF token, uncached', async () => {
    const { app } = await setup();
    const { cookie, csrfToken } = await signIn(app);

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      admin: { id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, email: ADMIN_EMAIL },
      csrfToken,
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/auth/login', () => {
  it('WHEN the credentials are right THE SYSTEM SHALL set an HttpOnly, Secure, SameSite=Lax cookie and store only its hash', async () => {
    const { app, kit } = await setup();

    const res = await login(app);

    expect(res.status).toBe(200);
    const line = setCookieLine(res);
    expect(line).toMatch(/^__Host-session=[A-Za-z0-9_-]{43};/);
    expect(line).toContain('HttpOnly');
    expect(line).toContain('Secure');
    expect(line).toContain('SameSite=Lax');
    expect(line).toContain('Path=/');
    const rawSessionId = cookiePair(res).split('=')[1] ?? '';
    expect([...kit.sessions.byHash.keys()]).toHaveLength(1);
    expect([...kit.sessions.byHash.keys()]).not.toContain(rawSessionId);
    expect(JSON.stringify(res.body)).not.toContain(rawSessionId);
  });

  it('WHEN the operator opts out of Secure for local http THE SYSTEM SHALL drop only Secure and the __Host- prefix', async () => {
    const { app } = await setup({ secure: false });

    const res = await login(app);

    const line = setCookieLine(res);
    expect(line).toMatch(/^session=/);
    expect(line).not.toContain('Secure');
    expect(line).toContain('HttpOnly');
    expect(line).toContain('SameSite=Lax');
  });

  it('WHEN the password is wrong THE SYSTEM SHALL answer the same 401 as for an unknown email, with no cookie', async () => {
    const { app } = await setup();

    const wrongPassword = await login(app, { email: ADMIN_EMAIL, password: 'not the password' });
    const unknownUser = await login(app, {
      email: 'nobody@example.test',
      password: 'not the password',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    const strip = (res: Response): unknown => {
      const { error } = res.body as { error: { code: string; message: string } };
      return { code: error.code, message: error.message };
    };
    expect(strip(wrongPassword)).toEqual(strip(unknownUser));
    expect((wrongPassword.body as { error: { code: string } }).error.code).toBe(
      'INVALID_CREDENTIALS',
    );
    expect(setCookieLine(wrongPassword)).toBe('');
    expect(setCookieLine(unknownUser)).toBe('');
  });

  it('WHEN the email is unknown THE SYSTEM SHALL still run a password hash check, so timing does not reveal it', async () => {
    const { app, kit } = await setup();

    await login(app, { email: 'nobody@example.test', password: 'whatever' });

    expect(kit.hasher.verifyCalls).toHaveLength(1);
    expect(kit.hasher.verifyCalls[0]?.password).toBe('whatever');
  });

  it('WHEN the email differs only in case or spaces THE SYSTEM SHALL still sign the admin in', async () => {
    const { app } = await setup();

    const res = await login(app, {
      email: `  ${ADMIN_EMAIL.toUpperCase()} `,
      password: ADMIN_PASSWORD,
    });

    expect(res.status).toBe(200);
  });

  it('WHEN a login arrives with an old session cookie THE SYSTEM SHALL end the old session (no fixation)', async () => {
    const { app, kit } = await setup();
    const first = await signIn(app);

    const second = await login(app).set('Cookie', first.cookie);

    expect(second.status).toBe(200);
    expect(cookiePair(second)).not.toBe(first.cookie);
    expect(kit.sessions.byHash.size).toBe(1);
    expect((await request(app).get('/api/auth/me').set('Cookie', first.cookie)).status).toBe(401);
  });

  it.each([
    ['a missing password', { email: ADMIN_EMAIL }],
    ['an invalid email', { email: 'not-an-email', password: 'x' }],
    ['an unknown key', { email: ADMIN_EMAIL, password: 'x', admin: true }],
    ['an oversized password', { email: ADMIN_EMAIL, password: 'x'.repeat(257) }],
    ['a non-string password', { email: ADMIN_EMAIL, password: { $ne: '' } }],
  ])(
    'WHEN the body has %s THE SYSTEM SHALL answer 400 VALIDATION_FAILED and not look up the admin',
    async (_name, body) => {
      const { app, kit } = await setup();

      const res = await login(app, body);

      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
      expect(kit.hasher.verifyCalls).toHaveLength(0);
    },
  );

  it('WHEN the body is not JSON THE SYSTEM SHALL answer 400, never 500 (and a form post cannot log in)', async () => {
    const { app } = await setup();

    const broken = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    const form = await request(app)
      .post('/api/auth/login')
      .type('form')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    expect(broken.status).toBe(400);
    expect(form.status).toBe(400);
  });

  it('WHEN the body is larger than the limit THE SYSTEM SHALL answer 413', async () => {
    const { app } = await setup();

    const res = await login(app, { email: ADMIN_EMAIL, password: 'x'.repeat(20_000) });

    expect(res.status).toBe(413);
  });
});

describe('login rate limit', () => {
  it('WHEN one email is tried too often from one address THE SYSTEM SHALL answer 429 with Retry-After, even for the right password', async () => {
    const { app, kit } = await setup();
    const wrong = { email: ADMIN_EMAIL, password: 'wrong' };
    for (let attempt = 0; attempt < LOGIN_LIMIT_PER_IP_AND_EMAIL; attempt += 1) {
      expect((await login(app, wrong)).status).toBe(401);
    }

    const blocked = await login(app);

    expect(blocked.status).toBe(429);
    expect((blocked.body as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(kit.hasher.verifyCalls).toHaveLength(LOGIN_LIMIT_PER_IP_AND_EMAIL);
  });

  it('WHEN the window has passed THE SYSTEM SHALL accept logins again', async () => {
    const { app, kit } = await setup();
    for (let attempt = 0; attempt <= LOGIN_LIMIT_PER_IP_AND_EMAIL; attempt += 1) {
      await login(app, { email: ADMIN_EMAIL, password: 'wrong' });
    }
    kit.clock.advance(61_000);

    const res = await login(app);

    expect(res.status).toBe(200);
  });

  it('WHEN one address sprays many emails THE SYSTEM SHALL answer 429 at the per-address limit', async () => {
    const { app } = await setup();
    for (let attempt = 0; attempt < LOGIN_LIMIT_PER_IP; attempt += 1) {
      await login(app, { email: `user${String(attempt)}@example.test`, password: 'wrong' });
    }

    const res = await login(app, { email: 'another@example.test', password: 'wrong' });

    expect(res.status).toBe(429);
  });
});

describe('login throttle behind a reverse proxy', () => {
  const sprayFrom = async (app: ReturnType<typeof createServer>, client: string): Promise<void> => {
    for (let attempt = 0; attempt < LOGIN_LIMIT_PER_IP; attempt += 1) {
      await login(app, { email: `user${String(attempt)}@example.test`, password: 'wrong' }).set(
        'X-Forwarded-For',
        client,
      );
    }
  };

  it('WHEN TRUST_PROXY_HOPS is 1 THE SYSTEM SHALL throttle each forwarded client separately', async () => {
    const { app } = await setup({ trustProxyHops: 1 });
    await sprayFrom(app, '203.0.113.7');

    const sameClient = await login(app, { email: 'x@example.test', password: 'wrong' }).set(
      'X-Forwarded-For',
      '203.0.113.7',
    );
    const otherClient = await login(app).set('X-Forwarded-For', '203.0.113.8');

    expect(sameClient.status).toBe(429);
    expect(otherClient.status).toBe(200);
  });

  it('WHEN the proxy is not trusted THE SYSTEM SHALL warn once that forwarded headers are being ignored', async () => {
    const { app, sink } = await setup();

    await login(app).set('X-Forwarded-For', '203.0.113.7');
    await login(app).set('X-Forwarded-For', '203.0.113.8');

    expect(sink.messages().filter((m) => m === 'config.proxy_not_trusted')).toHaveLength(1);
  });

  it('WHEN the proxy is trusted THE SYSTEM SHALL not warn', async () => {
    const { app, sink } = await setup({ trustProxyHops: 1 });

    await login(app).set('X-Forwarded-For', '203.0.113.7');

    expect(sink.messages()).not.toContain('config.proxy_not_trusted');
  });
});

describe('POST /api/auth/logout (CSRF)', () => {
  it('WHEN there is no session THE SYSTEM SHALL answer 401 before it checks CSRF', async () => {
    const { app } = await setup();

    const res = await request(app).post('/api/auth/logout');

    expect(res.status).toBe(401);
  });

  it('WHEN the CSRF header is missing THE SYSTEM SHALL answer 403 CSRF_REJECTED and keep the session', async () => {
    const { app, kit, sink } = await setup();
    const { cookie } = await signIn(app);

    const res = await request(app).post('/api/auth/logout').set('Cookie', cookie);

    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('CSRF_REJECTED');
    expect(kit.sessions.byHash.size).toBe(1);
    expect(sink.records().some((r) => r.event === 'auth.csrf.rejected')).toBe(true);
  });

  it.each([
    ['wrong', 'x'.repeat(43)],
    ['empty', ''],
    ['too short', 'abc'],
  ])('WHEN the CSRF token is %s THE SYSTEM SHALL answer 403', async (_name, token) => {
    const { app } = await setup();
    const { cookie } = await signIn(app);

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .set(CSRF_HEADER, token);

    expect(res.status).toBe(403);
  });

  it("WHEN another session's CSRF token is used THE SYSTEM SHALL answer 403", async () => {
    const { app } = await setup();
    const mine = await signIn(app);
    const theirs = await signIn(app);

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', mine.cookie)
      .set(CSRF_HEADER, theirs.csrfToken);

    expect(res.status).toBe(403);
  });

  it('WHEN the CSRF token is right THE SYSTEM SHALL end the session server-side and clear the cookie', async () => {
    const { app, kit } = await setup();
    const { cookie, csrfToken } = await signIn(app);

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .set(CSRF_HEADER, csrfToken);

    expect(res.status).toBe(204);
    expect(setCookieLine(res)).toMatch(/^__Host-session=;/);
    expect(kit.sessions.byHash.size).toBe(0);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
  });
});

describe('security events', () => {
  it('WHEN logins succeed and fail THE SYSTEM SHALL log security events with ids only, never the email or password', async () => {
    const { app, sink } = await setup();

    await login(app, { email: ADMIN_EMAIL, password: 'wrong-password-value' });
    await login(app);

    const events = sink.records().filter((r) => r.logType === 'security');
    expect(events.map((e) => [e.event, e.result])).toEqual([
      ['auth.login.failed', 'failed'],
      ['auth.login.succeeded', 'success'],
    ]);
    expect(sink.text()).not.toContain('wrong-password-value');
    expect(sink.text()).not.toContain(ADMIN_PASSWORD);
    expect(sink.text()).not.toContain(ADMIN_EMAIL);
  });

  it('WHEN the throttle trips THE SYSTEM SHALL log auth.login.rate_limited', async () => {
    const { app, sink } = await setup();
    for (let attempt = 0; attempt <= LOGIN_LIMIT_PER_IP_AND_EMAIL; attempt += 1) {
      await login(app, { email: ADMIN_EMAIL, password: 'wrong' });
    }

    expect(sink.records().some((r) => r.event === 'auth.login.rate_limited')).toBe(true);
  });
});
