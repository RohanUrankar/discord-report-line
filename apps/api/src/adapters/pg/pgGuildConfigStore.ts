import type { CommandName } from '@report-line/shared';
import type pg from 'pg';
import { z } from 'zod';

import type { GuildRecord } from '../../ports/dashboard.js';
import type {
  GuildConfigStore,
  SettingsPatch,
  StoredRule,
  StoredSettings,
} from '../../ports/guildConfig.js';

// Tenancy (CLAUDE.md): every statement below checks admin_guild for the signed-in admin ($1) and the guild
// ($2) itself, so the TenantGuard middleware is a first lock and this is the second. Columns are listed by
// name; mirror_webhook_enc is only ever written, or tested for NULL, never selected.

/**
 * The claim, in one statement. The guild row must exist (the bot has seen the server). admin_guild's primary
 * key is guild_id (migration 003), so the INSERT is the arbiter: a free server is claimed; a server this admin
 * already manages hits the conflict and the no-op UPDATE hands the row back (idempotent); a server another
 * admin manages hits the conflict, the WHERE fails and nothing is returned. No SELECT-then-INSERT to race.
 */
const CLAIM_GUILD = `
  WITH claimed AS (
    INSERT INTO admin_guild (guild_id, admin_id)
    SELECT g.id, $1::uuid FROM guild g WHERE g.id = $2
    ON CONFLICT (guild_id) DO UPDATE SET admin_id = admin_guild.admin_id
      WHERE admin_guild.admin_id = EXCLUDED.admin_id
    RETURNING guild_id
  )
  SELECT g.id, g.name FROM claimed JOIN guild g ON g.id = claimed.guild_id`;

const SETTINGS_COLUMNS = `g.post_channel_id, (g.mirror_webhook_enc IS NOT NULL) AS mirror_configured`;
const MANAGED = `EXISTS (SELECT 1 FROM admin_guild ag WHERE ag.guild_id = g.id AND ag.admin_id = $1)`;

const READ_SETTINGS = `SELECT ${SETTINGS_COLUMNS} FROM guild g WHERE g.id = $2 AND ${MANAGED}`;

/** $3/$4: set the channel? to what. $5/$6: set the webhook? to what. A flag of false keeps the column. */
const UPDATE_SETTINGS = `
  UPDATE guild g SET
    post_channel_id    = CASE WHEN $3::boolean THEN $4::text  ELSE g.post_channel_id    END,
    mirror_webhook_enc = CASE WHEN $5::boolean THEN $6::bytea ELSE g.mirror_webhook_enc END
  WHERE g.id = $2 AND ${MANAGED}
  RETURNING ${SETTINGS_COLUMNS}`;

const LIST_RULES = `
  SELECT r.command_name, r.config, r.enabled
    FROM command_rule r
   WHERE r.guild_id = $2
     AND EXISTS (SELECT 1 FROM admin_guild ag WHERE ag.guild_id = r.guild_id AND ag.admin_id = $1)
   ORDER BY r.command_name`;

const SAVE_RULE = `
  INSERT INTO command_rule (guild_id, command_name, config, enabled)
  SELECT g.id, $3::text, $4::jsonb, $5::boolean
    FROM guild g
   WHERE g.id = $2 AND ${MANAGED}
  ON CONFLICT (guild_id, command_name)
  DO UPDATE SET config = EXCLUDED.config, enabled = EXCLUDED.enabled, updated_at = now()
  RETURNING 1 AS saved`;

const GuildRow = z.object({ id: z.string(), name: z.string().nullable() });
const SettingsRow = z.object({
  post_channel_id: z.string().nullable(),
  mirror_configured: z.boolean(),
});
const RuleRow = z.object({ command_name: z.string(), config: z.unknown(), enabled: z.boolean() });

function toSettings(raw: unknown): StoredSettings {
  const row = SettingsRow.parse(raw);
  return { postChannelId: row.post_channel_id, mirrorConfigured: row.mirror_configured };
}

export class PgGuildConfigStore implements GuildConfigStore {
  public constructor(private readonly pool: pg.Pool) {}

  public async claimGuild(adminId: string, guildId: string): Promise<GuildRecord | undefined> {
    const result = await this.pool.query(CLAIM_GUILD, [adminId, guildId]);
    return result.rows[0] === undefined ? undefined : GuildRow.parse(result.rows[0]);
  }

  public async readSettings(adminId: string, guildId: string): Promise<StoredSettings | undefined> {
    const result = await this.pool.query(READ_SETTINGS, [adminId, guildId]);
    return result.rows[0] === undefined ? undefined : toSettings(result.rows[0]);
  }

  public async updateSettings(
    adminId: string,
    guildId: string,
    patch: SettingsPatch,
  ): Promise<StoredSettings | undefined> {
    const result = await this.pool.query(UPDATE_SETTINGS, [
      adminId,
      guildId,
      patch.postChannelId !== undefined,
      patch.postChannelId ?? null,
      patch.mirrorWebhookEnc !== undefined,
      patch.mirrorWebhookEnc ?? null,
    ]);
    return result.rows[0] === undefined ? undefined : toSettings(result.rows[0]);
  }

  public async listRules(adminId: string, guildId: string): Promise<StoredRule[]> {
    const result = await this.pool.query(LIST_RULES, [adminId, guildId]);
    return result.rows.map((raw): StoredRule => {
      const row = RuleRow.parse(raw);
      return { command: row.command_name, config: row.config, enabled: row.enabled };
    });
  }

  public async saveRule(
    adminId: string,
    guildId: string,
    command: CommandName,
    config: unknown,
    enabled: boolean,
  ): Promise<boolean> {
    const result = await this.pool.query(SAVE_RULE, [
      adminId,
      guildId,
      command,
      JSON.stringify(config),
      enabled,
    ]);
    return result.rowCount === 1;
  }
}
