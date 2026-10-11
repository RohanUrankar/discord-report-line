import { HarnessLoader } from '@angular/cdk/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { MatSelectHarness } from '@angular/material/select/testing';
import {
  Router,
  provideRouter,
  withComponentInputBinding,
  withRouterConfig,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { queryAll, settle, textOf, root } from '../../../testing/dom';
import { GUILD_A, GUILD_B, session } from '../../../testing/fixtures';
import { ApiClient } from '../api/api-client';
import { AppError } from '../errors/app-error';
import { GuildsStore } from '../guilds/guilds-store';
import { AuthStore } from '../auth/auth-store';
import { GuildLayout } from './guild-layout';
import { Shell } from './shell';

const listGuilds = vi.fn();
const logout = vi.fn();
const me = vi.fn();

function configure(): void {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideRouter(
        [
          { path: 'login', children: [] },
          { path: 'connect', children: [] },
          {
            path: '',
            component: Shell,
            children: [
              { path: '', pathMatch: 'full', children: [] },
              {
                path: 'g/:guildId',
                component: GuildLayout,
                children: [
                  { path: 'log', children: [] },
                  { path: 'settings', children: [] },
                  { path: 'rules', children: [] },
                ],
              },
            ],
          },
        ],
        withComponentInputBinding(),
        withRouterConfig({ paramsInheritanceStrategy: 'always' }),
      ),
      { provide: ApiClient, useValue: { listGuilds, logout, me } },
    ],
  });
}

describe('Shell and guild layout', () => {
  beforeEach(() => {
    listGuilds.mockReset();
    logout.mockReset();
    me.mockReset().mockResolvedValue(session());
    configure();
  });

  it('WHEN the server is not one this admin manages THE UI SHALL show "not found" and render none of its pages', async () => {
    listGuilds.mockResolvedValue({ items: [{ id: GUILD_A, name: null }] });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/g/${GUILD_B}/log`);
    await settle(harness.fixture);
    expect(textOf(harness.fixture)).toContain("We couldn't find that server");
    expect(root(harness.fixture).querySelector('nav[aria-label="Server sections"]')).toBeNull();
  });

  it('WHEN the server is known THE UI SHALL show the section links with the current one marked', async () => {
    listGuilds.mockResolvedValue({ items: [{ id: GUILD_A, name: 'Team Server' }] });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/g/${GUILD_A}/settings`);
    await settle(harness.fixture);
    const links = queryAll<HTMLAnchorElement>(
      harness.fixture,
      'nav[aria-label="Server sections"] a',
    );
    expect(links.map((a) => textOf(a))).toEqual(['Command log', 'Settings', 'Command rules']);
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual([null, 'page', null]);
  });

  it('WHEN the server list fails to load THE UI SHALL show the error with a retry that asks again', async () => {
    listGuilds.mockRejectedValueOnce(
      new AppError({
        code: 'NETWORK',
        message: "We can't reach the server. Check your connection and try again.",
        status: 0,
      }),
    );
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/g/${GUILD_A}/log`);
    await settle(harness.fixture);
    expect(textOf(root(harness.fixture).querySelector('[role="alert"]') as HTMLElement)).toContain(
      "can't reach the server",
    );

    listGuilds.mockResolvedValue({ items: [{ id: GUILD_A, name: null }] });
    (root(harness.fixture).querySelector('[role="alert"] button') as HTMLButtonElement).click();
    await settle(harness.fixture);
    expect(root(harness.fixture).querySelector('nav[aria-label="Server sections"]')).not.toBeNull();
  });

  it('WHEN the admin picks another server THE UI SHALL keep the section (log, settings, rules)', async () => {
    listGuilds.mockResolvedValue({
      items: [
        { id: GUILD_A, name: 'Alpha' },
        { id: GUILD_B, name: 'Beta' },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/g/${GUILD_A}/rules`);
    await settle(harness.fixture);
    const loader: HarnessLoader = TestbedHarnessEnvironment.loader(harness.fixture);
    const select = await loader.getHarness(MatSelectHarness);
    await select.open();
    await (await select.getOptions({ text: 'Beta' }))[0]!.click();
    await settle(harness.fixture);
    await vi.waitFor(() => {
      expect(TestBed.inject(Router).url).toBe(`/g/${GUILD_B}/rules`);
    });
  });

  it('names an unnamed server by the end of its id, with the full id on hover', async () => {
    listGuilds.mockResolvedValue({ items: [{ id: GUILD_A, name: null }] });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/g/${GUILD_A}/log`);
    await settle(harness.fixture);
    const loader = TestbedHarnessEnvironment.loader(harness.fixture);
    const select = await loader.getHarness(MatSelectHarness);
    expect(await select.getValueText()).toBe('Server …111111');
  });

  it('WHEN sign-out cannot reach the server THE UI SHALL stay on the page and say so', async () => {
    listGuilds.mockResolvedValue({ items: [] });
    logout.mockRejectedValue(new AppError({ code: 'NETWORK', message: 'x', status: 0 }));
    await TestBed.inject(AuthStore).restore();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    await settle(harness.fixture);
    const button = queryAll<HTMLButtonElement>(harness.fixture, 'header button').find((b) =>
      textOf(b).includes('Sign out'),
    )!;
    button.click();
    await settle(harness.fixture);
    expect(TestBed.inject(Router).url).toBe('/');
    expect(TestBed.inject(AuthStore).isAuthenticated()).toBe(true);
    expect(document.body.textContent).toContain("couldn't sign you out");
  });

  it('empties the server list when the shell goes away so the next admin never sees it', async () => {
    listGuilds.mockResolvedValue({ items: [{ id: GUILD_A, name: null }] });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    await settle(harness.fixture);
    expect(TestBed.inject(GuildsStore).items()).toHaveLength(1);
    await harness.navigateByUrl('/login');
    await settle(harness.fixture);
    expect(TestBed.inject(GuildsStore).items()).toHaveLength(0);
  });
});
