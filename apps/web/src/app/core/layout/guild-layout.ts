import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { ROUTE, logPath, rulesPath, settingsPath } from '../constants/routes.constants';
import { GuildsStore } from '../guilds/guilds-store';
import { AppIcon } from '../../shared/ui/icon';
import { EmptyState } from '../../shared/ui/empty-state';
import { ErrorPanel } from '../../shared/ui/error-panel';
import { LoadingBlock } from '../../shared/ui/loading-block';
import { PageHeader } from '../../shared/ui/page-header';

/**
 * Wraps every page of one server (`/g/:guildId/...`). A server that is not in this admin's list is shown
 * as not found, the same answer the API gives (404), and none of its pages are rendered.
 */
@Component({
  selector: 'app-guild-layout',
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    AppIcon,
    EmptyState,
    ErrorPanel,
    LoadingBlock,
    PageHeader,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 8px 16px 0;
      max-width: 1100px;
      margin: 0 auto;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    nav a {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 44px;
      padding: 0 16px;
      color: var(--mat-sys-on-surface);
      text-decoration: none;
      border-bottom: 3px solid transparent;
      border-radius: var(--mat-sys-corner-small) var(--mat-sys-corner-small) 0 0;
    }
    nav a.active {
      border-bottom-color: var(--mat-sys-primary);
      font-weight: 600;
    }
    nav a:hover {
      background: var(--mat-sys-surface-container-low);
    }
  `,
  template: `
    @switch (state()) {
      @case ('loading') {
        <div class="page">
          <app-page-header heading="Server" />
          <app-loading-block label="Loading your servers" [lines]="2" />
        </div>
      }
      @case ('error') {
        <div class="page">
          <app-page-header heading="Server" />
          @if (guilds.error(); as error) {
            <app-error-panel [error]="error" (retry)="reload()" />
          }
        </div>
      }
      @case ('not-found') {
        <div class="page">
          <app-page-header
            heading="We couldn't find that server"
            lead="It may not be one you manage, or the link may be wrong."
          />
          <app-empty-state heading="Choose a server" icon="info">
            Pick one of your servers from the list at the top, or connect a new one.
            <div actions>
              <a [routerLink]="home">Go to your dashboard</a>
            </div>
          </app-empty-state>
        </div>
      }
      @default {
        <nav aria-label="Server sections">
          <a [routerLink]="log()" routerLinkActive="active" ariaCurrentWhenActive="page">
            <app-icon name="list_alt" /> Command log
          </a>
          <a [routerLink]="settings()" routerLinkActive="active" ariaCurrentWhenActive="page">
            <app-icon name="settings" /> Settings
          </a>
          <a [routerLink]="rules()" routerLinkActive="active" ariaCurrentWhenActive="page">
            <app-icon name="tune" /> Command rules
          </a>
        </nav>
        <router-outlet />
      }
    }
  `,
})
export class GuildLayout {
  protected readonly guilds = inject(GuildsStore);

  /** Bound from the `:guildId` route parameter. */
  readonly guildId = input.required<string>();

  protected readonly home = ROUTE.home;
  protected readonly log = computed(() => logPath(this.guildId()));
  protected readonly settings = computed(() => settingsPath(this.guildId()));
  protected readonly rules = computed(() => rulesPath(this.guildId()));

  protected readonly state = computed<'loading' | 'error' | 'not-found' | 'ready'>(() => {
    switch (this.guilds.status()) {
      case 'idle':
      case 'loading':
        return 'loading';
      case 'error':
        return 'error';
      case 'loaded':
        return this.guilds.items().some((g) => g.id === this.guildId()) ? 'ready' : 'not-found';
    }
  });

  protected reload(): void {
    void this.guilds.load(true);
  }
}
