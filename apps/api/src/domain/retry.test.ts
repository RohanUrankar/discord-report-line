import { describe, expect, it } from 'vitest';

import { classifyFailure, nextBackoffMs, retryDelayMs } from './retry.js';

const BASE_MS = 500;
const MAX_MS = 60_000;
const always = (value: number) => () => value;

describe('classifyFailure', () => {
  it.each([
    ['timeout', { kind: 'timeout' as const }],
    ['network error', { kind: 'network' as const }],
    ['429', { status: 429 }],
    ['429 with Retry-After', { status: 429, retryAfterMs: 2_000 }],
    ['500', { status: 500 }],
    ['502', { status: 502 }],
    ['503', { status: 503 }],
    ['504', { status: 504 }],
    ['599', { status: 599 }],
  ])('WHEN a downstream fails with %s THE SYSTEM SHALL treat it as retryable', (_case, failure) => {
    expect(classifyFailure(failure)).toBe('retryable');
  });

  it.each([
    ['400 bad payload', 400],
    ['401 (follow-up token invalid)', 401],
    ['403 missing permissions', 403],
    ['404 (unknown webhook)', 404],
    ['408', 408],
    ['409', 409],
    ['425', 425],
    ['499', 499],
  ])(
    'WHEN a downstream returns %s THE SYSTEM SHALL treat it as fatal and not retry',
    (_case, status) => {
      expect(classifyFailure({ status })).toBe('fatal');
    },
  );

  it('WHEN PATCH @original returns 401 or 404 THE SYSTEM SHALL NOT retry it (classifier says fatal)', () => {
    expect(classifyFailure({ status: 401 })).toBe('fatal');
    expect(classifyFailure({ status: 404 })).toBe('fatal');
  });

  it('treats a redirect (fetched with redirect: manual) as fatal', () => {
    expect(classifyFailure({ status: 302 })).toBe('fatal');
  });

  it('treats a status outside the HTTP range as fatal', () => {
    expect(classifyFailure({ status: 600 })).toBe('fatal');
  });

  it('treats a failure with neither status nor kind as fatal (no evidence it is transient)', () => {
    expect(classifyFailure({})).toBe('fatal');
  });

  it('a network-level kind wins over a status the adapter also attached', () => {
    expect(classifyFailure({ kind: 'timeout', status: 400 })).toBe('retryable');
  });
});

describe('nextBackoffMs (full jitter)', () => {
  it('scales the jitter by base * 2^attempt below the cap', () => {
    expect(nextBackoffMs(3, BASE_MS, MAX_MS, always(0.5))).toBe(2_000);
  });

  it('returns the full ceiling when rnd is at its upper bound', () => {
    expect(nextBackoffMs(0, BASE_MS, MAX_MS, always(1))).toBe(500);
  });

  it('returns 0 when rnd returns 0 (full jitter, not equal jitter)', () => {
    expect(nextBackoffMs(5, BASE_MS, MAX_MS, always(0))).toBe(0);
  });

  it('caps the delay at maxMs once base * 2^attempt exceeds it', () => {
    expect(nextBackoffMs(20, BASE_MS, MAX_MS, always(0.999))).toBe(59_940);
  });

  it('stays at the cap for absurd attempt counts instead of overflowing', () => {
    expect(nextBackoffMs(10_000, BASE_MS, MAX_MS, always(1))).toBe(MAX_MS);
  });

  it('treats a negative attempt as attempt 0', () => {
    expect(nextBackoffMs(-3, BASE_MS, MAX_MS, always(1))).toBe(500);
  });

  it('clamps an out-of-range rnd so the delay is never negative or above the ceiling', () => {
    expect(nextBackoffMs(2, BASE_MS, MAX_MS, always(-0.5))).toBe(0);
    expect(nextBackoffMs(2, BASE_MS, MAX_MS, always(7))).toBe(2_000);
  });

  it('returns whole milliseconds', () => {
    expect(Number.isInteger(nextBackoffMs(1, 333, MAX_MS, always(0.123)))).toBe(true);
  });
});

describe('retryDelayMs', () => {
  it('WHEN a downstream returns 429 with Retry-After THE SYSTEM SHALL schedule no earlier than Retry-After', () => {
    expect(retryDelayMs({ status: 429, retryAfterMs: 3_000 }, 0, BASE_MS, MAX_MS, always(0))).toBe(
      3_000,
    );
  });

  it('does not cap Retry-After at maxMs', () => {
    expect(
      retryDelayMs({ status: 429, retryAfterMs: 120_000 }, 0, BASE_MS, MAX_MS, always(1)),
    ).toBe(120_000);
  });

  it('rounds a fractional Retry-After up, never down', () => {
    expect(
      retryDelayMs({ status: 429, retryAfterMs: 1_500.2 }, 0, BASE_MS, MAX_MS, always(1)),
    ).toBe(1_501);
  });

  it('clamps a negative Retry-After to 0', () => {
    expect(retryDelayMs({ status: 429, retryAfterMs: -5 }, 0, BASE_MS, MAX_MS, always(1))).toBe(0);
  });

  it('falls back to jittered backoff when there is no Retry-After', () => {
    expect(retryDelayMs({ status: 503 }, 3, BASE_MS, MAX_MS, always(0.5))).toBe(2_000);
  });

  it('ignores a non-finite Retry-After and uses jittered backoff', () => {
    expect(
      retryDelayMs({ status: 429, retryAfterMs: Number.NaN }, 3, BASE_MS, MAX_MS, always(0.5)),
    ).toBe(2_000);
    expect(
      retryDelayMs(
        { status: 429, retryAfterMs: Number.POSITIVE_INFINITY },
        3,
        BASE_MS,
        MAX_MS,
        always(0.5),
      ),
    ).toBe(2_000);
  });
});
