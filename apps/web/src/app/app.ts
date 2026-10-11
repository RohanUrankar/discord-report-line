import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { FocusOnNavigation } from './core/a11y/focus-on-navigation';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .skip-link {
      position: absolute;
      left: 8px;
      top: -64px;
      z-index: 1000;
      padding: 12px 16px;
      background: var(--mat-sys-inverse-surface);
      color: var(--mat-sys-inverse-on-surface);
      border-radius: var(--mat-sys-corner-small);
    }
    .skip-link:focus {
      top: 8px;
    }
  `,
  template: `
    <a class="skip-link" href="#main" (click)="skipToMain($event)">Skip to main content</a>
    <router-outlet />
  `,
})
export class App {
  private readonly doc = inject(DOCUMENT);

  constructor() {
    inject(FocusOnNavigation).start();
  }

  /** `<base href="/">` makes a bare `#main` link leave the page, so focus the target by hand. */
  protected skipToMain(event: Event): void {
    event.preventDefault();
    this.doc.getElementById('main')?.focus();
  }
}
