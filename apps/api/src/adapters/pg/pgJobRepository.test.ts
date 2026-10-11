import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { reportInput } from '../../../test/helpers/ledgerInput.js';
import {
  captureQueryText,
  testDatabaseUrl,
  truncateAll,
  useTestDatabase,
} from '../../../test/helpers/db.js';
import { FAKE_INTERACTION_TOKEN } from '../../../test/helpers/payloads.js';
import type { AttemptRecord, ClaimedJob } from '../../ports/jobs.js';
import { PgJobRepository } from './pgJobRepository.js';
import { PgLedger } from './pgLedger.js';

const db = useTestDatabase();

const NOW_MS = Date.UTC(2026, 9, 11, 15, 30);
const LEASE_MS = 60_000;

/** Records a deferred report through the real ledger, then makes it due at `dueAtMs`. */
async function seedJob(pool: pg.Pool, number: number, dueAtMs = NOW_MS): Promise<string> {
  const id = `9200000000000${String(number).padStart(5, '0')}`;
  await new PgLedger(pool).recordAndEnqueue(reportInput({ id }));
  await pool.query('UPDATE job SET next_run_at = $2 WHERE interaction_id = $1', [
    id,
    new Date(dueAtMs),
  ]);
  return id;
}

const claim = (repo: PgJobRepository, nowMs = NOW_MS, limit = 5): Promise<ClaimedJob[]> =>
  repo.claim({ limit, nowMs, leaseMs: LEASE_MS });

function attemptRecord(job: ClaimedJob): AttemptRecord {
  return {
    attemptNo: job.attempts,
    target: 'mirror',
    outcome: 'success',
    httpStatus: 200,
    error: undefined,
    startedAt: new Date(NOW_MS),
    finishedAt: new Date(NOW_MS),
  };
}

async function firstClaimed(repo: PgJobRepository): Promise<ClaimedJob> {
  const [job] = await claim(repo);
  if (job === undefined) {
    throw new Error('Expected a claimed job.');
  }
  return job;
}

describe('PgJobRepository.claim', () => {
  it('WHEN a job is due THE SYSTEM SHALL claim it, stamp the lease, count the pass and return what the pass needs', async () => {
    const pool = db();
    await truncateAll(pool);
    const id = await seedJob(pool, 1);

    const [job] = await claim(new PgJobRepository(pool));

    expect(job).toMatchObject({
      interactionId: id,
      attempts: 1,
      interactionToken: FAKE_INTERACTION_TOKEN,
      mirrorStatus: 'pending',
      mirrorWebhookEnc: null,
      postChannelId: null,
    });
    expect(job?.claimedAt.getTime()).toBe(NOW_MS);
    const row = await pool.query('SELECT status, attempts, claimed_at FROM job');
    expect(row.rows).toEqual([{ status: 'processing', attempts: 1, claimed_at: new Date(NOW_MS) }]);
  });

  it('WHEN a job is not due yet THE SYSTEM SHALL leave it alone', async () => {
    const pool = db();
    await truncateAll(pool);
    await seedJob(pool, 1, NOW_MS + 1);

    expect(await claim(new PgJobRepository(pool))).toEqual([]);
  });

  it('SHALL claim no more than the limit, oldest first', async () => {
    const pool = db();
    await truncateAll(pool);
    await seedJob(pool, 1, NOW_MS - 3000);
    await seedJob(pool, 2, NOW_MS - 2000);
    await seedJob(pool, 3, NOW_MS - 1000);

    const claimed = await claim(new PgJobRepository(pool), NOW_MS, 2);

    expect(claimed.map((job) => job.interactionId)).toEqual([
      '920000000000000001',
      '920000000000000002',
    ]);
  });

  it('WHEN a claimed job is never finished THE SYSTEM SHALL return it to the queue after the lease expires', async () => {
    const pool = db();
    await truncateAll(pool);
    await seedJob(pool, 1);
    const repo = new PgJobRepository(pool);
    await claim(repo);

    expect(await claim(repo, NOW_MS + LEASE_MS - 1)).toEqual([]);
    const [recovered] = await claim(repo, NOW_MS + LEASE_MS);

    expect(recovered?.attempts).toBe(2);
    expect(recovered?.claimedAt.getTime()).toBe(NOW_MS + LEASE_MS);
  });

  it('WHEN two workers claim 20 jobs concurrently THE SYSTEM SHALL give each job to exactly one of them', async () => {
    const pool = db();
    await truncateAll(pool);
    for (let number = 1; number <= 20; number += 1) {
      await seedJob(pool, number);
    }
    const first = new PgJobRepository(pool);
    const second = new PgJobRepository(pool);

    const batches = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        claim(index % 2 === 0 ? first : second, NOW_MS, 3),
      ),
    );

    const ids = batches.flat().map((job) => job.interactionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(20);
  });

  it('SHALL send the interaction token only as a bind parameter or a result column, never in SQL text', async () => {
    const pool = db();
    await truncateAll(pool);
    await seedJob(pool, 1);
    const watched = new pg.Pool({ connectionString: testDatabaseUrl(), max: 2 });
    const texts = captureQueryText(watched);
    try {
      const repo = new PgJobRepository(watched);
      const job = await firstClaimed(repo);
      await repo.commitStep(job, attemptRecord(job), { clearToken: true, lastError: 'x' });
    } finally {
      await watched.end();
    }

    expect(texts.length).toBeGreaterThan(0);
    expect(texts.join('\n')).not.toContain(FAKE_INTERACTION_TOKEN);
  });
});

describe('PgJobRepository.commitStep', () => {
  it('SHALL write the attempt and the mirror marker in one transaction', async () => {
    const pool = db();
    await truncateAll(pool);
    await seedJob(pool, 1);
    const repo = new PgJobRepository(pool);
    const job = await firstClaimed(repo);

    const result = await repo.commitStep(job, attemptRecord(job), { mirrorStatus: 'sent' });

    expect(result).toBe('applied');
    const attempts = await pool.query(
      'SELECT attempt_no, target, outcome, http_status FROM job_attempt',
    );
    expect(attempts.rows).toEqual([
      { attempt_no: 1, target: 'mirror', outcome: 'success', http_status: 200 },
    ]);
    const action = await pool.query('SELECT mirror_status FROM action');
    expect(action.rows).toEqual([{ mirror_status: 'sent' }]);
    const row = await pool.query('SELECT status, interaction_token FROM job');
    expect(row.rows).toEqual([{ status: 'processing', interaction_token: FAKE_INTERACTION_TOKEN }]);
  });

  it('WHEN the step schedules a retry THE SYSTEM SHALL return the job to pending, release the lease and keep the token', async () => {
    const pool = db();
    await truncateAll(pool);
    await seedJob(pool, 1);
    const repo = new PgJobRepository(pool);
    const job = await firstClaimed(repo);
    const runAt = new Date(NOW_MS + 5000);

    await repo.commitStep(job, null, {
      lastError: 'Slack is down',
      next: { kind: 'retry', runAt },
    });

    const row = await pool.query(
      'SELECT status, next_run_at, claimed_at, last_error, interaction_token FROM job',
    );
    expect(row.rows).toEqual([
      {
        status: 'pending',
        next_run_at: runAt,
        claimed_at: null,
        last_error: 'Slack is down',
        interaction_token: FAKE_INTERACTION_TOKEN,
      },
    ]);
  });

  it('WHEN the step finishes the job THE SYSTEM SHALL clear the token and set the job and interaction status together', async () => {
    const pool = db();
    await truncateAll(pool);
    await seedJob(pool, 1);
    const repo = new PgJobRepository(pool);
    const job = await firstClaimed(repo);

    await repo.commitStep(job, attemptRecord(job), {
      next: { kind: 'finish', jobStatus: 'done', interactionStatus: 'followed_up' },
    });

    const row = await pool.query(
      `SELECT j.status, j.interaction_token, j.claimed_at, i.status AS interaction_status
         FROM job j JOIN interaction i ON i.id = j.interaction_id`,
    );
    expect(row.rows).toEqual([
      {
        status: 'done',
        interaction_token: null,
        claimed_at: null,
        interaction_status: 'followed_up',
      },
    ]);
  });

  it('WHEN a job finishes dead THE SYSTEM SHALL keep its last error for the dashboard, and WHEN done SHALL clear an older one', async () => {
    const pool = db();
    await truncateAll(pool);
    await seedJob(pool, 1);
    await seedJob(pool, 2);
    const repo = new PgJobRepository(pool);
    const [dead, done] = await claim(repo);
    if (dead === undefined || done === undefined) {
      throw new Error('Expected two claimed jobs.');
    }
    await pool.query('UPDATE job SET last_error = $2 WHERE id = $1', [done.id, 'old error']);

    await repo.commitStep(dead, null, {
      lastError: 'Slack says the webhook no longer exists.',
      next: { kind: 'finish', jobStatus: 'dead', interactionStatus: 'failed' },
    });
    await repo.commitStep(done, null, {
      next: { kind: 'finish', jobStatus: 'done', interactionStatus: 'followed_up' },
    });

    const rows = await pool.query('SELECT id, status, last_error FROM job');
    const byId = new Map(rows.rows.map((row: { id: string }) => [row.id, row]));
    expect(byId.get(dead.id)).toMatchObject({
      status: 'dead',
      last_error: 'Slack says the webhook no longer exists.',
    });
    expect(byId.get(done.id)).toMatchObject({ status: 'done', last_error: null });
  });

  it('WHEN the lease was lost to another worker THE SYSTEM SHALL write nothing', async () => {
    const pool = db();
    await truncateAll(pool);
    await seedJob(pool, 1);
    const repo = new PgJobRepository(pool);
    const stale = await firstClaimed(repo);
    await claim(repo, NOW_MS + LEASE_MS); // the lease expired and a second pass took the job

    const result = await repo.commitStep(stale, attemptRecord(stale), { mirrorStatus: 'sent' });

    expect(result).toBe('lease_lost');
    expect((await pool.query('SELECT 1 FROM job_attempt')).rows).toEqual([]);
    expect((await pool.query('SELECT mirror_status FROM action')).rows).toEqual([
      { mirror_status: 'pending' },
    ]);
  });

  it('WHEN the write fails midway THE SYSTEM SHALL roll back the attempt and the marker together', async () => {
    const pool = db();
    await truncateAll(pool);
    await seedJob(pool, 1);
    const repo = new PgJobRepository(pool);
    const job = await firstClaimed(repo);
    const impossible: AttemptRecord = {
      ...attemptRecord(job),
      outcome: 'success',
      httpStatus: 2 ** 40,
    };

    await expect(repo.commitStep(job, impossible, { mirrorStatus: 'sent' })).rejects.toThrow();

    expect((await pool.query('SELECT 1 FROM job_attempt')).rows).toEqual([]);
    expect((await pool.query('SELECT mirror_status FROM action')).rows).toEqual([
      { mirror_status: 'pending' },
    ]);
  });
});
