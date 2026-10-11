import type pg from 'pg';

import type { StatusCounts } from '../../domain/status.js';
import type { Clock } from '../../ports/clock.js';
import type { StatusReader } from '../../ports/status.js';
import { HEARTBEAT_ROW_ID } from './pgWorkerHeartbeat.js';

/**
 * Both counts in one round trip, both scoped by $1 = guild_id (CLAUDE.md: tenancy).
 * - reports today: uses the interaction (guild_id, created_at DESC) index, then the action's unique key.
 * - retrying: a job that has been tried and is waiting for its next attempt (attempts count claims, so a
 *   pending job with attempts > 0 has failed at least once or lost its worker).
 * - last_beat: the worker's heartbeat. It is not per server: one worker serves every server.
 */
const READ_COUNTS = `
  SELECT
    (SELECT count(*)
       FROM interaction i
       JOIN action a ON a.interaction_id = i.id
      WHERE i.guild_id = $1 AND i.created_at >= $2::timestamptz AND a.type = 'report')::int
      AS reports_today,
    (SELECT count(*)
       FROM job
      WHERE guild_id = $1 AND status = 'pending' AND attempts > 0)::int
      AS retrying,
    (SELECT beat_at FROM worker_heartbeat WHERE id = $3) AS last_beat`;

interface CountsRow {
  reports_today: number;
  retrying: number;
  last_beat: Date | null;
}

export class PgStatusReader implements StatusReader {
  public constructor(
    private readonly pool: pg.Pool,
    private readonly clock: Clock,
  ) {}

  public async read(guildId: string): Promise<StatusCounts> {
    const nowMs = this.clock.nowMs();
    const result = await this.pool.query<CountsRow>(READ_COUNTS, [
      guildId,
      startOfUtcDay(nowMs),
      HEARTBEAT_ROW_ID,
    ]);
    const row = result.rows[0];
    const lastBeat = row?.last_beat ?? null;
    return {
      reportsToday: row?.reports_today ?? 0,
      retrying: row?.retrying ?? 0,
      // Null until a worker has ever reported, which is the honest answer for a worker that never started.
      workerLastBeatSeconds:
        lastBeat === null ? null : Math.max(0, (nowMs - lastBeat.getTime()) / 1000),
    };
  }
}

/** "Today" is the UTC day, so the number does not depend on where the server runs. */
function startOfUtcDay(nowMs: number): Date {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
