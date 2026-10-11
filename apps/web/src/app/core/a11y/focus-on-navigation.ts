import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';

const MAIN_HEADING = 'main h1';

/**
 * After a route change a keyboard or screen-reader user would otherwise be left on a link that no longer
 * exists. Move focus to the new page's `h1` (it announces the page) when the path changes. Changing only
 * the query string (a filter) keeps focus where it is.
 */
@Injectable({ providedIn: 'root' })
export class FocusOnNavigation {
  private readonly router = inject(Router);
  private readonly doc = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private lastPath: string | null = null;

  start(): void {
    const subscription = this.router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) {
        return;
      }
      const path = event.urlAfterRedirects.split(/[?#]/, 1)[0] ?? '';
      if (path === this.lastPath) {
        return;
      }
      this.lastPath = path;
      // Wait one task so the routed component has rendered its heading.
      setTimeout(() => {
        this.doc.querySelector<HTMLElement>(MAIN_HEADING)?.focus();
      });
    });
    this.destroyRef.onDestroy(() => {
      subscription.unsubscribe();
    });
  }
}
