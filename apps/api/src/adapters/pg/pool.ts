import pg from 'pg';

import { errorLogFields } from '../../domain/errorFields.js';
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
    logger.error(errorLogFields(error), 'db.pool_error');
  });
  return pool;
}
