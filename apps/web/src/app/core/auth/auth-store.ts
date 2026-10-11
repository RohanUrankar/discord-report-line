import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { SessionInfo } from '@report-line/shared';

import { ApiClient } from '../api/api-client';
import { RETURN_URL_PARAM, ROUTE } from '../constants/routes.constants';
import { isUnauthenticated } from '../errors/app-error';
import { safeReturnUrl } from './safe-return-url';

/**
 * `unknown`: not asked yet. `unavailable`: asked, but the server could not be reached or failed, so we do
 * not know whether there is a session (the sign-in page says so and offers a retry).
 */
export type AuthStatus = 'unknown' | 'authenticated' | 'anonymous' | 'unavailable';

export interface AdminSummary {
  readonly id: string;
  readonly email: string;
}

/**
 * "Who am I" and nothing else. The session itself is an HttpOnly cookie the page cannot read; the CSRF token
 * is held in a private signal (memory only, never storage) and handed to the one interceptor that needs it.
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);

  private readonly _status = signal<AuthStatus>('unknown');
  private readonly _admin = signal<AdminSummary | null>(null);
  private readonly _csrf = signal<string | null>(null);
  private restoring: Promise<void> | null = null;

  readonly status = this._status.asReadonly();
  readonly admin = this._admin.asReadonly();
  readonly isAuthenticated = computed(() => this._status() === 'authenticated');

  csrfToken(): string | null {
    return this._csrf();
  }

  /** Ask the server who we are (page load). Calls made while one is in flight share it. */
  restore(): Promise<void> {
    this.restoring ??= this.runRestore().finally(() => {
      this.restoring = null;
    });
    return this.restoring;
  }

  /** Throws the AppError (wrong password, rate limit, offline) for the form to show. */
  async login(email: string, password: string): Promise<void> {
    this.accept(await this.api.login({ email, password }));
  }

  /** Throws if the server could not be reached: pretending to be signed out while the session lives on is worse. */
  async logout(): Promise<void> {
    try {
      await this.api.logout();
    } catch (error) {
      // A session that is already gone is the outcome we wanted.
      if (!isUnauthenticated(error)) {
        throw error;
      }
    }
    this.clear('anonymous');
    await this.router.navigate([ROUTE.login]);
  }

  /** A call came back 401: the session is gone. Forget it and go to sign-in, remembering where we were. */
  expire(): void {
    if (this._status() === 'anonymous') {
      return;
    }
    this.clear('anonymous');
    const returnUrl = safeReturnUrl(this.router.url);
    void this.router.navigate([ROUTE.login], {
      queryParams: returnUrl === null ? {} : { [RETURN_URL_PARAM]: returnUrl },
    });
  }

  private async runRestore(): Promise<void> {
    try {
      this.accept(await this.api.me());
    } catch (error) {
      this.clear(isUnauthenticated(error) ? 'anonymous' : 'unavailable');
    }
  }

  private accept(session: SessionInfo): void {
    this._admin.set({ id: session.admin.id, email: session.admin.email });
    this._csrf.set(session.csrfToken);
    this._status.set('authenticated');
  }

  private clear(status: AuthStatus): void {
    this._admin.set(null);
    this._csrf.set(null);
    this._status.set(status);
  }
}
