import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { TestBed } from '@angular/core/testing';
import { MatSlideToggleHarness } from '@angular/material/slide-toggle/testing';
import { RULE_SCHEMAS, type RuleView } from '@report-line/shared';

import { query, queryAll, settle, textOf, type as typeInto } from '../../../testing/dom';
import { reportRule, statusRule } from '../../../testing/fixtures';
import type { RuleUpdate } from '../../core/api/api-client';
import { AppError } from '../../core/errors/app-error';
import { RuleEditor } from './rule-editor';
import { RULE_FIELDS } from './rule-fields';

function create(rule: RuleView, inputs: { saving?: boolean; error?: AppError | null } = {}) {
  const fixture = TestBed.createComponent(RuleEditor);
  fixture.componentRef.setInput('rule', rule);
  if (inputs.saving !== undefined) {
    fixture.componentRef.setInput('saving', inputs.saving);
  }
  if (inputs.error !== undefined) {
    fixture.componentRef.setInput('error', inputs.error);
  }
  const saved: RuleUpdate[] = [];
  fixture.componentInstance.save.subscribe((update) => saved.push(update));
  fixture.detectChanges();
  return { fixture, saved, loader: TestbedHarnessEnvironment.loader(fixture) };
}

const textarea = (f: ReturnType<typeof create>['fixture']): HTMLTextAreaElement =>
  query<HTMLTextAreaElement>(f, 'textarea')!;
const saveButton = (f: ReturnType<typeof create>['fixture']): HTMLButtonElement =>
  query<HTMLButtonElement>(f, 'button[type="submit"]')!;

describe('RULE_FIELDS', () => {
  it.each(['status', 'report'] as const)(
    'has a label for every editable key of the %s rule schema and nothing else',
    (command) => {
      const schemaKeys = Object.keys(RULE_SCHEMAS[command].shape)
        .filter((k) => k !== 'version')
        .sort();
      expect(Object.keys(RULE_FIELDS[command]).sort()).toEqual(schemaKeys);
    },
  );
});

describe('RuleEditor', () => {
  it('builds the form from the rule schema: /report has four settings, /status has one', async () => {
    const report = create(reportRule());
    await settle(report.fixture);
    report.fixture.detectChanges();
    expect(textOf(report.fixture)).toContain('/report');
    expect(textOf(report.fixture)).toContain('Using the built-in defaults');
    expect(await report.loader.getAllHarnesses(MatSlideToggleHarness)).toHaveLength(4); // enabled, ephemeral, mirror, tag
    expect(textarea(report.fixture).value).toBe('Report logged. The team has been notified.');

    const status = create(statusRule({ customised: true }));
    await settle(status.fixture);
    expect(await status.loader.getAllHarnesses(MatSlideToggleHarness)).toHaveLength(2); // enabled, ephemeral
    expect(queryAll(status.fixture, 'textarea')).toHaveLength(0);
    expect(textOf(status.fixture)).toContain('Customised for this server');
  });

  it('WHEN a setting is edited THE UI SHALL show the card as unsaved, and clear it when the edit is undone', async () => {
    const { fixture } = create(reportRule());
    await settle(fixture);
    expect(textOf(fixture)).not.toContain('Unsaved changes');
    typeInto(textarea(fixture), 'Thanks, we are on it.');
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('Unsaved changes');
    expect(fixture.componentInstance.hasUnsavedChanges()).toBe(true);
    typeInto(textarea(fixture), 'Report logged. The team has been notified.');
    fixture.detectChanges();
    expect(fixture.componentInstance.hasUnsavedChanges()).toBe(false);
  });

  it('WHEN saved THE UI SHALL send the whole rule: enabled plus a versioned config', async () => {
    const { fixture, saved, loader } = create(reportRule());
    await settle(fixture);
    typeInto(textarea(fixture), 'Thanks, we are on it.');
    const toggles = await loader.getAllHarnesses(MatSlideToggleHarness);
    const tag = (
      await Promise.all(toggles.map(async (t) => ({ t, label: await t.getLabelText() })))
    ).find((x) => x.label === 'Add an AI tag')!;
    await tag.t.check();
    saveButton(fixture).click();
    await settle(fixture);
    expect(saved).toEqual([
      {
        enabled: true,
        config: {
          version: 1,
          ephemeral: true,
          replyMessage: 'Thanks, we are on it.',
          mirror: true,
          tag: true,
        },
      },
    ]);
  });

  it('WHEN the command is switched off THE UI SHALL send enabled false', async () => {
    const { fixture, saved, loader } = create(statusRule());
    await settle(fixture);
    const enabled = await loader.getHarness(
      MatSlideToggleHarness.with({ label: 'Command enabled' }),
    );
    await enabled.uncheck();
    saveButton(fixture).click();
    await settle(fixture);
    expect(saved).toEqual([{ enabled: false, config: { version: 1, ephemeral: true } }]);
  });

  it('WHEN the reply is empty THE UI SHALL explain, focus it and NOT send', async () => {
    const { fixture, saved } = create(reportRule());
    await settle(fixture);
    typeInto(textarea(fixture), '   ');
    typeInto(textarea(fixture), '');
    saveButton(fixture).click();
    await settle(fixture);
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    expect(saved).toEqual([]);
    expect(textOf(fixture)).toContain('Write a reply of at least one character.');
    expect(document.activeElement).toBe(textarea(fixture));
  });

  it('WHEN the reply is longer than 300 characters THE UI SHALL say so and NOT send', async () => {
    const { fixture, saved } = create(reportRule());
    await settle(fixture);
    typeInto(textarea(fixture), 'x'.repeat(301));
    saveButton(fixture).click();
    await settle(fixture);
    fixture.detectChanges();
    expect(saved).toEqual([]);
    expect(textOf(fixture)).toContain('The reply is 301 characters. Keep it to 300 or fewer.');
  });

  it('WHEN the server rejects config.replyMessage THE UI SHALL put the error on that field and focus it, keeping the typed text', async () => {
    const { fixture } = create(reportRule());
    await settle(fixture);
    typeInto(textarea(fixture), 'my edit');
    fixture.componentRef.setInput(
      'error',
      new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Some fields need attention. Check them and try again.',
        status: 400,
        fields: ['config.replyMessage'],
        requestId: 'ref-8',
      }),
    );
    fixture.detectChanges();
    await settle(fixture);
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();

    expect(textOf(fixture)).toContain('Write a reply between 1 and 300 characters.');
    expect(textOf(fixture)).toContain('Some fields need attention');
    expect(textOf(fixture)).toContain('Reference: ref-8');
    expect(textarea(fixture).value).toBe('my edit');
    expect(document.activeElement).toBe(textarea(fixture));
    expect(textarea(fixture).getAttribute('aria-invalid')).toBe('true');
  });

  it('WHEN the server error is not about a field THE UI SHALL show it in the card and move focus there', async () => {
    const { fixture } = create(reportRule());
    await settle(fixture);
    fixture.componentRef.setInput(
      'error',
      new AppError({
        code: 'NETWORK',
        message: "We can't reach the server. Check your connection and try again.",
        status: 0,
      }),
    );
    fixture.detectChanges();
    await settle(fixture);
    await new Promise((resolve) => setTimeout(resolve));
    const summary = query(fixture, '[data-summary]')!;
    expect(textOf(summary)).toContain("can't reach the server");
    expect(document.activeElement).toBe(summary);
  });

  it('WHEN a save is running THE UI SHALL disable the button and say so', async () => {
    const { fixture } = create(reportRule(), { saving: true });
    await settle(fixture);
    expect(saveButton(fixture).disabled).toBe(true);
    expect(textOf(saveButton(fixture))).toBe('Saving…');
  });

  it('WHEN the server returns the saved rule THE UI SHALL take it as the new baseline', async () => {
    const { fixture } = create(reportRule());
    await settle(fixture);
    typeInto(textarea(fixture), 'Thanks, we are on it.');
    fixture.componentRef.setInput(
      'rule',
      reportRule({ customised: true, config: { replyMessage: 'Thanks, we are on it.' } }),
    );
    fixture.detectChanges();
    await settle(fixture);
    expect(fixture.componentInstance.hasUnsavedChanges()).toBe(false);
    expect(textOf(fixture)).toContain('Customised for this server');
  });
});
