import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButton } from '@angular/material/button';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map, startWith } from 'rxjs';

import { AuthStore } from '../auth/auth-store';
import { ROUTE, guildPath } from '../constants/routes.constants';
import { GuildsStore } from '../guilds/guilds-store';
import { NotifyService } from '../notify/notify.service';
import { AppIcon } from '../../shared/ui/icon';
import { GuildSwitcher } from './guild-switcher';

const GUILD_URL = /^\/g\/(\d{17,20})(?:\/([a-z]+))?/;
const SECTIONS = new Set(['log', 'settings', 'rules']);
const SIGN_OUT_FAILED = "We couldn't sign you out. Check your connection and try again.";

/** Chrome around every signed-in page: brand, server switcher, who you are, sign out, and the page itself. */
@Component({
  selector: 'app-shell',
  imports: [RouterLink, RouterOutlet, MatButton, AppIcon, GuildSwitcher],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 16px;
      padding: 8px 16px;
      background: var(--mat-sys-surface-container);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .brand {
      font: var(--mat-sys-title-medium);
      color: var(--mat-sys-on-surface);
      text-decoration: none;
      border-radius: var(--mat-sys-corner-small);
    }
    .switcher {
      flex: 1 1 220px;
      max-width: 320px;
    }
    .spacer {
      flex: 1 1 0;
    }
    .who {
      color: var(--mat-sys-on-surface-variant);
      max-width: 24ch;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    main:focus {
      outline: none;
    }
  `,
  template: `
    <header>
      <a class="brand" [routerLink]="home">The Report Line</a>
      <nav class="switcher" aria-label="Servers">
        @if (guilds.items().length > 0) {
          <app-guild-switcher
            [guilds]="guilds.items()"
            [selectedId]="currentGuildId()"
            (picked)="switchTo($event)"
          />
        }
      </nav>
      <a matButton="outlined" [routerLink]="connect"> <app-icon name="add" /> Connect a server </a>
      <span class="spacer"></span>
      @if (auth.admin(); as admin) {
        <span class="who" [attr.title]="admin.email">{{ admin.email }}</span>
      }
      <button matButton type="button" (click)="signOut()" [disabled]="signingOut()">
        <app-icon name="logout" /> Sign out
      </button>
    </header>
    <main id="main" tabindex="-1">
      <router-outlet />
    </main>
  `,
})
export class Shell {
  protected readonly auth = inject(AuthStore);
  protected readonly guilds = inject(GuildsStore);
  private readonly router = inject(Router);
  private readonly notify = inject(NotifyService);

  protected readonly home = ROUTE.home;
  protected readonly connect = ROUTE.connect;
  protected readonly signingOut = signal(false);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );
  protected readonly currentGuildId = computed(() => GUILD_URL.exec(this.url())?.[1] ?? null);

  constructor() {
    void this.guilds.load();
    inject(DestroyRef).onDestroy(() => {
      this.guilds.reset();
    });
  }

  /** Keep the section (log, settings, rules) when changing server; a detail page of one server means nothing in another. */
  protected switchTo(guildId: string): void {
    const section = GUILD_URL.exec(this.url())?.[2];
    void this.router.navigate([
      guildPath(guildId),
      section !== undefined && SECTIONS.has(section) ? section : 'log',
    ]);
  }

  protected async signOut(): Promise<void> {
    this.signingOut.set(true);
    try {
      await this.auth.logout();
    } catch {
      this.notify.failure(SIGN_OUT_FAILED);
    } finally {
      this.signingOut.set(false);
    }
  }
}
