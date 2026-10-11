import type {
  GuildList,
  InteractionDetail,
  InteractionLogPage,
  ListInteractionsQuery,
} from '@report-line/shared';

import { decodeLogCursor, encodeLogCursor } from '../domain/logCursor.js';
import type { DashboardReader } from '../ports/dashboard.js';
import { toDetail, toGuildSummary, toLogItem } from './dashboardView.js';

export type ListResult = { kind: 'ok'; page: InteractionLogPage } | { kind: 'invalid_cursor' };

/**
 * The dashboard's read use cases (DESIGN §7 `dashboard.ts`). Every call names the admin and the guild; the
 * reader refuses to return rows for a guild that admin does not manage.
 */
export class DashboardService {
  public constructor(private readonly reader: DashboardReader) {}

  public managesGuild(adminId: string, guildId: string): Promise<boolean> {
    return this.reader.managesGuild(adminId, guildId);
  }

  public async listGuilds(adminId: string): Promise<GuildList> {
    const rows = await this.reader.listGuilds(adminId);
    return { items: rows.map(toGuildSummary) };
  }

  public async listInteractions(
    adminId: string,
    guildId: string,
    query: ListInteractionsQuery,
  ): Promise<ListResult> {
    const after = query.cursor === undefined ? undefined : decodeLogCursor(query.cursor);
    if (query.cursor !== undefined && after === undefined) {
      return { kind: 'invalid_cursor' };
    }
    // One extra row tells whether another page exists without a count query.
    const rows = await this.reader.listInteractions(adminId, guildId, {
      limit: query.limit + 1,
      ...(after === undefined ? {} : { after }),
      ...(query.status === undefined ? {} : { jobStatus: query.status }),
    });
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? encodeLogCursor({ at: last.createdAtExact, id: last.id })
        : null;
    return { kind: 'ok', page: { items: pageRows.map(toLogItem), nextCursor } };
  }

  public async getInteraction(
    adminId: string,
    guildId: string,
    interactionId: string,
  ): Promise<InteractionDetail | undefined> {
    const found = await this.reader.findInteraction(adminId, guildId, interactionId);
    return found === undefined ? undefined : toDetail(found.row, found.attempts);
  }
}
