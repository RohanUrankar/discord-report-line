import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { InteractionDetail } from '@report-line/shared';

import { ApiClient } from '../../core/api/api-client';
import { POLL_BACKOFF_MS, POLL_INTERVAL_MS } from '../../core/constants/app.constants';
import { asAppError, type AppError } from '../../core/errors/app-error';
import { messageForCode } from '../../core/errors/error-messages';
import { PollingLoop } from '../../core/polling/polling-loop';

export type DetailStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** Work that can still change: the job has not finished, so attempts may still be added. */
export function isStillWorking(detail: InteractionDetail): boolean {
  return (
    detail.job !== null && (detail.job.status === 'pending' || detail.job.status === 'processing')
  );
}

/**
 * One command's details and its attempt history. While the job is still running the page keeps itself fresh
 * (same polling rules as the log: visible tab only, no overlap, backs off, stops on 401). If a refresh fails
 * the last good details stay on screen with a notice (`refreshError`): a partial state, not an empty one.
 */
@Injectable()
export class InteractionDetailStore {
  private readonly api = inject(ApiClient);

  private readonly _detail = signal<InteractionDetail | null>(null);
  private readonly _status = signal<DetailStatus>('idle');
  private readonly _error = signal<AppError | null>(null);
  private readonly _refreshError = signal<AppError | null>(null);

  private guildId: string | null = null;
  private interactionId: string | null = null;
  private generation = 0;

  private readonly loop = new PollingLoop({
    tick: () => this.refresh(),
    intervalMs: POLL_INTERVAL_MS,
    backoffMs: POLL_BACKOFF_MS,
    doc: inject(DOCUMENT),
  });

  readonly detail = this._detail.asReadonly();
  readonly status = this._status.asReadonly();
  readonly error = this._error.asReadonly();
  readonly refreshError = this._refreshError.asReadonly();
  readonly working = computed(() => {
    const detail = this._detail();
    return detail !== null && isStillWorking(detail);
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.close();
    });
  }

  async open(guildId: string, interactionId: string): Promise<void> {
    this.close();
    const mine = this.generation;
    this.guildId = guildId;
    this.interactionId = interactionId;
    this._status.set('loading');
    try {
      const detail = await this.api.getInteraction(guildId, interactionId);
      if (mine !== this.generation) {
        return;
      }
      this._detail.set(detail);
      this._status.set('loaded');
      if (isStillWorking(detail)) {
        this.loop.start();
      }
    } catch (error) {
      if (mine !== this.generation) {
        return;
      }
      this._error.set(asAppError(error, messageForCode('INTERNAL')));
      this._status.set('error');
    }
  }

  /** "Try again" after a failed load, or after a failed refresh. Not a job retry. */
  async reload(): Promise<void> {
    if (this.guildId === null || this.interactionId === null) {
      return;
    }
    if (this._status() === 'error' || this._detail() === null) {
      await this.open(this.guildId, this.interactionId);
      return;
    }
    this._refreshError.set(null);
    try {
      await this.refresh();
    } catch (error) {
      this._refreshError.set(asAppError(error, messageForCode('INTERNAL')));
    }
    if (this.working()) {
      this.loop.start();
    }
  }

  close(): void {
    this.generation++;
    this.loop.stop();
    this._detail.set(null);
    this._status.set('idle');
    this._error.set(null);
    this._refreshError.set(null);
  }

  private async refresh(): Promise<void> {
    const { guildId, interactionId } = this;
    if (guildId === null || interactionId === null) {
      return;
    }
    const mine = this.generation;
    try {
      const detail = await this.api.getInteraction(guildId, interactionId);
      if (mine !== this.generation) {
        return;
      }
      this._detail.set(detail);
      this._refreshError.set(null);
      if (!isStillWorking(detail)) {
        this.loop.stop(); // finished: nothing more will change
      }
    } catch (error) {
      if (mine === this.generation) {
        this._refreshError.set(asAppError(error, messageForCode('INTERNAL')));
      }
      throw error;
    }
  }
}
