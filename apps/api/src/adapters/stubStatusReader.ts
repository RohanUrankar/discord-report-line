import type { StatusCounts } from '../domain/reply.js';
import type { StatusReader } from '../ports/status.js';

/** Step 1 stand-in until the ledger exists (Step 2): reports an idle system. Replaced by a Postgres reader. */
export class StubStatusReader implements StatusReader {
  public read(_guildId: string): Promise<StatusCounts> {
    return Promise.resolve({ reportsToday: 0, retrying: 0, workerLastBeatSeconds: null });
  }
}
