import { Injectable, computed, inject, signal } from '@angular/core';
import type { GuildSummary } from '@report-line/shared';

import { ApiClient } from '../api/api-client';
import { asAppError, type AppError } from '../errors/app-error';
import { messageForCode } from '../errors/error-messages';

export type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** The servers this admin manages (server state). Everything per-server hangs off the route's guild id. */
@Injectable({ providedIn: 'root' })
export class GuildsStore {
  private readonly api = inject(ApiClient);

  private readonly _items = signal<readonly GuildSummary[]>([]);
  private readonly _status = signal<LoadStatus>('idle');
  private readonly _error = signal<AppError | null>(null);
  private generation = 0;

  readonly items = this._items.asReadonly();
  readonly status = this._status.asReadonly();
  readonly error = this._error.asReadonly();
  readonly isEmpty = computed(() => this._status() === 'loaded' && this._items().length === 0);

  /** Loads once; a failed or never-started load tries again. `force` always asks the server. */
  async load(force = false): Promise<void> {
    if (!force && (this._status() === 'loaded' || this._status() === 'loading')) {
      return;
    }
    const mine = ++this.generation;
    this._status.set('loading');
    this._error.set(null);
    try {
      const list = await this.api.listGuilds();
      if (mine !== this.generation) {
        return;
      }
      this._items.set(list.items);
      this._status.set('loaded');
    } catch (error) {
      if (mine !== this.generation) {
        return;
      }
      this._error.set(asAppError(error, messageForCode('INTERNAL')));
      this._status.set('error');
    }
  }

  /** A server was just connected: show it without another round trip. */
  add(guild: GuildSummary): void {
    this._items.update((items) =>
      items.some((g) => g.id === guild.id) ? items : [...items, guild],
    );
    this._status.set('loaded');
  }

  reset(): void {
    this.generation++;
    this._items.set([]);
    this._error.set(null);
    this._status.set('idle');
  }
}
