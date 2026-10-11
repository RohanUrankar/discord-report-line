import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import axe, { type Result } from 'axe-core';

import { settle } from '../testing/dom';
import {
  GUILD_A,
  attempt,
  detail,
  logItem,
  logPage,
  reportRule,
  session,
  settings,
  statusRule,
} from '../testing/fixtures';
import { ApiClient } from './core/api/api-client';
import { Shell } from './core/layout/shell';
import { GuildLayout } from './core/layout/guild-layout';
import { Login } from './features/auth/login';
import { InteractionDetailPage } from './features/command-log/interaction-detail';
import { LogPage } from './features/command-log/log-page';
import { RulesPage } from './features/rules/rules-page';
import { ConnectServer } from './features/servers/connect-server';
import { SettingsPage } from './features/settings/settings-page';

// Automated WCAG checks with axe-core on every screen, rendered with data. jsdom has no layout engine, so
// colour contrast cannot be computed here: that rule is off and contrast is checked by hand per theme
// (see the report). Everything structural (names, roles, labels, headings, table semantics) is covered.
const api = {
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  listGuilds: vi.fn(),
  connectGuild: vi.fn(),
  listInteractions: vi.fn(),
  getInteraction: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  listRules: vi.fn(),
  updateRule: vi.fn(),
};

const dead = logItem(3, {
  interactionStatus: 'followed_up',
  job: { status: 'dead', attempts: 8, lastError: 'Slack answered 404' },
  action: { type: 'report', mirrorStatus: 'failed', llmTag: null, tagState: 'off' },
});

async function audit(url: string): Promise<Result[]> {
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  await settle(harness.fixture);
  harness.fixture.detectChanges();
  await settle(harness.fixture);
  const results = await axe.run(harness.fixture.nativeElement as HTMLElement, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    },
  });
  return results.violations;
}

const summarise = (violations: Result[]): string[] =>
  violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);

describe('accessibility (axe-core)', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) {
      fn.mockReset();
    }
    api.me.mockResolvedValue(session());
    api.listGuilds.mockResolvedValue({ items: [{ id: GUILD_A, name: null }] });
    api.listInteractions.mockResolvedValue(
      logPage([
        dead,
        logItem(2, { interactionStatus: 'failed', action: null, job: null }),
        logItem(1),
      ]),
    );
    api.getInteraction.mockResolvedValue(
      detail(dead, [
        attempt({ outcome: 'retryable', httpStatus: 503, error: 'Slack unavailable' }),
        attempt({ attemptNo: 2, outcome: 'fatal', httpStatus: 404 }),
      ]),
    );
    api.getSettings.mockResolvedValue(settings({ mirrorConfigured: true }));
    api.listRules.mockResolvedValue({ items: [statusRule(), reportRule()] });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideRouter(
          [
            { path: 'login', component: Login },
            {
              path: '',
              component: Shell,
              children: [
                { path: 'connect', component: ConnectServer },
                {
                  path: 'g/:guildId',
                  component: GuildLayout,
                  children: [
                    { path: 'log', component: LogPage },
                    { path: 'log/:interactionId', component: InteractionDetailPage },
                    { path: 'settings', component: SettingsPage },
                    { path: 'rules', component: RulesPage },
                  ],
                },
              ],
            },
          ],
          withComponentInputBinding(),
          withRouterConfig({ paramsInheritanceStrategy: 'always' }),
        ),
        { provide: ApiClient, useValue: api },
      ],
    });
  });

  it.each([
    ['sign-in', '/login'],
    ['connect a server', '/connect'],
    ['command log with rows', `/g/${GUILD_A}/log`],
    ['command details with the attempt timeline', `/g/${GUILD_A}/log/${dead.id}`],
    ['settings', `/g/${GUILD_A}/settings`],
    ['command rules', `/g/${GUILD_A}/rules`],
  ])('WHEN the %s screen is rendered THE UI SHALL have no axe violations', async (_name, url) => {
    expect(summarise(await audit(url))).toEqual([]);
  });

  it('WHEN the log is empty THE UI SHALL have no axe violations', async () => {
    api.listInteractions.mockResolvedValue(logPage([]));
    expect(summarise(await audit(`/g/${GUILD_A}/log`))).toEqual([]);
  });

  it('WHEN the log fails to load THE UI SHALL have no axe violations', async () => {
    api.listInteractions.mockRejectedValue(new Error('boom'));
    expect(summarise(await audit(`/g/${GUILD_A}/log`))).toEqual([]);
  });
});
