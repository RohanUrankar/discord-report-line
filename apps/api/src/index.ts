import type { Server } from 'node:http';

import { PgLedger } from './adapters/pg/pgLedger.js';
import { createRequestPool } from './adapters/pg/pool.js';
import { PgStatusReader } from './adapters/pg/pgStatusReader.js';
import { SystemClock } from './adapters/systemClock.js';
import { InteractionController } from './app/interactions.js';
import { composeAuth, composeDashboard, composeWorker } from './compose.js';
import {
  ConfigError,
  loadServerConfig,
  loadWorkerConfig,
  loadWorkerMode,
  type ServerConfig,
} from './config.js';
import { createLogger } from './http/middleware.js';
import { createServer } from './http/server.js';
import type { Logger } from './ports/logger.js';

const SHUTDOWN_GRACE_MS = 10_000;

/** Fail closed: continuing after an unknown failure is worse than a restart (security-secrets). */
function exitOnUnexpectedFailure(logger: Logger): void {
  const crash = (event: string) => (reason: unknown) => {
    logger.error({ errorName: reason instanceof Error ? reason.name : 'NonError' }, event);
    process.exit(1);
  };
  process.on('unhandledRejection', crash('process.unhandled_rejection'));
  process.on('uncaughtException', crash('process.uncaught_exception'));
}

/** Runs `shutdown` once on SIGTERM or SIGINT; the exit below is the backstop if it hangs. */
function onTermination(logger: Logger, shutdown: () => Promise<void>): void {
  const handler = (signal: string): void => {
    logger.info({ signal }, 'process.shutting_down');
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', () => {
    handler('SIGTERM');
  });
  process.on('SIGINT', () => {
    handler('SIGINT');
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

/** HTTP server and the in-process worker (ADR-0002). */
function startServerWithWorker(config: ServerConfig): void {
  const logger = createLogger(config.LOG_LEVEL);
  // The pool connects lazily, so startup does not wait on the database and a cold start stays fast.
  const requestPool = createRequestPool(
    {
      connectionString: config.DATABASE_URL,
      max: config.DB_POOL_MAX,
      connectionTimeoutMs: config.DB_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: config.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    logger,
  );
  const { worker, pool: workerPool } = composeWorker(config, logger);
  const clock = new SystemClock();
  const controller = new InteractionController({
    publicKeyHex: config.DISCORD_PUBLIC_KEY,
    replayWindowMs: config.REPLAY_WINDOW_MS,
    statusTimeoutMs: config.STATUS_TIMEOUT_MS,
    recordTimeoutMs: config.RECORD_TIMEOUT_MS,
    clock,
    ledger: new PgLedger(requestPool),
    statusReader: new PgStatusReader(requestPool, clock),
    onJobEnqueued: () => {
      worker.nudge();
    },
  });
  const { auth, cookie } = composeAuth(config, requestPool, clock);
  if (!config.SESSION_COOKIE_SECURE) {
    logger.warn({}, 'config.session_cookie_not_secure'); // acceptable on http://localhost only
  }
  const server = createServer({
    controller,
    logger,
    auth,
    dashboard: composeDashboard(requestPool),
    cookie,
    trustProxyHops: config.TRUST_PROXY_HOPS,
  }).listen(config.PORT, () => {
    logger.info({ port: config.PORT }, 'server.listening');
  });
  worker.start();

  exitOnUnexpectedFailure(logger);
  onTermination(logger, async () => {
    await closeServer(server); // stop taking requests first; in-flight ones still reach the ledger
    await worker.stop(); // then let the jobs in flight finish; a crash would be recovered by the lease
    await Promise.all([requestPool.end(), workerPool.end()]);
  });
}

/** WORKER_MODE=standalone: the same worker, no HTTP server (ADR-0002). */
function startStandaloneWorker(): void {
  const config = loadWorkerConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const { worker, pool } = composeWorker(config, logger);
  worker.start();
  logger.info({}, 'worker.standalone_started');

  exitOnUnexpectedFailure(logger);
  onTermination(logger, async () => {
    await worker.stop();
    await pool.end();
  });
}

try {
  if (loadWorkerMode() === 'standalone') {
    startStandaloneWorker();
  } else {
    startServerWithWorker(loadServerConfig());
  }
} catch (error) {
  if (error instanceof ConfigError) {
    // Names the variables only. The logger needs config, so this is the one place that writes directly.
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
