import { ACTION_SUMMARIES } from '../domain/messages.js';
import { INTERACTION_TYPE, type RouteDecision } from '../domain/router.js';
import type { Action } from '../domain/types.js';
import type { RecordInput } from '../ports/ledger.js';

type CommandDecision = Extract<RouteDecision, { kind: 'command' }>;

/**
 * The ledger record for a command that is answered inline: status `answered`, mirror `skipped`, no job
 * (DESIGN §9, §11.2). Returns undefined for an action that is not answered inline; `report` is recorded
 * with its job in Step 3, when it can be deferred.
 */
export function answeredRecord(
  interactionId: string,
  decision: CommandDecision,
  action: Action,
): RecordInput | undefined {
  if (action.type === 'report') {
    return undefined;
  }
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
