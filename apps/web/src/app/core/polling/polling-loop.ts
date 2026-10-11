import { signal } from '@angular/core';

import { isUnauthenticated } from '../errors/app-error';

/**
 * `running`: ticking on schedule. `retrying`: the last tick failed and we are backing off.
 * `paused`: the tab is hidden, so nothing is requested. `stopped`: not started, stopped, or the session ended.
 */
export type PollState = 'running' | 'retrying' | 'paused' | 'stopped';

export interface PollingOptions {
  /** One poll. Throw to signal failure; a 401 (UNAUTHENTICATED) stops the loop for good. */
  readonly tick: () => Promise<void>;
  readonly intervalMs: number;
  /** Waits after the 1st, 2nd, ... consecutive failure; the last entry repeats. */
  readonly backoffMs: readonly number[];
  readonly doc: Document;
}

/**
 * A timer chain, not an interval: the next tick is scheduled only after the current one settles, so ticks
 * never overlap and a slow server never builds a queue. Hidden tabs make no requests; coming back refreshes
 * at once. Consecutive failures back off. The first one that is a 401 ends the loop (the session is gone).
 */
export class PollingLoop {
  readonly state = signal<PollState>('stopped');

  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private inFlight = false;
  private failures = 0;

  constructor(private readonly options: PollingOptions) {}

  private readonly onVisibility = (): void => {
    if (!this.active) {
      return;
    }
    this.clearTimer();
    if (this.options.doc.hidden) {
      this.state.set('paused');
      return;
    }
    if (!this.inFlight) {
      void this.run();
    }
  };

  /** Starts ticking `intervalMs` from now (the caller has just loaded the data itself). */
  start(): void {
    if (this.active) {
      return;
    }
    this.active = true;
    this.failures = 0;
    this.options.doc.addEventListener('visibilitychange', this.onVisibility);
    this.schedule();
  }

  stop(): void {
    this.active = false;
    this.clearTimer();
    this.options.doc.removeEventListener('visibilitychange', this.onVisibility);
    this.state.set('stopped');
  }

  /** Runs a tick now unless one is already running (for example after the user changes a filter). */
  refreshNow(): Promise<void> {
    if (!this.active || this.inFlight) {
      return Promise.resolve();
    }
    this.clearTimer();
    return this.run();
  }

  private async run(): Promise<void> {
    this.inFlight = true;
    try {
      await this.options.tick();
      this.failures = 0;
    } catch (error) {
      if (isUnauthenticated(error)) {
        this.stop();
        return;
      }
      this.failures++;
    } finally {
      this.inFlight = false;
    }
    this.schedule();
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.active) {
      return;
    }
    if (this.options.doc.hidden) {
      this.state.set('paused');
      return;
    }
    const { backoffMs, intervalMs } = this.options;
    const delay =
      this.failures === 0
        ? intervalMs
        : (backoffMs[Math.min(this.failures, backoffMs.length) - 1] ?? intervalMs);
    this.state.set(this.failures === 0 ? 'running' : 'retrying');
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
