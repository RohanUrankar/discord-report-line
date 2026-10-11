import type { Clock } from '../ports/clock.js';

export class SystemClock implements Clock {
  public nowMs(): number {
    return Date.now();
  }
}
