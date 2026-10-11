import type { CommandName } from '@report-line/shared';

export interface StoredRuleRow {
  /** Whatever JSON is stored. It is checked by `validateRule` before anyone relies on its shape. */
  config: unknown;
  enabled: boolean;
}

/**
 * Runtime read of one command's rule for one server (DESIGN §8.3). Not admin-scoped: the guild id comes from
 * the signed interaction, not from a dashboard session. `undefined` = no row = enabled with the defaults.
 * Rejects when the database is unreachable.
 */
export interface RuleReader {
  read(guildId: string, command: CommandName): Promise<StoredRuleRow | undefined>;
}
