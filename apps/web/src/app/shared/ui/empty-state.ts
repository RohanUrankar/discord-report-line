import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { AppIcon } from './icon';
import type { IconName } from './icons';

/** Why a list is empty and what to do next. The next action is projected in as `<div actions>`. */
@Component({
  selector: 'app-empty-state',
  imports: [AppIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
    }
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 8px;
      padding: 32px 16px;
      border: 1px dashed var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-medium);
    }
    app-icon {
      font-size: 2rem;
      color: var(--mat-sys-on-surface-variant);
    }
    h2 {
      margin: 0;
    }
    .text {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      max-width: 60ch;
    }
  `,
  template: `
    <div class="empty">
      <app-icon [name]="icon()" />
      <h2>{{ heading() }}</h2>
      <div class="text"><ng-content /></div>
      <ng-content select="[actions]" />
    </div>
  `,
})
export class EmptyState {
  readonly heading = input.required<string>();
  readonly icon = input<IconName>('info');
}
