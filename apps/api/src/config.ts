import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { REPLAY_WINDOW_MS } from './domain/signature.js';

// The only module that reads environment variables (backend-guidelines). Everything is validated once, at
// startup, and a bad value stops the process with the variable NAMES that are wrong, never their values.

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const WORKER_MODES = ['inline', 'standalone'] as const;
const DEFAULT_PORT = 3000;
const DEFAULT_STATUS_TIMEOUT_MS = 1200; // rule + record + status read must fit Discord's 3 s window (CLAUDE.md)
const DEFAULT_DISCORD_TIMEOUT_MS = 5000;
/** Where `ng build` puts the dashboard (apps/web, project "web"), found from this file so the working directory does not matter. */
export const DEFAULT_WEB_DIST_DIR = fileURLToPath(
  new URL('../../web/dist/web/browser', import.meta.url),
);
const DEFAULT_DISCORD_API_BASE_URL = 'https://discord.com/api/v10';

// LLM tagging (DESIGN §11.3 step 1, rev 8). Off by default; the key is required only when it is on.
const DEFAULT_GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
// Stable, cheapest current model on ai.google.dev/gemini-api/docs/models when this was chosen. Operators may override.
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_GEMINI_TIMEOUT_MS = 8000; // four calls per pass must still fit inside LEASE_MS
const GEMINI_MODEL_ID = /^[A-Za-z0-9._-]{1,64}$/; // goes into a URL path: no slashes, no query

/** An empty value (`FOO=` in a .env file) counts as unset, so defaults and "required" behave. */
const unlessEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

const snowflake = z.string().regex(/^\d{17,20}$/);
const positiveInt = z.coerce.number().int().positive();
const logLevel = z.preprocess(unlessEmpty, z.enum(LOG_LEVELS).default('info'));

// Request-path database limits (resilience skill): nothing on the 3 s path may wait without a bound.
const DEFAULT_RECORD_TIMEOUT_MS = 1000;
const DEFAULT_RULE_TIMEOUT_MS = 400;
const DEFAULT_HEALTH_TIMEOUT_MS = 2000; // /healthz: long enough for a hosted database to wake, short enough for a pinger
const DEFAULT_DB_POOL_MAX = 5; // free-tier Postgres allows few connections
const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 1000;
const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 1500;
const DEFAULT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = 5000;
/** Record + status read run one after the other and must finish inside Discord's 3 s with room to spare. */
const REQUEST_BUDGET_MS = 2800;

// Worker and outbound-call defaults (DESIGN §7.1). The worker has its OWN pool with looser limits than the
// request path: it is not racing Discord's 3 s clock, and its queries (claim, finish) may legitimately wait.
const DEFAULT_SLACK_TIMEOUT_MS = 5000;
const DEFAULT_SLACK_WEBHOOK_URL_PREFIX = 'https://hooks.slack.com/services/';
const DEFAULT_CLAIM_BATCH = 5;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_MAX_MS = 60_000;
const DEFAULT_WORKER_DB_POOL_MAX = 3;
const DEFAULT_WORKER_DB_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_WORKER_DB_STATEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_WORKER_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;
/** One job pass can make four calls in a row (tag, mirror, edit, fallback), so a lease must outlast all of them. */
const CALLS_PER_PASS = 4;
const WEBHOOK_KEY_BYTES = 32;

// Dashboard sessions (ADR-0003). The cookie is Secure unless an operator opts out explicitly.
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60_000;
const MIN_SESSION_SECRET_LENGTH = 32;
const MIN_ADMIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;
const MAX_TRUST_PROXY_HOPS = 10;
const cookieSecure = z.preprocess(
  unlessEmpty,
  z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
);
/** An opt-in switch: unset or empty is off, so a missing variable never turns a paid or external call on. */
const boolFlag = z.preprocess(
  unlessEmpty,
  z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
);

const databaseUrl = z.string().regex(/^postgres(ql)?:\/\/\S+$/);

/** AES-256 needs exactly 32 bytes; the env value is those bytes in base64. */
const base64Key32 = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .refine((value) => Buffer.from(value, 'base64').length === WEBHOOK_KEY_BYTES);

/** Everything the worker needs. The server schema spreads this in, so both read the same variables. */
const workerShape = {
  DISCORD_APP_ID: z.preprocess(unlessEmpty, snowflake),
  DISCORD_BOT_TOKEN: z.preprocess(unlessEmpty, z.string().min(1)),
  WEBHOOK_ENC_KEY: z.preprocess(unlessEmpty, base64Key32),
  DISCORD_API_BASE_URL: z.preprocess(unlessEmpty, z.url().default(DEFAULT_DISCORD_API_BASE_URL)),
  DISCORD_TIMEOUT_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_DISCORD_TIMEOUT_MS)),
  SLACK_TIMEOUT_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_SLACK_TIMEOUT_MS)),
  LLM_ENABLED: boolFlag,
  GEMINI_API_KEY: z.preprocess(unlessEmpty, z.string().min(1).optional()),
  GEMINI_MODEL: z.preprocess(
    unlessEmpty,
    z.string().regex(GEMINI_MODEL_ID).default(DEFAULT_GEMINI_MODEL),
  ),
  GEMINI_API_BASE_URL: z.preprocess(unlessEmpty, z.url().default(DEFAULT_GEMINI_API_BASE_URL)),
  GEMINI_TIMEOUT_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_GEMINI_TIMEOUT_MS)),
  SLACK_WEBHOOK_URL_PREFIX: z.preprocess(
    unlessEmpty,
    z.url().default(DEFAULT_SLACK_WEBHOOK_URL_PREFIX),
  ),
  WORKER_MODE: z.preprocess(unlessEmpty, z.enum(WORKER_MODES).default('inline')),
  CLAIM_BATCH: z.preprocess(unlessEmpty, positiveInt.max(50).default(DEFAULT_CLAIM_BATCH)),
  POLL_INTERVAL_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_POLL_INTERVAL_MS)),
  LEASE_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_LEASE_MS)),
  MAX_ATTEMPTS: z.preprocess(unlessEmpty, positiveInt.max(50).default(DEFAULT_MAX_ATTEMPTS)),
  BACKOFF_BASE_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_BACKOFF_BASE_MS)),
  BACKOFF_MAX_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_BACKOFF_MAX_MS)),
  WORKER_DB_POOL_MAX: z.preprocess(
    unlessEmpty,
    positiveInt.max(50).default(DEFAULT_WORKER_DB_POOL_MAX),
  ),
  WORKER_DB_CONNECTION_TIMEOUT_MS: z.preprocess(
    unlessEmpty,
    positiveInt.default(DEFAULT_WORKER_DB_CONNECTION_TIMEOUT_MS),
  ),
  WORKER_DB_STATEMENT_TIMEOUT_MS: z.preprocess(
    unlessEmpty,
    positiveInt.default(DEFAULT_WORKER_DB_STATEMENT_TIMEOUT_MS),
  ),
  WORKER_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.preprocess(
    unlessEmpty,
    positiveInt.default(DEFAULT_WORKER_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS),
  ),
};

interface WorkerTimings {
  LEASE_MS: number;
  DISCORD_TIMEOUT_MS: number;
  SLACK_TIMEOUT_MS: number;
  LLM_ENABLED: boolean;
  GEMINI_TIMEOUT_MS: number;
}

/** A lease shorter than one pass hands a slow-but-alive job to a second worker (DESIGN §7.1). */
const leaseOutlastsAPass = (env: WorkerTimings): boolean =>
  env.LEASE_MS >
  CALLS_PER_PASS *
    Math.max(
      env.DISCORD_TIMEOUT_MS,
      env.SLACK_TIMEOUT_MS,
      env.LLM_ENABLED ? env.GEMINI_TIMEOUT_MS : 0,
    );

/** With LLM_ENABLED=false nothing here is required: the key is read only when the switch is on. */
const keyPresentWhenEnabled = (env: {
  LLM_ENABLED: boolean;
  GEMINI_API_KEY?: string | undefined;
}): boolean => !env.LLM_ENABLED || env.GEMINI_API_KEY !== undefined;
const GEMINI_KEY_ISSUE = {
  path: ['GEMINI_API_KEY'],
  error: 'GEMINI_API_KEY is required when LLM_ENABLED=true',
};
const LEASE_ISSUE = {
  path: ['LEASE_MS'],
  error: 'LEASE_MS must be longer than three outbound call timeouts',
};

const ServerEnv = z
  .object({
    PORT: z.preprocess(unlessEmpty, positiveInt.max(65535).default(DEFAULT_PORT)),
    LOG_LEVEL: logLevel,
    DISCORD_PUBLIC_KEY: z.preprocess(unlessEmpty, z.string().regex(/^[0-9a-fA-F]{64}$/)),
    REPLAY_WINDOW_MS: z.preprocess(unlessEmpty, positiveInt.default(REPLAY_WINDOW_MS)),
    STATUS_TIMEOUT_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_STATUS_TIMEOUT_MS)),
    RECORD_TIMEOUT_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_RECORD_TIMEOUT_MS)),
    RULE_TIMEOUT_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_RULE_TIMEOUT_MS)),
    HEALTH_TIMEOUT_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_HEALTH_TIMEOUT_MS)),
    DATABASE_URL: z.preprocess(unlessEmpty, databaseUrl),
    DB_POOL_MAX: z.preprocess(unlessEmpty, positiveInt.max(50).default(DEFAULT_DB_POOL_MAX)),
    DB_CONNECTION_TIMEOUT_MS: z.preprocess(
      unlessEmpty,
      positiveInt.default(DEFAULT_DB_CONNECTION_TIMEOUT_MS),
    ),
    DB_STATEMENT_TIMEOUT_MS: z.preprocess(
      unlessEmpty,
      positiveInt.default(DEFAULT_DB_STATEMENT_TIMEOUT_MS),
    ),
    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.preprocess(
      unlessEmpty,
      positiveInt.default(DEFAULT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS),
    ),
    SESSION_SECRET: z.preprocess(unlessEmpty, z.string().min(MIN_SESSION_SECRET_LENGTH)),
    SESSION_TTL_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_SESSION_TTL_MS)),
    SESSION_COOKIE_SECURE: cookieSecure,
    WEB_DIST_DIR: z.preprocess(unlessEmpty, z.string().min(1).default(DEFAULT_WEB_DIST_DIR)),
    TRUST_PROXY_HOPS: z.preprocess(
      unlessEmpty,
      z.coerce.number().int().min(0).max(MAX_TRUST_PROXY_HOPS).default(0),
    ),
    ...workerShape,
  })
  .refine(
    (env) =>
      env.RULE_TIMEOUT_MS + env.RECORD_TIMEOUT_MS + env.STATUS_TIMEOUT_MS <= REQUEST_BUDGET_MS,
    {
      path: ['RECORD_TIMEOUT_MS'],
      error:
        'RULE_TIMEOUT_MS + RECORD_TIMEOUT_MS + STATUS_TIMEOUT_MS must fit inside the 3 s Discord window',
    },
  )
  .refine(leaseOutlastsAPass, LEASE_ISSUE)
  .refine(keyPresentWhenEnabled, GEMINI_KEY_ISSUE);

/** The standalone worker (WORKER_MODE=standalone) has no HTTP server, so it needs no public key. */
const WorkerEnv = z
  .object({
    LOG_LEVEL: logLevel,
    DATABASE_URL: z.preprocess(unlessEmpty, databaseUrl),
    ...workerShape,
  })
  .refine(leaseOutlastsAPass, LEASE_ISSUE)
  .refine(keyPresentWhenEnabled, GEMINI_KEY_ISSUE);

/** For `scripts/set-mirror-webhook.ts`: the database, the key, and which URL prefix is acceptable. */
const WebhookScriptEnv = z.object({
  DATABASE_URL: z.preprocess(unlessEmpty, databaseUrl),
  WEBHOOK_ENC_KEY: workerShape.WEBHOOK_ENC_KEY,
  SLACK_WEBHOOK_URL_PREFIX: workerShape.SLACK_WEBHOOK_URL_PREFIX,
});

/** For `scripts/seed-admin.ts`: the database and the throwaway admin's credentials. */
const SeedAdminEnv = z.object({
  DATABASE_URL: z.preprocess(unlessEmpty, databaseUrl),
  ADMIN_EMAIL: z.preprocess(unlessEmpty, z.email().max(254)),
  ADMIN_PASSWORD: z.preprocess(
    unlessEmpty,
    z.string().min(MIN_ADMIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  ),
});

const MigrateEnv = z.object({
  DATABASE_URL: z.preprocess(unlessEmpty, databaseUrl),
});

const RegisterEnv = z.object({
  DISCORD_APP_ID: z.preprocess(unlessEmpty, snowflake),
  DISCORD_GUILD_ID: z.preprocess(unlessEmpty, snowflake),
  DISCORD_BOT_TOKEN: z.preprocess(unlessEmpty, z.string().min(1)),
  DISCORD_API_BASE_URL: z.preprocess(unlessEmpty, z.url().default(DEFAULT_DISCORD_API_BASE_URL)),
  DISCORD_TIMEOUT_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_DISCORD_TIMEOUT_MS)),
});

export type ServerConfig = z.infer<typeof ServerEnv>;
export type WorkerConfig = z.infer<typeof WorkerEnv>;
export type WebhookScriptConfig = z.infer<typeof WebhookScriptEnv>;
export type RegisterConfig = z.infer<typeof RegisterEnv>;
export type SeedAdminConfig = z.infer<typeof SeedAdminEnv>;
export type MigrateConfig = z.infer<typeof MigrateEnv>;
export type WorkerMode = (typeof WORKER_MODES)[number];

/** Thrown at startup. `variables` are names only; the message never contains a value. */
export class ConfigError extends Error {
  public readonly variables: readonly string[];

  public constructor(variables: readonly string[]) {
    super(`Invalid configuration. Check these environment variables: ${variables.join(', ')}`);
    this.name = 'ConfigError';
    this.variables = variables;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function parseEnv<S extends z.ZodType>(schema: S, env: Env): z.output<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const names = result.error.issues.map((issue) => String(issue.path[0] ?? '(unknown)'));
    throw new ConfigError([...new Set(names)]);
  }
  return result.data;
}

export function loadServerConfig(env: Env = process.env): ServerConfig {
  return parseEnv(ServerEnv, env);
}

/** For the standalone worker process. */
export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  return parseEnv(WorkerEnv, env);
}

/** Which role this process plays. Read first, so each role then validates only the variables it needs. */
export function loadWorkerMode(env: Env = process.env): WorkerMode {
  return parseEnv(z.object({ WORKER_MODE: workerShape.WORKER_MODE }), env).WORKER_MODE;
}

/** For `scripts/set-mirror-webhook.ts`. */
export function loadWebhookScriptConfig(env: Env = process.env): WebhookScriptConfig {
  return parseEnv(WebhookScriptEnv, env);
}

/** For `scripts/seed-admin.ts`. */
export function loadSeedAdminConfig(env: Env = process.env): SeedAdminConfig {
  return parseEnv(SeedAdminEnv, env);
}

/** For `scripts/migrate.ts`, which needs only the database. */
export function loadMigrateConfig(env: Env = process.env): MigrateConfig {
  return parseEnv(MigrateEnv, env);
}

/** For `scripts/register-commands.ts`, which needs the bot token the server itself does not use yet. */
export function loadRegisterConfig(env: Env = process.env): RegisterConfig {
  return parseEnv(RegisterEnv, env);
}
