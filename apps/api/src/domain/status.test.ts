import { describe, expect, it } from 'vitest';

import { MESSAGES } from './messages.js';
import { statusText } from './status.js';

describe('status unavailable notice', () => {
  it('tells the user what happened and what to do, without technical detail', () => {
    expect(MESSAGES.statusUnavailable).toBe(
      "We couldn't check the status right now. Please try again in a minute.",
    );
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
