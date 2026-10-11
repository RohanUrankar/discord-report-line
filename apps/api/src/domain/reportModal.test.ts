import { describe, expect, it } from 'vitest';

import { DISCORD_LIMITS } from './discordProtocol.js';
import { MESSAGES } from './messages.js';
import {
  REPORT_MODAL_ID,
  REPORT_TEXT_INPUT_ID,
  REPORT_TEXT_MAX_LENGTH,
  reportModal,
} from './reportModal.js';

describe('reportModal', () => {
  it('is a type 9 modal: Label (18) wrapping a paragraph text input (4, style 2)', () => {
    expect(reportModal()).toEqual({
      type: 9,
      data: {
        custom_id: 'report_modal',
        title: MESSAGES.modalTitle,
        components: [
          {
            type: 18,
            label: MESSAGES.modalLabel,
            description: MESSAGES.modalDescription,
            component: {
              type: 4,
              custom_id: 'report_text',
              style: 2,
              min_length: 1,
              max_length: 1000,
              required: true,
              placeholder: MESSAGES.modalPlaceholder,
            },
          },
        ],
      },
    });
  });

  // Limits verified 2026-10-11 against the official docs:
  // - Modal title max 45: https://docs.discord.com/developers/interactions/receiving-and-responding (Modal)
  // - Label label max 45, description max 100; Text Input placeholder max 100, max_length 1..4000,
  //   custom_id 1-100: https://docs.discord.com/developers/components/reference (Label, Text Input)
  it('pins the verified Discord limits', () => {
    expect(DISCORD_LIMITS).toEqual({
      modalTitle: 45,
      labelText: 45,
      labelDescription: 100,
      textInputPlaceholder: 100,
      textInputMaxLength: 4000,
      customId: 100,
    });
  });

  it('keeps every modal string within the verified Discord limits', () => {
    expect(MESSAGES.modalTitle.length).toBeLessThanOrEqual(DISCORD_LIMITS.modalTitle);
    expect(MESSAGES.modalLabel.length).toBeLessThanOrEqual(DISCORD_LIMITS.labelText);
    expect(MESSAGES.modalDescription.length).toBeLessThanOrEqual(DISCORD_LIMITS.labelDescription);
    expect(MESSAGES.modalPlaceholder.length).toBeLessThanOrEqual(
      DISCORD_LIMITS.textInputPlaceholder,
    );
    expect(REPORT_MODAL_ID.length).toBeLessThanOrEqual(DISCORD_LIMITS.customId);
    expect(REPORT_TEXT_INPUT_ID.length).toBeLessThanOrEqual(DISCORD_LIMITS.customId);
    expect(REPORT_TEXT_MAX_LENGTH).toBeLessThanOrEqual(DISCORD_LIMITS.textInputMaxLength);
  });
});
