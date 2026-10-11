// Message bodies for the report flow: the PATCH @original result and the dead-token channel fallback.
import { isSnowflake, type MessageBody } from './discordProtocol.js';
import { plainBody } from './discordResponses.js';
import { truncate } from './discordText.js';
import { MESSAGES } from './messages.js';
import { reportButtons } from './reportButtons.js';

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
  return result.reportId === undefined
    ? body
    : { ...body, components: [reportButtons(result.reportId)] };
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
 * reporter. Quotes their text only if they chose a public report, and never more than ~100 characters.
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
