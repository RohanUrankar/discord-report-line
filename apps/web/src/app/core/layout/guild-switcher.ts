import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatOption, MatSelect } from '@angular/material/select';
import type { GuildSummary } from '@report-line/shared';

import { guildLabel } from '../guilds/guild-label';

/** Picks which connected server the dashboard shows. Presentational: the shell owns the navigation. */
@Component({
  selector: 'app-guild-switcher',
  imports: [MatFormField, MatLabel, MatSelect, MatOption],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    mat-form-field {
      width: 100%;
      min-width: 180px;
    }
  `,
  template: `
    <mat-form-field subscriptSizing="dynamic" appearance="outline">
      <mat-label>Server</mat-label>
      <mat-select [value]="selectedId()" (selectionChange)="picked.emit($event.value)">
        @for (guild of guilds(); track guild.id) {
          <mat-option [value]="guild.id" [attr.title]="guild.id">{{ label(guild) }}</mat-option>
        }
      </mat-select>
    </mat-form-field>
  `,
})
export class GuildSwitcher {
  readonly guilds = input.required<readonly GuildSummary[]>();
  readonly selectedId = input<string | null>(null);
  readonly picked = output<string>();

  protected label(guild: GuildSummary): string {
    return guildLabel(guild);
  }
}
