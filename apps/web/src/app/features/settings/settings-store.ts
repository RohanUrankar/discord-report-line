import { Injectable, inject, signal } from '@angular/core';
import type { GuildSettings, UpdateGuildSettingsRequest } from '@report-line/shared';

import { ApiClient } from '../../core/api/api-client';
import { asAppError, type AppError } from '../../core/errors/app-error';
import { messageForCode } from '../../core/errors/error-messages';

export type SettingsStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * One server's settings. The webhook URL is write-only: it goes out in `save` and nothing here ever holds it.
 * The store only knows whether one is configured, which is all the API ever returns.
 */
@Injectable()
export class SettingsStore {
  private readonly api = inject(ApiClient);

  private readonly _settings = signal<GuildSettings | null>(null);
  private readonly _status = signal<SettingsStatus>('idle');
  private readonly _error = signal<AppError | null>(null);
  private readonly _saving = signal(false);
  private readonly _saveError = signal<AppError | null>(null);
  private generation = 0;
  private guildId: string | null = null;

  readonly settings = this._settings.asReadonly();
  readonly status = this._status.asReadonly();
  readonly error = this._error.asReadonly();
  readonly saving = this._saving.asReadonly();
  readonly saveError = this._saveError.asReadonly();

  async load(guildId: string): Promise<void> {
    const mine = ++this.generation;
    this.guildId = guildId;
    this._status.set('loading');
    this._error.set(null);
    this._saveError.set(null);
    try {
      const settings = await this.api.getSettings(guildId);
      if (mine !== this.generation) {
        return;
      }
      this._settings.set(settings);
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

  /** Resolves true when the server accepted the change. On failure the error is in `saveError` and nothing is lost. */
  async save(body: UpdateGuildSettingsRequest): Promise<boolean> {
    const guildId = this.guildId;
    if (guildId === null || this._saving()) {
      return false;
    }
    const mine = this.generation;
    this._saving.set(true);
    this._saveError.set(null);
    try {
      const settings = await this.api.updateSettings(guildId, body);
      if (mine === this.generation) {
        this._settings.set(settings);
      }
      return true;
    } catch (error) {
      if (mine === this.generation) {
        this._saveError.set(asAppError(error, messageForCode('INTERNAL')));
      }
      return false;
    } finally {
      this._saving.set(false);
    }
  }

  clearSaveError(): void {
    this._saveError.set(null);
  }
}
