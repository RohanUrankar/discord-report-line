import type { ReportButtonAction, ReportView } from '../domain/reportState.js';
import type { RecordedInteraction } from './ledger.js';

export interface ReportClick {
  /** The click's own interaction row (type 3). Its id is the dedupe key. */
  interaction: RecordedInteraction;
  /** The report the button was attached to, parsed from the untrusted custom_id. */
  reportId: string;
  action: ReportButtonAction;
}

/**
 * - `applied`: this delivery changed the state; `view` is the new state.
 * - `duplicate`: this very click was already applied by an earlier delivery; nothing was written.
 * - `refused`: the move is not allowed from the current state (a stale button); nothing was written.
 * - `not_found`: no such report in the clicker's server (missing, another server's, or not a report).
 */
export type ClickOutcome =
  | { kind: 'applied'; view: ReportView }
  | { kind: 'duplicate'; view: ReportView }
  | { kind: 'refused'; view: ReportView }
  | { kind: 'not_found' };

export interface ReportActionStore {
  /**
   * One transaction: lock the report's own action row (so clicks on one report take turns), INSERT the
   * click's interaction ON CONFLICT DO NOTHING, then INSERT its action row only if no row already blocks the
   * move. A refused click rolls the interaction insert back, so it leaves no trace. Rejects when the database
   * cannot be reached; the caller must not claim success then.
   */
  applyClick(click: ReportClick): Promise<ClickOutcome>;
}
