import { logItem, attempt } from '../../../testing/fixtures';
import {
  attemptReason,
  commandLabel,
  deadNotificationSummary,
  describeAttempt,
  describeNotification,
  describeRow,
  describeTag,
  isReplyDeliveredNotificationFailed,
} from './log-labels';

const job = (status: 'pending' | 'processing' | 'done' | 'dead', attempts: number) => ({
  status,
  attempts,
  lastError: null,
});

describe('describeRow: refused commands', () => {
  it.each([
    ['disabled', 'Refused: command is off'],
    ['unknown_command', 'Unknown command'],
  ] as const)(
    'WHEN the bot answered with %s THE UI SHALL say so, not just "Answered"',
    (type, label) => {
      const row = describeRow(
        logItem(1, {
          interactionStatus: 'answered',
          job: null,
          action: { type, mirrorStatus: 'skipped', llmTag: null, tagState: 'off' as const },
        }),
      );
      expect(row.label).toBe(label);
      expect(row.needsAttention).toBe(false);
    },
  );
});

describe('describeRow', () => {
  it('WHEN the job is dead after the user got their reply THE UI SHALL say the notification failed', () => {
    const row = describeRow(logItem(1, { interactionStatus: 'followed_up', job: job('dead', 8) }));
    expect(row).toMatchObject({
      label: 'Reply sent, notification failed',
      needsAttention: true,
      tone: 'warn',
    });
  });

  it('WHEN the job is dead and the user got no reply THE UI SHALL say it failed', () => {
    expect(
      describeRow(logItem(1, { interactionStatus: 'deferred', job: job('dead', 8) })),
    ).toMatchObject({
      label: 'Failed',
      needsAttention: true,
      tone: 'error',
    });
  });

  it('flags a failed interaction even without a job', () => {
    expect(
      describeRow(logItem(1, { interactionStatus: 'failed', job: null, action: null }))
        .needsAttention,
    ).toBe(true);
  });

  it('WHEN a job is still retrying THE UI SHALL show how many attempts so far', () => {
    expect(
      describeRow(logItem(1, { interactionStatus: 'deferred', job: job('pending', 3) })),
    ).toMatchObject({
      label: 'Retrying (3 attempts so far)',
      icon: 'sync',
      needsAttention: false,
    });
    expect(
      describeRow(logItem(1, { interactionStatus: 'deferred', job: job('processing', 1) })).label,
    ).toBe('Retrying (1 attempt so far)');
  });

  it.each([
    ['deferred', 'Working on it'],
    ['fallback_posted', 'Posted in the channel instead'],
    ['followed_up', 'Replied'],
    ['answered', 'Answered'],
  ] as const)('labels %s as "%s"', (interactionStatus, label) => {
    expect(describeRow(logItem(1, { interactionStatus, job: job('done', 0) })).label).toBe(label);
  });

  it('every status has an icon and words (never colour alone)', () => {
    for (const status of [
      'answered',
      'deferred',
      'followed_up',
      'fallback_posted',
      'failed',
    ] as const) {
      const row = describeRow(logItem(1, { interactionStatus: status, job: null }));
      expect(row.icon.length).toBeGreaterThan(0);
      expect(row.label.length).toBeGreaterThan(0);
    }
  });
});

describe('describeNotification', () => {
  it.each([
    ['pending', 'Sending'],
    ['sent', 'Sent'],
    ['failed', 'Failed'],
    ['skipped', 'Not needed'],
  ] as const)('shows mirror status %s as "%s"', (mirrorStatus, label) => {
    expect(
      describeNotification(
        logItem(1, { action: { type: 'report', mirrorStatus, llmTag: null, tagState: 'off' } }),
      )?.label,
    ).toBe(label);
  });

  it('shows "Not sent" when the job gave up before the notification went out', () => {
    expect(
      describeNotification(
        logItem(1, {
          action: {
            type: 'report',
            mirrorStatus: 'pending',
            llmTag: null,
            tagState: 'off' as const,
          },
          job: job('dead', 8),
        }),
      )?.label,
    ).toBe('Not sent');
  });

  it('returns null when there is no action', () => {
    expect(describeNotification(logItem(1, { action: null }))).toBeNull();
  });
});

describe('commandLabel', () => {
  it('prefixes slash commands and names component clicks', () => {
    expect(commandLabel({ command: 'report', action: null })).toBe('/report');
    expect(commandLabel({ command: null, action: null })).toBe('Button click');
    const click = (type: 'acknowledged' | 'escalated') => ({
      command: null,
      action: { type, mirrorStatus: 'skipped' as const, llmTag: null, tagState: 'off' as const },
    });
    expect(commandLabel(click('acknowledged'))).toBe('Button: Acknowledge');
    expect(commandLabel(click('escalated'))).toBe('Button: Escalate');
  });
});

describe('attempt wording', () => {
  it.each([
    [
      { target: 'mirror', outcome: 'retryable', httpStatus: 503 },
      'Slack had a problem on its side (HTTP 503).',
    ],
    [
      { target: 'mirror', outcome: 'retryable', httpStatus: null },
      'Slack did not answer in time, or the connection failed.',
    ],
    [
      { target: 'mirror', outcome: 'retryable', httpStatus: 429 },
      'Slack asked us to slow down (rate limited).',
    ],
    [
      { target: 'mirror', outcome: 'fatal', httpStatus: 404 },
      'Slack rejected the webhook address (HTTP 404). Check it in Settings.',
    ],
    [
      { target: 'followup', outcome: 'fatal', httpStatus: 404 },
      'Discord no longer accepts a reply to this command (its 15-minute window has passed).',
    ],
    [
      { target: 'fallback', outcome: 'fatal', httpStatus: 403 },
      "The bot can't post in the channel (it lacks permission, or the channel was deleted).",
    ],
    [
      { target: 'tag', outcome: 'fatal', httpStatus: 400 },
      'The AI tag could not be obtained, so the report is shown as not tagged. The notification was not held up.',
    ],
    [{ target: 'mirror', outcome: 'success', httpStatus: 200 }, 'Done.'],
  ] as const)('explains %j', (input, text) => {
    expect(attemptReason(input)).toBe(text);
  });

  it('labels target and outcome in plain words', () => {
    const described = describeAttempt(
      attempt({ target: 'followup', outcome: 'retryable', httpStatus: 500 }),
    );
    expect(described.targetLabel).toBe('Reply in Discord');
    expect(described.outcome).toMatchObject({ label: 'Failed, will retry', tone: 'warn' });
  });
});

describe('dead notification summary', () => {
  it('names the exact situation with the attempt count', () => {
    const item = logItem(1, { interactionStatus: 'followed_up', job: job('dead', 8) });
    expect(isReplyDeliveredNotificationFailed(item)).toBe(true);
    expect(deadNotificationSummary(item)).toBe(
      'The user got their reply, but the Slack notification failed after 8 attempts.',
    );
  });

  it('uses the singular for one attempt', () => {
    expect(
      deadNotificationSummary(
        logItem(1, { interactionStatus: 'followed_up', job: job('dead', 1) }),
      ),
    ).toContain('failed after 1 attempt.');
  });

  it('does not apply to a done job', () => {
    expect(isReplyDeliveredNotificationFailed(logItem(1))).toBe(false);
  });
});

describe('describeTag', () => {
  const item = (
    tagState: 'tagged' | 'untagged' | 'pending' | 'off',
    llmTag: string | null,
    type = 'report',
  ) => ({ action: { type, mirrorStatus: 'sent', llmTag, tagState } }) as never;

  it('gives each state its own state, icon and wording', () => {
    const all = [
      describeTag(item('tagged', 'outage')),
      describeTag(item('untagged', 'untagged')),
      describeTag(item('pending', null)),
      describeTag(item('off', null)),
    ];
    expect(all.map((t) => t?.state)).toEqual(['tagged', 'untagged', 'pending', 'off']);
    expect(new Set(all.map((t) => t?.label)).size).toBe(4);
    expect(new Set(all.map((t) => t?.icon)).size).toBe(4);
    expect(all[0]).toMatchObject({ label: 'Tag: outage', text: 'outage' });
  });

  it('treats a tagged state without a real tag as untagged rather than showing an empty tag', () => {
    expect(describeTag(item('tagged', null))?.state).toBe('untagged');
  });

  it('says nothing for a command that is not a report and for no action', () => {
    expect(describeTag(item('off', null, 'status'))).toBeNull();
    expect(describeTag({ action: null })).toBeNull();
  });
});
