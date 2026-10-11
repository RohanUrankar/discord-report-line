import { ACTION_SUMMARIES } from '../domain/messages.js';
import { INTERACTION_TYPE, type RouteDecision } from '../domain/router.js';
import type { Action } from '../domain/types.js';
import type { RecordInput } from '../ports/ledger.js';

type CommandDecision = Extract<RouteDecision, { kind: 'command' }>;

/**
 * The ledger record for a command that is answered inline: status `answered`, mirror `skipped`, no job
 * (DESIGN §9, §11.2). A deferred `report` is recorded with its job by reportRecord.ts instead.
 */
export function answeredRecord(
  interactionId: string,
  decision: CommandDecision,
  action: Exclude<Action, { type: 'report' }>,
): RecordInput {
  return {
    interaction: {
      id: interactionId,
      guildId: decision.tenant.guildId,
      channelId: decision.tenant.channelId,
      userId: decision.actor.userId,
      type: INTERACTION_TYPE.APPLICATION_COMMAND,
      commandName: decision.name,
      customId: null,
      options: decision.options,
      status: 'answered',
    },
    action: { type: action.type, summary: ACTION_SUMMARIES[action.type], mirrorStatus: 'skipped' },
  };
}
