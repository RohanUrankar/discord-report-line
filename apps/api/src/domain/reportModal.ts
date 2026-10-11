import {
  CALLBACK_TYPE,
  COMPONENT_TYPE,
  TEXT_INPUT_STYLE,
  type InteractionResponse,
} from './discordProtocol.js';
import { MESSAGES } from './messages.js';

export const REPORT_MODAL_ID = 'report_modal';
export const REPORT_TEXT_INPUT_ID = 'report_text';
/** Same bound as the `/report text` option (§5.2), so both paths accept the same reports. */
export const REPORT_TEXT_MAX_LENGTH = 1000;

/** Type 9: the `/report` form (§5.2). Label (18) wrapping a paragraph text input (4), per current docs. */
export function reportModal(): InteractionResponse {
  return {
    type: CALLBACK_TYPE.MODAL,
    data: {
      custom_id: REPORT_MODAL_ID,
      title: MESSAGES.modalTitle,
      components: [
        {
          type: COMPONENT_TYPE.LABEL,
          label: MESSAGES.modalLabel,
          description: MESSAGES.modalDescription,
          component: {
            type: COMPONENT_TYPE.TEXT_INPUT,
            custom_id: REPORT_TEXT_INPUT_ID,
            style: TEXT_INPUT_STYLE.PARAGRAPH,
            min_length: 1,
            max_length: REPORT_TEXT_MAX_LENGTH,
            required: true,
            placeholder: MESSAGES.modalPlaceholder,
          },
        },
      ],
    },
  };
}
