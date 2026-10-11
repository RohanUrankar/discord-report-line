import { REPORT_TEXT_MAX_LENGTH, REPORT_TEXT_OPTION } from '../domain/commands.js';
import { ACTION_SUMMARIES } from '../domain/messages.js';
import { INTERACTION_TYPE, type RouteDecision } from '../domain/router.js';
import { TOKEN_SAFE_LIFETIME_MS } from '../domain/reportJob.js';
import type { Action } from '../domain/types.js';
import type { RecordInput } from '../ports/ledger.js';

type CommandDecision = Extract<RouteDecision, { kind: 'command' }>;
type ReportAction = Extract<Action, { type: 'report' }>;

/** What the user typed, or why it cannot be used. */
export type ReportText = { ok: true; text: string } | { ok: false; reason: 'empty' | 'tooLong' };

/**
 * Reads the `text` option. Discord enforces min and max length in its client, but the server checks again:
 * a payload is only trusted for who signed it, not for being well-formed (DESIGN §5.2).
 */
export function readReportText(options: Record<string, unknown>): ReportText {
  const raw = options[REPORT_TEXT_OPTION];
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') {
    return { ok: false, reason: 'empty' };
  }
  return Array.from(text).length > REPORT_TEXT_MAX_LENGTH
    ? { ok: false, reason: 'tooLong' }
    : { ok: true, text };
}

export interface DeferredReportInput {
  interactionId: string;
  interactionToken: string;
  receivedAtMs: number;
  decision: CommandDecision;
  action: ReportAction;
  text: string;
}

/**
 * The ledger record for a deferred /report: interaction `deferred`, action `report`, and the outbox job with
 * its token, expiry and rule snapshot (DESIGN §9, §11.3). The summary is fixed text: the report itself is
 * not copied into the action row.
 */
export function deferredReportRecord(input: DeferredReportInput): RecordInput {
  const { decision, action } = input;
  return {
    interaction: {
      id: input.interactionId,
      guildId: decision.tenant.guildId,
      channelId: decision.tenant.channelId,
      userId: decision.actor.userId,
      type: INTERACTION_TYPE.APPLICATION_COMMAND,
      commandName: decision.name,
      customId: null,
      options: decision.options,
      status: 'deferred',
    },
    action: {
      type: 'report',
      summary: ACTION_SUMMARIES.report,
      mirrorStatus: action.mirror ? 'pending' : 'skipped',
    },
    job: {
      kind: 'report',
      interactionToken: input.interactionToken,
      tokenExpiresAt: new Date(input.receivedAtMs + TOKEN_SAFE_LIFETIME_MS),
      payload: {
        text: input.text,
        userId: decision.actor.userId,
        channelId: decision.tenant.channelId,
        ephemeral: action.ephemeral,
        replyMessage: action.replyMessage,
        mirror: action.mirror,
        tag: action.tag,
      },
    },
  };
}
