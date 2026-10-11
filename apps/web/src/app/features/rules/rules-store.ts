import { Injectable, inject, signal } from '@angular/core';
import type { CommandName, RuleView } from '@report-line/shared';

import { ApiClient, type RuleUpdate } from '../../core/api/api-client';
import { asAppError, type AppError } from '../../core/errors/app-error';
import { messageForCode } from '../../core/errors/error-messages';

export type RulesStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** One server's command rules. Server state: saved rules come back from the API and replace what is held. */
@Injectable()
export class RulesStore {
  private readonly api = inject(ApiClient);

  private readonly _items = signal<readonly RuleView[]>([]);
  private readonly _status = signal<RulesStatus>('idle');
  private readonly _error = signal<AppError | null>(null);
  private readonly _saving = signal<ReadonlySet<CommandName>>(new Set());
  private readonly _saveErrors = signal<Readonly<Partial<Record<CommandName, AppError>>>>({});
  private generation = 0;
  private guildId: string | null = null;

  readonly items = this._items.asReadonly();
  readonly status = this._status.asReadonly();
  readonly error = this._error.asReadonly();
  readonly saveErrors = this._saveErrors.asReadonly();
  /** Commands with a save in flight. */
  readonly savingCommands = this._saving.asReadonly();

  async load(guildId: string): Promise<void> {
    const mine = ++this.generation;
    this.guildId = guildId;
    this._status.set('loading');
    this._error.set(null);
    this._saveErrors.set({});
    try {
      const list = await this.api.listRules(guildId);
      if (mine !== this.generation) {
        return;
      }
      this._items.set(list.items);
      this._status.set('loaded');
    } catch (error) {
      if (mine === this.generation) {
        this._error.set(asAppError(error, messageForCode('INTERNAL')));
        this._status.set('error');
      }
    }
  }

  async reload(): Promise<void> {
    if (this.guildId !== null) {
      await this.load(this.guildId);
    }
  }

  /** True when the server accepted it. On failure the form keeps its values and the error is in `saveErrors`. */
  async save(command: CommandName, body: RuleUpdate): Promise<boolean> {
    const guildId = this.guildId;
    if (guildId === null || this._saving().has(command)) {
      return false;
    }
    const mine = this.generation;
    this._saving.update((set) => new Set(set).add(command));
    this._saveErrors.update(({ [command]: _dropped, ...rest }) => rest);
    try {
      const saved = await this.api.updateRule(guildId, command, body);
      if (mine === this.generation) {
        this._items.update((items) =>
          items.map((rule) => (rule.command === command ? saved : rule)),
        );
      }
      return true;
    } catch (error) {
      if (mine === this.generation) {
        const problem = asAppError(error, messageForCode('INTERNAL'));
        this._saveErrors.update((errors) => ({ ...errors, [command]: problem }));
      }
      return false;
    } finally {
      this._saving.update((set) => {
        const next = new Set(set);
        next.delete(command);
        return next;
      });
    }
  }
}
