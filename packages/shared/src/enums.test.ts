import { describe, expect, it } from 'vitest';

import {
  ActionType,
  AttemptOutcome,
  AttemptTarget,
  InteractionStatus,
  JobKind,
  JobStatus,
  MirrorStatus,
  TagFallback,
} from './index.js';

// These lists become migration CHECK constraints (DESIGN §9). A silent edit here would let the code write
// values the database rejects, or the other way round, so the exact contents are pinned.
describe('shared enums match DESIGN §8.3', () => {
  it.each([
    ['JobStatus', JobStatus, ['pending', 'processing', 'done', 'dead']],
    ['JobKind', JobKind, ['report', 'component']],
    ['AttemptOutcome', AttemptOutcome, ['success', 'retryable', 'fatal']],
    ['AttemptTarget', AttemptTarget, ['tag', 'mirror', 'followup', 'fallback']],
    [
      'InteractionStatus',
      InteractionStatus,
      ['answered', 'deferred', 'followed_up', 'fallback_posted', 'failed'],
    ],
    [
      'ActionType',
      ActionType,
      ['report', 'status', 'disabled', 'unknown_command', 'acknowledged', 'escalated'],
    ],
    ['MirrorStatus', MirrorStatus, ['pending', 'sent', 'failed', 'skipped']],
  ])('%s', (_name, actual, expected) => {
    expect([...actual]).toEqual(expected);
  });

  it('TagFallback is "untagged"', () => {
    expect(TagFallback).toBe('untagged');
  });
});
