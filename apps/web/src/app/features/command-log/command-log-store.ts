import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { InteractionLogItem, JobStatus } from '@report-line/shared';

import { ApiClient } from '../../core/api/api-client';
import {
  LOG_LIST_CAP,
  LOG_PAGE_SIZE,
  POLL_BACKOFF_MS,
  POLL_INTERVAL_MS,
} from '../../core/constants/app.constants';
import { asAppError, isUnauthenticated, type AppError } from '../../core/errors/app-error';
import { messageForCode } from '../../core/errors/error-messages';
import { PollingLoop } from '../../core/polling/polling-loop';

export type LogStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** Newest first: by time, and by id (a Discord snowflake, so numerically ordered) for equal times. */
export function compareNewestFirst(a: InteractionLogItem, b: InteractionLogItem): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  const left = BigInt(a.id);
  const right = BigInt(b.id);
  return left === right ? 0 : left < right ? 1 : -1;
}

const sameRow = (a: InteractionLogItem, b: InteractionLogItem): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const newCommands = (n: number): string => `${String(n)} new ${n === 1 ? 'command' : 'commands'}`;

/**
 * The live command log of one server (server state). Provided by the log page, so it lives and dies with it
 * and never shows server A's rows under server B.
 *
 * There is no "since" parameter, so a poll re-reads page 1 and merges it by id: changed rows are replaced in
 * place (a job finishing flips its row), unseen rows are new. Rows older than page 1 are fetched on demand
 * ("Load older") and do not refresh until the page is reloaded. New rows wait in `pendingCount` while the
 * reader has scrolled away or is working in the table (`setHold`), so the list never moves under them.
 */
@Injectable()
export class CommandLogStore {
  private readonly api = inject(ApiClient);

  private readonly _items = signal<readonly InteractionLogItem[]>([]);
  private readonly _status = signal<LogStatus>('idle');
  private readonly _error = signal<AppError | null>(null);
  private readonly _nextCursor = signal<string | null>(null);
  private readonly _loadingMore = signal(false);
  private readonly _moreError = signal<AppError | null>(null);
  private readonly _capped = signal(false);
  private readonly _loadedOlder = signal(false);
  private readonly _pending = signal<ReadonlyMap<string, InteractionLogItem>>(new Map());
  private readonly _highlight = signal<ReadonlySet<string>>(new Set());
  private readonly _announcement = signal('');
  private readonly _lastUpdated = signal<string | null>(null);
  private readonly _hold = signal(false);

  private guildId: string | null = null;
  private jobStatus: JobStatus | undefined;
  private generation = 0;

  private readonly loop = new PollingLoop({
    tick: () => this.poll(),
    intervalMs: POLL_INTERVAL_MS,
    backoffMs: POLL_BACKOFF_MS,
    doc: inject(DOCUMENT),
  });

  readonly items = this._items.asReadonly();
  readonly status = this._status.asReadonly();
  readonly error = this._error.asReadonly();
  readonly hasMore = computed(() => this._nextCursor() !== null);
  readonly loadingMore = this._loadingMore.asReadonly();
  readonly moreError = this._moreError.asReadonly();
  /** The list is at its cap: older rows are not offered (reload, or narrow the filter, to see them). */
  readonly capped = this._capped.asReadonly();
  /** Rows from older pages are in the list; they do not refresh until the page is reloaded. */
  readonly loadedOlder = this._loadedOlder.asReadonly();
  readonly pendingCount = computed(() => this._pending().size);
  /** Ids inserted by the latest merge; the table flashes them briefly (unless motion is reduced). */
  readonly highlight = this._highlight.asReadonly();
  /** A short summary for a polite live region: "3 new commands", never one message per row. */
  readonly announcement = this._announcement.asReadonly();
  readonly lastUpdated = this._lastUpdated.asReadonly();
  readonly pollState = this.loop.state.asReadonly();
  readonly isEmpty = computed(() => this._status() === 'loaded' && this._items().length === 0);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.close();
    });
  }

  /** (Re)load page 1 for a server and filter, and start polling. Anything from a previous call is dropped. */
  async open(guildId: string, jobStatus: JobStatus | undefined): Promise<void> {
    this.close();
    const mine = this.generation;
    this.guildId = guildId;
    this.jobStatus = jobStatus;
    this._status.set('loading');
    try {
      const page = await this.api.listInteractions(guildId, this.query());
      if (mine !== this.generation) {
        return;
      }
      this._items.set([...page.items].sort(compareNewestFirst));
      this._nextCursor.set(page.nextCursor);
      this._capped.set(false);
      this._status.set('loaded');
      this._lastUpdated.set(new Date().toISOString());
      this.loop.start();
    } catch (error) {
      if (mine !== this.generation) {
        return;
      }
      this._error.set(asAppError(error, messageForCode('INTERNAL')));
      this._status.set('error');
    }
  }

  /** The "Try again" of a failed first load. Not a job retry. */
  async reload(): Promise<void> {
    if (this.guildId !== null) {
      await this.open(this.guildId, this.jobStatus);
    }
  }

  async loadOlder(): Promise<void> {
    const cursor = this._nextCursor();
    const guildId = this.guildId;
    if (cursor === null || guildId === null || this._loadingMore()) {
      return;
    }
    const mine = this.generation;
    this._loadingMore.set(true);
    this._moreError.set(null);
    try {
      const page = await this.api.listInteractions(guildId, { ...this.query(), cursor });
      if (mine !== this.generation) {
        return;
      }
      const known = new Set(this._items().map((item) => item.id));
      const merged = [...this._items(), ...page.items.filter((item) => !known.has(item.id))].sort(
        compareNewestFirst,
      );
      this._loadedOlder.set(true);
      this.commit(merged, page.nextCursor);
    } catch (error) {
      if (mine === this.generation && !isUnauthenticated(error)) {
        this._moreError.set(asAppError(error, messageForCode('INTERNAL')));
      }
    } finally {
      if (mine === this.generation) {
        this._loadingMore.set(false);
      }
    }
  }

  /** The table tells us whether the reader is away from the top or busy in a row. Releasing the hold shows what waited. */
  setHold(hold: boolean): void {
    if (this._hold() === hold) {
      return;
    }
    this._hold.set(hold);
    if (!hold) {
      this.showPending();
    }
  }

  /** The "N new, show" button. */
  showPending(): void {
    const waiting = [...this._pending().values()];
    if (waiting.length === 0) {
      return;
    }
    this._pending.set(new Map());
    this._highlight.set(new Set(waiting.map((item) => item.id)));
    this.commit([...waiting, ...this._items()].sort(compareNewestFirst), this._nextCursor());
  }

  close(): void {
    this.generation++;
    this.loop.stop();
    this._items.set([]);
    this._status.set('idle');
    this._error.set(null);
    this._nextCursor.set(null);
    this._loadingMore.set(false);
    this._moreError.set(null);
    this._capped.set(false);
    this._loadedOlder.set(false);
    this._pending.set(new Map());
    this._highlight.set(new Set());
    this._announcement.set('');
    this._lastUpdated.set(null);
    this._hold.set(false);
  }

  private query(): { limit: number; status?: JobStatus } {
    return this.jobStatus === undefined
      ? { limit: LOG_PAGE_SIZE }
      : { limit: LOG_PAGE_SIZE, status: this.jobStatus };
  }

  /** One poll: page 1 again, merged by id. Throws on failure so the loop can back off. */
  private async poll(): Promise<void> {
    const guildId = this.guildId;
    if (guildId === null) {
      return;
    }
    const mine = this.generation;
    const page = await this.api.listInteractions(guildId, this.query());
    if (mine !== this.generation) {
      return;
    }
    this._lastUpdated.set(new Date().toISOString());
    this.merge(page.items, page.nextCursor);
  }

  private merge(fetched: readonly InteractionLogItem[], page1Cursor: string | null): void {
    const current = this._items();
    const byId = new Map(current.map((item) => [item.id, item]));
    const pending = new Map(this._pending());

    // A burst of more than one page between two polls leaves a hole between page 1 and what we hold.
    // Rather than show a list with a silent gap, start again from page 1.
    const overlaps = fetched.some((item) => byId.has(item.id) || pending.has(item.id));
    if (!overlaps && fetched.length > 0 && current.length > 0 && page1Cursor !== null) {
      const fresh = [...fetched].sort(compareNewestFirst);
      this._pending.set(new Map());
      this._highlight.set(new Set(fresh.map((item) => item.id)));
      this._announcement.set(`The list was refreshed: ${newCommands(fresh.length)} or more.`);
      this._capped.set(false);
      this.commit(fresh, page1Cursor);
      return;
    }

    const arrivals: InteractionLogItem[] = [];
    const updated = current.map((item) => {
      const next = fetched.find((candidate) => candidate.id === item.id);
      return next !== undefined && !sameRow(next, item) ? next : item;
    });
    const changed = updated.some((row, index) => row !== current[index]);
    for (const item of fetched) {
      if (byId.has(item.id)) {
        continue;
      }
      if (pending.has(item.id)) {
        pending.set(item.id, item); // a waiting row that changed: keep it current
      } else {
        arrivals.push(item);
      }
    }

    if (arrivals.length === 0 && !changed && pending.size === this._pending().size) {
      this._pending.set(pending);
      return;
    }

    if (arrivals.length > 0 && this._hold()) {
      for (const item of arrivals) {
        pending.set(item.id, item);
      }
      this._pending.set(pending);
      this._announcement.set(
        `${newCommands(pending.size)}. Use the button above the list to show them.`,
      );
      if (changed) {
        this.commit(updated, this._nextCursor());
      }
      return;
    }

    this._pending.set(pending);
    if (arrivals.length > 0) {
      this._highlight.set(new Set(arrivals.map((item) => item.id)));
      this._announcement.set(newCommands(arrivals.length));
    }
    this.commit([...arrivals, ...updated].sort(compareNewestFirst), this._nextCursor());
  }

  /** Apply the cap. Dropping the oldest rows also drops the way back to "older", since the cursor no longer matches. */
  private commit(rows: readonly InteractionLogItem[], nextCursor: string | null): void {
    if (rows.length > LOG_LIST_CAP) {
      this._items.set(rows.slice(0, LOG_LIST_CAP));
      this._nextCursor.set(null);
      this._capped.set(true);
      return;
    }
    this._items.set(rows);
    this._nextCursor.set(nextCursor);
  }
}
