import type { StatusCounts } from '../domain/status.js';

/**
 * Read side of `/status` (DESIGN §5.1): cheap, indexed counts for one server. Rejects when the database
 * is unreachable; the caller decides what to tell the user.
 */
export interface StatusReader {
  read(guildId: string): Promise<StatusCounts>;
}
