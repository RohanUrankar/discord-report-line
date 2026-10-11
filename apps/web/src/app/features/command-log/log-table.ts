import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  MatCell,
  MatCellDef,
  MatColumnDef,
  MatHeaderCell,
  MatHeaderCellDef,
  MatHeaderRow,
  MatHeaderRowDef,
  MatRow,
  MatRowDef,
  MatTable,
} from '@angular/material/table';
import { RouterLink } from '@angular/router';
import type { InteractionLogItem } from '@report-line/shared';

import { interactionPath } from '../../core/constants/routes.constants';
import { shortId } from '../../core/guilds/guild-label';
import { RelativeTime } from '../../core/time/relative-time';
import { StatusBadge } from '../../shared/ui/status-badge';
import {
  commandLabel,
  describeNotification,
  describeRow,
  describeTag,
  type Presentation,
  type RowStatus,
  type TagPresentation,
} from './log-labels';

interface RowVm {
  readonly item: InteractionLogItem;
  readonly link: string;
  readonly command: string;
  readonly user: string;
  readonly status: RowStatus;
  readonly notification: Presentation | null;
  readonly tag: TagPresentation | null;
}

const COLUMNS = ['time', 'command', 'user', 'status', 'notification', 'tag', 'attempts'] as const;

/**
 * The command log as a real table (roles: table, row, columnheader, cell). Below 720px each row becomes a
 * stacked card whose cells carry their own label, so nothing scrolls sideways and meaning survives. The time
 * cell holds the link to the row's details: the one tab stop per row.
 */
@Component({
  selector: 'app-log-table',
  imports: [
    MatTable,
    MatColumnDef,
    MatHeaderCell,
    MatHeaderCellDef,
    MatCell,
    MatCellDef,
    MatHeaderRow,
    MatHeaderRowDef,
    MatRow,
    MatRowDef,
    RouterLink,
    RelativeTime,
    StatusBadge,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
    }
    mat-table {
      display: block;
      background: transparent;
    }
    mat-header-row,
    mat-row {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 52px;
      padding: 4px 12px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    mat-header-row {
      font: var(--mat-sys-label-large);
      color: var(--mat-sys-on-surface-variant);
    }
    mat-cell,
    mat-header-cell {
      min-width: 0;
      flex: 1 1 0;
      padding: 0;
      border-bottom-width: 0;
    }
    .mat-column-time {
      flex: 0 0 120px;
    }
    .mat-column-command {
      flex: 0 0 150px;
    }
    .mat-column-user {
      flex: 0 0 130px;
    }
    .mat-column-status {
      flex: 1.6 1 0;
    }
    .mat-column-notification {
      flex: 1 1 0;
    }
    .mat-column-tag {
      flex: 1 1 0;
    }
    .mat-column-attempts {
      flex: 0 0 80px;
    }
    mat-row.attention {
      border-inline-start: 4px solid var(--mat-sys-error);
      background: var(--mat-sys-surface-container-low);
    }
    mat-row.fresh {
      animation: flash 2.4s ease-out;
    }
    @keyframes flash {
      from {
        background: var(--mat-sys-primary-container);
      }
    }
    a {
      color: var(--mat-sys-primary);
    }
    .none {
      color: var(--mat-sys-on-surface-variant);
    }
    @media (max-width: 720px) {
      mat-header-row {
        position: absolute;
        width: 1px;
        height: 1px;
        min-height: 0;
        padding: 0;
        overflow: hidden;
        clip-path: inset(50%);
      }
      mat-row {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
        margin-bottom: 12px;
        padding: 12px;
        border: 1px solid var(--mat-sys-outline-variant);
        border-radius: var(--mat-sys-corner-medium);
      }
      mat-row.attention {
        border-inline-start-width: 4px;
        border-inline-start-color: var(--mat-sys-error);
      }
      mat-cell {
        flex: none;
        display: flex;
        flex-wrap: wrap;
        gap: 2px 8px;
        align-items: baseline;
      }
      mat-cell::before {
        content: attr(data-label);
        flex: 0 0 7.5em;
        font: var(--mat-sys-label-medium);
        color: var(--mat-sys-on-surface-variant);
      }
    }
  `,
  template: `
    <mat-table [dataSource]="rows()" [trackBy]="trackById" aria-label="Commands, newest first">
      <ng-container matColumnDef="time">
        <mat-header-cell *matHeaderCellDef>Time</mat-header-cell>
        <mat-cell *matCellDef="let row" data-label="Time">
          <a [routerLink]="row.link">
            <app-time [value]="row.item.createdAt" />
            <span class="sr-only">, details of {{ row.command }}</span>
          </a>
        </mat-cell>
      </ng-container>

      <ng-container matColumnDef="command">
        <mat-header-cell *matHeaderCellDef>Command</mat-header-cell>
        <mat-cell *matCellDef="let row" data-label="Command">
          <span>{{ row.command }}</span>
        </mat-cell>
      </ng-container>

      <ng-container matColumnDef="user">
        <mat-header-cell *matHeaderCellDef>User</mat-header-cell>
        <mat-cell *matCellDef="let row" data-label="User">
          <span [attr.title]="row.item.userId">{{ row.user }}</span>
        </mat-cell>
      </ng-container>

      <ng-container matColumnDef="status">
        <mat-header-cell *matHeaderCellDef>Status</mat-header-cell>
        <mat-cell *matCellDef="let row" data-label="Status">
          <app-status-badge
            [tone]="row.status.tone"
            [icon]="row.status.icon"
            [label]="row.status.label"
          />
        </mat-cell>
      </ng-container>

      <ng-container matColumnDef="notification">
        <mat-header-cell *matHeaderCellDef>Notification</mat-header-cell>
        <mat-cell *matCellDef="let row" data-label="Notification">
          @if (row.notification; as n) {
            <app-status-badge [tone]="n.tone" [icon]="n.icon" [label]="n.label" />
          } @else {
            <span class="none"
              ><span aria-hidden="true">&mdash;</span><span class="sr-only">None</span></span
            >
          }
        </mat-cell>
      </ng-container>

      <ng-container matColumnDef="tag">
        <mat-header-cell *matHeaderCellDef>AI tag</mat-header-cell>
        <mat-cell *matCellDef="let row" data-label="AI tag">
          @if (row.tag; as t) {
            <app-status-badge [tone]="t.tone" [icon]="t.icon" [label]="t.label" />
          } @else {
            <span class="none"
              ><span aria-hidden="true">&mdash;</span><span class="sr-only">None</span></span
            >
          }
        </mat-cell>
      </ng-container>

      <ng-container matColumnDef="attempts">
        <mat-header-cell *matHeaderCellDef>Attempts</mat-header-cell>
        <mat-cell *matCellDef="let row" data-label="Attempts">
          @if (row.item.job; as job) {
            {{ job.attempts }}
          } @else {
            <span class="none"
              ><span aria-hidden="true">&mdash;</span><span class="sr-only">None</span></span
            >
          }
        </mat-cell>
      </ng-container>

      <mat-header-row *matHeaderRowDef="columns" />
      <mat-row
        *matRowDef="let row; columns: columns"
        [class.attention]="row.status.needsAttention"
        [class.fresh]="highlight().has(row.item.id)"
      />
    </mat-table>
  `,
})
export class LogTable {
  readonly items = input.required<readonly InteractionLogItem[]>();
  readonly guildId = input.required<string>();
  readonly highlight = input<ReadonlySet<string>>(new Set());

  protected readonly columns = COLUMNS;

  /** Everything a row shows is worked out once per change of the list, not once per change-detection pass. */
  protected readonly rows = computed<readonly RowVm[]>(() =>
    this.items().map((item) => ({
      item,
      link: interactionPath(this.guildId(), item.id),
      command: commandLabel(item),
      user: `User ${shortId(item.userId)}`,
      status: describeRow(item),
      notification: describeNotification(item),
      tag: describeTag(item),
    })),
  );

  protected readonly trackById = (_index: number, row: RowVm): string => row.item.id;
}
