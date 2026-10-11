import { describe, expect, it } from 'vitest';

import { WindowRateLimiter } from './windowRateLimiter.js';

const WINDOW_MS = 1000;
const make = (maxKeys = 100): WindowRateLimiter =>
  new WindowRateLimiter({ limit: 2, windowMs: WINDOW_MS, maxKeys });

describe('WindowRateLimiter', () => {
  it('WHEN attempts stay within the limit THE SYSTEM SHALL allow them', () => {
    const limiter = make();

    expect(limiter.hit('a', 0).allowed).toBe(true);
    expect(limiter.hit('a', 10).allowed).toBe(true);
  });

  it('WHEN the limit is exceeded THE SYSTEM SHALL deny and say when the window ends', () => {
    const limiter = make();
    limiter.hit('a', 0);
    limiter.hit('a', 10);

    expect(limiter.hit('a', 400)).toEqual({ allowed: false, retryAfterMs: 600 });
  });

  it('WHEN the window has elapsed THE SYSTEM SHALL start counting again', () => {
    const limiter = make();
    limiter.hit('a', 0);
    limiter.hit('a', 1);
    limiter.hit('a', 2);

    expect(limiter.hit('a', WINDOW_MS).allowed).toBe(true);
  });

  it('WHEN keys differ THE SYSTEM SHALL count them separately', () => {
    const limiter = make();
    limiter.hit('a', 0);
    limiter.hit('a', 0);
    limiter.hit('a', 0);

    expect(limiter.hit('b', 0).allowed).toBe(true);
  });

  it('WHEN more distinct keys arrive than the bound THE SYSTEM SHALL evict the oldest rather than grow', () => {
    const limiter = make(2);
    limiter.hit('a', 0);
    limiter.hit('a', 0);
    limiter.hit('a', 0); // "a" is now over its limit
    limiter.hit('b', 1);
    limiter.hit('c', 2); // the map is full, so the oldest live window ("a") is evicted

    expect(limiter.hit('a', 3).allowed).toBe(true); // a fresh window, so its earlier count is gone
  });
});
