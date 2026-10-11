import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';

import { ROUTE, logPath } from '../../core/constants/routes.constants';
import { GuildsStore } from '../../core/guilds/guilds-store';
import { ErrorPanel } from '../../shared/ui/error-panel';
import { LoadingBlock } from '../../shared/ui/loading-block';
import { PageHeader } from '../../shared/ui/page-header';

/**
 * `/`: send the admin where they will want to be. Their first server's live log; with no server yet, the
 * connect-a-server first-run page. Shows loading or the load error while it finds out.
 */
@Component({
  selector: 'app-landing',
  imports: [ErrorPanel, LoadingBlock, PageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header heading="Your servers" lead="Finding your servers." />
      @if (guilds.status() === 'error' && guilds.error(); as error) {
        <app-error-panel [error]="error" (retry)="start()" />
      } @else {
        <app-loading-block label="Loading your servers" [lines]="2" />
      }
    </div>
  `,
})
export class Landing {
  protected readonly guilds = inject(GuildsStore);
  private readonly router = inject(Router);

  constructor() {
    void this.start();
  }

  protected async start(): Promise<void> {
    await this.guilds.load(this.guilds.status() === 'error');
    if (this.guilds.status() !== 'loaded') {
      return;
    }
    const first = this.guilds.items()[0];
    await this.router.navigate([first === undefined ? ROUTE.connect : logPath(first.id)], {
      replaceUrl: true,
    });
  }
}
