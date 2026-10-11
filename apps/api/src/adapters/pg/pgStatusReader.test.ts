import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { deadDatabasePool, truncateAll, useTestDatabase } from '../../../test/helpers/db.js';
import { PgStatusReader } from './pgStatusReader.js';

const db = useTestDatabase();

const GUILD_A = '900000000000000011';
const GUILD_B = '900000000000000012';
const NOW_MS = Date.UTC(2026, 9, 11, 15, 30); // 2026-10-11 15:30 UTC
const LATER_TODAY = new Date(Date.UTC(2026, 9, 11, 9, 0));
const YESTERDAY = new Date(Date.UTC(2026, 9, 10, 23, 59, 59));
const clock = { nowMs: (): number => NOW_MS };

let nextId = 0;

/** Seeds one interaction with its action (and a job when given), bypassing the ledger to control created_at. */
async function seed(
  pool: pg.Pool,
  guildId: string,
  options: {
    actionType: 'report' | 'status';
    createdAt: Date;
    job?: { status: 'pending' | 'processing' | 'done' | 'dead'; attempts: number };
  },
): Promise<void> {
  nextId += 1;
  const id = `9100000000000${String(nextId).padStart(5, '0')}`;
  await pool.query('INSERT INTO guild (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [guildId]);
  await pool.query(
    `INSERT INTO interaction (id, guild_id, channel_id, user_id, type, status, created_at)
     VALUES ($1, $2, 'c', 'u', 2, 'answered', $3)`,
    [id, guildId, options.createdAt],
  );
  await pool.query(
    `INSERT INTO action (interaction_id, guild_id, type, mirror_status)
     VALUES ($1, $2, $3, 'pending')`,
    [id, guildId, options.actionType],
  );
  if (options.job !== undefined) {
    await pool.query(
      `INSERT INTO job (interaction_id, guild_id, kind, status, attempts)
       VALUES ($1, $2, 'report', $3, $4)`,
      [id, guildId, options.job.status, options.job.attempts],
    );
  }
}

describe('PgStatusReader', () => {
  it('WHEN a server has no activity THE SYSTEM SHALL report zeros and an unknown worker', async () => {
    const pool = db();
    await truncateAll(pool);

    const counts = await new PgStatusReader(pool, clock).read(GUILD_A);

    expect(counts).toEqual({ reportsToday: 0, retrying: 0, workerLastBeatSeconds: null });
  });

  it('SHALL count only reports from the current UTC day', async () => {
    const pool = db();
    await truncateAll(pool);
    await seed(pool, GUILD_A, { actionType: 'report', createdAt: LATER_TODAY });
    await seed(pool, GUILD_A, { actionType: 'report', createdAt: LATER_TODAY });
    await seed(pool, GUILD_A, { actionType: 'report', createdAt: YESTERDAY });
    await seed(pool, GUILD_A, { actionType: 'status', createdAt: LATER_TODAY });

    const counts = await new PgStatusReader(pool, clock).read(GUILD_A);

    expect(counts.reportsToday).toBe(2);
  });

  it('SHALL count only jobs that were tried and are waiting to be tried again', async () => {
    const pool = db();
    await truncateAll(pool);
    const at = LATER_TODAY;
    await seed(pool, GUILD_A, {
      actionType: 'report',
      createdAt: at,
      job: { status: 'pending', attempts: 2 },
    });
    await seed(pool, GUILD_A, {
      actionType: 'report',
      createdAt: at,
      job: { status: 'pending', attempts: 0 },
    });
    await seed(pool, GUILD_A, {
      actionType: 'report',
      createdAt: at,
      job: { status: 'processing', attempts: 1 },
    });
    await seed(pool, GUILD_A, {
      actionType: 'report',
      createdAt: at,
      job: { status: 'done', attempts: 3 },
    });
    await seed(pool, GUILD_A, {
      actionType: 'report',
      createdAt: at,
      job: { status: 'dead', attempts: 8 },
    });

    const counts = await new PgStatusReader(pool, clock).read(GUILD_A);

    expect(counts.retrying).toBe(1);
  });

  it('SHALL show each server only its own numbers', async () => {
    const pool = db();
    await truncateAll(pool);
    const at = LATER_TODAY;
    await seed(pool, GUILD_A, {
      actionType: 'report',
      createdAt: at,
      job: { status: 'pending', attempts: 1 },
    });
    await seed(pool, GUILD_A, { actionType: 'report', createdAt: at });
    await seed(pool, GUILD_B, { actionType: 'report', createdAt: at });
    await seed(pool, GUILD_B, { actionType: 'report', createdAt: at });
    await seed(pool, GUILD_B, { actionType: 'report', createdAt: at });

    const reader = new PgStatusReader(pool, clock);

    expect(await reader.read(GUILD_A)).toMatchObject({ reportsToday: 2, retrying: 1 });
    expect(await reader.read(GUILD_B)).toMatchObject({ reportsToday: 3, retrying: 0 });
    expect(await reader.read('900000000000000099')).toMatchObject({ reportsToday: 0, retrying: 0 });
  });

  it('WHEN the database is down THE SYSTEM SHALL reject so the caller can say so', async () => {
    const pool = deadDatabasePool();
    try {
      await expect(new PgStatusReader(pool, clock).read(GUILD_A)).rejects.toThrow();
    } finally {
      await pool.end();
    }
  });
});
