import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ActionType,
  AttemptOutcome,
  AttemptTarget,
  InteractionStatus,
  JobKind,
  JobStatus,
  MirrorStatus,
  RULE_SCHEMAS,
} from '@report-line/shared';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { testDatabaseUrl, useTestDatabase } from '../../../test/helpers/db.js';
import { MIGRATIONS_DIR, MigrationError, runMigrations } from './migrator.js';

const db = useTestDatabase();

const constraintDefinitions = async (): Promise<Map<string, string>> => {
  const result = await db().query<{ name: string; def: string }>(
    `SELECT conname AS name, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE contype = 'c' AND connamespace = current_schema()::regnamespace`,
  );
  return new Map(result.rows.map((row) => [row.name, row.def]));
};

const quotedValues = (definition: string): string[] =>
  [...definition.matchAll(/'([^']*)'::text/g)].map((match) => match[1] ?? '').sort();

describe('migrations', () => {
  it('WHEN the runner is executed again THE SYSTEM SHALL apply nothing and keep one ledger row per file', async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      const second = await runMigrations(client, MIGRATIONS_DIR);
      expect(second).toEqual([]);
    } finally {
      await client.end();
    }
    const ledger = await db().query<{ filename: string }>('SELECT filename FROM schema_migrations');
    expect(ledger.rows.map((row) => row.filename)).toEqual(['001_init.sql']);
  });

  it('WHEN a migration fails THE SYSTEM SHALL roll back that file, keep earlier ones and name the file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
    const schema = `mig_test_${String(Date.now())}`;
    const client = new pg.Client({ connectionString: testDatabaseUrl() });
    await client.connect();
    try {
      await writeFile(path.join(dir, '001_first.sql'), 'CREATE TABLE first_table (id int);');
      await writeFile(
        path.join(dir, '002_broken.sql'),
        'CREATE TABLE half_done (id int); SELECT * FROM table_that_does_not_exist;',
      );
      await writeFile(path.join(dir, 'notes.txt'), 'ignored: not a numbered .sql file');
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);

      await expect(runMigrations(client, dir)).rejects.toThrow(MigrationError);
      await expect(runMigrations(client, dir)).rejects.toThrow(/002_broken\.sql/);

      const applied = await client.query<{ filename: string }>(
        'SELECT filename FROM schema_migrations',
      );
      expect(applied.rows.map((row) => row.filename)).toEqual(['001_first.sql']);
      const tables = await client.query<{ tablename: string }>(
        'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
        [schema],
      );
      expect(tables.rows.map((row) => row.tablename)).toEqual(['first_table', 'schema_migrations']);
    } finally {
      await client.query('SET search_path TO DEFAULT');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('schema (DESIGN §9)', () => {
  it('SHALL key dedupe on interaction.id and allow one job and one action per interaction', async () => {
    const result = await db().query<{ tbl: string; def: string }>(
      `SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE contype IN ('p', 'u') AND connamespace = current_schema()::regnamespace`,
    );
    const defs = result.rows.map((row) => `${row.tbl}: ${row.def}`);
    expect(defs).toContain('interaction: PRIMARY KEY (id)');
    expect(defs).toContain('job: UNIQUE (interaction_id)');
    expect(defs).toContain('action: UNIQUE (interaction_id)');
    expect(defs).toContain('command_rule: UNIQUE (guild_id, command_name)');
  });

  it('SHALL keep guild name, channel and webhook optional so a guild can be created from an interaction alone', async () => {
    const result = await db().query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'guild'`,
    );
    const nullable = new Map(result.rows.map((row) => [row.column_name, row.is_nullable]));
    expect(nullable.get('id')).toBe('NO');
    expect(nullable.get('name')).toBe('YES');
    expect(nullable.get('post_channel_id')).toBe('YES');
    expect(nullable.get('mirror_webhook_enc')).toBe('YES');
  });

  it('SHALL NOT index the interaction token', async () => {
    const result = await db().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema()`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.filter((row) => row.indexdef.includes('interaction_token'))).toEqual([]);
  });

  it('SHALL create the indexes DESIGN §9 names', async () => {
    const result = await db().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema()`,
    );
    const defs = result.rows.map((row) => row.indexdef);
    const has = (table: string, columns: string): boolean =>
      defs.some((def) => def.includes(`.${table} USING btree (${columns})`));
    expect(has('job', 'status, next_run_at')).toBe(true);
    expect(has('interaction', 'guild_id, created_at DESC')).toBe(true);
    expect(has('job_attempt', 'job_id, attempt_no')).toBe(true);
    expect(has('session', 'expires_at')).toBe(true);
  });

  it('WHEN a value outside an enum is written THE SYSTEM SHALL reject it at the database', async () => {
    await db().query("INSERT INTO guild (id) VALUES ('1')");
    await expect(
      db().query(
        `INSERT INTO interaction (id, guild_id, channel_id, user_id, type, status)
         VALUES ('i1', '1', 'c', 'u', 2, 'invented')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('enum drift (DESIGN §8.3: one list, two enforcements)', () => {
  const expectedByConstraint: Record<string, readonly string[]> = {
    interaction_status_check: InteractionStatus,
    job_kind_check: JobKind,
    job_status_check: JobStatus,
    job_attempt_target_check: AttemptTarget,
    job_attempt_outcome_check: AttemptOutcome,
    action_type_check: ActionType,
    action_mirror_status_check: MirrorStatus,
    command_rule_command_name_check: Object.keys(RULE_SCHEMAS),
  };

  it('WHEN the CHECK constraints are read back THE SYSTEM SHALL find exactly the values in @report-line/shared', async () => {
    const definitions = await constraintDefinitions();
    for (const [name, expected] of Object.entries(expectedByConstraint)) {
      const definition = definitions.get(name);
      expect(definition, `constraint ${name} exists`).toBeDefined();
      expect(quotedValues(definition ?? ''), name).toEqual([...expected].sort());
    }
  });

  it('SHALL have no CHECK constraint this test does not cover', async () => {
    const definitions = await constraintDefinitions();
    const uncovered = [...definitions.keys()].filter((name) => !(name in expectedByConstraint));
    expect(uncovered).toEqual([]);
  });
});
