import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';

import { MIGRATIONS_DIR, runMigrations } from '../../src/adapters/pg/migrator.js';
import { createRequestPool, type PoolSettings } from '../../src/adapters/pg/pool.js';
import type { Logger } from '../../src/ports/logger.js';

const TEST_POOL_MAX = 10;

const silentLogger: Logger = {
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

/** Between tests. CASCADE follows the foreign keys, so guild and admin cover every other table. */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE guild, admin CASCADE');
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
