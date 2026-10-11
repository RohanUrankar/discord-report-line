// Creates the throwaway dashboard admin, or resets its password. Run by hand:
//   npm run seed-admin
// The email comes from ADMIN_EMAIL. The password comes from ADMIN_PASSWORD in the environment (see .env.example)
// or, when that is not set and a terminal is attached, from a hidden prompt (asked twice). Never from the command
// line, so it never lands in shell history or a process list, and it is never printed or stored in a file.
import { stdin, stdout } from 'node:process';

import pg from 'pg';

import { Argon2PasswordHasher } from '../apps/api/src/adapters/argon2PasswordHasher.js';
import { PgAdminRepository } from '../apps/api/src/adapters/pg/pgAdminRepository.js';
import { seedAdmin } from '../apps/api/src/app/seedAdmin.js';
import { ConfigError, loadSeedAdminConfig } from '../apps/api/src/config.js';
import { errorLogFields } from '../apps/api/src/domain/errorFields.js';

const CONNECT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 10_000;

const ENTER_KEYS = new Set(['\r', '\n']);
const CTRL_C = '\u0003';
const BACKSPACE_KEYS = new Set(['\u007f', '\b']);

/** A mistake the person running the script made; its message is safe to print. */
class PromptError extends Error {}

/** Reads one line from the terminal without echoing it. Ctrl+C cancels. */
function promptHidden(question: string): Promise<string> {
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (ENTER_KEYS.has(character)) {
          finish();
          resolve(value);
          return;
        }
        if (character === CTRL_C) {
          finish();
          reject(new PromptError('Cancelled.'));
          return;
        }
        value = BACKSPACE_KEYS.has(character) ? value.slice(0, -1) : value + character;
      }
    };
    stdin.on('data', onData);
  });
}

/** The environment, plus a prompted password when ADMIN_PASSWORD is missing and there is a terminal to ask. */
async function environmentWithPassword(): Promise<NodeJS.ProcessEnv> {
  const env = process.env;
  if ((env.ADMIN_PASSWORD ?? '') !== '' || !stdin.isTTY) {
    return env; // missing and no terminal: the config check below names ADMIN_PASSWORD
  }
  const password = await promptHidden('Admin password (12+ characters, not shown): ');
  const again = await promptHidden('Repeat it: ');
  if (password !== again) {
    throw new PromptError('The two passwords differ. Nothing was changed.');
  }
  return { ...env, ADMIN_PASSWORD: password };
}

async function main(): Promise<void> {
  const config = loadSeedAdminConfig(await environmentWithPassword());
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
  if (error instanceof ConfigError || error instanceof PromptError) {
    return error.message;
  }
  const { errorName, errorCode } = errorLogFields(error);
  return `Could not seed the admin (${errorCode ?? errorName}). Check DATABASE_URL and that migrations ran.`;
}
