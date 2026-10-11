import type { CommandName } from '@report-line/shared';

import type { GuildRecord } from './dashboard.js';

export interface StoredSettings {
  postChannelId: string | null;
  /** Whether a webhook is stored. The ciphertext itself never leaves the adapter. */
  mirrorConfigured: boolean;
}

/** A key left out is left alone; `null` clears the value. */
export interface SettingsPatch {
  postChannelId?: string | null;
  mirrorWebhookEnc?: Buffer | null;
}

export interface StoredRule {
  command: string;
  /** Whatever JSON is stored. It is checked by `validateRule` before anyone relies on its shape. */
  config: unknown;
  enabled: boolean;
}

/**
 * Write side of the dashboard (DESIGN §2.3, rev 6). Like `DashboardReader`, every method takes the signed-in
 * admin AND the guild and the adapter's SQL checks `admin_guild` itself, so a route that forgets
 * `TenantGuard` still changes and returns nothing for a server the admin does not manage. `undefined` or
 * `false` means "not yours or does not exist": the caller cannot tell which. Rejects when the database is
 * unreachable.
 */
export interface GuildConfigStore {
  /**
   * Makes `adminId` the managing admin of a server the bot has seen, if nobody else manages it: first claim
   * wins, and claiming your own server again is not an error. One statement, so two admins racing for the
   * same server cannot both win. `undefined` = no such server, or another admin manages it.
   */
  claimGuild(adminId: string, guildId: string): Promise<GuildRecord | undefined>;
  readSettings(adminId: string, guildId: string): Promise<StoredSettings | undefined>;
  updateSettings(
    adminId: string,
    guildId: string,
    patch: SettingsPatch,
  ): Promise<StoredSettings | undefined>;
  listRules(adminId: string, guildId: string): Promise<StoredRule[]>;
  /** Insert or replace the one rule row of (guild, command). Jobs already enqueued keep their snapshot. */
  saveRule(
    adminId: string,
    guildId: string,
    command: CommandName,
    config: unknown,
    enabled: boolean,
  ): Promise<boolean>;
}
