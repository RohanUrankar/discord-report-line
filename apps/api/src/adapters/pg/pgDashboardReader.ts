import {
  ActionType,
  AttemptOutcome,
  AttemptTarget,
  InteractionStatus,
  JobStatus,
  MirrorStatus,
} from '@report-line/shared';
import type pg from 'pg';
import { z } from 'zod';

import {
  InvalidCursorError,
  type AttemptRecord,
  type DashboardReader,
  type GuildRecord,
  type LogQuery,
  type LogRecord,
} from '../../ports/dashboard.js';

// Tenancy (CLAUDE.md): every guild query below joins admin_guild on the signed-in admin AND filters on
// guild_id. Columns are listed by name: no SELECT *, so interaction_token and mirror_webhook_enc are not
// even read. $1 is always the admin id, $2 the guild id.

const MANAGES = `SELECT 1 FROM admin_guild WHERE admin_id = $1 AND guild_id = $2`;

const LIST_GUILDS = `
  SELECT g.id, g.name
    FROM admin_guild ag
    JOIN guild g ON g.id = ag.guild_id
   WHERE ag.admin_id = $1
   ORDER BY g.name NULLS LAST, g.id`;

/** to_char keeps the microseconds a JS Date would lose; the keyset cursor needs them (see logCursor.ts). */
const LOG_COLUMNS = `
  i.id, i.created_at,
  to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact,
  i.command_name, i.user_id, i.status AS interaction_status,
  a.type AS action_type, a.mirror_status, a.llm_tag,
  j.status AS job_status, j.attempts AS job_attempts, j.last_error AS job_last_error,
  COALESCE(j.payload ->> 'tag' = 'true', false) AS job_tag_requested`;

const LOG_FROM = `
  FROM interaction i
  JOIN admin_guild ag ON ag.guild_id = i.guild_id AND ag.admin_id = $1
  LEFT JOIN action a ON a.interaction_id = i.id
  LEFT JOIN job j ON j.interaction_id = i.id`;

/** $3 job status filter, $4/$5 keyset position, $6 row limit; each filter is inert when its parameter is NULL. */
const LIST_INTERACTIONS = `
  SELECT ${LOG_COLUMNS}
  ${LOG_FROM}
  WHERE i.guild_id = $2
    AND ($3::text IS NULL OR j.status = $3::text)
    AND ($4::timestamptz IS NULL OR (i.created_at, i.id) < ($4::timestamptz, $5::text))
  ORDER BY i.created_at DESC, i.id DESC
  LIMIT $6`;

const FIND_INTERACTION = `
  SELECT ${LOG_COLUMNS}
  ${LOG_FROM}
  WHERE i.guild_id = $2 AND i.id = $3`;

/** Oldest first; within one pass the calls run in the order tag, mirror, follow-up, fallback (DESIGN §11.3). */
const LIST_ATTEMPTS = `
  SELECT t.attempt_no, t.target, t.outcome, t.http_status, t.error, t.started_at, t.finished_at
    FROM job_attempt t
    JOIN job j ON j.id = t.job_id
    JOIN interaction i ON i.id = j.interaction_id
    JOIN admin_guild ag ON ag.guild_id = i.guild_id AND ag.admin_id = $1
   WHERE i.guild_id = $2 AND i.id = $3
   ORDER BY t.attempt_no,
            CASE t.target WHEN 'tag' THEN 0 WHEN 'mirror' THEN 1 WHEN 'followup' THEN 2 ELSE 3 END,
            t.started_at`;

// The CHECK constraints already limit these columns; parsing anyway keeps the types honest without `as`
// and turns a future drift between the schema and the shared enums into a loud error, not a bad response.
const LogRow = z.object({
  id: z.string(),
  created_at: z.date(),
  created_at_exact: z.string(),
  command_name: z.string().nullable(),
  user_id: z.string(),
  interaction_status: z.enum(InteractionStatus),
  action_type: z.enum(ActionType).nullable(),
  mirror_status: z.enum(MirrorStatus).nullable(),
  llm_tag: z.string().nullable(),
  job_status: z.enum(JobStatus).nullable(),
  job_attempts: z.number().int().nullable(),
  job_last_error: z.string().nullable(),
  job_tag_requested: z.boolean(),
});
type LogRow = z.infer<typeof LogRow>;

const AttemptRow = z.object({
  attempt_no: z.number().int(),
  target: z.enum(AttemptTarget),
  outcome: z.enum(AttemptOutcome),
  http_status: z.number().int().nullable(),
  error: z.string().nullable(),
  started_at: z.date(),
  finished_at: z.date().nullable(),
});

const GuildRow = z.object({ id: z.string(), name: z.string().nullable() });

function toLogRecord(raw: unknown): LogRecord {
  const row: LogRow = LogRow.parse(raw);
  return {
    id: row.id,
    createdAt: row.created_at,
    createdAtExact: row.created_at_exact,
    command: row.command_name,
    userId: row.user_id,
    interactionStatus: row.interaction_status,
    action:
      row.action_type === null || row.mirror_status === null
        ? null
        : { type: row.action_type, mirrorStatus: row.mirror_status, llmTag: row.llm_tag },
    job:
      row.job_status === null
        ? null
        : {
            status: row.job_status,
            attempts: row.job_attempts ?? 0,
            lastError: row.job_last_error,
            tagRequested: row.job_tag_requested,
          },
  };
}

function toAttemptRecord(raw: unknown): AttemptRecord {
  const row = AttemptRow.parse(raw);
  return {
    attemptNo: row.attempt_no,
    target: row.target,
    outcome: row.outcome,
    httpStatus: row.http_status,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** 22007 invalid_datetime_format, 22008 datetime_field_overflow. */
function isBadTimestamp(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === '22007' || error.code === '22008')
  );
}

export class PgDashboardReader implements DashboardReader {
  public constructor(private readonly pool: pg.Pool) {}

  public async managesGuild(adminId: string, guildId: string): Promise<boolean> {
    const result = await this.pool.query(MANAGES, [adminId, guildId]);
    return result.rowCount === 1;
  }

  public async listGuilds(adminId: string): Promise<GuildRecord[]> {
    const result = await this.pool.query(LIST_GUILDS, [adminId]);
    return result.rows.map((row): GuildRecord => GuildRow.parse(row));
  }

  public async listInteractions(
    adminId: string,
    guildId: string,
    query: LogQuery,
  ): Promise<LogRecord[]> {
    try {
      const result = await this.pool.query(LIST_INTERACTIONS, [
        adminId,
        guildId,
        query.jobStatus ?? null,
        query.after?.at ?? null,
        query.after?.id ?? null,
        query.limit,
      ]);
      return result.rows.map(toLogRecord);
    } catch (error) {
      // Defence in depth: the decoder already checks the calendar, but the store has the last word on what a
      // timestamp is. The cursor is the only user text in this query.
      if (query.after !== undefined && isBadTimestamp(error)) {
        throw new InvalidCursorError();
      }
      throw error;
    }
  }

  public async findInteraction(
    adminId: string,
    guildId: string,
    interactionId: string,
  ): Promise<{ row: LogRecord; attempts: AttemptRecord[] } | undefined> {
    const found = await this.pool.query(FIND_INTERACTION, [adminId, guildId, interactionId]);
    if (found.rows[0] === undefined) {
      return undefined;
    }
    const attempts = await this.pool.query(LIST_ATTEMPTS, [adminId, guildId, interactionId]);
    return { row: toLogRecord(found.rows[0]), attempts: attempts.rows.map(toAttemptRecord) };
  }
}
