import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { inertAuth } from '../../../test/helpers/authFakes.js';
import { silentLogger, truncateAll, useTestDatabase } from '../../../test/helpers/db.js';
import { HealthService } from '../../app/health.js';
import { createServer } from '../../http/server.js';
import { createLogger } from '../../http/middleware.js';
import { LogSink } from '../../../test/helpers/logging.js';
import { createRequestPool } from './pool.js';
import { PgHealthReader } from './pgHealthReader.js';
import { PgWorkerHeartbeat } from './pgWorkerHeartbeat.js';

const db = useTestDatabase();
const BEAT_MS = 1_800_000_000_000;
const STALE_AFTER_MS = 60_000;
const controller = { handle: () => Promise.resolve({ status: 401 as const }) };

describe('PgHealthReader', () => {
  it('WHEN no worker has beaten THE SYSTEM SHALL return null, and WHEN one has THE SYSTEM SHALL return its time', async () => {
    const pool = db();
    await truncateAll(pool);
    const reader = new PgHealthReader(pool);

    expect(await reader.lastWorkerBeatMs()).toBeNull();
    await new PgWorkerHeartbeat(pool).beat(BEAT_MS);
    expect(await reader.lastWorkerBeatMs()).toBe(BEAT_MS);
  });
});

describe('GET /healthz against Postgres', () => {
  it('WHEN the database is up and the worker beats THE SYSTEM SHALL answer 200 with three status words and no secrets', async () => {
    const pool = db();
    await truncateAll(pool);
    await new PgWorkerHeartbeat(pool).beat(BEAT_MS);
    const clock = { nowMs: () => BEAT_MS + 1000 };
    const health = new HealthService(new PgHealthReader(pool), clock, {
      timeoutMs: 1000,
      staleAfterMs: STALE_AFTER_MS,
    });
    const app = createServer({
      controller,
      logger: createLogger('silent', new LogSink()),
      ...inertAuth(),
      health,
    });

    const res = await request(app).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up', worker: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('WHEN the database is unreachable THE SYSTEM SHALL answer 503 quickly, without hanging and without connection details', async () => {
    // Nothing listens on port 1: the connection is refused, as with a stopped or firewalled database.
    const deadUrl = 'postgresql://healthcheck-user:sentinel-db-password@127.0.0.1:1/nowhere';
    const pool = createRequestPool(
      {
        connectionString: deadUrl,
        max: 1,
        connectionTimeoutMs: 300,
        statementTimeoutMs: 300,
        idleInTransactionTimeoutMs: 300,
      },
      silentLogger,
    );
    const sink = new LogSink();
    const health = new HealthService(
      new PgHealthReader(pool),
      { nowMs: () => BEAT_MS },
      { timeoutMs: 500, staleAfterMs: STALE_AFTER_MS },
    );
    const app = createServer({
      controller,
      logger: createLogger('debug', sink),
      ...inertAuth(),
      health,
    });

    const startedAt = performance.now();
    const res = await request(app).get('/healthz');
    const elapsedMs = performance.now() - startedAt;
    await pool.end();

    expect(res.status).toBe(503);
    expect(elapsedMs).toBeLessThan(1500);
    expect(res.body).toEqual({ status: 'unhealthy', db: 'down', worker: 'unknown' });
    expect(`${res.text}${sink.text()}`).not.toContain('sentinel-db-password');
    expect(sink.messages()).toContain('health.unhealthy');
  });
});
