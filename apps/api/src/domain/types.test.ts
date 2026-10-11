import * as shared from '@report-line/shared';
import { describe, expect, it } from 'vitest';

import * as types from './types.js';

describe('domain/types re-exports', () => {
  it.each([
    'JobStatus',
    'JobKind',
    'AttemptOutcome',
    'AttemptTarget',
    'InteractionStatus',
    'ActionType',
    'MirrorStatus',
    'TagFallback',
    'ReportTag',
    'TagState',
  ] as const)('%s is the same list as @report-line/shared (one source, no copy)', (name) => {
    expect(types[name]).toBe(shared[name]);
  });
});
