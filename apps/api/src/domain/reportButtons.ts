// Encodes and decodes the Acknowledge / Escalate buttons (§5.3). Both directions live together because
// the `custom_id` format is their shared contract.
import {
  BUTTON_STYLE,
  COMPONENT_TYPE,
  isSnowflake,
  type ActionRowComponent,
  type ButtonComponent,
} from './discordProtocol.js';
import { MESSAGES } from './messages.js';
import { availableActions, type ReportButtonAction, type ReportState } from './reportState.js';

export type { ReportButtonAction };

const BUTTON_PREFIX = { acknowledge: 'rpt:ack:', escalate: 'rpt:esc:' } as const;

/**
 * `custom_id` encodes intent + report id (a Discord snowflake, so at most 8 + 20 characters, far under the
 * 100 limit); it never holds the interaction token or any report text, and it is untrusted on return.
 */
function button(action: ReportButtonAction, reportId: string): ButtonComponent {
  return action === 'acknowledge'
    ? {
        type: COMPONENT_TYPE.BUTTON,
        style: BUTTON_STYLE.SUCCESS,
        custom_id: `${BUTTON_PREFIX.acknowledge}${reportId}`,
        label: MESSAGES.acknowledgeButton,
      }
    : {
        type: COMPONENT_TYPE.BUTTON,
        style: BUTTON_STYLE.PRIMARY,
        custom_id: `${BUTTON_PREFIX.escalate}${reportId}`,
        label: MESSAGES.escalateButton,
      };
}

/**
 * The action row for a report in `state`: only the buttons that would still be accepted. Undefined when none
 * are left (an empty action row is invalid in Discord), so callers send `components: []` to clear them.
 */
export function reportButtons(
  reportId: string,
  state: ReportState = 'reported',
): ActionRowComponent | undefined {
  const components = availableActions(state).map((action) => button(action, reportId));
  return components.length === 0 ? undefined : { type: COMPONENT_TYPE.ACTION_ROW, components };
}

/**
 * Parses a button `custom_id` defensively. A valid parse only means the format is right: the caller must
 * still check that the report belongs to the interaction's guild before acting (§5.3, T-05).
 */
export function parseReportButton(
  customId: string,
): { action: ReportButtonAction; reportId: string } | undefined {
  for (const action of ['acknowledge', 'escalate'] as const) {
    const prefix = BUTTON_PREFIX[action];
    if (customId.startsWith(prefix)) {
      const reportId = customId.slice(prefix.length);
      return isSnowflake(reportId) ? { action, reportId } : undefined;
    }
  }
  return undefined;
}
