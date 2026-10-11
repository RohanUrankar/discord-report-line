import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  FormRecord,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatError, MatFormField, MatHint, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { RULE_SCHEMAS, type CommandName, type RuleView } from '@report-line/shared';
import { map, startWith } from 'rxjs';

import type { RuleUpdate } from '../../core/api/api-client';
import { REPLY_MESSAGE_MAX } from '../../core/constants/app.constants';
import type { AppError } from '../../core/errors/app-error';
import { AppIcon } from '../../shared/ui/icon';
import {
  COMMAND_TITLES,
  DEFAULT_FIELD_SERVER_TEXT,
  FIELD_SERVER_TEXT,
  RULE_FIELDS,
  type FieldSpec,
} from './rule-fields';

type ConfigValue = boolean | string;
type ConfigControl = FormControl<ConfigValue>;

interface FieldVm {
  readonly key: string;
  readonly spec: FieldSpec;
  readonly control: ConfigControl;
  readonly hintId: string;
}

interface RuleValues {
  readonly enabled: boolean;
  readonly config: Readonly<Record<string, ConfigValue>>;
}

const CONFIG_PREFIX = 'config.';

/** The editable part of a stored rule: everything except `version`, which the editor does not own. */
function valuesOf(rule: RuleView): RuleValues {
  const { version: _version, ...editable } = rule.config;
  return { enabled: rule.enabled, config: editable };
}

/** Key order does not matter: a form and a schema may list the same settings differently. */
function sameValues(a: RuleValues, b: RuleValues): boolean {
  const keys = new Set([...Object.keys(a.config), ...Object.keys(b.config)]);
  return a.enabled === b.enabled && [...keys].every((key) => a.config[key] === b.config[key]);
}

/**
 * One card per command: the enabled switch and one control per setting in the command's rule schema (see
 * rule-fields.ts, which the compiler holds to the shared schemas). Emits the whole rule on save; the server
 * validates again and reports problems as `config.<field>`, which land on that field.
 */
@Component({
  selector: 'app-rule-editor',
  imports: [
    ReactiveFormsModule,
    MatButton,
    MatError,
    MatFormField,
    MatHint,
    MatInput,
    MatLabel,
    MatSlideToggle,
    AppIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
    }
    section {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-medium);
      padding: 16px;
      background: var(--mat-sys-surface-container-low);
    }
    header {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      align-items: baseline;
    }
    h2 {
      margin: 0;
    }
    .origin {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
    .desc {
      color: var(--mat-sys-on-surface-variant);
      margin: 4px 0 12px;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .hint {
      margin: 2px 0 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      align-items: center;
    }
    .dirty {
      color: var(--mat-sys-on-surface-variant);
    }
    .problem {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      padding: 12px;
      margin-bottom: 12px;
      border: 1px solid var(--mat-sys-error);
      border-radius: var(--mat-sys-corner-small);
      background: var(--mat-sys-surface-container);
    }
    .problem app-icon {
      color: var(--mat-sys-error);
    }
    .problem p {
      margin: 0 0 4px;
    }
  `,
  template: `
    <section [attr.aria-labelledby]="titleId()">
      <header>
        <h2 [id]="titleId()">{{ title().title }}</h2>
        <span class="origin">
          {{ rule().customised ? 'Customised for this server' : 'Using the built-in defaults' }}
        </span>
      </header>
      <p class="desc">{{ title().description }}</p>

      @if (error(); as problem) {
        <div class="problem" role="alert" tabindex="-1" data-summary>
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

      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <mat-slide-toggle formControlName="enabled" data-field="enabled">
          Command enabled
        </mat-slide-toggle>

        @for (f of fields(); track f.key) {
          @if (f.spec.kind === 'toggle') {
            <div>
              <mat-slide-toggle
                [formControl]="f.control"
                [attr.data-field]="f.key"
                [attr.aria-describedby]="f.hintId"
              >
                {{ f.spec.label }}
              </mat-slide-toggle>
              <p class="hint" [id]="f.hintId">{{ f.spec.hint }}</p>
              @if (f.control.hasError('server')) {
                <p class="hint" role="alert">{{ serverText(f.key) }}</p>
              }
            </div>
          } @else {
            <mat-form-field appearance="outline">
              <mat-label>{{ f.spec.label }}</mat-label>
              <textarea
                matInput
                rows="3"
                [formControl]="f.control"
                [attr.data-field]="f.key"
                [attr.aria-describedby]="f.hintId"
              ></textarea>
              <mat-hint [id]="f.hintId">{{ f.spec.hint }}</mat-hint>
              <mat-hint align="end">{{ textLength(f.key) }} / {{ replyMax }}</mat-hint>
              @if (f.control.hasError('required')) {
                <mat-error>Write a reply of at least one character.</mat-error>
              } @else if (f.control.hasError('maxlength')) {
                <mat-error>
                  The reply is {{ textLength(f.key) }} characters. Keep it to {{ replyMax }} or
                  fewer.
                </mat-error>
              } @else if (f.control.hasError('server')) {
                <mat-error>{{ serverText(f.key) }}</mat-error>
              }
            </mat-form-field>
          }
        }

        <div class="actions">
          <button matButton="filled" type="submit" [disabled]="saving()">
            {{ saving() ? 'Saving…' : 'Save ' + title().title }}
          </button>
          @if (dirty()) {
            <span class="dirty">Unsaved changes</span>
          }
        </div>
      </form>
    </section>
  `,
})
export class RuleEditor {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly rule = input.required<RuleView>();
  readonly saving = input(false);
  /** The failure of the last save of this rule, if any. */
  readonly error = input<AppError | null>(null);
  readonly save = output<RuleUpdate>();

  protected readonly replyMax = REPLY_MESSAGE_MAX;
  protected readonly form = new FormGroup({
    enabled: new FormControl(true, { nonNullable: true }),
    config: new FormRecord<ConfigControl>({}),
  });
  protected readonly fields = signal<readonly FieldVm[]>([]);

  protected readonly title = computed(() => COMMAND_TITLES[this.rule().command]);
  protected readonly titleId = computed(() => `rule-${this.rule().command}-title`);

  private readonly formValue = toSignal(
    this.form.valueChanges.pipe(
      startWith(null),
      map((): RuleValues => ({
        enabled: this.form.controls.enabled.value,
        config: this.form.controls.config.getRawValue(),
      })),
    ),
    { requireSync: true },
  );

  /** Unsaved edits compared with what the server last gave us. */
  readonly dirty = computed(() => !sameValues(this.formValue(), valuesOf(this.rule())));

  constructor() {
    effect(() => {
      const rule = this.rule();
      untracked(() => {
        this.load(rule);
      });
    });
    effect(() => {
      const problem = this.error();
      untracked(() => {
        if (problem !== null) {
          this.showServerError(problem);
        }
      });
    });
  }

  hasUnsavedChanges(): boolean {
    return this.dirty();
  }

  protected textLength(key: string): number {
    const value = this.form.controls.config.controls[key]?.value;
    return typeof value === 'string' ? value.length : 0;
  }

  protected serverText(key: string): string {
    return FIELD_SERVER_TEXT[key] ?? DEFAULT_FIELD_SERVER_TEXT;
  }

  protected submit(): void {
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      this.focusField(this.firstInvalidKey());
      return;
    }
    const config: Record<string, ConfigValue> = this.form.controls.config.getRawValue();
    const command = this.rule().command;
    const checked = this.checkAgainstSchema(command, { version: 1, ...config });
    if (!checked) {
      return;
    }
    this.save.emit({
      enabled: this.form.controls.enabled.value,
      config: { version: 1, ...config },
    });
  }

  /** UX-only: the same schema the server uses, so an impossible rule never leaves the browser. */
  private checkAgainstSchema(command: CommandName, config: unknown): boolean {
    const result = RULE_SCHEMAS[command].safeParse(config);
    if (result.success) {
      return true;
    }
    for (const issue of result.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string') {
        this.form.controls.config.controls[key]?.setErrors({ server: true });
      }
    }
    this.focusField(this.firstInvalidKey());
    return false;
  }

  private load(rule: RuleView): void {
    const specs = RULE_FIELDS[rule.command] as Readonly<Record<string, FieldSpec>>;
    const values = valuesOf(rule);
    const group = this.form.controls.config;
    for (const key of Object.keys(group.controls)) {
      if (!(key in specs)) {
        group.removeControl(key, { emitEvent: false });
      }
    }
    const vms: FieldVm[] = [];
    for (const [key, spec] of Object.entries(specs)) {
      const value = values.config[key] ?? (spec.kind === 'toggle' ? false : '');
      let control = group.controls[key];
      if (control === undefined) {
        control = new FormControl<ConfigValue>(value, {
          nonNullable: true,
          validators:
            spec.kind === 'text'
              ? [Validators.required, Validators.maxLength(REPLY_MESSAGE_MAX)]
              : [],
        });
        group.addControl(key, control, { emitEvent: false });
      }
      vms.push({ key, spec, control, hintId: `rule-${rule.command}-${key}-hint` });
    }
    this.form.reset({ enabled: values.enabled, config: values.config });
    this.fields.set(vms);
  }

  private showServerError(problem: AppError): void {
    if (problem.code !== 'VALIDATION_FAILED') {
      this.focusSummary();
      return;
    }
    let first: string | null = null;
    for (const path of problem.fields) {
      if (!path.startsWith(CONFIG_PREFIX)) {
        continue;
      }
      const key = path.slice(CONFIG_PREFIX.length);
      const control = this.form.controls.config.controls[key];
      if (control !== undefined) {
        control.setErrors({ server: true });
        control.markAsTouched();
        first ??= key;
      }
    }
    if (first === null) {
      this.focusSummary();
    } else {
      this.focusField(first);
    }
  }

  private firstInvalidKey(): string | null {
    const entry = Object.entries(this.form.controls.config.controls).find(([, c]) => c.invalid);
    return entry === undefined ? null : entry[0];
  }

  private focusField(key: string | null): void {
    if (key === null) {
      return;
    }
    setTimeout(() => {
      const target = this.host.nativeElement.querySelector<HTMLElement>(`[data-field="${key}"]`);
      (target?.tagName === 'MAT-SLIDE-TOGGLE' ? target.querySelector('button') : target)?.focus();
    });
  }

  private focusSummary(): void {
    setTimeout(() => {
      this.host.nativeElement.querySelector<HTMLElement>('[data-summary]')?.focus();
    });
  }
}
