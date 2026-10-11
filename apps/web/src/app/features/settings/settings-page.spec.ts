import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { query, queryAll, root, settle, textOf, type as typeInto } from '../../../testing/dom';
import { GUILD_A, settings } from '../../../testing/fixtures';
import { ApiClient } from '../../core/api/api-client';
import { AppError } from '../../core/errors/app-error';
import { SettingsPage } from './settings-page';

const getSettings = vi.fn();
const updateSettings = vi.fn();

const WEBHOOK = 'https://hooks.example.test/services/T000/B000/not-a-real-secret';
const CHANNEL = '555555555555555555';

function configure(): void {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideRouter(
        [{ path: 'g/:guildId/settings', component: SettingsPage }],
        withComponentInputBinding(),
        withRouterConfig({ paramsInheritanceStrategy: 'always' }),
      ),
      { provide: ApiClient, useValue: { getSettings, updateSettings } },
    ],
  });
}

const open = async (): Promise<RouterTestingHarness> => {
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/g/${GUILD_A}/settings`);
  await settle(harness.fixture);
  harness.fixture.detectChanges();
  return harness;
};

const input = (h: RouterTestingHarness, selector: string): HTMLInputElement =>
  query<HTMLInputElement>(h.fixture, selector)!;
const channel = (h: RouterTestingHarness): HTMLInputElement =>
  queryAll<HTMLInputElement>(h.fixture, 'input')[0]!;
const webhook = (h: RouterTestingHarness): HTMLInputElement => input(h, 'input[type="password"]');
const submit = async (h: RouterTestingHarness): Promise<void> => {
  query<HTMLButtonElement>(h.fixture, 'button[type="submit"]')!.click();
  await settle(h.fixture);
  h.fixture.detectChanges();
};

describe('SettingsPage', () => {
  beforeEach(() => {
    getSettings.mockReset();
    updateSettings.mockReset();
    configure();
  });

  it('shows a loading state, then the form', async () => {
    getSettings.mockReturnValue(new Promise(() => undefined));
    const harness = await open();
    expect(textOf(harness.fixture)).toContain('Loading settings');
  });

  it('WHEN settings cannot be loaded THE UI SHALL show the error and a retry that loads them again', async () => {
    getSettings.mockRejectedValueOnce(
      new AppError({
        code: 'NETWORK',
        message: "We can't reach the server. Check your connection and try again.",
        status: 0,
      }),
    );
    const harness = await open();
    const alert = root(harness.fixture).querySelector('[role="alert"]') as HTMLElement;
    expect(textOf(alert)).toContain("can't reach the server");
    getSettings.mockResolvedValue(settings());
    (alert.querySelector('button') as HTMLButtonElement).click();
    await settle(harness.fixture);
    harness.fixture.detectChanges();
    expect(textOf(harness.fixture)).toContain('Slack notifications: not configured');
  });

  it('WHEN a webhook is configured THE UI SHALL say so and never show or prefill it', async () => {
    getSettings.mockResolvedValue(settings({ postChannelId: CHANNEL, mirrorConfigured: true }));
    const harness = await open();
    expect(textOf(harness.fixture)).toContain('Slack notifications: configured');
    expect(textOf(harness.fixture)).toContain('Replace Slack webhook address');
    expect(webhook(harness).type).toBe('password');
    expect(webhook(harness).value).toBe('');
    expect(webhook(harness).getAttribute('autocomplete')).not.toBe('on');
    expect(channel(harness).value).toBe(CHANNEL);
    expect(textOf(harness.fixture)).toContain('never shown again');
  });

  it('WHEN only the channel changed THE UI SHALL send only the channel (a key left out is left alone)', async () => {
    getSettings.mockResolvedValue(settings({ mirrorConfigured: true }));
    updateSettings.mockResolvedValue(settings({ postChannelId: CHANNEL, mirrorConfigured: true }));
    const harness = await open();
    typeInto(channel(harness), CHANNEL);
    await submit(harness);
    expect(updateSettings).toHaveBeenCalledWith(GUILD_A, { postChannelId: CHANNEL });
  });

  it('WHEN a webhook is saved THE UI SHALL send it once, clear the field, and show only "configured"', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    getSettings.mockResolvedValue(settings());
    updateSettings.mockResolvedValue(settings({ mirrorConfigured: true }));
    const harness = await open();
    typeInto(webhook(harness), `  ${WEBHOOK}  `);
    await submit(harness);

    expect(updateSettings).toHaveBeenCalledWith(GUILD_A, { mirrorWebhookUrl: WEBHOOK });
    expect(webhook(harness).value).toBe('');
    expect(textOf(harness.fixture)).toContain('Slack notifications: configured');
    expect(textOf(harness.fixture)).not.toContain('hooks.example.test');
    expect(document.body.textContent).not.toContain('hooks.example.test');
    for (const input of Array.from(document.querySelectorAll('input'))) {
      expect(input.value).not.toContain('hooks.example.test');
    }
    for (const spy of consoleSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('hooks.example.test');
    }
  });

  it('WHEN the address does not start with https:// THE UI SHALL explain and NOT call the API', async () => {
    getSettings.mockResolvedValue(settings());
    const harness = await open();
    typeInto(webhook(harness), 'http://insecure.example.test/x');
    await submit(harness);
    expect(textOf(harness.fixture)).toContain('Enter an address that starts with https://');
    expect(updateSettings).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(webhook(harness));
  });

  it('WHEN the channel id is malformed THE UI SHALL explain and NOT call the API', async () => {
    getSettings.mockResolvedValue(settings());
    const harness = await open();
    typeInto(channel(harness), 'general');
    await submit(harness);
    expect(textOf(harness.fixture)).toContain('A channel id is 17 to 20 digits');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('WHEN the server rejects the webhook (400 mirrorWebhookUrl) THE UI SHALL mark that field, keep what was typed and focus it', async () => {
    getSettings.mockResolvedValue(settings());
    updateSettings.mockRejectedValue(
      new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Some fields need attention. Check them and try again.',
        status: 400,
        fields: ['mirrorWebhookUrl'],
        requestId: 'ref-1',
      }),
    );
    const harness = await open();
    typeInto(webhook(harness), WEBHOOK);
    await submit(harness);
    await new Promise((resolve) => setTimeout(resolve));
    harness.fixture.detectChanges();

    expect(textOf(harness.fixture)).toContain(
      'That webhook address was rejected. Check it and paste it again.',
    );
    expect(textOf(harness.fixture)).toContain('Some fields need attention');
    expect(textOf(harness.fixture)).toContain('Reference: ref-1');
    expect(textOf(harness.fixture)).not.toContain('hooks.example.test');
    expect(webhook(harness).value).toBe(WEBHOOK);
    expect(document.activeElement).toBe(webhook(harness));
    expect(webhook(harness).getAttribute('aria-invalid')).toBe('true');
  });

  it('WHEN the server rejects the channel THE UI SHALL mark the channel field', async () => {
    getSettings.mockResolvedValue(settings());
    updateSettings.mockRejectedValue(
      new AppError({
        code: 'VALIDATION_FAILED',
        message: 'x',
        status: 400,
        fields: ['postChannelId'],
      }),
    );
    const harness = await open();
    typeInto(channel(harness), CHANNEL);
    await submit(harness);
    expect(textOf(harness.fixture)).toContain('The channel id should be 17 to 20 digits');
  });

  it('WHEN removing the webhook is confirmed THE UI SHALL send null; WHEN cancelled it SHALL send nothing', async () => {
    getSettings.mockResolvedValue(settings({ mirrorConfigured: true }));
    updateSettings.mockResolvedValue(settings({ mirrorConfigured: false }));
    const harness = await open();
    const remove = queryAll<HTMLButtonElement>(harness.fixture, 'button').find(
      (b) => textOf(b) === 'Remove webhook',
    )!;

    remove.click();
    await settle(harness.fixture);
    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>('app-confirm-dialog button'),
    ).find((b) => textOf(b) === 'Cancel')!;
    expect(document.querySelector('app-confirm-dialog')!.textContent).toContain(
      'New reports will no longer be sent to Slack',
    );
    cancel.click();
    await settle(harness.fixture);
    expect(updateSettings).not.toHaveBeenCalled();

    remove.click();
    await settle(harness.fixture);
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>('app-confirm-dialog button'),
    ).find((b) => textOf(b) === 'Remove webhook')!;
    confirm.click();
    await settle(harness.fixture);
    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(GUILD_A, { mirrorWebhookUrl: null });
    });
  });

  it('knows when there are unsaved changes (so leaving can be confirmed)', async () => {
    getSettings.mockResolvedValue(settings());
    const harness = await open();
    const page = harness.routeDebugElement!.componentInstance as SettingsPage;
    expect(page.hasUnsavedChanges()).toBe(false);
    typeInto(channel(harness), CHANNEL);
    expect(page.hasUnsavedChanges()).toBe(true);
    typeInto(channel(harness), '');
    expect(page.hasUnsavedChanges()).toBe(false);
    typeInto(webhook(harness), WEBHOOK);
    expect(page.hasUnsavedChanges()).toBe(true);
  });
});
