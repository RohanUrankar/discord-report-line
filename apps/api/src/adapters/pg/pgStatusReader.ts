import type pg from 'pg';

import type { StatusCounts } from '../../domain/status.js';
import type { Clock } from '../../ports/clock.js';
import type { StatusReader } from '../../ports/status.js';

/**
 * Both counts in one round trip, both scoped by $1 = guild_id (CLAUDE.md: tenancy).
 * - reports today: uses the interaction (guild_id, created_at DESC) index, then the action's unique key.
 * - retrying: a job that has been tried and is waiting for its next attempt (attempts count claims, so a
 *   pending job with attempts > 0 has failed at least once or lost its worker).
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
      AS retrying`;

interface CountsRow {
  reports_today: number;
  retrying: number;
}

export class PgStatusReader implements StatusReader {
  public constructor(
    private readonly pool: pg.Pool,
    private readonly clock: Clock,
  ) {}

  public async read(guildId: string): Promise<StatusCounts> {
    const result = await this.pool.query<CountsRow>(READ_COUNTS, [
      guildId,
      startOfUtcDay(this.clock.nowMs()),
    ]);
    const row = result.rows[0];
    return {
      reportsToday: row?.reports_today ?? 0,
      retrying: row?.retrying ?? 0,
      // The worker records a heartbeat in Step 3; until then "never reported" is the honest answer.
      workerLastBeatSeconds: null,
    };
  }
}

/** "Today" is the UTC day, so the number does not depend on where the server runs. */
function startOfUtcDay(nowMs: number): Date {
  const now = new Date(nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
