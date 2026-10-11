import { ChangeDetectionStrategy, Component, ElementRef, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatError, MatFormField, MatHint, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { Router } from '@angular/router';

import { ApiClient } from '../../core/api/api-client';
import { SNOWFLAKE_PATTERN } from '../../core/constants/app.constants';
import { logPath } from '../../core/constants/routes.constants';
import { asAppError, type AppError } from '../../core/errors/app-error';
import { messageForCode } from '../../core/errors/error-messages';
import { GuildsStore } from '../../core/guilds/guilds-store';
import { CONNECT_NOT_FOUND_MESSAGE } from '../../core/messages/copy';
import { NotifyService } from '../../core/notify/notify.service';
import { AppIcon } from '../../shared/ui/icon';
import { PageHeader } from '../../shared/ui/page-header';

/** Wording for a failed connect: a missing or foreign server gets the one generic answer. */
export function connectErrorMessage(error: AppError): string {
  return error.code === 'NOT_FOUND' ? CONNECT_NOT_FOUND_MESSAGE : error.message;
}

@Component({
  selector: 'app-connect-server',
  imports: [
    ReactiveFormsModule,
    MatButton,
    MatFormField,
    MatLabel,
    MatError,
    MatHint,
    MatInput,
    AppIcon,
    PageHeader,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .narrow {
      max-width: 560px;
    }
    ol {
      padding-left: 20px;
      margin: 0 0 20px;
    }
    li {
      margin-bottom: 6px;
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
  `,
  template: `
    <div class="page narrow">
      <app-page-header
        heading="Connect a server"
        [lead]="
          isFirstRun()
            ? 'You have not connected a server yet. Connect one to see its commands here.'
            : 'Connect another Discord server to manage it from this dashboard.'
        "
      />

      <ol>
        <li>Add the bot to your Discord server.</li>
        <li>
          In Discord, turn on Developer Mode (User Settings, Advanced), then right-click your
          server's icon and choose Copy Server ID.
        </li>
        <li>
          Paste the id below. If the bot has not answered a command there yet, run
          <code>/status</code> once first.
        </li>
      </ol>

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
          <mat-label>Server id</mat-label>
          <input
            matInput
            formControlName="guildId"
            inputmode="numeric"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="guild-id-hint"
          />
          <mat-hint id="guild-id-hint">17 to 20 digits</mat-hint>
          @if (form.controls.guildId.hasError('required')) {
            <mat-error>Enter the server id.</mat-error>
          } @else if (form.controls.guildId.hasError('pattern')) {
            <mat-error>A server id is 17 to 20 digits, with no spaces or letters.</mat-error>
          }
        </mat-form-field>
        <div>
          <button matButton="filled" type="submit" [disabled]="submitting()">
            {{ submitting() ? 'Connecting…' : 'Connect server' }}
          </button>
        </div>
      </form>
    </div>
  `,
})
export class ConnectServer {
  private readonly api = inject(ApiClient);
  private readonly guilds = inject(GuildsStore);
  private readonly router = inject(Router);
  private readonly notify = inject(NotifyService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly submitting = signal(false);
  protected readonly error = signal<AppError | null>(null);

  protected readonly form = new FormGroup({
    guildId: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(SNOWFLAKE_PATTERN)],
    }),
  });

  protected isFirstRun(): boolean {
    return this.guilds.isEmpty();
  }

  protected message(): string {
    const err = this.error();
    return err === null ? '' : connectErrorMessage(err);
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) {
      return;
    }
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      this.host.nativeElement.querySelector<HTMLElement>('input.ng-invalid')?.focus();
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    try {
      const guild = await this.api.connectGuild(this.form.controls.guildId.value.trim());
      this.guilds.add(guild);
      this.notify.success('Server connected.');
      await this.router.navigateByUrl(logPath(guild.id));
    } catch (error) {
      this.error.set(asAppError(error, messageForCode('INTERNAL')));
      this.host.nativeElement.querySelector<HTMLElement>('input')?.focus();
    } finally {
      this.submitting.set(false);
    }
  }
}
