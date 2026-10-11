import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { MatButton } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import type { AttemptView, InteractionDetail } from '@report-line/shared';

import { logPath, settingsPath } from '../../core/constants/routes.constants';
import { shortId } from '../../core/guilds/guild-label';
import { absoluteTime } from '../../shared/format/time';
import { RelativeTime } from '../../core/time/relative-time';
import { ErrorPanel } from '../../shared/ui/error-panel';
import { AppIcon } from '../../shared/ui/icon';
import { LoadingBlock } from '../../shared/ui/loading-block';
import { PageHeader } from '../../shared/ui/page-header';
import { StatusBadge } from '../../shared/ui/status-badge';
import { InteractionDetailStore } from './interaction-detail-store';
import {
  commandLabel,
  deadNotificationSummary,
  describeAttempt,
  describeNotification,
  describeRow,
  describeTag,
  isReplyDeliveredNotificationFailed,
  type AttemptPresentation,
  type Presentation,
  type RowStatus,
  type TagPresentation,
} from './log-labels';

const NOT_FOUND_MESSAGE = "We couldn't find that command in this server.";

interface AttemptVm {
  readonly attempt: AttemptView;
  readonly view: AttemptPresentation;
  readonly http: string;
  readonly started: string;
}

interface DetailVm {
  readonly detail: InteractionDetail;
  readonly command: string;
  readonly status: RowStatus;
  readonly notification: Presentation | null;
  readonly time: string;
  readonly user: string;
  readonly tag: TagPresentation | null;
  readonly deliveredButNotNotified: boolean;
  readonly summary: string;
  readonly attempts: readonly AttemptVm[];
}

function toVm(detail: InteractionDetail): DetailVm {
  return {
    detail,
    command: commandLabel(detail),
    status: describeRow(detail),
    notification: describeNotification(detail),
    time: absoluteTime(detail.createdAt),
    user: `User ${shortId(detail.userId)}`,
    tag: describeTag(detail),
    deliveredButNotNotified: isReplyDeliveredNotificationFailed(detail),
    summary: deadNotificationSummary(detail),
    attempts: detail.attemptHistory.map((attempt) => ({
      attempt,
      view: describeAttempt(attempt),
      http: attempt.httpStatus === null ? 'No response' : `HTTP ${String(attempt.httpStatus)}`,
      started: absoluteTime(attempt.startedAt),
    })),
  };
}

/** One command, what the bot did about it, and every attempt it made, in plain language. */
@Component({
  selector: 'app-interaction-detail',
  imports: [
    MatButton,
    RouterLink,
    AppIcon,
    ErrorPanel,
    LoadingBlock,
    PageHeader,
    RelativeTime,
    StatusBadge,
  ],
  providers: [InteractionDetailStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .back {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    .callout {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      padding: 16px;
      margin: 16px 0;
      border: 1px solid var(--mat-sys-tertiary);
      border-inline-start-width: 6px;
      border-radius: var(--mat-sys-corner-medium);
      background: var(--mat-sys-surface-container);
    }
    .callout.error {
      border-color: var(--mat-sys-error);
    }
    .callout app-icon {
      font-size: 1.5rem;
      color: var(--mat-sys-tertiary);
    }
    .callout.error app-icon {
      color: var(--mat-sys-error);
    }
    .callout h2,
    .callout p {
      margin: 0 0 4px;
    }
    .notice {
      margin: 12px 0;
      padding: 8px 12px;
      border: 1px solid var(--mat-sys-outline);
      border-radius: var(--mat-sys-corner-small);
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 8px 24px;
      margin: 16px 0;
    }
    dt {
      color: var(--mat-sys-on-surface-variant);
    }
    dd {
      margin: 0;
      min-width: 0;
    }
    @media (max-width: 480px) {
      dl {
        grid-template-columns: 1fr;
        gap: 2px;
      }
      dd {
        margin-bottom: 10px;
      }
    }
    ol.timeline {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    ol.timeline > li {
      padding: 12px 0 12px 16px;
      border-inline-start: 3px solid var(--mat-sys-outline-variant);
      margin-inline-start: 6px;
    }
    .attempt-head {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      align-items: center;
      margin-bottom: 4px;
    }
    .attempt-meta {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
    .attempt p {
      margin: 2px 0;
    }
    .empty {
      color: var(--mat-sys-on-surface-variant);
    }
  `,
  template: `
    <div class="page">
      <a class="back" [routerLink]="backLink()"
        ><app-icon name="arrow_back" /> Back to the command log</a
      >

      <app-page-header heading="Command details" [lead]="lead()" />

      @switch (store.status()) {
        @case ('error') {
          @if (store.error(); as error) {
            <app-error-panel
              [error]="error"
              [message]="errorText()"
              [canRetry]="canRetry()"
              (retry)="store.reload()"
            />
          }
        }
        @case ('loaded') {
          @if (vm(); as v) {
            @if (store.refreshError(); as problem) {
              <div class="notice" role="status">
                <app-icon name="cloud_off" />
                <span>
                  We couldn't refresh these details. What you see is from a moment ago.
                  @if (problem.requestId) {
                    <span class="reference"
                      >Reference: <code>{{ problem.requestId }}</code></span
                    >
                  }
                </span>
                <button matButton="outlined" type="button" (click)="store.reload()">
                  <app-icon name="refresh" /> Try again
                </button>
              </div>
            }

            @if (v.deliveredButNotNotified) {
              <section class="callout" aria-labelledby="dead-title">
                <app-icon name="warning" />
                <div>
                  <h2 id="dead-title">Reply sent, notification failed</h2>
                  <p>{{ v.summary }}</p>
                  <p>
                    The bot has stopped trying.
                    <a [routerLink]="settingsLink()">Check the Slack settings</a>
                    for this server.
                  </p>
                </div>
              </section>
            } @else if (v.status.needsAttention) {
              <section class="callout error" aria-labelledby="failed-title">
                <app-icon name="error" />
                <div>
                  <h2 id="failed-title">This command could not be completed</h2>
                  <p>The bot has stopped trying. The attempts below show what went wrong.</p>
                </div>
              </section>
            }

            <dl>
              <dt>Command</dt>
              <dd>{{ v.command }}</dd>
              <dt>When</dt>
              <dd><app-time [value]="v.detail.createdAt" /> ({{ v.time }})</dd>
              <dt>User</dt>
              <dd [attr.title]="v.detail.userId">{{ v.user }}</dd>
              <dt>Status</dt>
              <dd>
                <app-status-badge
                  [tone]="v.status.tone"
                  [icon]="v.status.icon"
                  [label]="v.status.label"
                />
              </dd>
              <dt>Slack notification</dt>
              <dd>
                @if (v.notification; as n) {
                  <app-status-badge [tone]="n.tone" [icon]="n.icon" [label]="n.label" />
                } @else {
                  None for this command
                }
              </dd>
              @if (v.tag; as t) {
                <dt>AI tag</dt>
                <dd>
                  <app-status-badge [tone]="t.tone" [icon]="t.icon" [label]="t.label" />
                </dd>
              }
              @if (v.detail.job; as job) {
                <dt>Attempts</dt>
                <dd>{{ job.attempts }}</dd>
                @if (job.lastError) {
                  <dt>Last problem</dt>
                  <dd>{{ job.lastError }}</dd>
                }
              }
            </dl>

            <h2>Attempts</h2>
            @if (v.attempts.length === 0) {
              <p class="empty">
                @if (v.detail.job === null) {
                  The bot answered this command straight away, so there was no background work to
                  try.
                } @else {
                  No attempts yet. The first one starts shortly.
                  @if (store.working()) {
                    This page updates by itself.
                  }
                }
              </p>
            } @else {
              <ol class="timeline" aria-label="Attempts, oldest first">
                @for (a of v.attempts; track a.attempt.attemptNo + a.attempt.target) {
                  <li class="attempt">
                    <div class="attempt-head">
                      <strong>Attempt {{ a.attempt.attemptNo }}: {{ a.view.targetLabel }}</strong>
                      <app-status-badge
                        [tone]="a.view.outcome.tone"
                        [icon]="a.view.outcome.icon"
                        [label]="a.view.outcome.label"
                      />
                    </div>
                    <p class="attempt-meta">{{ a.http }} &middot; {{ a.started }}</p>
                    <p>{{ a.view.reason }}</p>
                    @if (a.attempt.error) {
                      <p class="attempt-meta">Detail: {{ a.attempt.error }}</p>
                    }
                  </li>
                }
              </ol>
            }
          }
        }
        @default {
          <app-loading-block label="Loading command details" [lines]="5" />
        }
      }
    </div>
  `,
})
export class InteractionDetailPage {
  protected readonly store = inject(InteractionDetailStore);

  readonly guildId = input.required<string>();
  readonly interactionId = input.required<string>();

  protected readonly backLink = computed(() => logPath(this.guildId()));
  protected readonly settingsLink = computed(() => settingsPath(this.guildId()));
  protected readonly vm = computed<DetailVm | null>(() => {
    const detail = this.store.detail();
    return detail === null ? null : toVm(detail);
  });

  protected readonly lead = computed(() => {
    const v = this.vm();
    return v === null ? null : `${v.command} · ${v.time}`;
  });
  protected readonly errorText = computed(() =>
    this.store.error()?.code === 'NOT_FOUND' ? NOT_FOUND_MESSAGE : null,
  );
  protected readonly canRetry = computed(() => this.store.error()?.code !== 'NOT_FOUND');

  constructor() {
    effect(() => {
      const guildId = this.guildId();
      const interactionId = this.interactionId();
      untracked(() => {
        void this.store.open(guildId, interactionId);
      });
    });
  }
}
