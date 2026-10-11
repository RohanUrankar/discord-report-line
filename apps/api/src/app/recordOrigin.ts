import { REPORT_MODAL_ID } from '../domain/reportModal.js';
import { INTERACTION_TYPE, type RouteDecision } from '../domain/router.js';
import type { Actor, Tenant } from '../domain/types.js';

/** What the INTERACTION row says about where a record came from (DESIGN §9). */
export interface RecordOrigin {
  type: number;
  commandName: string | null;
  customId: string | null;
  options: Record<string, unknown> | null;
  actor: Actor;
  tenant: Tenant;
}

/** A slash command: the name and the options as typed. */
export function commandOrigin(decision: Extract<RouteDecision, { kind: 'command' }>): RecordOrigin {
  return {
    type: INTERACTION_TYPE.APPLICATION_COMMAND,
    commandName: decision.name,
    customId: null,
    options: decision.options,
    actor: decision.actor,
    tenant: decision.tenant,
  };
}

/**
 * A /report modal submit. command_name is 'report' so the log can label the row like the text path; the
 * custom_id is our own constant. `options` stays empty: the text lives in the job payload only (DESIGN rev 7).
 */
export function reportModalOrigin(
  decision: Extract<RouteDecision, { kind: 'modalSubmit' }>,
): RecordOrigin {
  return {
    type: INTERACTION_TYPE.MODAL_SUBMIT,
    commandName: 'report',
    customId: REPORT_MODAL_ID,
    options: null,
    actor: decision.actor,
    tenant: decision.tenant,
  };
}
