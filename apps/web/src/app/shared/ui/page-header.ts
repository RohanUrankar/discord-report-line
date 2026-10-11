import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The page title and its one-line purpose. The `h1` is the target of focus management on route change, so
 * every routed page renders exactly one, always (never inside a conditional).
 */
@Component({
  selector: 'app-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
      margin-bottom: 16px;
    }
    .lead {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
  template: `
    <h1 tabindex="-1">{{ heading() }}</h1>
    @if (lead(); as text) {
      <p class="lead">{{ text }}</p>
    }
    <ng-content />
  `,
})
export class PageHeader {
  readonly heading = input.required<string>();
  readonly lead = input<string | null>(null);
}
