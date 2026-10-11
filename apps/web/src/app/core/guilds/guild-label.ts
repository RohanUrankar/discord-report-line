import type { GuildSummary } from '@report-line/shared';

import { SHORT_ID_LENGTH } from '../constants/app.constants';

/** The last few digits of a Discord id: enough to tell two apart, short enough to fit a phone. */
export function shortId(id: string): string {
  return id.length <= SHORT_ID_LENGTH ? id : `…${id.slice(-SHORT_ID_LENGTH)}`;
}

/** Servers have no name until the bot learns it; until then the (shortened) id stands in. */
export function guildLabel(guild: GuildSummary): string {
  return guild.name ?? `Server ${shortId(guild.id)}`;
}
