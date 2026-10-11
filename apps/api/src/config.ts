import { z } from 'zod';

import { REPLAY_WINDOW_MS } from './domain/signature.js';

// The only module that reads environment variables (backend-guidelines). Everything is validated once, at
// startup, and a bad value stops the process with the variable NAMES that are wrong, never their values.

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const DEFAULT_PORT = 3000;
const DEFAULT_STATUS_TIMEOUT_MS = 1500; // well inside Discord's 3 s window (CLAUDE.md)
const DEFAULT_DISCORD_TIMEOUT_MS = 5000;
const DEFAULT_DISCORD_API_BASE_URL = 'https://discord.com/api/v10';

/** An empty value (`FOO=` in a .env file) counts as unset, so defaults and "required" behave. */
const unlessEmpty = (value: unknown): unknown => (value === '' ? undefined : value);

const snowflake = z.string().regex(/^\d{17,20}$/);
const positiveInt = z.coerce.number().int().positive();

// Request-path database limits (resilience skill): nothing on the 3 s path may wait without a bound.
const DEFAULT_RECORD_TIMEOUT_MS = 1200;
const DEFAULT_DB_POOL_MAX = 5; // free-tier Postgres allows few connections
const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 1000;
const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 1500;
const DEFAULT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS = 5000;
/** Record + status read run one after the other and must finish inside Discord's 3 s with room to spare. */
const REQUEST_BUDGET_MS = 2800;

const databaseUrl = z.string().regex(/^postgres(ql)?:\/\/\S+$/);

const ServerEnv = z
  .object({
    PORT: z.preprocess(unlessEmpty, positiveInt.max(65535).default(DEFAULT_PORT)),
    LOG_LEVEL: z.preprocess(unlessEmpty, z.enum(LOG_LEVELS).default('info')),
    DISCORD_PUBLIC_KEY: z.preprocess(unlessEmpty, z.string().regex(/^[0-9a-fA-F]{64}$/)),
    REPLAY_WINDOW_MS: z.preprocess(unlessEmpty, positiveInt.default(REPLAY_WINDOW_MS)),
    STATUS_TIMEOUT_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_STATUS_TIMEOUT_MS)),
    RECORD_TIMEOUT_MS: z.preprocess(unlessEmpty, positiveInt.default(DEFAULT_RECORD_TIMEOUT_MS)),
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
  })
  .refine((env) => env.RECORD_TIMEOUT_MS + env.STATUS_TIMEOUT_MS <= REQUEST_BUDGET_MS, {
    path: ['RECORD_TIMEOUT_MS'],
    error: 'RECORD_TIMEOUT_MS + STATUS_TIMEOUT_MS must fit inside the 3 s Discord window',
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
export type RegisterConfig = z.infer<typeof RegisterEnv>;
export type MigrateConfig = z.infer<typeof MigrateEnv>;

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

/** For `scripts/migrate.ts`, which needs only the database. */
export function loadMigrateConfig(env: Env = process.env): MigrateConfig {
  return parseEnv(MigrateEnv, env);
}

/** For `scripts/register-commands.ts`, which needs the bot token the server itself does not use yet. */
export function loadRegisterConfig(env: Env = process.env): RegisterConfig {
  return parseEnv(RegisterEnv, env);
}
