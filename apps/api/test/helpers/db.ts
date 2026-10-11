import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';

import { MIGRATIONS_DIR, runMigrations } from '../../src/adapters/pg/migrator.js';
import { createRequestPool, type PoolSettings } from '../../src/adapters/pg/pool.js';
import type { Logger } from '../../src/ports/logger.js';

const TEST_POOL_MAX = 10;

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

/**
 * The URL of the database the tests may TRUNCATE. Missing means the run is misconfigured, and a DB test
 * that quietly skips would let the dedupe guarantees go unproven, so this throws instead.
 */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL_TEST is not set. Database tests do not skip: put a throwaway database URL in .env ' +
        '(see .env.example and the README).',
    );
  }
  if (url === process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL_TEST must not equal DATABASE_URL: tests wipe their database.');
  }
  return url;
}

export function testPoolSettings(overrides: Partial<PoolSettings> = {}): PoolSettings {
  return {
    connectionString: testDatabaseUrl(),
    max: TEST_POOL_MAX,
    connectionTimeoutMs: 2000,
    statementTimeoutMs: 5000,
    idleInTransactionTimeoutMs: 10_000,
    ...overrides,
  };
}

/** Migrates the test database, empties every table, and returns a pool shaped like the production one. */
export async function prepareTestDatabase(): Promise<pg.Pool> {
  const { connectionString } = testPoolSettings();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await runMigrations(client, MIGRATIONS_DIR);
  } finally {
    await client.end();
  }
  const pool = createRequestPool(testPoolSettings(), silentLogger);
  await truncateAll(pool);
  return pool;
}

/** Between tests. CASCADE follows the foreign keys, so guild and admin cover every table but the heartbeat. */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE guild, admin, worker_heartbeat CASCADE');
}

/** A pool aimed at a port nothing listens on: the database is "down". */
export function deadDatabasePool(): pg.Pool {
  return createRequestPool(
    {
      connectionString: 'postgresql://nobody:nothing@127.0.0.1:1/none',
      max: 2,
      connectionTimeoutMs: 1000,
      statementTimeoutMs: 1500,
      idleInTransactionTimeoutMs: 5000,
    },
    silentLogger,
  );
}

/**
 * Registers the suite's hooks and returns the pool getter. A failing `beforeAll` (no DATABASE_URL_TEST,
 * database unreachable) fails every test in the file: loud, never skipped.
 */
export function useTestDatabase(): () => pg.Pool {
  let pool: pg.Pool | undefined;
  beforeAll(async () => {
    pool = await prepareTestDatabase();
  });
  afterAll(async () => {
    await pool?.end();
  });
  return () => {
    if (pool === undefined) {
      throw new Error('The test database is not ready: its beforeAll hook failed.');
    }
    return pool;
  };
}

/**
 * Records the SQL text of every statement the pool's NEW connections run, so a test can prove a secret
 * only ever travelled as a bind parameter. Call it before the pool opens its first connection.
 * The casts are confined to this helper: `pg` overloads `query` too widely to wrap type-safely.
 */
export function captureQueryText(pool: pg.Pool): string[] {
  const texts: string[] = [];
  pool.on('connect', (client) => {
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      const first = args[0];
      texts.push(queryTextOf(first));
      return original(...args);
    }) as typeof client.query;
  });
  return texts;
}

function queryTextOf(first: unknown): string {
  if (typeof first === 'string') {
    return first;
  }
  if (
    typeof first === 'object' &&
    first !== null &&
    'text' in first &&
    typeof first.text === 'string'
  ) {
    return first.text;
  }
  return '';
}

/**
 * Makes every INSERT INTO job fail with a check violation (23514), after the interaction and action rows
 * were already written in the same transaction. NOT VALID applies the rule to new rows only. Returns the undo.
 */
export async function forceJobInsertFailure(pool: pg.Pool): Promise<() => Promise<void>> {
  await pool.query('ALTER TABLE job ADD CONSTRAINT job_test_force_failure CHECK (false) NOT VALID');
  return async () => {
    await pool.query('ALTER TABLE job DROP CONSTRAINT IF EXISTS job_test_force_failure');
  };
}
