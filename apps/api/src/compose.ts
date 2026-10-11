import type pg from 'pg';

import { Argon2PasswordHasher } from './adapters/argon2PasswordHasher.js';
import { AesGcmWebhookCipher } from './adapters/aesGcmWebhookCipher.js';
import { GeminiHttpTagger } from './adapters/geminiHttp.js';
import { DiscordHttpClient } from './adapters/discordHttp.js';
import { NodeSessionCrypto } from './adapters/nodeSessionCrypto.js';
import { PgGuildConfigStore } from './adapters/pg/pgGuildConfigStore.js';
import { PgDashboardReader } from './adapters/pg/pgDashboardReader.js';
import { PgAdminRepository } from './adapters/pg/pgAdminRepository.js';
import { PgJobRepository } from './adapters/pg/pgJobRepository.js';
import { PgSessionRepository } from './adapters/pg/pgSessionRepository.js';
import { createWorkerPool } from './adapters/pg/pool.js';
import { PgWorkerHeartbeat } from './adapters/pg/pgWorkerHeartbeat.js';
import { SlackHttpClient } from './adapters/slackHttp.js';
import { SystemClock } from './adapters/systemClock.js';
import { AuthService } from './app/auth.js';
import { DashboardService } from './app/dashboard.js';
import { GuildConfigService } from './app/guildConfig.js';
import { ReportJobRunner } from './app/reportJobRunner.js';
import { Worker } from './app/worker.js';
import type { ServerConfig, WorkerConfig } from './config.js';
import type { SessionCookieSettings } from './http/sessionCookie.js';
import type { Clock } from './ports/clock.js';
import type { Logger } from './ports/logger.js';
import type { Tagger } from './ports/tagger.js';

/**
 * The Gemini client, or nothing. With LLM_ENABLED=false no adapter exists, so nothing can call Gemini and no key
 * is read; config already guarantees a key when it is on.
 */
export function composeTagger(config: WorkerConfig): Tagger | undefined {
  if (!config.LLM_ENABLED || config.GEMINI_API_KEY === undefined) {
    return undefined;
  }
  return new GeminiHttpTagger({
    apiBaseUrl: config.GEMINI_API_BASE_URL,
    apiKey: config.GEMINI_API_KEY,
    model: config.GEMINI_MODEL,
    timeoutMs: config.GEMINI_TIMEOUT_MS,
  });
}

export interface ComposedWorker {
  worker: Worker;
  /** The worker's own pool. Close it after `worker.stop()`. */
  pool: pg.Pool;
}

/**
 * The worker's composition root (DESIGN §8.2: no DI container, wired by hand). Everything the worker touches is
 * built here from config: its own database pool, the Discord and Slack clients, the cipher and the runner.
 * A server config satisfies `WorkerConfig`, so the in-process and the standalone worker share this.
 */
export function composeWorker(config: WorkerConfig, logger: Logger): ComposedWorker {
  const pool = createWorkerPool(
    {
      connectionString: config.DATABASE_URL,
      max: config.WORKER_DB_POOL_MAX,
      connectionTimeoutMs: config.WORKER_DB_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: config.WORKER_DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: config.WORKER_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    logger,
  );
  const clock = new SystemClock();
  const jobs = new PgJobRepository(pool);
  const runner = new ReportJobRunner(
    {
      jobs,
      discord: new DiscordHttpClient({
        apiBaseUrl: config.DISCORD_API_BASE_URL,
        botToken: config.DISCORD_BOT_TOKEN,
        timeoutMs: config.DISCORD_TIMEOUT_MS,
      }),
      slack: new SlackHttpClient({
        timeoutMs: config.SLACK_TIMEOUT_MS,
        allowedUrlPrefix: config.SLACK_WEBHOOK_URL_PREFIX,
      }),
      tagger: composeTagger(config),
      cipher: new AesGcmWebhookCipher(config.WEBHOOK_ENC_KEY),
      clock,
      random: Math.random, // jitter only; nothing an attacker must not guess (security-secrets)
    },
    {
      appId: config.DISCORD_APP_ID,
      maxAttempts: config.MAX_ATTEMPTS,
      backoffBaseMs: config.BACKOFF_BASE_MS,
      backoffMaxMs: config.BACKOFF_MAX_MS,
    },
  );
  const worker = new Worker(
    { jobs, runner, heartbeat: new PgWorkerHeartbeat(pool), clock, logger },
    {
      batch: config.CLAIM_BATCH,
      pollIntervalMs: config.POLL_INTERVAL_MS,
      leaseMs: config.LEASE_MS,
    },
  );
  return { worker, pool };
}

export interface AuthWiring {
  auth: AuthService;
  cookie: SessionCookieSettings;
}

/** The dashboard's sign-in wiring (ADR-0003), on the request pool. */
export function composeAuth(
  config: Pick<ServerConfig, 'SESSION_SECRET' | 'SESSION_TTL_MS' | 'SESSION_COOKIE_SECURE'>,
  pool: pg.Pool,
  clock: Clock,
): AuthWiring {
  return {
    auth: new AuthService(
      {
        admins: new PgAdminRepository(pool),
        sessions: new PgSessionRepository(pool),
        hasher: new Argon2PasswordHasher(),
        sessionCrypto: new NodeSessionCrypto(config.SESSION_SECRET),
        clock,
      },
      { sessionTtlMs: config.SESSION_TTL_MS },
    ),
    cookie: { secure: config.SESSION_COOKIE_SECURE, ttlMs: config.SESSION_TTL_MS },
  };
}

/** The dashboard's read side (tenant-scoped log and server list), on the request pool. */
export function composeDashboard(pool: pg.Pool): DashboardService {
  return new DashboardService(new PgDashboardReader(pool));
}

/** The dashboard's write side (connect a server, settings, rules), on the request pool. */
export function composeGuildConfig(
  config: Pick<ServerConfig, 'WEBHOOK_ENC_KEY' | 'SLACK_WEBHOOK_URL_PREFIX'>,
  pool: pg.Pool,
): GuildConfigService {
  return new GuildConfigService(
    new PgGuildConfigStore(pool),
    new AesGcmWebhookCipher(config.WEBHOOK_ENC_KEY),
    { allowedWebhookPrefix: config.SLACK_WEBHOOK_URL_PREFIX },
  );
}
