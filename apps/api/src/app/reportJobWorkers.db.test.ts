import { describe, expect, it } from 'vitest';

import {
  captureQueryText,
  silentLogger,
  testPoolSettings,
  useTestDatabase,
} from '../../test/helpers/db.js';
import { FAKE_INTERACTION_TOKEN } from '../../test/helpers/payloads.js';
import {
  readJob,
  seedReport,
  startHarness,
  usePipeline,
  WEBHOOK_SECRET,
} from '../../test/helpers/workerHarness.js';
import { PgJobRepository } from '../adapters/pg/pgJobRepository.js';
import { createWorkerPool } from '../adapters/pg/pool.js';

const db = useTestDatabase();
const pipeline = usePipeline(db, { leaseMs: 60_000 });

const idOf = (number: number): string => `9400000000000${String(number).padStart(5, '0')}`;
const patches = () => pipeline().discord.requests.filter((request) => request.method === 'PATCH');

describe('report job: workers', () => {
  it('WHEN a worker claims a job and never finishes it THE SYSTEM SHALL recover the job after the lease expires and deliver it once', async () => {
    const h = pipeline();
    await seedReport(db(), h);
    const orphaned = await new PgJobRepository(db()).claim({
      limit: 5,
      nowMs: h.clock.nowMs(),
      leaseMs: 60_000,
    });
    expect(orphaned).toHaveLength(1); // the "crashed" worker holds the lease and does nothing

    expect(await h.drain()).toBe(0);
    h.clock.advance(59_999);
    expect(await h.drain()).toBe(0);
    h.clock.advance(1);
    expect(await h.drain()).toBe(1);

    expect(await readJob(db())).toMatchObject({
      status: 'done',
      attempts: 2,
      interaction_token: null,
    });
    expect(h.slack.requests).toHaveLength(1);
    expect(patches()).toHaveLength(1);
  });

  it('WHEN the first worker finishes after losing its lease THE SYSTEM SHALL let the second worker’s result stand', async () => {
    const h = pipeline();
    await seedReport(db(), h);
    const repo = new PgJobRepository(db());
    const [stale] = await repo.claim({ limit: 1, nowMs: h.clock.nowMs(), leaseMs: 60_000 });
    h.clock.advance(60_000);
    await h.drain(); // a second pass takes over and completes the job

    if (stale === undefined) {
      throw new Error('Expected the first worker to have claimed the job.');
    }
    const result = await repo.commitStep(stale, null, {
      next: { kind: 'finish', jobStatus: 'dead', interactionStatus: 'failed' },
    });

    expect(result).toBe('lease_lost');
    expect(await readJob(db())).toMatchObject({
      status: 'done',
      interaction_status: 'followed_up',
    });
  });

  it('WHEN two workers drain 20 jobs together THE SYSTEM SHALL process every job exactly once', async () => {
    const h = pipeline();
    for (let number = 1; number <= 20; number += 1) {
      await seedReport(db(), h, { id: idOf(number), text: `report ${String(number)}` });
    }
    const secondPool = createWorkerPool(testPoolSettings(), silentLogger);
    try {
      const second = h.addWorker(secondPool);
      for (let round = 0; round < 50; round += 1) {
        const [first, other] = await Promise.all([h.worker.tick(), second.tick()]);
        if (first + other === 0) {
          break;
        }
      }
    } finally {
      await secondPool.end();
    }

    expect(patches()).toHaveLength(20);
    expect(new Set(patches().map((request) => request.url)).size).toBe(20);
    expect(h.slack.requests).toHaveLength(20);
    expect(new Set(h.slack.requests.map((request) => request.body)).size).toBe(20);
    const rows = await db().query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM job',
    );
    expect(rows.rows).toHaveLength(20);
    expect(rows.rows.every((row) => row.status === 'done' && row.attempts === 1)).toBe(true);
  });

  it('SHALL send neither the interaction token nor the webhook URL inside any SQL text, only as bind parameters', async () => {
    const watched = createWorkerPool(testPoolSettings(), silentLogger);
    const texts = captureQueryText(watched);
    const h = await startHarness(db(), { pool: watched });
    try {
      await seedReport(db(), h);
      await h.drain();
    } finally {
      await h.stop();
      await watched.end();
    }

    expect(texts.length).toBeGreaterThan(3);
    const sql = texts.join('\n');
    expect(sql).not.toContain(FAKE_INTERACTION_TOKEN);
    expect(sql).not.toContain(WEBHOOK_SECRET);
  });
});
