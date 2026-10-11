import { DestroyRef, Injectable, inject, signal } from '@angular/core';

import { CLOCK_TICK_MS } from '../constants/app.constants';

/** One shared tick so every "2 min ago" on the page refreshes together without a timer per row. */
@Injectable({ providedIn: 'root' })
export class NowClock {
  private readonly _now = signal(Date.now());
  readonly now = this._now.asReadonly();

  constructor() {
    const timer = setInterval(() => {
      this._now.set(Date.now());
    }, CLOCK_TICK_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
    });
  }
}
