import pg from 'pg';

import type { Logger } from '../../ports/logger.js';

const IDLE_CLIENT_TIMEOUT_MS = 30_000;
const APPLICATION_NAME = 'report-line-api';

export interface PoolSettings {
  connectionString: string;
  max: number;
  /** How long to wait for a connection. A pool with no bound turns a dead database into a hung request. */
  connectionTimeoutMs: number;
  /** Server-enforced per statement, so a stuck query cannot pin a connection (resilience skill). */
  statementTimeoutMs: number;
  /** Server kills a session that opens a transaction and goes quiet, e.g. after a crash mid-transaction. */
  idleInTransactionTimeoutMs: number;
}

/**
 * The request-path pool. Every limit is a connection setting, so it also holds for code that forgets one.
 * An idle client can fail (network blip, server restart) with nobody awaiting it; pg then emits `error` on
 * the pool, and an unhandled `error` event would crash the process, so it is logged by name and dropped.
 */
export function createRequestPool(settings: PoolSettings, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString: settings.connectionString,
    max: settings.max,
    connectionTimeoutMillis: settings.connectionTimeoutMs,
    idleTimeoutMillis: IDLE_CLIENT_TIMEOUT_MS,
    statement_timeout: settings.statementTimeoutMs,
    idle_in_transaction_session_timeout: settings.idleInTransactionTimeoutMs,
    application_name: APPLICATION_NAME,
  });
  pool.on('error', (error) => {
    logger.error(describeDbError(error), 'db.pool_error');
  });
  return pool;
}

/**
 * What is safe to log about a database failure: the error class and the SQLSTATE / Node code. Never the
 * message or `detail`: Postgres puts the failing row's values there, and a job row holds the interaction token.
 */
export function describeDbError(error: unknown): { errorName: string; errorCode?: string } {
  if (!(error instanceof Error)) {
    return { errorName: 'NonError' };
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return code === undefined
    ? { errorName: error.name }
    : { errorName: error.name, errorCode: code };
}
