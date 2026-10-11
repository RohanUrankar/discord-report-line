import { describe, expect, it } from 'vitest';

import { silentLogger, truncateAll, useTestDatabase } from '../../../test/helpers/db.js';
import { commandPayload } from '../../../test/helpers/payloads.js';
import { NOW_MS, wire, type Reply } from '../../../test/helpers/pgApp.js';
import { Worker } from '../../app/worker.js';
import { PgJobRepository } from './pgJobRepository.js';
import { PgStatusReader } from './pgStatusReader.js';
import { PgWorkerHeartbeat } from './pgWorkerHeartbeat.js';

const db = useTestDatabase();

describe('PgWorkerHeartbeat', () => {
  it('SHALL keep exactly one row, however many times the worker beats', async () => {
    const pool = db();
    await truncateAll(pool);
    const heartbeat = new PgWorkerHeartbeat(pool);

    await heartbeat.beat(NOW_MS - 10_000);
    await heartbeat.beat(NOW_MS - 4000);

    const rows = await pool.query('SELECT id, beat_at FROM worker_heartbeat');
    expect(rows.rows).toEqual([{ id: 'worker', beat_at: new Date(NOW_MS - 4000) }]);
  });

  it('WHEN the worker has beaten THE SYSTEM SHALL let the status reader report how long ago', async () => {
    const pool = db();
    await truncateAll(pool);
    await new PgWorkerHeartbeat(pool).beat(NOW_MS - 4000);

    const counts = await new PgStatusReader(pool, { nowMs: () => NOW_MS }).read(
      '900000000000000001',
    );

    expect(counts.workerLastBeatSeconds).toBe(4);
  });

  it('WHEN a worker ticks while /status is run THE SYSTEM SHALL show "Worker last active N s ago"', async () => {
    const pool = db();
    await truncateAll(pool);
    const worker = new Worker(
      {
        jobs: new PgJobRepository(pool),
        runner: { run: () => Promise.resolve() },
        heartbeat: new PgWorkerHeartbeat(pool),
        clock: { nowMs: () => NOW_MS - 3000 },
        logger: silentLogger,
      },
      { batch: 5, pollIntervalMs: 1000, leaseMs: 60_000 },
    );
    await worker.tick();
    const { send } = wire(pool);

    const res = await send(commandPayload('status')).expect(200);

    expect((res.body as Reply).data.content).toContain('Worker last active 3 s ago');
  });

  it('WHEN no worker has ever beaten THE SYSTEM SHALL say so instead of inventing a time', async () => {
    const pool = db();
    await truncateAll(pool);
    const { send } = wire(pool);

    const res = await send(commandPayload('status')).expect(200);

    expect((res.body as Reply).data.content).toContain("The worker hasn't checked in yet");
  });
});
