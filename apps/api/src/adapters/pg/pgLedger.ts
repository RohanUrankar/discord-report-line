import type pg from 'pg';

import type { LedgerService, RecordInput, RecordOutcome } from '../../ports/ledger.js';

// Every value is a bind parameter. The interaction token only ever travels as $n in INSERT_JOB.

/** A server we have never seen gets a row on its first interaction; name, channel and webhook come later. */
const ENSURE_GUILD = 'INSERT INTO guild (id) VALUES ($1) ON CONFLICT (id) DO NOTHING';

/** THE dedupe statement (CLAUDE.md): a returned row means this delivery won, no row means a duplicate. */
const INSERT_INTERACTION = `
  INSERT INTO interaction
    (id, guild_id, channel_id, user_id, type, command_name, custom_id, options, status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
  ON CONFLICT (id) DO NOTHING
  RETURNING id`;

const INSERT_ACTION = `
  INSERT INTO action (interaction_id, guild_id, type, summary, mirror_status)
  VALUES ($1, $2, $3, $4, $5)`;

const INSERT_JOB = `
  INSERT INTO job (interaction_id, guild_id, kind, interaction_token, token_expires_at)
  VALUES ($1, $2, $3, $4, $5)`;

/** Postgres implementation of the ledger: dedupe + outbox on one checked-out connection. */
export class PgLedger implements LedgerService {
  public constructor(private readonly pool: pg.Pool) {}

  public async recordAndEnqueue(input: RecordInput): Promise<RecordOutcome> {
    // One client for the whole transaction. Two pool.query() calls would be two connections, so the
    // "transaction" would be two unrelated statements and a failed job insert could leave an orphan row.
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      const outcome = await this.writeAll(client, input);
      await client.query('COMMIT');
      return outcome;
    } catch (error) {
      discard = !(await rollback(client));
      throw error;
    } finally {
      // Releasing with `true` destroys the connection instead of returning one in an unknown state.
      client.release(discard);
    }
  }

  private async writeAll(client: pg.PoolClient, input: RecordInput): Promise<RecordOutcome> {
    const { interaction, action, job } = input;
    await client.query(ENSURE_GUILD, [interaction.guildId]);
    const inserted = await client.query(INSERT_INTERACTION, [
      interaction.id,
      interaction.guildId,
      interaction.channelId,
      interaction.userId,
      interaction.type,
      interaction.commandName,
      interaction.customId,
      interaction.options === null ? null : JSON.stringify(interaction.options),
      interaction.status,
    ]);
    if (inserted.rows.length === 0) {
      return 'duplicate';
    }
    await client.query(INSERT_ACTION, [
      interaction.id,
      interaction.guildId,
      action.type,
      action.summary,
      action.mirrorStatus,
    ]);
    if (job !== undefined) {
      await client.query(INSERT_JOB, [
        interaction.id,
        interaction.guildId,
        job.kind,
        job.interactionToken,
        job.tokenExpiresAt,
      ]);
    }
    return 'won';
  }
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
