// Creates the throwaway dashboard admin, or resets its password. Run by hand:
//   npm run seed-admin
// Credentials come from ADMIN_EMAIL and ADMIN_PASSWORD in the environment (see .env.example), not from the
// command line, so the password never lands in shell history or a process list. It is never printed.
import pg from 'pg';

import { Argon2PasswordHasher } from '../apps/api/src/adapters/argon2PasswordHasher.js';
import { PgAdminRepository } from '../apps/api/src/adapters/pg/pgAdminRepository.js';
import { seedAdmin } from '../apps/api/src/app/seedAdmin.js';
import { ConfigError, loadSeedAdminConfig } from '../apps/api/src/config.js';
import { errorLogFields } from '../apps/api/src/domain/errorFields.js';

const CONNECT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadSeedAdminConfig();
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  try {
    const admin = await seedAdmin(
      { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD },
      { admins: new PgAdminRepository(pool), hasher: new Argon2PasswordHasher() },
    );
    process.stdout.write(`Admin ${admin.email} is ready. Sign in with the password you set.\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${describeFailure(error)}\n`);
  process.exit(1);
});

/** Only messages we wrote ourselves are printed. Anything else is reduced to its error code. */
function describeFailure(error: unknown): string {
  if (error instanceof ConfigError) {
    return error.message;
  }
  const { errorName, errorCode } = errorLogFields(error);
  return `Could not seed the admin (${errorCode ?? errorName}). Check DATABASE_URL and that migrations ran.`;
}
