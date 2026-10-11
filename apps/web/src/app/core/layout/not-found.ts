import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ROUTE } from '../constants/routes.constants';
import { EmptyState } from '../../shared/ui/empty-state';
import { PageHeader } from '../../shared/ui/page-header';

@Component({
  selector: 'app-not-found',
  imports: [EmptyState, PageHeader, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header heading="We couldn't find that page" />
      <app-empty-state heading="Nothing here" icon="info">
        The address may be mistyped or out of date.
        <div actions>
          <a [routerLink]="home">Go to your dashboard</a>
        </div>
      </app-empty-state>
    </div>
  `,
})
export class NotFound {
  protected readonly home = ROUTE.home;
}
