import { describe, expect, it } from 'vitest';

import { describeFailure, withAttemptLimit } from './failureReasons.js';

describe('describeFailure', () => {
  it.each([
    ['mirror', { kind: 'timeout' as const }, 'Slack did not answer in time.'],
    ['mirror', { kind: 'network' as const }, 'Could not reach Slack.'],
    ['followup', { kind: 'timeout' as const }, 'Discord did not answer in time.'],
    ['fallback', { kind: 'network' as const }, 'Could not reach Discord.'],
  ] as const)('explains a %s failure with no response', (target, failure, expected) => {
    expect(describeFailure(target, failure)).toBe(expected);
  });

  it('tells the admin what to do when Slack says the webhook is gone', () => {
    expect(describeFailure('mirror', { status: 404 })).toBe(
      'Slack says the webhook no longer exists (HTTP 404). Set a new webhook URL on the dashboard.',
    );
  });

  it('says a rejected follow-up was answered in the channel instead', () => {
    expect(describeFailure('followup', { status: 401 })).toContain('posted in the channel instead');
    expect(describeFailure('followup', { status: 404 })).toContain('posted in the channel instead');
  });

  it('tells the admin which permissions the bot needs when the channel post is forbidden', () => {
    expect(describeFailure('fallback', { status: 403 })).toBe(
      'The bot cannot post in that channel (HTTP 403). Give it View Channel and Send Messages.',
    );
  });

  it.each([
    ['mirror', 429, 'rate limiting'],
    ['mirror', 503, 'problem on its side'],
    ['mirror', 302, 'redirect'],
    ['mirror', 400, 'rejected the notification'],
    ['followup', 400, 'rejected the reply'],
    ['fallback', 404, 'could not find that channel'],
    ['fallback', 400, 'rejected the channel post'],
  ] as const)('describes %s HTTP %i', (target, status, fragment) => {
    expect(describeFailure(target, { status })).toContain(fragment);
  });

  it('explains a mirror call that was refused before sending', () => {
    expect(describeFailure('mirror', {})).toContain('not an allowed Slack webhook');
  });

  it('SHALL never contain a URL, a token or anything but the status code from the response', () => {
    const reasons = [
      describeFailure('mirror', { status: 500 }),
      describeFailure('followup', { status: 401 }),
      describeFailure('fallback', { status: 403 }),
    ];
    for (const reason of reasons) {
      expect(reason).not.toMatch(/https?:|token|secret/i);
    }
  });
});

describe('withAttemptLimit', () => {
  it('appends how many attempts were made', () => {
    expect(withAttemptLimit('Slack had a problem on its side (HTTP 503).', 8)).toBe(
      'Slack had a problem on its side (HTTP 503). Gave up after 8 attempts.',
    );
  });
});
