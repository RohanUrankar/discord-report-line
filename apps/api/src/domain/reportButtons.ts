// Encodes and decodes the Acknowledge / Escalate buttons (§5.3). Both directions live together because
// the `custom_id` format is their shared contract.
import {
  BUTTON_STYLE,
  COMPONENT_TYPE,
  isSnowflake,
  type ActionRowComponent,
} from './discordProtocol.js';
import { MESSAGES } from './messages.js';

const BUTTON_PREFIX = { acknowledge: 'rpt:ack:', escalate: 'rpt:esc:' } as const;
export type ReportButtonAction = keyof typeof BUTTON_PREFIX;

/** `custom_id` encodes intent + report id; it is untrusted on return. */
export function reportButtons(reportId: string): ActionRowComponent {
  return {
    type: COMPONENT_TYPE.ACTION_ROW,
    components: [
      {
        type: COMPONENT_TYPE.BUTTON,
        style: BUTTON_STYLE.SUCCESS,
        custom_id: `${BUTTON_PREFIX.acknowledge}${reportId}`,
        label: MESSAGES.acknowledgeButton,
      },
      {
        type: COMPONENT_TYPE.BUTTON,
        style: BUTTON_STYLE.PRIMARY,
        custom_id: `${BUTTON_PREFIX.escalate}${reportId}`,
        label: MESSAGES.escalateButton,
      },
    ],
  };
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
