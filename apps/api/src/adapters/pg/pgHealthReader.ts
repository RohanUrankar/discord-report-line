import type pg from 'pg';

import type { HealthReader } from '../../ports/health.js';
import { HEARTBEAT_ROW_ID } from './pgWorkerHeartbeat.js';

/** A primary-key lookup: as cheap as a ping, and it also proves the heartbeat table is reachable. */
const READ_BEAT = 'SELECT beat_at FROM worker_heartbeat WHERE id = $1';

export class PgHealthReader implements HealthReader {
  public constructor(private readonly pool: pg.Pool) {}

  public async lastWorkerBeatMs(): Promise<number | null> {
    const result = await this.pool.query<{ beat_at: Date }>(READ_BEAT, [HEARTBEAT_ROW_ID]);
    return result.rows[0]?.beat_at.getTime() ?? null;
  }
}
