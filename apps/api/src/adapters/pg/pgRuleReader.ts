import type { CommandName } from '@report-line/shared';
import type pg from 'pg';
import { z } from 'zod';

import type { RuleReader, StoredRuleRow } from '../../ports/rules.js';

const READ_RULE = `
  SELECT config, enabled FROM command_rule WHERE guild_id = $1 AND command_name = $2`;

const RuleRow = z.object({ config: z.unknown(), enabled: z.boolean() });

export class PgRuleReader implements RuleReader {
  public constructor(private readonly pool: pg.Pool) {}

  public async read(guildId: string, command: CommandName): Promise<StoredRuleRow | undefined> {
    const result = await this.pool.query(READ_RULE, [guildId, command]);
    return result.rows[0] === undefined ? undefined : RuleRow.parse(result.rows[0]);
  }
}
