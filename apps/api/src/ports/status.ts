import type { StatusCounts } from '../domain/status.js';

/** Read side of `/status` (DESIGN §5.1): cheap, indexed counts for one server. Postgres arrives in Step 2. */
export interface StatusReader {
  read(guildId: string): Promise<StatusCounts>;
}
