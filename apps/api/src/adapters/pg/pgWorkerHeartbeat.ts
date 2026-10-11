import type pg from 'pg';

import type { WorkerHeartbeat } from '../../ports/heartbeat.js';

/** Every worker writes the same row: "some worker is alive" is what /status wants to know. */
export const HEARTBEAT_ROW_ID = 'worker';

const UPSERT_BEAT = `
  INSERT INTO worker_heartbeat (id, beat_at) VALUES ($1, $2)
  ON CONFLICT (id) DO UPDATE SET beat_at = EXCLUDED.beat_at`;

export class PgWorkerHeartbeat implements WorkerHeartbeat {
  public constructor(private readonly pool: pg.Pool) {}

  public async beat(nowMs: number): Promise<void> {
    await this.pool.query(UPSERT_BEAT, [HEARTBEAT_ROW_ID, new Date(nowMs)]);
  }
}
