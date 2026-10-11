import { PgLedger } from './adapters/pg/pgLedger.js';
import { createRequestPool } from './adapters/pg/pool.js';
import { PgStatusReader } from './adapters/pg/pgStatusReader.js';
import { SystemClock } from './adapters/systemClock.js';
import { InteractionController } from './app/interactions.js';
import { ConfigError, loadServerConfig } from './config.js';
import { createLogger } from './http/middleware.js';
import { createServer } from './http/server.js';

const SHUTDOWN_GRACE_MS = 10_000;

function main(): void {
  const config = loadServerConfig();
  const logger = createLogger(config.LOG_LEVEL);

  // The pool connects lazily, so startup does not wait on the database and a cold start stays fast.
  const pool = createRequestPool(
    {
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      connectionTimeoutMs: config.DB_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    logger,
  );
  const clock = new SystemClock();
  const controller = new InteractionController({
    publicKeyHex: config.DISCORD_PUBLIC_KEY,
    replayWindowMs: config.REPLAY_WINDOW_MS,
    statusTimeoutMs: config.STATUS_TIMEOUT_MS,
    recordTimeoutMs: config.RECORD_TIMEOUT_MS,
    clock,
    ledger: new PgLedger(pool),
    statusReader: new PgStatusReader(pool, clock),
  });
  const server = createServer({ controller, logger }).listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'server.listening');
  });

  // Fail closed: continuing after an unknown failure is worse than a restart (security-secrets).
  const crash = (event: string) => (reason: unknown) => {
    logger.error({ errorName: reason instanceof Error ? reason.name : 'NonError' }, event);
    process.exit(1);
  };
  process.on('unhandledRejection', crash('process.unhandled_rejection'));
  process.on('uncaughtException', crash('process.uncaught_exception'));

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'server.shutting_down');
    server.close(() => {
      // Drain the pool so in-flight transactions finish; the exit below is the backstop.
      pool.end().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    // Names the variables only. The logger needs config, so this is the one place that writes directly.
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
