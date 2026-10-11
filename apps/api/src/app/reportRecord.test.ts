import { describe, expect, it } from 'vitest';

import { ACTION_SUMMARIES } from '../domain/messages.js';
import { deferredReportRecord, readReportText } from './reportRecord.js';

const decision = {
  kind: 'command' as const,
  name: 'report',
  options: { text: 'printer' },
  actor: { userId: '900000000000000003' },
  tenant: { guildId: '900000000000000001', channelId: '900000000000000002' },
};
const action = {
  type: 'report' as const,
  ephemeral: true,
  replyMessage: 'Logged.',
  mirror: true,
  tag: false,
};

describe('readReportText', () => {
  it('trims the text', () => {
    expect(readReportText({ text: '  hello  ' })).toEqual({ ok: true, text: 'hello' });
  });

  it.each([[{}], [{ text: '' }], [{ text: ' \n\t' }], [{ text: 5 }], [{ text: null }]])(
    'rejects %j as empty',
    (options) => {
      expect(readReportText(options)).toEqual({ ok: false, reason: 'empty' });
    },
  );

  it('accepts 1000 characters and rejects 1001, counting an emoji as one', () => {
    expect(readReportText({ text: '😀'.repeat(1000) }).ok).toBe(true);
    expect(readReportText({ text: '😀'.repeat(1001) })).toEqual({ ok: false, reason: 'tooLong' });
  });
});

describe('deferredReportRecord', () => {
  const build = (overrides: Partial<typeof action> = {}) =>
    deferredReportRecord({
      interactionId: '900000000000000004',
      interactionToken: 'tok',
      receivedAtMs: 1_000_000,
      decision,
      action: { ...action, ...overrides },
      text: 'printer',
    });

  it('records a deferred interaction with a pending mirror and the rule snapshot', () => {
    const record = build();
    expect(record.interaction.status).toBe('deferred');
    expect(record.action).toEqual({
      type: 'report',
      summary: ACTION_SUMMARIES.report,
      mirrorStatus: 'pending',
    });
    expect(record.job?.payload).toMatchObject({ text: 'printer', mirror: true, ephemeral: true });
  });

  it('marks the mirror skipped when the rule turns it off', () => {
    expect(build({ mirror: false }).action.mirrorStatus).toBe('skipped');
  });

  it('expires the token 14 minutes 30 seconds after the request arrived', () => {
    expect(build().job?.tokenExpiresAt.getTime()).toBe(1_000_000 + 870_000);
  });

  it('keeps the report text out of the action summary', () => {
    expect(build().action.summary).not.toContain('printer');
  });
});
