import { describe, expect, it } from 'vitest';

import {
  DISCORD_LIMITS,
  MESSAGES,
  REPORT_MODAL_ID,
  REPORT_TEXT_INPUT_ID,
  REPORT_TEXT_MAX_LENGTH,
  deferMessage,
  deferUpdate,
  message,
  parseReportButton,
  pong,
  reportButtons,
  reportFallbackBody,
  reportModal,
  reportResultBody,
  statusText,
  updateMessage,
} from './reply.js';

const USER_ID = '1000000000000000001';
const REPORT_ID = '1300000000000000001';

describe('interaction responses', () => {
  it('PING is answered with exactly {type: 1}', () => {
    expect(pong()).toEqual({ type: 1 });
  });

  it('builds an ephemeral type 4 message with mentions disabled', () => {
    expect(message('Hello', { ephemeral: true })).toEqual({
      type: 4,
      data: { content: 'Hello', allowed_mentions: { parse: [] }, flags: 64 },
    });
  });

  it('builds a public type 4 message without flags', () => {
    expect(message('Hello', { ephemeral: false })).toEqual({
      type: 4,
      data: { content: 'Hello', allowed_mentions: { parse: [] } },
    });
  });

  it('never lets user text ping everyone', () => {
    const response = message('@everyone look', { ephemeral: false });
    expect(response).toMatchObject({ data: { allowed_mentions: { parse: [] } } });
  });

  it('truncates content to Discord’s 2000-character limit', () => {
    const response = message('a'.repeat(2500), { ephemeral: false });
    expect(response.type === 4 && Array.from(response.data.content).length).toBe(2000);
  });

  it('does not split an emoji when truncating', () => {
    const response = message('😀'.repeat(2001), { ephemeral: false });
    expect(response.type === 4 && response.data.content.endsWith('😀…')).toBe(true);
  });

  it('defers ephemerally with flag 64 as the only data', () => {
    expect(deferMessage({ ephemeral: true })).toEqual({ type: 5, data: { flags: 64 } });
  });

  it('defers publicly with no data', () => {
    expect(deferMessage({ ephemeral: false })).toEqual({ type: 5 });
  });

  it('defers a component update with type 6', () => {
    expect(deferUpdate()).toEqual({ type: 6 });
  });

  it('updates a message with type 7, mentions disabled and no flags', () => {
    expect(updateMessage('Acknowledged')).toEqual({
      type: 7,
      data: { content: 'Acknowledged', allowed_mentions: { parse: [] }, components: [] },
    });
  });
});

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

describe('status unavailable notice', () => {
  it('tells the user what happened and what to do, without technical detail', () => {
    expect(MESSAGES.statusUnavailable).toBe(
      "We couldn't check the status right now. Please try again in a minute.",
    );
  });
});

describe('buttons', () => {
  it('puts Acknowledge and Escalate buttons (type 2) inside one action row (type 1)', () => {
    expect(reportButtons(REPORT_ID)).toEqual({
      type: 1,
      components: [
        { type: 2, style: 3, custom_id: `rpt:ack:${REPORT_ID}`, label: 'Acknowledge' },
        { type: 2, style: 1, custom_id: `rpt:esc:${REPORT_ID}`, label: 'Escalate' },
      ],
    });
  });

  it('keeps custom_id within Discord’s 100-character limit', () => {
    for (const button of reportButtons('9'.repeat(20)).components) {
      expect(button.custom_id.length).toBeLessThanOrEqual(100);
    }
  });

  it('round-trips a custom_id it built', () => {
    expect(parseReportButton(`rpt:ack:${REPORT_ID}`)).toEqual({
      action: 'acknowledge',
      reportId: REPORT_ID,
    });
    expect(parseReportButton(`rpt:esc:${REPORT_ID}`)).toEqual({
      action: 'escalate',
      reportId: REPORT_ID,
    });
  });

  it.each([
    ['unknown action', `rpt:del:${REPORT_ID}`],
    ['missing id', 'rpt:ack:'],
    ['non-snowflake id', 'rpt:ack:../../admin'],
    ['trailing junk', `rpt:ack:${REPORT_ID}:x`],
    ['other prefix', `report_modal`],
    ['empty', ''],
  ])('rejects a forged custom_id: %s', (_case, customId) => {
    expect(parseReportButton(customId)).toBeUndefined();
  });
});

describe('reportResultBody (PATCH @original)', () => {
  it('uses the rule’s reply message with mentions disabled', () => {
    expect(reportResultBody({ replyMessage: 'Logged.', mirrorFailed: false })).toEqual({
      content: 'Logged.',
      allowed_mentions: { parse: [] },
    });
  });

  it('tells the user honestly when the team notification failed', () => {
    const body = reportResultBody({ replyMessage: 'Logged.', mirrorFailed: true });
    expect(body.content).toBe(`Logged.\n${MESSAGES.mirrorFailed}`);
  });

  it('attaches the buttons when a report id is given', () => {
    const body = reportResultBody({
      replyMessage: 'Logged.',
      mirrorFailed: false,
      reportId: REPORT_ID,
    });
    expect(body.components).toEqual([reportButtons(REPORT_ID)]);
  });

  it('never sets flags (visibility was fixed at defer time)', () => {
    expect(
      reportResultBody({ replyMessage: 'Logged.', mirrorFailed: false }).flags,
    ).toBeUndefined();
  });
});

describe('reportFallbackBody (bot-token channel post)', () => {
  const SECRET_TEXT = 'the CFO is embezzling';

  it('WHEN the report was ephemeral THE SYSTEM SHALL NOT include its text in the public fallback', () => {
    const body = reportFallbackBody({
      userId: USER_ID,
      reference: 'a1b2c3',
      ephemeral: true,
      text: SECRET_TEXT,
    });
    expect(body.content).toBe(`<@${USER_ID}>, your report was logged (ref \`a1b2c3\`)`);
    expect(JSON.stringify(body)).not.toContain('embezzling');
    expect(body.allowed_mentions).toStrictEqual({ parse: [], users: [USER_ID] });
  });

  it('quotes a public report, truncated to about 100 characters', () => {
    const body = reportFallbackBody({
      userId: USER_ID,
      reference: 'a1b2c3',
      ephemeral: false,
      text: 'x'.repeat(500),
    });
    expect(body.content).toContain(`: “${'x'.repeat(99)}…”`);
    expect(body.content).not.toContain('x'.repeat(101));
    expect(body.allowed_mentions).toStrictEqual({ parse: [], users: [USER_ID] });
  });

  it('pings only the reporter, never @everyone or roles', () => {
    const body = reportFallbackBody({
      userId: USER_ID,
      reference: 'a1b2c3',
      ephemeral: false,
      text: '@everyone <@&123> hi',
    });
    expect(body.allowed_mentions).toEqual({ parse: [], users: [USER_ID] });
  });

  it('omits the mention when the user id is not a snowflake', () => {
    const body = reportFallbackBody({
      userId: '@everyone',
      reference: 'a1b2c3',
      ephemeral: true,
      text: '',
    });
    expect(body.content).toBe('Your report was logged (ref `a1b2c3`)');
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it('strips markdown and mention characters from the reference', () => {
    const body = reportFallbackBody({
      userId: USER_ID,
      reference: '`<@&1>ab`',
      ephemeral: true,
      text: '',
    });
    expect(body.content).toContain('(ref `1ab`)');
  });
});

describe('statusText', () => {
  it('summarises counts and worker liveness', () => {
    expect(statusText({ reportsToday: 3, retrying: 1, workerLastBeatSeconds: 4 })).toBe(
      'Reports today: 3 · Retrying: 1 · Worker last active 4 s ago.',
    );
  });

  it('says so when the worker has never checked in', () => {
    expect(statusText({ reportsToday: 0, retrying: 0, workerLastBeatSeconds: null })).toBe(
      "Reports today: 0 · Retrying: 0 · The worker hasn't checked in yet.",
    );
  });
});
