import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, Router } from '@angular/router';

import { query, settle, textOf, type as typeInto } from '../../../testing/dom';
import { GUILD_A } from '../../../testing/fixtures';
import { ApiClient } from '../../core/api/api-client';
import { AppError } from '../../core/errors/app-error';
import { GuildsStore } from '../../core/guilds/guilds-store';
import { CONNECT_NOT_FOUND_MESSAGE } from '../../core/messages/copy';
import { ConnectServer, connectErrorMessage } from './connect-server';

const connectGuild = vi.fn();

function create() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideRouter([{ path: 'g/:guildId/log', children: [] }]),
      { provide: ApiClient, useValue: { connectGuild, listGuilds: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(ConnectServer);
  fixture.detectChanges();
  return fixture;
}

async function submit(fixture: ReturnType<typeof create>, id: string): Promise<void> {
  typeInto(query<HTMLInputElement>(fixture, 'input')!, id);
  query<HTMLButtonElement>(fixture, 'button[type="submit"]')!.click();
  await settle(fixture);
}

describe('ConnectServer', () => {
  beforeEach(() => {
    connectGuild.mockReset();
  });

  it('WHEN the id is not 17 to 20 digits THE UI SHALL explain and NOT call the API', async () => {
    const fixture = create();
    await submit(fixture, 'abc');
    expect(textOf(fixture)).toContain('A server id is 17 to 20 digits');
    expect(connectGuild).not.toHaveBeenCalled();
  });

  it('WHEN the API answers 404 THE UI SHALL show one generic message that does not say which case it was', async () => {
    connectGuild.mockRejectedValue(
      new AppError({
        code: 'NOT_FOUND',
        message: "We couldn't find that.",
        status: 404,
        requestId: 'req-5',
      }),
    );
    const fixture = create();
    await submit(fixture, GUILD_A);
    const alert = textOf(query(fixture, '[role="alert"]'));
    expect(alert).toContain(CONNECT_NOT_FOUND_MESSAGE);
    expect(alert).toContain('Check the server id');
    expect(alert).toContain('the bot has been added');
    expect(alert).not.toMatch(/someone else|another admin|already managed|not allowed/i);
    expect(alert).toContain('Reference: req-5');
  });

  it('WHEN the server is connected THE UI SHALL add it to the list and open its log', async () => {
    connectGuild.mockResolvedValue({ id: GUILD_A, name: null });
    const fixture = create();
    const router = TestBed.inject(Router);
    await submit(fixture, ` ${GUILD_A} `.trim());
    expect(connectGuild).toHaveBeenCalledWith(GUILD_A);
    expect(TestBed.inject(GuildsStore).items()).toEqual([{ id: GUILD_A, name: null }]);
    await vi.waitFor(() => {
      expect(router.url).toBe(`/g/${GUILD_A}/log`);
    });
  });

  it('WHEN the network is down THE UI SHALL use the shared offline wording', async () => {
    connectGuild.mockRejectedValue(
      new AppError({
        code: 'NETWORK',
        message: "We can't reach the server. Check your connection and try again.",
        status: 0,
      }),
    );
    const fixture = create();
    await submit(fixture, GUILD_A);
    expect(textOf(query(fixture, '[role="alert"]'))).toContain("We can't reach the server");
  });

  it('connectErrorMessage only special-cases NOT_FOUND', () => {
    expect(
      connectErrorMessage(
        new AppError({ code: 'RATE_LIMITED', message: 'slow down', status: 429 }),
      ),
    ).toBe('slow down');
  });
});
