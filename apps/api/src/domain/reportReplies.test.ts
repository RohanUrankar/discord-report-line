import { describe, expect, it } from 'vitest';

import { MESSAGES } from './messages.js';
import { reportButtons } from './reportButtons.js';
import { reportFallbackBody, reportResultBody } from './reportReplies.js';

const USER_ID = '1000000000000000001';
const REPORT_ID = '1300000000000000001';

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
    expect(JSON.stringify(body.components)).not.toMatch(/token|printer/i);
  });

  it('never sets flags (visibility was fixed at defer time)', () => {
    expect(
      reportResultBody({ replyMessage: 'Logged.', mirrorFailed: false }).flags,
    ).toBeUndefined();
  });
});

describe('reportFallbackBody (bot-token channel post)', () => {
  it.each([true, false])(
    'carries no buttons, with ephemeral = %s: a public post must not let anyone act on a private report',
    (ephemeral) => {
      const body = reportFallbackBody({
        userId: USER_ID,
        reference: 'a1b2c3',
        ephemeral,
        text: 'x',
      });
      expect(body).not.toHaveProperty('components');
    },
  );

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
