import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle';
import { Router } from '@angular/router';
import type { JobStatus } from '@report-line/shared';

import { LIVE_HOLD_SCROLL_PX } from '../../core/constants/app.constants';
import { FILTER_ATTENTION, FILTER_PARAM } from '../../core/constants/routes.constants';
import { NotifyService } from '../../core/notify/notify.service';
import { RelativeTime } from '../../core/time/relative-time';
import { EmptyState } from '../../shared/ui/empty-state';
import { ErrorPanel } from '../../shared/ui/error-panel';
import { AppIcon } from '../../shared/ui/icon';
import { LoadingBlock } from '../../shared/ui/loading-block';
import { PageHeader } from '../../shared/ui/page-header';
import { CommandLogStore } from './command-log-store';
import { LogTable } from './log-table';

const ALL = 'all';
const ATTENTION_JOB_STATUS: JobStatus = 'dead';

/**
 * The live command log of one server: what ran, what the bot did, what needs a look. The filter lives in the
 * URL (`?filter=attention`) so reload, back and sharing a link all work.
 */
@Component({
  selector: 'app-log-page',
  imports: [
    MatButton,
    MatButtonToggle,
    MatButtonToggleGroup,
    AppIcon,
    EmptyState,
    ErrorPanel,
    LoadingBlock,
    LogTable,
    PageHeader,
    RelativeTime,
  ],
  providers: [CommandLogStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:scroll)': 'onScroll()',
  },
  styles: `
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 16px;
      margin-bottom: 12px;
    }
    .live {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
    .grow {
      flex: 1 1 0;
    }
    .pending {
      position: sticky;
      top: 8px;
      z-index: 2;
      margin-bottom: 8px;
    }
    .more {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      margin-top: 16px;
    }
    .note {
      margin: 8px 0 0;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
  template: `
    <div class="page">
      <app-page-header
        heading="Command log"
        lead="Every command people run in your server, what the bot did about it, and anything that needs a look."
      />

      <div class="sr-only" role="status" aria-live="polite">{{ store.announcement() }}</div>

      <div class="bar">
        <mat-button-toggle-group
          aria-label="Show"
          [value]="activeFilter()"
          (change)="setFilter($event.value)"
        >
          <mat-button-toggle value="all">All commands</mat-button-toggle>
          <mat-button-toggle value="attention">Needs attention</mat-button-toggle>
        </mat-button-toggle-group>
        <span class="grow"></span>
        @if (store.status() === 'loaded') {
          <span class="live">
            @switch (store.pollState()) {
              @case ('retrying') {
                <app-icon name="sync" /> Live updates paused. Trying again shortly.
              }
              @case ('paused') {
                <app-icon name="schedule" /> Updates resume when you return to this tab.
              }
              @case ('stopped') {
                <app-icon name="info" /> Not updating.
              }
              @default {
                <app-icon name="sync" /> Live
              }
            }
            @if (store.lastUpdated(); as updated) {
              <span>&middot; updated <app-time [value]="updated" /></span>
            }
          </span>
        }
      </div>

      @switch (store.status()) {
        @case ('error') {
          @if (store.error(); as error) {
            <app-error-panel [error]="error" (retry)="store.reload()" />
          }
        }
        @case ('loaded') {
          @if (store.pendingCount() > 0) {
            <div class="pending">
              <button matButton="filled" type="button" (click)="store.showPending()">
                Show {{ store.pendingCount() }} new
                {{ store.pendingCount() === 1 ? 'command' : 'commands' }}
              </button>
            </div>
          }
          @if (store.isEmpty()) {
            @if (isAttention()) {
              <app-empty-state heading="Nothing needs attention" icon="check_circle">
                A command shows up here when its notification still fails after every retry.
                <div actions>
                  <button matButton type="button" (click)="setFilter('all')">
                    Show all commands
                  </button>
                </div>
              </app-empty-state>
            } @else {
              <app-empty-state heading="No commands yet" icon="chat">
                Run <code>/status</code> in your Discord server and it will appear here within a few
                seconds.
                <div actions>
                  <button matButton="outlined" type="button" (click)="copyStatus()">
                    <app-icon name="add" /> Copy /status
                  </button>
                </div>
              </app-empty-state>
            }
          } @else {
            <div (focusin)="onFocusIn()" (focusout)="onFocusOut($event)">
              <app-log-table
                [items]="store.items()"
                [guildId]="guildId()"
                [highlight]="store.highlight()"
              />
            </div>
            <div class="more">
              @if (store.moreError(); as error) {
                <div role="alert">{{ error.message }}</div>
              }
              @if (store.hasMore()) {
                <button
                  matButton="outlined"
                  type="button"
                  [disabled]="store.loadingMore()"
                  (click)="store.loadOlder()"
                >
                  {{ store.loadingMore() ? 'Loading…' : 'Load older commands' }}
                </button>
              }
              @if (store.capped()) {
                <p class="note">
                  Showing the newest 500 commands. Older ones are not listed here; narrow the view
                  with the filter, or reload the page.
                </p>
              }
              @if (store.loadedOlder()) {
                <p class="note">Older rows are not refreshed until you reload the page.</p>
              }
            </div>
          }
        }
        @default {
          <app-loading-block label="Loading commands" [lines]="6" />
        }
      }
    </div>
  `,
})
export class LogPage {
  protected readonly store = inject(CommandLogStore);
  private readonly router = inject(Router);
  private readonly doc = inject(DOCUMENT);
  private readonly notify = inject(NotifyService);

  /** From the `:guildId` route parameter. */
  readonly guildId = input.required<string>();
  /** From the `?filter=` query parameter. */
  readonly filter = input<string | undefined>();

  protected readonly activeFilter = computed(() => (this.isAttention() ? FILTER_ATTENTION : ALL));
  protected readonly isAttention = computed(() => this.filter() === FILTER_ATTENTION);

  private readonly scrolledAway = signal(false);
  private readonly focusInside = signal(false);

  constructor() {
    effect(() => {
      const guildId = this.guildId();
      const status = this.isAttention() ? ATTENTION_JOB_STATUS : undefined;
      untracked(() => {
        void this.store.open(guildId, status);
      });
    });
    effect(() => {
      const hold = this.scrolledAway() || this.focusInside();
      untracked(() => {
        this.store.setHold(hold);
      });
    });
  }

  protected setFilter(value: string): void {
    void this.router.navigate([], {
      queryParams: { [FILTER_PARAM]: value === FILTER_ATTENTION ? FILTER_ATTENTION : null },
      queryParamsHandling: 'merge',
    });
  }

  protected onScroll(): void {
    const view = this.doc.defaultView;
    this.scrolledAway.set((view?.scrollY ?? 0) > LIVE_HOLD_SCROLL_PX);
  }

  protected onFocusIn(): void {
    this.focusInside.set(true);
  }

  protected onFocusOut(event: FocusEvent): void {
    const host = event.currentTarget as HTMLElement;
    if (!(event.relatedTarget instanceof Node) || !host.contains(event.relatedTarget)) {
      this.focusInside.set(false);
    }
  }

  protected async copyStatus(): Promise<void> {
    try {
      await this.doc.defaultView?.navigator.clipboard.writeText('/status');
      this.notify.success('Copied /status.');
    } catch {
      this.notify.failure("We couldn't copy that. Type /status in Discord instead.");
    }
  }
}
