import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  untracked,
  viewChildren,
} from '@angular/core';
import type { CommandName } from '@report-line/shared';

import type { RuleUpdate } from '../../core/api/api-client';
import type { HasUnsavedChanges } from '../../core/forms/unsaved-changes.guard';
import { NotifyService } from '../../core/notify/notify.service';
import { ErrorPanel } from '../../shared/ui/error-panel';
import { LoadingBlock } from '../../shared/ui/loading-block';
import { PageHeader } from '../../shared/ui/page-header';
import { RuleEditor } from './rule-editor';
import { COMMAND_TITLES } from './rule-fields';
import { RulesStore } from './rules-store';

/** How each command behaves for this server. One card per command, saved on its own. */
@Component({
  selector: 'app-rules-page',
  imports: [ErrorPanel, LoadingBlock, PageHeader, RuleEditor],
  providers: [RulesStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .cards {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr));
      align-items: start;
    }
  `,
  template: `
    <div class="page">
      <app-page-header
        heading="Command rules"
        lead="Choose how each command behaves in this server. Each command is saved on its own."
      />

      @switch (store.status()) {
        @case ('error') {
          @if (store.error(); as error) {
            <app-error-panel [error]="error" (retry)="store.reload()" />
          }
        }
        @case ('loaded') {
          <div class="cards">
            @for (rule of store.items(); track rule.command) {
              <app-rule-editor
                [rule]="rule"
                [saving]="store.savingCommands().has(rule.command)"
                [error]="store.saveErrors()[rule.command] ?? null"
                (save)="saveRule(rule.command, $event)"
              />
            }
          </div>
        }
        @default {
          <app-loading-block label="Loading command rules" [lines]="4" />
        }
      }
    </div>
  `,
})
export class RulesPage implements HasUnsavedChanges {
  protected readonly store = inject(RulesStore);
  private readonly notify = inject(NotifyService);
  private readonly editors = viewChildren(RuleEditor);

  readonly guildId = input.required<string>();

  constructor() {
    effect(() => {
      const guildId = this.guildId();
      untracked(() => {
        void this.store.load(guildId);
      });
    });
  }

  hasUnsavedChanges(): boolean {
    return this.editors().some((editor) => editor.hasUnsavedChanges());
  }

  protected async saveRule(command: CommandName, update: RuleUpdate): Promise<void> {
    if (await this.store.save(command, update)) {
      this.notify.success(`Saved the ${COMMAND_TITLES[command].title} rule.`);
    }
  }
}
