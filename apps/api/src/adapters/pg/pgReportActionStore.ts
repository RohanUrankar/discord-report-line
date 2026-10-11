import { DEFAULT_RULES } from '@report-line/shared';
import type pg from 'pg';
import { z } from 'zod';

import { ACTION_SUMMARIES } from '../../domain/messages.js';
import {
  blockingActionTypes,
  CLICK_ACTION_TYPE,
  stateOf,
  type ReportView,
} from '../../domain/reportState.js';
import type { ClickOutcome, ReportActionStore, ReportClick } from '../../ports/reportActions.js';

// Tenancy (CLAUDE.md): the guild in every statement is the signed interaction's, never the custom_id's.

/**
 * The report must exist in THIS server and be a report (an action of type 'report' on a command or a modal
 * submit). FOR UPDATE on its action row makes concurrent clicks on one report take turns, so the conditional
 * insert below sees every click that committed before it.
 */
const LOCK_REPORT = `
  SELECT a.interaction_id
    FROM action a
    JOIN interaction i ON i.id = a.interaction_id
   WHERE a.interaction_id = $1 AND a.type = 'report' AND i.guild_id = $2 AND i.type IN (2, 5)
     FOR UPDATE OF a`;

/** THE dedupe statement for a click, same shape as the ledger's (CLAUDE.md). */
const INSERT_CLICK = `
  INSERT INTO interaction
    (id, guild_id, channel_id, user_id, type, command_name, custom_id, options, status)
  VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)
  ON CONFLICT (id) DO NOTHING
  RETURNING id`;

/** The conditional write: no row comes back when a blocking state change already exists. */
const INSERT_CLICK_ACTION = `
  INSERT INTO action (interaction_id, guild_id, type, summary, mirror_status, report_id)
  SELECT $1, $2, $3, $4, 'skipped', $5
   WHERE NOT EXISTS (
     SELECT 1 FROM action WHERE report_id = $5 AND type = ANY($6::text[]))
  RETURNING id`;

const READ_VIEW = `
  SELECT a.mirror_status, j.payload ->> 'replyMessage' AS reply_message,
         (SELECT ci.user_id FROM action c JOIN interaction ci ON ci.id = c.interaction_id
           WHERE c.report_id = a.interaction_id AND c.type = 'acknowledged') AS acknowledged_by,
         (SELECT ci.user_id FROM action c JOIN interaction ci ON ci.id = c.interaction_id
           WHERE c.report_id = a.interaction_id AND c.type = 'escalated') AS escalated_by
    FROM action a
    LEFT JOIN job j ON j.interaction_id = a.interaction_id
   WHERE a.interaction_id = $1`;

const ViewRow = z.object({
  mirror_status: z.string(),
  reply_message: z.string().nullable(),
  acknowledged_by: z.string().nullable(),
  escalated_by: z.string().nullable(),
});

export class PgReportActionStore implements ReportActionStore {
  public constructor(private readonly pool: pg.Pool) {}

  public async applyClick(click: ReportClick): Promise<ClickOutcome> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      const outcome = await this.apply(client, click);
      // Only 'applied' has anything to keep; the other outcomes wrote nothing or must be undone.
      await client.query(outcome.kind === 'applied' ? 'COMMIT' : 'ROLLBACK');
      return outcome;
    } catch (error) {
      discard = !(await rollback(client));
      throw error;
    } finally {
      client.release(discard);
    }
  }

  private async apply(client: pg.PoolClient, click: ReportClick): Promise<ClickOutcome> {
    const { interaction } = click;
    const report = await client.query(LOCK_REPORT, [click.reportId, interaction.guildId]);
    if (report.rows.length === 0) {
      return { kind: 'not_found' };
    }
    const inserted = await client.query(INSERT_CLICK, [
      interaction.id,
      interaction.guildId,
      interaction.channelId,
      interaction.userId,
      interaction.type,
      interaction.commandName,
      interaction.customId,
      interaction.status,
    ]);
    if (inserted.rows.length === 0) {
      return { kind: 'duplicate', view: await this.readView(client, click.reportId) };
    }
    const type = CLICK_ACTION_TYPE[click.action];
    const written = await client.query(INSERT_CLICK_ACTION, [
      interaction.id,
      interaction.guildId,
      type,
      ACTION_SUMMARIES[type],
      click.reportId,
      blockingActionTypes(click.action),
    ]);
    const view = await this.readView(client, click.reportId);
    return written.rows.length === 0 ? { kind: 'refused', view } : { kind: 'applied', view };
  }

  private async readView(client: pg.PoolClient, reportId: string): Promise<ReportView> {
    const result = await client.query(READ_VIEW, [reportId]);
    const row = ViewRow.parse(result.rows[0]);
    return {
      state: stateOf({ acknowledgedBy: row.acknowledged_by, escalatedBy: row.escalated_by }),
      replyMessage: row.reply_message ?? DEFAULT_RULES.report.replyMessage,
      mirrorFailed: row.mirror_status === 'failed',
      acknowledgedBy: row.acknowledged_by,
      escalatedBy: row.escalated_by,
    };
  }
}

async function rollback(client: pg.PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}
