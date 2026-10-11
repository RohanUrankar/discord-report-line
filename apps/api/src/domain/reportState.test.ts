import { describe, expect, it } from 'vitest';

import { availableActions, blockingActionTypes, isAllowed, stateOf } from './reportState.js';

describe('report state', () => {
  it('allows reported → acknowledged, reported → escalated and acknowledged → escalated only', () => {
    expect(isAllowed('reported', 'acknowledge')).toBe(true);
    expect(isAllowed('reported', 'escalate')).toBe(true);
    expect(isAllowed('acknowledged', 'acknowledge')).toBe(false);
    expect(isAllowed('acknowledged', 'escalate')).toBe(true);
    expect(isAllowed('escalated', 'acknowledge')).toBe(false);
    expect(isAllowed('escalated', 'escalate')).toBe(false);
  });

  it('offers exactly the allowed actions', () => {
    expect(availableActions('reported')).toEqual(['acknowledge', 'escalate']);
    expect(availableActions('acknowledged')).toEqual(['escalate']);
    expect(availableActions('escalated')).toEqual([]);
  });

  it('derives the state from who acted, escalation winning', () => {
    expect(stateOf({ acknowledgedBy: null, escalatedBy: null })).toBe('reported');
    expect(stateOf({ acknowledgedBy: '1', escalatedBy: null })).toBe('acknowledged');
    expect(stateOf({ acknowledgedBy: '1', escalatedBy: '2' })).toBe('escalated');
    expect(stateOf({ acknowledgedBy: null, escalatedBy: '2' })).toBe('escalated');
  });
});

describe('blockingActionTypes', () => {
  it('lists the rows that stop each move, matching isAllowed', () => {
    expect(blockingActionTypes('acknowledge')).toEqual(['acknowledged', 'escalated']);
    expect(blockingActionTypes('escalate')).toEqual(['escalated']);
  });
});
