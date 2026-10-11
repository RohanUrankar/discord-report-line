import type pg from 'pg';

import type { MirrorStatus } from '../../domain/types.js';
import type {
  AttemptRecord,
  ClaimedJob,
  ClaimRequest,
  CommitResult,
  JobRepository,
  StepEffect,
} from '../../ports/jobs.js';

// Every value is a bind parameter. The interaction token is only ever read here, in the claim statement, and
// only ever written as NULL (cleared) after the ledger stored it.

/**
 * THE claim (DESIGN §11.1, CLAUDE.md). One statement, so the lease is committed before any network call:
 * pick due jobs with `FOR UPDATE SKIP LOCKED` (a second worker skips rows this one is claiming), stamp the
 * lease, count the pass, and read what the pass needs. A `processing` job whose lease is older than the lease
 * length is presumed orphaned by a crashed worker and is claimable again.
 */
const CLAIM = `
  WITH picked AS (
    SELECT id FROM job
     WHERE (status = 'pending' AND next_run_at <= $1::timestamptz)
        OR (status = 'processing'
            AND claimed_at <= $1::timestamptz - make_interval(secs => $2::double precision / 1000))
     ORDER BY next_run_at
     LIMIT $3::int
     FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE job
       SET status = 'processing', claimed_at = $1::timestamptz, attempts = job.attempts + 1
      FROM picked
     WHERE job.id = picked.id
    RETURNING job.id, job.interaction_id, job.guild_id, job.attempts, job.claimed_at,
              job.interaction_token, job.token_expires_at, job.payload, job.next_run_at
  )
  SELECT c.id, c.interaction_id, c.guild_id, c.attempts, c.claimed_at, c.interaction_token,
         c.token_expires_at, c.payload, a.mirror_status, a.llm_tag, g.mirror_webhook_enc, g.post_channel_id,
         i.channel_id
    FROM claimed c
    JOIN interaction i ON i.id = c.interaction_id
    JOIN action a ON a.interaction_id = c.interaction_id
    JOIN guild g ON g.id = c.guild_id
   ORDER BY c.next_run_at`;

/** Takes the job's row lock and proves the lease is still ours. No row means another worker owns it now. */
const LOCK_OWN_LEASE = `
  SELECT interaction_id FROM job
   WHERE id = $1 AND status = 'processing' AND claimed_at = $2::timestamptz
     FOR UPDATE`;

const INSERT_ATTEMPT = `
  INSERT INTO job_attempt (job_id, attempt_no, target, outcome, http_status, error, started_at, finished_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;

/** Once only: a tag already set (or the fallback) is never overwritten. */
const SET_LLM_TAG = 'UPDATE action SET llm_tag = $2 WHERE interaction_id = $1 AND llm_tag IS NULL';

const SET_MIRROR_STATUS = 'UPDATE action SET mirror_status = $2 WHERE interaction_id = $1';

/** A step that is neither a retry nor the end: record an error, maybe drop the dead token, keep the lease. */
const UPDATE_PROGRESS = `
  UPDATE job
     SET last_error = COALESCE($2, last_error),
         interaction_token = CASE WHEN $3::boolean THEN NULL ELSE interaction_token END
   WHERE id = $1`;

/** Back to the queue for a later pass. The token stays: the next pass may still use it. */
const UPDATE_RETRY = `
  UPDATE job
     SET status = 'pending', next_run_at = $2::timestamptz, claimed_at = NULL, last_error = $3
   WHERE id = $1`;

/** The end. The token is always cleared; a clean finish also clears any error from earlier passes. */
const UPDATE_FINISH = `
  UPDATE job
     SET status = $2, interaction_token = NULL, claimed_at = NULL,
         last_error = CASE WHEN $2 = 'done' THEN NULL ELSE COALESCE($3, last_error) END
   WHERE id = $1`;

const SET_INTERACTION_STATUS = 'UPDATE interaction SET status = $2 WHERE id = $1';

interface ClaimRow {
  id: string;
  interaction_id: string;
  guild_id: string;
  attempts: number;
  claimed_at: Date;
  interaction_token: string | null;
  token_expires_at: Date | null;
  payload: unknown;
  mirror_status: MirrorStatus;
  llm_tag: string | null;
  mirror_webhook_enc: Buffer | null;
  post_channel_id: string | null;
  channel_id: string;
}

export class PgJobRepository implements JobRepository {
  public constructor(private readonly pool: pg.Pool) {}

  public async claim(request: ClaimRequest): Promise<ClaimedJob[]> {
    const result = await this.pool.query<ClaimRow>(CLAIM, [
      new Date(request.nowMs),
      request.leaseMs,
      request.limit,
    ]);
    return result.rows.map(toClaimedJob);
  }

  public async commitStep(
    job: ClaimedJob,
    attempt: AttemptRecord | null,
    effect: StepEffect,
  ): Promise<CommitResult> {
    // One client for the whole transaction: two pool.query calls would be two unrelated connections.
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      const result = await this.apply(client, job, attempt, effect);
      await client.query(result === 'applied' ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      discard = !(await rollback(client));
      throw error;
    } finally {
      client.release(discard);
    }
  }

  private async apply(
    client: pg.PoolClient,
    job: ClaimedJob,
    attempt: AttemptRecord | null,
    effect: StepEffect,
  ): Promise<CommitResult> {
    const own = await client.query(LOCK_OWN_LEASE, [job.id, job.claimedAt]);
    if (own.rows.length === 0) {
      return 'lease_lost';
    }
    if (attempt !== null) {
      await client.query(INSERT_ATTEMPT, [
        job.id,
        attempt.attemptNo,
        attempt.target,
        attempt.outcome,
        attempt.httpStatus ?? null,
        attempt.error ?? null,
        attempt.startedAt,
        attempt.finishedAt,
      ]);
    }
    if (effect.llmTag !== undefined) {
      await client.query(SET_LLM_TAG, [job.interactionId, effect.llmTag]);
    }
    if (effect.mirrorStatus !== undefined) {
      await client.query(SET_MIRROR_STATUS, [job.interactionId, effect.mirrorStatus]);
    }
    await this.applyJobTransition(client, job, effect);
    return 'applied';
  }

  private async applyJobTransition(
    client: pg.PoolClient,
    job: ClaimedJob,
    effect: StepEffect,
  ): Promise<void> {
    const { next } = effect;
    switch (next?.kind) {
      case undefined:
        await client.query(UPDATE_PROGRESS, [
          job.id,
          effect.lastError ?? null,
          effect.clearToken ?? false,
        ]);
        return;
      case 'retry':
        await client.query(UPDATE_RETRY, [job.id, next.runAt, effect.lastError ?? null]);
        return;
      case 'finish':
        await client.query(UPDATE_FINISH, [job.id, next.jobStatus, effect.lastError ?? null]);
        await client.query(SET_INTERACTION_STATUS, [job.interactionId, next.interactionStatus]);
        return;
    }
  }
}

function toClaimedJob(row: ClaimRow): ClaimedJob {
  return {
    id: row.id,
    interactionId: row.interaction_id,
    guildId: row.guild_id,
    attempts: row.attempts,
    claimedAt: row.claimed_at,
    interactionToken: row.interaction_token,
    tokenExpiresAt: row.token_expires_at,
    payload: row.payload,
    mirrorStatus: row.mirror_status,
    llmTag: row.llm_tag,
    mirrorWebhookEnc: row.mirror_webhook_enc,
    postChannelId: row.post_channel_id,
    channelId: row.channel_id,
  };
}

/** True when the transaction was rolled back cleanly; false when the connection is too broken to say. */
async function rollback(client: pg.PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}
