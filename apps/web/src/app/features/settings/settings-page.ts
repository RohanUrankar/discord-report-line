import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatError, MatFormField, MatHint, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import type { UpdateGuildSettingsRequest } from '@report-line/shared';
import { firstValueFrom, map, startWith } from 'rxjs';

import { OPTIONAL_SNOWFLAKE_PATTERN } from '../../core/constants/app.constants';
import type { HasUnsavedChanges } from '../../core/forms/unsaved-changes.guard';
import {
  SLACK_CONFIGURED_LABEL,
  SLACK_NOT_CONFIGURED_LABEL,
  WEBHOOK_WRITE_ONLY_HINT,
} from '../../core/messages/copy';
import { NotifyService } from '../../core/notify/notify.service';
import { ConfirmDialog, type ConfirmDialogData } from '../../shared/ui/confirm-dialog';
import { ErrorPanel } from '../../shared/ui/error-panel';
import { AppIcon } from '../../shared/ui/icon';
import { LoadingBlock } from '../../shared/ui/loading-block';
import { PageHeader } from '../../shared/ui/page-header';
import { SettingsStore } from './settings-store';

const WEBHOOK_PREFIX = 'https://';

const REMOVE_WEBHOOK_DIALOG: ConfirmDialogData = {
  title: 'Remove the Slack webhook?',
  message:
    'New reports will no longer be sent to Slack until you add a webhook again. Commands keep working in Discord.',
  confirmLabel: 'Remove webhook',
};

/** Inline wording for a field the server rejected (by path); how to fix it, not a status code. */
const SERVER_FIELD_TEXT: Readonly<Record<string, string>> = {
  postChannelId:
    'The channel id should be 17 to 20 digits. Copy it from Discord and paste it again.',
  mirrorWebhookUrl: 'That webhook address was rejected. Check it and paste it again.',
};

/** Where reports go: the Discord channel the bot falls back to, and the Slack webhook (write-only). */
@Component({
  selector: 'app-settings-page',
  imports: [
    ReactiveFormsModule,
    MatButton,
    MatError,
    MatFormField,
    MatHint,
    MatInput,
    MatLabel,
    AppIcon,
    ErrorPanel,
    LoadingBlock,
    PageHeader,
  ],
  providers: [SettingsStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .narrow {
      max-width: 640px;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    mat-form-field {
      width: 100%;
    }
    fieldset {
      display: flex;
      flex-direction: column;
      gap: 4px;
      border: 0;
      padding: 0;
      margin: 0 0 16px;
      min-width: 0;
    }
    legend {
      font: var(--mat-sys-title-medium);
      padding: 0;
      margin-bottom: 8px;
    }
    .state {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 12px;
      font-weight: 600;
    }
    .state.on app-icon {
      color: var(--mat-sys-primary);
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
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
  `,
  template: `
    <div class="page narrow">
      <app-page-header
        heading="Settings"
        lead="Choose where the bot posts when it can no longer edit its original reply, and where reports are sent in Slack."
      />

      @switch (store.status()) {
        @case ('error') {
          @if (store.error(); as error) {
            <app-error-panel [error]="error" (retry)="store.reload()" />
          }
        }
        @case ('loaded') {
          @if (store.saveError(); as problem) {
            <div class="banner" role="alert" tabindex="-1" #summary>
              <app-icon name="error" />
              <div>
                <p>{{ problem.message }}</p>
                @if (problem.requestId) {
                  <p class="reference">
                    Reference: <code>{{ problem.requestId }}</code>
                  </p>
                }
              </div>
            </div>
          }

          <form [formGroup]="form" (ngSubmit)="save()" novalidate>
            <fieldset>
              <legend>Discord</legend>
              <mat-form-field appearance="outline">
                <mat-label>Post channel id</mat-label>
                <input
                  matInput
                  formControlName="postChannelId"
                  inputmode="numeric"
                  autocomplete="off"
                  spellcheck="false"
                  aria-describedby="channel-hint"
                />
                <mat-hint id="channel-hint">
                  In Discord, right-click the channel and choose Copy Channel ID.
                </mat-hint>
                @if (form.controls.postChannelId.hasError('pattern')) {
                  <mat-error>A channel id is 17 to 20 digits, with no spaces or letters.</mat-error>
                } @else if (form.controls.postChannelId.hasError('server')) {
                  <mat-error>{{ serverText('postChannelId') }}</mat-error>
                }
              </mat-form-field>
            </fieldset>

            <fieldset>
              <legend>Slack</legend>
              <p class="state" [class.on]="store.settings()?.mirrorConfigured === true">
                @if (store.settings()?.mirrorConfigured === true) {
                  <app-icon name="check_circle" />
                } @else {
                  <app-icon name="notifications_off" />
                }
                <span>{{ slackState() }}</span>
              </p>
              <mat-form-field appearance="outline">
                <mat-label>
                  {{
                    store.settings()?.mirrorConfigured === true
                      ? 'Replace Slack webhook address'
                      : 'Slack webhook address'
                  }}
                </mat-label>
                <input
                  matInput
                  type="password"
                  formControlName="mirrorWebhookUrl"
                  autocomplete="new-password"
                  autocapitalize="none"
                  spellcheck="false"
                  aria-describedby="webhook-hint"
                />
                <mat-hint id="webhook-hint">{{ webhookHint }}</mat-hint>
                @if (form.controls.mirrorWebhookUrl.hasError('prefix')) {
                  <mat-error>Enter an address that starts with https://</mat-error>
                } @else if (form.controls.mirrorWebhookUrl.hasError('server')) {
                  <mat-error>{{ serverText('mirrorWebhookUrl') }}</mat-error>
                }
              </mat-form-field>
              @if (store.settings()?.mirrorConfigured === true) {
                <div>
                  <button
                    matButton
                    type="button"
                    (click)="removeWebhook()"
                    [disabled]="store.saving()"
                  >
                    Remove webhook
                  </button>
                </div>
              }
            </fieldset>

            <div class="actions">
              <button matButton="filled" type="submit" [disabled]="store.saving()">
                {{ store.saving() ? 'Saving…' : 'Save settings' }}
              </button>
              @if (dirty()) {
                <span class="muted">You have changes that are not saved.</span>
              }
            </div>
          </form>
        }
        @default {
          <app-loading-block label="Loading settings" [lines]="4" />
        }
      }
    </div>
  `,
})
export class SettingsPage implements HasUnsavedChanges {
  protected readonly store = inject(SettingsStore);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(NotifyService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  readonly guildId = input.required<string>();

  protected readonly webhookHint = WEBHOOK_WRITE_ONLY_HINT;

  protected readonly form = new FormGroup({
    postChannelId: new FormControl('', {
      nonNullable: true,
      validators: [Validators.pattern(OPTIONAL_SNOWFLAKE_PATTERN)],
    }),
    mirrorWebhookUrl: new FormControl('', {
      nonNullable: true,
      validators: [
        (control) =>
          control.value === '' || String(control.value).trim().startsWith(WEBHOOK_PREFIX)
            ? null
            : { prefix: true },
      ],
    }),
  });

  protected readonly slackState = computed(() =>
    this.store.settings()?.mirrorConfigured === true
      ? SLACK_CONFIGURED_LABEL
      : SLACK_NOT_CONFIGURED_LABEL,
  );

  private readonly formValue = toSignal(
    this.form.valueChanges.pipe(
      map(() => this.form.getRawValue()),
      startWith(this.form.getRawValue()),
    ),
    { initialValue: this.form.getRawValue() },
  );

  protected readonly dirty = computed(() => {
    const value = this.formValue();
    const saved = this.store.settings()?.postChannelId ?? '';
    return value.postChannelId.trim() !== saved || value.mirrorWebhookUrl.trim() !== '';
  });

  constructor() {
    effect(() => {
      const guildId = this.guildId();
      untracked(() => {
        void this.store.load(guildId);
      });
    });
    // A fresh load (or a successful save) is the new baseline for the channel field. The webhook field
    // is never filled from anything: it only ever holds what was just typed.
    effect(() => {
      const settings = this.store.settings();
      untracked(() => {
        this.form.controls.postChannelId.setValue(settings?.postChannelId ?? '', {
          emitEvent: true,
        });
        this.form.markAsPristine();
      });
    });
    // Editing after a failed save: the validators re-run and drop the field errors by themselves;
    // the banner above the form should go too.
    this.form.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.store.clearSaveError();
    });
  }

  hasUnsavedChanges(): boolean {
    return this.store.status() === 'loaded' && this.dirty();
  }

  protected serverText(path: string): string {
    return SERVER_FIELD_TEXT[path] ?? 'Check this field.';
  }

  protected async save(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      this.focusFirstInvalid();
      return;
    }
    const body = this.buildRequest();
    if (body === null) {
      this.notify.success('Nothing to save: no changes.');
      return;
    }
    await this.submit(body, 'Settings saved.');
  }

  protected async removeWebhook(): Promise<void> {
    const dialog = this.dialog.open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
      data: REMOVE_WEBHOOK_DIALOG,
    });
    if ((await firstValueFrom(dialog.afterClosed())) === true) {
      await this.submit({ mirrorWebhookUrl: null }, 'Slack webhook removed.');
    }
  }

  /** Only what changed goes out (a key left out is left alone). The webhook is sent only when typed. */
  private buildRequest(): UpdateGuildSettingsRequest | null {
    const value = this.form.getRawValue();
    const saved = this.store.settings()?.postChannelId ?? '';
    const channel = value.postChannelId.trim();
    const webhook = value.mirrorWebhookUrl.trim();
    const body: UpdateGuildSettingsRequest = {};
    if (channel !== saved) {
      body.postChannelId = channel === '' ? null : channel;
    }
    if (webhook !== '') {
      body.mirrorWebhookUrl = webhook;
    }
    return Object.keys(body).length === 0 ? null : body;
  }

  private async submit(body: UpdateGuildSettingsRequest, success: string): Promise<void> {
    const ok = await this.store.save(body);
    if (ok) {
      // Never keep the secret around once it has been sent.
      this.form.controls.mirrorWebhookUrl.reset('');
      this.form.markAsPristine();
      this.notify.success(success);
      return;
    }
    this.applyServerErrors();
  }

  private applyServerErrors(): void {
    const problem = this.store.saveError();
    if (problem?.code === 'VALIDATION_FAILED') {
      for (const [path, control] of Object.entries(this.form.controls)) {
        if (problem.fields.includes(path)) {
          control.setErrors({ server: true });
          control.markAsTouched();
        }
      }
    }
    // Wait one task so the banner and the field errors are in the page before focus moves.
    setTimeout(() => {
      const root = this.host.nativeElement;
      (
        root.querySelector<HTMLElement>('input.ng-invalid') ??
        root.querySelector<HTMLElement>('[role="alert"]')
      )?.focus();
    });
  }

  private focusFirstInvalid(): void {
    // Decided from the form model, not from CSS classes: the classes only update on the next render.
    const first = Object.entries(this.form.controls).find(([, control]) => control.invalid);
    if (first !== undefined) {
      this.host.nativeElement
        .querySelector<HTMLElement>(`[formcontrolname="${first[0]}"]`)
        ?.focus();
    }
  }
}
