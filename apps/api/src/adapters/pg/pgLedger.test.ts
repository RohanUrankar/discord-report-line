import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  captureQueryText,
  deadDatabasePool,
  forceJobInsertFailure,
  silentLogger,
  testPoolSettings,
  truncateAll,
  useTestDatabase,
} from '../../../test/helpers/db.js';
import { answeredInput, reportInput } from '../../../test/helpers/ledgerInput.js';
import {
  FAKE_INTERACTION_TOKEN,
  GUILD_ID,
  INTERACTION_ID,
} from '../../../test/helpers/payloads.js';
import { createRequestPool } from './pool.js';
import { PgLedger } from './pgLedger.js';

const db = useTestDatabase();

interface GuildRow {
  id: string;
  name: string | null;
  post_channel_id: string | null;
  created_at: Date;
}

async function count(
  pool: pg.Pool,
  table: 'interaction' | 'action' | 'job' | 'guild',
): Promise<number> {
  const result = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0]?.n ?? -1;
}

describe('PgLedger.recordAndEnqueue', () => {
  it('WHEN the same interaction id is delivered 10 times concurrently THE SYSTEM SHALL create one interaction, one action and one job', async () => {
    const pool = db();
    await truncateAll(pool);
    const ledger = new PgLedger(pool);

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => ledger.recordAndEnqueue(reportInput())),
    );

    expect(outcomes.filter((outcome) => outcome === 'won')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'duplicate')).toHaveLength(9);
    expect(await count(pool, 'interaction')).toBe(1);
    expect(await count(pool, 'action')).toBe(1);
    expect(await count(pool, 'job')).toBe(1);
    expect(await count(pool, 'guild')).toBe(1);
  });

  it('WHEN an interaction is recorded THE SYSTEM SHALL store its action, and a pending job with the token in its own column', async () => {
    const pool = db();
    await truncateAll(pool);

    await new PgLedger(pool).recordAndEnqueue(reportInput());

    const action = await pool.query('SELECT type, mirror_status FROM action');
    expect(action.rows).toEqual([{ type: 'report', mirror_status: 'pending' }]);
    const interaction = await pool.query('SELECT status, command_name FROM interaction');
    expect(interaction.rows).toEqual([{ status: 'deferred', command_name: 'report' }]);
    const job = await pool.query(
      'SELECT status, attempts, kind, interaction_token FROM job WHERE interaction_id = $1',
      [INTERACTION_ID],
    );
    expect(job.rows).toEqual([
      { status: 'pending', attempts: 0, kind: 'report', interaction_token: FAKE_INTERACTION_TOKEN },
    ]);
  });

  it('WHEN no job is given THE SYSTEM SHALL record the interaction and action and enqueue nothing', async () => {
    const pool = db();
    await truncateAll(pool);

    const outcome = await new PgLedger(pool).recordAndEnqueue(answeredInput());

    expect(outcome).toBe('won');
    expect(await count(pool, 'interaction')).toBe(1);
    expect(await count(pool, 'action')).toBe(1);
    expect(await count(pool, 'job')).toBe(0);
  });

  it('WHEN a duplicate arrives later THE SYSTEM SHALL change nothing', async () => {
    const pool = db();
    await truncateAll(pool);
    const ledger = new PgLedger(pool);
    await ledger.recordAndEnqueue(reportInput());

    const second = await ledger.recordAndEnqueue(reportInput({ commandName: 'changed' }));

    expect(second).toBe('duplicate');
    const rows = await pool.query('SELECT command_name FROM interaction');
    expect(rows.rows).toEqual([{ command_name: 'report' }]);
  });

  it('WHEN the job insert fails THE SYSTEM SHALL leave no interaction, action or guild row behind', async () => {
    const pool = db();
    await truncateAll(pool);
    const ledger = new PgLedger(pool);
    const undo = await forceJobInsertFailure(pool);
    try {
      // The interaction and action inserts succeed first; only the job insert (the last statement) fails.
      await expect(ledger.recordAndEnqueue(reportInput())).rejects.toMatchObject({ code: '23514' });

      expect(await count(pool, 'interaction')).toBe(0);
      expect(await count(pool, 'action')).toBe(0);
      expect(await count(pool, 'job')).toBe(0);
      expect(await count(pool, 'guild')).toBe(0);
    } finally {
      await undo();
    }
    // Nothing is stuck behind the failure: the same delivery can still win.
    expect(await ledger.recordAndEnqueue(reportInput())).toBe('won');
  });

  it('WHEN writes fail repeatedly THE SYSTEM SHALL release every connection back to the pool', async () => {
    const pool = db();
    await truncateAll(pool);
    const undo = await forceJobInsertFailure(pool);
    const small = createRequestPool(testPoolSettings({ max: 2 }), silentLogger);
    try {
      const ledger = new PgLedger(small);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await expect(ledger.recordAndEnqueue(reportInput())).rejects.toThrow();
      }
      await undo();
      expect(small.waitingCount).toBe(0);
      expect(await ledger.recordAndEnqueue(reportInput())).toBe('won');
    } finally {
      await undo();
      await small.end();
    }
  });

  it('WHEN the process fails after the commit but before the reply THE SYSTEM SHALL keep the rows, visible to other connections', async () => {
    const pool = db();
    await truncateAll(pool);
    const ledger = new PgLedger(pool);

    const crashBeforeAck = async (): Promise<void> => {
      await ledger.recordAndEnqueue(reportInput());
      throw new Error('process died before the HTTP response was written');
    };
    await expect(crashBeforeAck()).rejects.toThrow('process died');

    // A brand-new pool means brand-new connections: only committed data is visible to them.
    const fresh = createRequestPool(testPoolSettings({ max: 1 }), silentLogger);
    try {
      expect(await count(fresh, 'interaction')).toBe(1);
      expect(await count(fresh, 'job')).toBe(1);
    } finally {
      await fresh.end();
    }
  });

  it('WHEN a guild is unseen THE SYSTEM SHALL create it in the same transaction, and a later interaction SHALL leave it unchanged', async () => {
    const pool = db();
    await truncateAll(pool);
    const ledger = new PgLedger(pool);

    await ledger.recordAndEnqueue(answeredInput({ id: '900000000000000101' }));
    const first = await pool.query<GuildRow>('SELECT id, name, post_channel_id, created_at FROM guild');
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ id: GUILD_ID, name: null, post_channel_id: null });

    await pool.query("UPDATE guild SET name = 'Acme', post_channel_id = '42' WHERE id = $1", [
      GUILD_ID,
    ]);
    await ledger.recordAndEnqueue(answeredInput({ id: '900000000000000102' }));

    const second = await pool.query<GuildRow>('SELECT id, name, post_channel_id, created_at FROM guild');
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]).toMatchObject({ name: 'Acme', post_channel_id: '42' });
    expect(second.rows[0]?.created_at).toEqual(first.rows[0]?.created_at);
  });

  it('WHEN many different interactions from one unseen guild arrive concurrently THE SYSTEM SHALL record all of them and one guild', async () => {
    const pool = db();
    await truncateAll(pool);
    const ledger = new PgLedger(pool);

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        ledger.recordAndEnqueue(
          answeredInput({ id: `90000000000001${String(index).padStart(4, '0')}` }),
        ),
      ),
    );

    expect(outcomes.every((outcome) => outcome === 'won')).toBe(true);
    expect(await count(pool, 'interaction')).toBe(10);
    expect(await count(pool, 'guild')).toBe(1);
  });

  it('SHALL send the interaction token only as a bind parameter, never inside SQL text or other tables', async () => {
    await truncateAll(db());
    const watched = createRequestPool(testPoolSettings({ max: 2 }), silentLogger);
    const statements = captureQueryText(watched);
    try {
      await new PgLedger(watched).recordAndEnqueue(reportInput());

      expect(statements.length).toBeGreaterThan(3);
      expect(statements.filter((sql) => sql.includes(FAKE_INTERACTION_TOKEN))).toEqual([]);
      const leaks = await watched.query(
        `SELECT 1 FROM interaction WHERE interaction::text LIKE $1
         UNION ALL SELECT 1 FROM action WHERE action::text LIKE $1
         UNION ALL SELECT 1 FROM guild WHERE guild::text LIKE $1`,
        [`%${FAKE_INTERACTION_TOKEN}%`],
      );
      expect(leaks.rows).toEqual([]);
    } finally {
      await watched.end();
    }
  });

  it('WHEN the database is down THE SYSTEM SHALL reject quickly instead of hanging', async () => {
    const pool = deadDatabasePool();
    const startedAt = Date.now();
    try {
      await expect(new PgLedger(pool).recordAndEnqueue(answeredInput())).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(2000);
    } finally {
      await pool.end();
    }
  });
});
