import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { AppIcon } from './icon';
import type { IconName } from './icons';

export type Tone = 'ok' | 'busy' | 'warn' | 'error' | 'neutral';

/**
 * A status as icon + words + colour (WCAG 1.4.1: colour is never the only signal). The words use the normal
 * text colour, so contrast holds in both themes whatever the tone colour is; the tone colours the icon and
 * the border only.
 */
@Component({
  selector: 'app-status-badge',
  imports: [AppIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: inline-flex;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 10px 2px 8px;
      border: 1px solid var(--tone, var(--mat-sys-outline));
      border-radius: 999px;
      background: var(--mat-sys-surface-container-low);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-label-large);
      white-space: nowrap;
    }
    app-icon {
      color: var(--tone, var(--mat-sys-on-surface-variant));
    }
    .tone-ok {
      --tone: var(--mat-sys-primary);
    }
    .tone-busy {
      --tone: var(--mat-sys-secondary);
    }
    .tone-warn {
      --tone: var(--mat-sys-tertiary);
    }
    .tone-error {
      --tone: var(--mat-sys-error);
    }
    .tone-neutral {
      --tone: var(--mat-sys-outline);
    }
  `,
  template: `
    <span class="badge" [class]="'badge tone-' + tone()">
      <app-icon [name]="icon()" />
      <span>{{ label() }}</span>
    </span>
  `,
})
export class StatusBadge {
  readonly tone = input.required<Tone>();
  readonly icon = input.required<IconName>();
  readonly label = input.required<string>();
}
