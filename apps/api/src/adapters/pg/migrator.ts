import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type pg from 'pg';

/** apps/api/migrations, resolved from this file so the CLI and the tests find the same directory. */
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../migrations');

/** Numbered plain SQL: the number fixes the order, the name says what it does. */
const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;

/** Arbitrary constant: every runner takes this advisory lock, so two of them never interleave. */
const MIGRATION_LOCK_KEY = 7_240_001;

const CREATE_LEDGER_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

export class MigrationError extends Error {
  public constructor(
    public readonly filename: string,
    cause: unknown,
  ) {
    super(`Migration ${filename} failed and was rolled back`, { cause });
    this.name = 'MigrationError';
  }
}

/**
 * Applies the migrations in `dir` that `schema_migrations` does not list yet, oldest first, each in its
 * own transaction together with its ledger row. Safe to run twice and from two processes at once.
 * Takes a dedicated `Client` (not the request pool): migrations must not inherit the request path's
 * statement_timeout. Returns the filenames it applied.
 */
export async function runMigrations(client: pg.Client, dir: string): Promise<string[]> {
  const files = await listMigrationFiles(dir);
  await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
  try {
    await client.query(CREATE_LEDGER_TABLE);
    const applied = await appliedFilenames(client);
    const ran: string[] = [];
    for (const filename of files.filter((file) => !applied.has(file))) {
      await applyMigration(client, dir, filename);
      ran.push(filename);
    }
    return ran;
  } finally {
    // If the connection is already gone the lock died with the session, so there is nothing to release.
    await client
      .query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
  }
}

async function listMigrationFiles(dir: string): Promise<string[]> {
  // `dir` is chosen by our own code (MIGRATIONS_DIR or a test), never by a request.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const entries = await readdir(dir);
  return entries.filter((name) => MIGRATION_FILE.test(name)).sort();
}

async function appliedFilenames(client: pg.Client): Promise<Set<string>> {
  const result = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(result.rows.map((row) => row.filename));
}

async function applyMigration(client: pg.Client, dir: string, filename: string): Promise<void> {
  // filename passed MIGRATION_FILE, so it cannot contain a separator or `..`.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const sql = await readFile(path.join(dir, filename), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new MigrationError(filename, error);
  }
}
