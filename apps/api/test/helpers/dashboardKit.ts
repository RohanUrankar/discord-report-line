import { CSRF_HEADER, type SessionInfo } from '@report-line/shared';
import type pg from 'pg';
import request, { type Response, type Test } from 'supertest';

import { NodeSessionCrypto } from '../../src/adapters/nodeSessionCrypto.js';
import { PgAdminRepository } from '../../src/adapters/pg/pgAdminRepository.js';
import { PgSessionRepository } from '../../src/adapters/pg/pgSessionRepository.js';
import { AuthService } from '../../src/app/auth.js';
import { composeDashboard, composeGuildConfig } from '../../src/compose.js';
import { createLogger } from '../../src/http/middleware.js';
import { createServer } from '../../src/http/server.js';
import {
  ManualClock,
  PlainHasher,
  SECURE_COOKIE,
  TEST_GUILD_CONFIG,
  TEST_SESSION_SECRET,
  TEST_TTL_MS,
} from './authFakes.js';
import { LogSink } from './logging.js';

const COOKIE_NAME = '__Host-session';
const PASSWORD = 'a throwaway password';

export interface Admin {
  id: string;
  /** The `Cookie` header value of a live session. */
  cookie: string;
  /** The value the server expects in the CSRF header of a change. */
  csrfToken: string;
}

export interface DashboardKit {
  app: ReturnType<typeof createServer>;
  logs: LogSink;
  /** Creates an admin in the database and signs them in through the real login route. */
  signIn(email: string): Promise<Admin>;
  /** The test helper for the connect flow (a later step): links an admin to a guild directly. */
  manage(admin: Admin, guildId: string): Promise<void>;
  get(admin: Admin | undefined, path: string, requestId?: string): Test;
  /** A change (POST or PUT) with a session cookie and, unless told otherwise, the right CSRF token. */
  send(
    method: 'post' | 'put',
    admin: Admin | undefined,
    path: string,
    body: unknown,
    csrf?: string | null,
  ): Test;
}

/** The real dashboard stack (Postgres repositories, sessions, tenant guard) around the given pool. */
export function makeDashboardKit(pool: pg.Pool): DashboardKit {
  const hasher = new PlainHasher();
  const admins = new PgAdminRepository(pool);
  const auth = new AuthService(
    {
      admins,
      sessions: new PgSessionRepository(pool),
      hasher,
      sessionCrypto: new NodeSessionCrypto(TEST_SESSION_SECRET),
      clock: new ManualClock(Date.now()),
    },
    { sessionTtlMs: TEST_TTL_MS },
  );
  const logs = new LogSink();
  const app = createServer({
    controller: { handle: () => Promise.resolve({ status: 401 }) },
    logger: createLogger('debug', logs),
    auth,
    dashboard: composeDashboard(pool),
    guildConfig: composeGuildConfig(TEST_GUILD_CONFIG, pool),
    cookie: SECURE_COOKIE,
  });

  return {
    app,
    logs,
    async signIn(email) {
      const { id } = await admins.upsert(email, await hasher.hash(PASSWORD));
      const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      return { id, cookie: cookieOf(login), csrfToken: csrfOf(login) };
    },
    async manage(admin, guildId) {
      await pool.query('INSERT INTO guild (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [guildId]);
      await pool.query('INSERT INTO admin_guild (admin_id, guild_id) VALUES ($1, $2)', [
        admin.id,
        guildId,
      ]);
    },
    send(method, admin, path, body, csrf) {
      let call = request(app)[method](path);
      if (admin !== undefined) {
        call = call.set('Cookie', admin.cookie);
        const token = csrf === undefined ? admin.csrfToken : csrf;
        if (typeof token === 'string') {
          call = call.set(CSRF_HEADER, token);
        }
      }
      return call.send(body as object);
    },
    get(admin, path, requestId) {
      let call = request(app).get(path);
      if (admin !== undefined) {
        call = call.set('Cookie', admin.cookie);
      }
      return requestId === undefined ? call : call.set('X-Request-Id', requestId);
    },
  };
}

function csrfOf(res: Response): string {
  return (res.body as SessionInfo).csrfToken;
}

function cookieOf(res: Response): string {
  const body = res.body as Partial<SessionInfo>;
  if (res.status !== 200 || body.csrfToken === undefined) {
    throw new Error(`Test sign-in failed with status ${String(res.status)}.`);
  }
  const lines = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const line = lines.find((entry) => entry.startsWith(`${COOKIE_NAME}=`));
  if (line === undefined) {
    throw new Error('Test sign-in set no session cookie.');
  }
  return line.split(';')[0] ?? '';
}
