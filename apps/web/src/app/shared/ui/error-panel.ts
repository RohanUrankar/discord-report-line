import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatButton } from '@angular/material/button';

import type { AppError } from '../../core/errors/app-error';
import { AppIcon } from './icon';

/**
 * A failed load or save, in the user-facing voice: what went wrong, what to do, and a small reference line
 * for support. The Retry button reloads the data; it is never a job retry.
 */
@Component({
  selector: 'app-error-panel',
  imports: [AppIcon, MatButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
    }
    .panel {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      padding: 16px;
      border: 1px solid var(--mat-sys-error);
      border-radius: var(--mat-sys-corner-medium);
      background: var(--mat-sys-surface-container);
    }
    app-icon {
      color: var(--mat-sys-error);
      font-size: 1.5rem;
    }
    .body {
      flex: 1;
      min-width: 0;
    }
    .message {
      margin: 0 0 4px;
      font-weight: 600;
    }
    .reference {
      margin: 0 0 12px;
    }
  `,
  template: `
    <div class="panel" role="alert">
      <app-icon name="error" />
      <div class="body">
        <p class="message">{{ text() }}</p>
        @if (error().requestId; as ref) {
          <p class="reference">
            Reference: <code>{{ ref }}</code>
          </p>
        }
        @if (canRetry()) {
          <button matButton="outlined" type="button" (click)="retry.emit()">
            <app-icon name="refresh" /> {{ retryLabel() }}
          </button>
        }
      </div>
    </div>
  `,
})
export class ErrorPanel {
  readonly error = input.required<AppError>();
  /** Replaces the default wording for this code when the page knows better (for example "server not found"). */
  readonly message = input<string | null>(null);
  readonly canRetry = input(true);
  readonly retryLabel = input('Try again');
  readonly retry = output();

  protected readonly text = computed(() => this.message() ?? this.error().message);
}
