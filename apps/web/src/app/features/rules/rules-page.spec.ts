import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { query, queryAll, root, settle, textOf, type as typeInto } from '../../../testing/dom';
import { GUILD_A, reportRule, statusRule } from '../../../testing/fixtures';
import { ApiClient } from '../../core/api/api-client';
import { AppError } from '../../core/errors/app-error';
import { RulesPage } from './rules-page';

const listRules = vi.fn();
const updateRule = vi.fn();

function configure(): void {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideRouter(
        [{ path: 'g/:guildId/rules', component: RulesPage }],
        withComponentInputBinding(),
        withRouterConfig({ paramsInheritanceStrategy: 'always' }),
      ),
      { provide: ApiClient, useValue: { listRules, updateRule } },
    ],
  });
}

const open = async (): Promise<RouterTestingHarness> => {
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/g/${GUILD_A}/rules`);
  await settle(harness.fixture);
  harness.fixture.detectChanges();
  return harness;
};

describe('RulesPage', () => {
  beforeEach(() => {
    listRules.mockReset();
    updateRule.mockReset();
    configure();
  });

  it('shows a loading state first', async () => {
    listRules.mockReturnValue(new Promise(() => undefined));
    const harness = await open();
    expect(textOf(harness.fixture)).toContain('Loading command rules');
  });

  it('WHEN the rules cannot be loaded THE UI SHALL show the error and a retry that loads them again', async () => {
    listRules.mockRejectedValueOnce(
      new AppError({
        code: 'INTERNAL',
        message: 'Something went wrong on our side. Please try again.',
        status: 500,
        requestId: 'ref-2',
      }),
    );
    const harness = await open();
    const alert = root(harness.fixture).querySelector('[role="alert"]') as HTMLElement;
    expect(textOf(alert)).toContain('Reference: ref-2');
    listRules.mockResolvedValue({ items: [statusRule(), reportRule()] });
    (alert.querySelector('button') as HTMLButtonElement).click();
    await settle(harness.fixture);
    harness.fixture.detectChanges();
    expect(queryAll(harness.fixture, 'app-rule-editor')).toHaveLength(2);
  });

  it('does not claim saved rules are unapplied: the bot reads them on every command (Step 5)', async () => {
    listRules.mockResolvedValue({ items: [statusRule(), reportRule()] });
    const harness = await open();
    expect(query(harness.fixture, '[role="note"]')).toBeNull();
    expect(textOf(root(harness.fixture))).not.toMatch(/not yet applied/i);
  });

  it('WHEN a rule is saved THE UI SHALL send that command only, then show the saved rule as customised', async () => {
    listRules.mockResolvedValue({ items: [statusRule(), reportRule()] });
    updateRule.mockResolvedValue(
      reportRule({ customised: true, config: { replyMessage: 'On it.' } }),
    );
    const harness = await open();
    const report = queryAll(harness.fixture, 'app-rule-editor')[1]!;
    typeInto(report.querySelector('textarea')!, 'On it.');
    (report.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await settle(harness.fixture);
    harness.fixture.detectChanges();

    expect(updateRule).toHaveBeenCalledTimes(1);
    expect(updateRule).toHaveBeenCalledWith(GUILD_A, 'report', {
      enabled: true,
      config: { version: 1, ephemeral: true, replyMessage: 'On it.', mirror: true, tag: false },
    });
    expect(textOf(queryAll(harness.fixture, 'app-rule-editor')[1])).toContain(
      'Customised for this server',
    );
    expect(textOf(queryAll(harness.fixture, 'app-rule-editor')[0])).toContain(
      'Using the built-in defaults',
    );
  });

  it('WHEN the server answers with field paths THE UI SHALL show them on that card only and keep the edit', async () => {
    listRules.mockResolvedValue({ items: [statusRule(), reportRule()] });
    updateRule.mockRejectedValue(
      new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Some fields need attention. Check them and try again.',
        status: 400,
        fields: ['config.replyMessage'],
      }),
    );
    const harness = await open();
    const [status, report] = queryAll(harness.fixture, 'app-rule-editor') as [
      HTMLElement,
      HTMLElement,
    ];
    typeInto(report.querySelector('textarea')!, 'my edit');
    (report.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await settle(harness.fixture);
    await new Promise((resolve) => setTimeout(resolve));
    harness.fixture.detectChanges();

    expect(textOf(report)).toContain('Write a reply between 1 and 300 characters.');
    expect(report.querySelector('textarea')!.value).toBe('my edit');
    expect(textOf(status)).not.toContain('Some fields need attention');
  });

  it('reports unsaved edits on any card so leaving can be confirmed', async () => {
    listRules.mockResolvedValue({ items: [statusRule(), reportRule()] });
    const harness = await open();
    const page = harness.routeDebugElement!.componentInstance as RulesPage;
    expect(page.hasUnsavedChanges()).toBe(false);
    typeInto(queryAll<HTMLTextAreaElement>(harness.fixture, 'textarea')[0]!, 'changed');
    expect(page.hasUnsavedChanges()).toBe(true);
  });
});
