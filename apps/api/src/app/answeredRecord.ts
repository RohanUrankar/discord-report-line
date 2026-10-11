import { ACTION_SUMMARIES } from '../domain/messages.js';
import type { Action } from '../domain/types.js';
import type { RecordInput } from '../ports/ledger.js';
import type { RecordOrigin } from './recordOrigin.js';

/**
 * The ledger record for a command that is answered inline: status `answered`, mirror `skipped`, no job
 * (DESIGN §9, §11.2). A deferred `report` is recorded with its job by reportRecord.ts instead.
 */
export function answeredRecord(
  interactionId: string,
  origin: RecordOrigin,
  action: Exclude<Action, { type: 'report' }>,
): RecordInput {
  return {
    interaction: {
      id: interactionId,
      guildId: origin.tenant.guildId,
      channelId: origin.tenant.channelId,
      userId: origin.actor.userId,
      type: origin.type,
      commandName: origin.commandName,
      customId: origin.customId,
      options: origin.options,
      status: 'answered',
    },
    action: { type: action.type, summary: ACTION_SUMMARIES[action.type], mirrorStatus: 'skipped' },
  };
}
