// The life of a processed report as the buttons move it (DESIGN §5.5). The state is DERIVED from ACTION rows
// (a click that was accepted is an `acknowledged` or `escalated` row pointing at the report), never stored.
// The database enforces the same transitions with a conditional INSERT and a unique index; this module only
// decides what the message should offer and say.

export const REPORT_STATES = ['reported', 'acknowledged', 'escalated'] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export type ReportButtonAction = 'acknowledge' | 'escalate';

/** The ACTION.type a click leaves behind. */
export const CLICK_ACTION_TYPE = { acknowledge: 'acknowledged', escalate: 'escalated' } as const;

/**
 * Allowed moves: reported → acknowledged, reported → escalated, acknowledged → escalated. Escalated is final
 * and nothing goes back. Escalating is allowed after acknowledging because acknowledging means "seen", not
 * "handled".
 */
export function isAllowed(state: ReportState, action: ReportButtonAction): boolean {
  return action === 'acknowledge' ? state === 'reported' : state !== 'escalated';
}

/** The buttons worth showing in a state: exactly the actions that would still be accepted. */
export function availableActions(state: ReportState): ReportButtonAction[] {
  return (['acknowledge', 'escalate'] as const).filter((action) => isAllowed(state, action));
}

/** What a message about one report says right now: read from the database, never from the click. */
export interface ReportView {
  state: ReportState;
  /** The rule's reply text, as snapshotted when the report was deferred. Never the report itself. */
  replyMessage: string;
  mirrorFailed: boolean;
  acknowledgedBy: string | null;
  escalatedBy: string | null;
}

export function stateOf(view: Pick<ReportView, 'acknowledgedBy' | 'escalatedBy'>): ReportState {
  if (view.escalatedBy !== null) {
    return 'escalated';
  }
  return view.acknowledgedBy !== null ? 'acknowledged' : 'reported';
}
