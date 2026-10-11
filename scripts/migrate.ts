// Applies pending SQL migrations (apps/api/migrations) to DATABASE_URL. Run by hand and in deploys:
//   npm run db:migrate
// Safe to run twice: applied files are recorded in schema_migrations. The server never migrates at startup.
import pg from 'pg';

import {
  MIGRATIONS_DIR,
  MigrationError,
  runMigrations,
} from '../apps/api/src/adapters/pg/migrator.js';
import { ConfigError, loadMigrateConfig } from '../apps/api/src/config.js';
import { errorLogFields } from '../apps/api/src/domain/errorFields.js';

const CONNECT_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const { DATABASE_URL } = loadMigrateConfig();
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  await client.connect();
  try {
    const applied = await runMigrations(client, MIGRATIONS_DIR);
    process.stdout.write(
      applied.length === 0 ? 'Database is up to date.\n' : `Applied: ${applied.join(', ')}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${describeFailure(error)}\n`);
  process.exit(1);
});

/** Config and migration errors carry safe messages. Anything else may carry the host, so only its codes are shown. */
function describeFailure(error: unknown): string {
  if (error instanceof ConfigError || error instanceof MigrationError) {
    return error.message;
  }
  const { errorName, errorCode } = errorLogFields(error);
  return `Could not use the database (${errorCode ?? errorName}). Check DATABASE_URL.`;
}
