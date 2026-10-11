export interface RateLimitDecision {
  allowed: boolean;
  /** How long until the key's window ends. Zero when allowed. */
  retryAfterMs: number;
}

export interface WindowRateLimiterOptions {
  /** Attempts allowed per key per window. */
  limit: number;
  windowMs: number;
  /** Upper bound on tracked keys, so a flood of distinct keys cannot grow memory without limit. */
  maxKeys: number;
}

interface Window {
  startedAtMs: number;
  count: number;
}

/**
 * Fixed-window counter per key, in memory (one process, no second datastore: CLAUDE.md). Time is passed in so
 * tests are deterministic. A fixed window lets a burst of up to twice the limit straddle a boundary; for a
 * login throttle that is an accepted trade for simplicity.
 */
export class WindowRateLimiter {
  private readonly windows = new Map<string, Window>();

  public constructor(private readonly options: WindowRateLimiterOptions) {}

  /** Counts one attempt and says whether it may proceed. Denied attempts are counted too. */
  public hit(key: string, nowMs: number): RateLimitDecision {
    const current = this.windows.get(key);
    if (current === undefined || nowMs - current.startedAtMs >= this.options.windowMs) {
      this.start(key, nowMs);
      return { allowed: true, retryAfterMs: 0 };
    }
    current.count += 1;
    if (current.count <= this.options.limit) {
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: current.startedAtMs + this.options.windowMs - nowMs };
  }

  private start(key: string, nowMs: number): void {
    this.windows.delete(key); // re-inserting moves the key to the end, keeping the Map in age order
    if (this.windows.size >= this.options.maxKeys) {
      this.evict(nowMs);
    }
    this.windows.set(key, { startedAtMs: nowMs, count: 1 });
  }

  /** Drops expired windows first; if every one is still live, drops the oldest so the bound holds. */
  private evict(nowMs: number): void {
    for (const [key, window] of this.windows) {
      if (nowMs - window.startedAtMs >= this.options.windowMs) {
        this.windows.delete(key);
      }
    }
    const oldest = this.windows.keys().next();
    if (this.windows.size >= this.options.maxKeys && oldest.done !== true) {
      this.windows.delete(oldest.value);
    }
  }
}
