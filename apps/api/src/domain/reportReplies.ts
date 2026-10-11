// Message bodies for the report flow: the PATCH @original result and the dead-token channel fallback.
import { isSnowflake, type InteractionResponse, type MessageBody } from './discordProtocol.js';
import { message, plainBody, updateMessage } from './discordResponses.js';
import { truncate } from './discordText.js';
import { MESSAGES, STATE_LINES } from './messages.js';
import { reportButtons } from './reportButtons.js';
import type { ReportButtonAction, ReportView } from './reportState.js';

/** How much of the user's own text we quote back. */
const ECHO_MAX_LENGTH = 100;

export interface ReportResult {
  replyMessage: string;
  /** True when the Slack mirror failed fatally (§11.3 step 2): the user is told honestly. */
  mirrorFailed: boolean;
  /** When set, the reply carries the Acknowledge / Escalate buttons for this report (§5.3). */
  reportId?: string;
}

/** Body for `PATCH @original` once the report job has run. Visibility was fixed at defer time. */
export function reportResultBody(result: ReportResult): MessageBody {
  const content = result.mirrorFailed
    ? `${result.replyMessage}\n${MESSAGES.mirrorFailed}`
    : result.replyMessage;
  const body = plainBody(content);
  if (result.reportId === undefined) {
    return body;
  }
  // Same bytes on every retry of the PATCH: the buttons depend only on the report id, so adding them does
  // not change the idempotency of editing @original.
  const row = reportButtons(result.reportId);
  return { ...body, components: row === undefined ? [] : [row] };
}

export interface ReportFallback {
  userId: string;
  reference: string;
  /** The rule's `ephemeral`. When true the report text is NEVER included (§11.3). */
  ephemeral: boolean;
  text: string;
}

/**
 * Public bot-token channel post used when the interaction token is dead (§11.3 step 4). Pings only the
 * reporter. It carries NO buttons (DESIGN §5.5): a public message would let anyone in the channel act on a
 * report the reporter meant to keep private, and an ephemeral reply's buttons only ever reached the reporter. Quotes their text only if they chose a public report, and never more than ~100 characters.
 */
export function reportFallbackBody(fallback: ReportFallback): MessageBody {
  const hasValidUser = isSnowflake(fallback.userId);
  const who = hasValidUser ? `<@${fallback.userId}>, your` : 'Your';
  const quoted = fallback.ephemeral ? '' : `: “${truncate(fallback.text, ECHO_MAX_LENGTH)}”`;
  const reference = sanitiseReference(fallback.reference);
  return plainBody(
    `${who} report was logged${quoted} (ref \`${reference}\`)`,
    hasValidUser ? { parse: [], users: [fallback.userId] } : { parse: [] },
  );
}

function sanitiseReference(reference: string): string {
  return reference.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32);
}

/** A user id from our own database. Anything that is not a snowflake is dropped rather than put in a mention. */
function mentionable(userId: string | null): string | undefined {
  return userId !== null && isSnowflake(userId) ? userId : undefined;
}

/**
 * Type 7 after an accepted click (or a redelivered one): the rule's reply text, the mirror warning if it
 * applies, who acknowledged and who escalated, and only the buttons still allowed. It is rebuilt from the
 * database each time, so it never grows lines, and it holds no report text and no token.
 */
export function reportStateResponse(reportId: string, view: ReportView): InteractionResponse {
  const lines = [view.replyMessage];
  if (view.mirrorFailed) {
    lines.push(MESSAGES.mirrorFailed);
  }
  const acknowledger = mentionable(view.acknowledgedBy);
  if (acknowledger !== undefined) {
    lines.push(STATE_LINES.acknowledgedBy(acknowledger));
  }
  const escalator = mentionable(view.escalatedBy);
  if (escalator !== undefined) {
    lines.push(STATE_LINES.escalatedBy(escalator));
  }
  const row = reportButtons(reportId, view.state);
  return updateMessage(lines.join('\n'), row === undefined ? [] : [row]);
}

/** Ephemeral type 4 for a click the current state no longer allows (a stale button). */
export function staleClickResponse(
  view: ReportView,
  action: ReportButtonAction,
): InteractionResponse {
  const escalator = mentionable(view.escalatedBy);
  const acknowledger = mentionable(view.acknowledgedBy);
  const text =
    action === 'acknowledge' && view.state === 'acknowledged' && acknowledger !== undefined
      ? STATE_LINES.alreadyAcknowledgedBy(acknowledger)
      : escalator !== undefined
        ? STATE_LINES.alreadyEscalatedBy(escalator)
        : MESSAGES.reportNotFound;
  return message(text, { ephemeral: true });
}
