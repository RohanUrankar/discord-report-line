import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatFormField, MatLabel, MatError } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { Router } from '@angular/router';

import { AuthStore } from '../../core/auth/auth-store';
import { safeReturnUrl } from '../../core/auth/safe-return-url';
import { ROUTE } from '../../core/constants/routes.constants';
import { asAppError, type AppError } from '../../core/errors/app-error';
import { messageForCode, rateLimitedMessage } from '../../core/errors/error-messages';
import { AppIcon } from '../../shared/ui/icon';

const FIELD_LABELS: Record<string, string> = {
  email: 'Check the email address.',
  password: 'Enter your password.',
};

/** What the sign-in form shows for a failed attempt: the exact wait when rate limited, shared wording otherwise. */
export function signInErrorMessage(error: AppError): string {
  return error.code === 'RATE_LIMITED'
    ? rateLimitedMessage(error.retryAfterSeconds)
    : error.message;
}

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, MatButton, MatFormField, MatLabel, MatError, MatInput, AppIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
    }
    main {
      max-width: 420px;
      margin: 0 auto;
      padding: 48px 16px;
    }
    main:focus {
      outline: none;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .banner {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      padding: 12px;
      margin-bottom: 16px;
      border: 1px solid var(--mat-sys-error);
      border-radius: var(--mat-sys-corner-small);
      background: var(--mat-sys-surface-container);
    }
    .banner app-icon {
      color: var(--mat-sys-error);
    }
    .banner p {
      margin: 0 0 4px;
    }
    .banner button {
      margin-top: 8px;
    }
  `,
  template: `
    <main id="main" tabindex="-1">
      <h1 tabindex="-1">Sign in</h1>
      <p class="page-lead">Sign in to see what your Discord bot is doing.</p>

      @if (auth.status() === 'unavailable') {
        <div class="banner" role="alert">
          <app-icon name="cloud_off" />
          <div>
            <p>We can't reach the server right now, so we can't tell if you are signed in.</p>
            <button matButton="outlined" type="button" (click)="checkAgain()">
              <app-icon name="refresh" /> Try again
            </button>
          </div>
        </div>
      }

      @if (error(); as err) {
        <div class="banner" role="alert">
          <app-icon name="error" />
          <div>
            <p>{{ message() }}</p>
            @if (err.requestId) {
              <p class="reference">
                Reference: <code>{{ err.requestId }}</code>
              </p>
            }
          </div>
        </div>
      }

      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <mat-form-field appearance="outline">
          <mat-label>Email</mat-label>
          <input
            matInput
            type="email"
            formControlName="email"
            autocomplete="username"
            inputmode="email"
            autocapitalize="none"
            spellcheck="false"
          />
          @if (form.controls.email.hasError('required')) {
            <mat-error>Enter your email address.</mat-error>
          } @else if (form.controls.email.hasError('email')) {
            <mat-error>Enter an email address like name@example.com.</mat-error>
          } @else if (fieldFailed('email')) {
            <mat-error>{{ fieldText('email') }}</mat-error>
          }
        </mat-form-field>

        <mat-form-field appearance="outline">
          <mat-label>Password</mat-label>
          <input
            matInput
            type="password"
            formControlName="password"
            autocomplete="current-password"
          />
          @if (form.controls.password.hasError('required')) {
            <mat-error>Enter your password.</mat-error>
          } @else if (fieldFailed('password')) {
            <mat-error>{{ fieldText('password') }}</mat-error>
          }
        </mat-form-field>

        <button matButton="filled" type="submit" [disabled]="submitting()">
          {{ submitting() ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </main>
  `,
})
export class Login {
  protected readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Bound from `?returnUrl=`; validated before it is ever navigated to. */
  readonly returnUrl = input<string | undefined>();

  protected readonly submitting = signal(false);
  protected readonly error = signal<AppError | null>(null);

  protected readonly form = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
    password: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  protected message(): string {
    const err = this.error();
    return err === null ? '' : signInErrorMessage(err);
  }

  protected fieldFailed(name: string): boolean {
    const err = this.error();
    return err !== null && err.code === 'VALIDATION_FAILED' && err.fields.includes(name);
  }

  protected fieldText(name: string): string {
    return FIELD_LABELS[name] ?? 'Check this field.';
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) {
      return;
    }
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      this.focusFirstInvalid();
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    const { email, password } = this.form.getRawValue();
    try {
      await this.auth.login(email, password);
      await this.router.navigateByUrl(safeReturnUrl(this.returnUrl()) ?? ROUTE.home);
    } catch (error) {
      this.error.set(asAppError(error, messageForCode('INTERNAL')));
      this.form.controls.password.reset('');
      this.focusPassword();
    } finally {
      this.submitting.set(false);
    }
  }

  protected async checkAgain(): Promise<void> {
    await this.auth.restore();
    if (this.auth.isAuthenticated()) {
      await this.router.navigateByUrl(safeReturnUrl(this.returnUrl()) ?? ROUTE.home);
    }
  }

  private focusFirstInvalid(): void {
    this.host.nativeElement.querySelector<HTMLElement>('input.ng-invalid')?.focus();
  }

  private focusPassword(): void {
    this.host.nativeElement.querySelector<HTMLElement>('input[type="password"]')?.focus();
  }
}
