import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, Router } from '@angular/router';

import { query, settle, textOf } from '../../../testing/dom';
import { GUILD_A, GUILD_B } from '../../../testing/fixtures';
import { ApiClient } from '../../core/api/api-client';
import { AppError } from '../../core/errors/app-error';
import { GuildsStore } from '../../core/guilds/guilds-store';
import { Landing } from './landing';

const listGuilds = vi.fn();

function create() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideRouter([
        { path: 'connect', children: [] },
        { path: 'g/:guildId/log', children: [] },
      ]),
      { provide: ApiClient, useValue: { listGuilds } },
    ],
  });
  const fixture = TestBed.createComponent(Landing);
  fixture.detectChanges();
  return fixture;
}

describe('Landing', () => {
  beforeEach(() => {
    listGuilds.mockReset();
  });

  it("WHEN the admin manages servers THE UI SHALL open the first one's live log", async () => {
    listGuilds.mockResolvedValue({
      items: [
        { id: GUILD_B, name: null },
        { id: GUILD_A, name: null },
      ],
    });
    const fixture = create();
    await settle(fixture);
    await vi.waitFor(() => {
      expect(TestBed.inject(Router).url).toBe(`/g/${GUILD_B}/log`);
    });
  });

  it('WHEN the admin has no server yet THE UI SHALL go to the connect-a-server first-run page', async () => {
    listGuilds.mockResolvedValue({ items: [] });
    const fixture = create();
    await settle(fixture);
    await vi.waitFor(() => {
      expect(TestBed.inject(Router).url).toBe('/connect');
    });
  });

  it('WHEN the shell is already loading the server list THE UI SHALL still open the first server once it arrives', async () => {
    let release: (value: unknown) => void = () => undefined;
    listGuilds.mockReturnValue(new Promise((resolve) => (release = resolve)));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideRouter([{ path: 'g/:guildId/log', children: [] }]),
        { provide: ApiClient, useValue: { listGuilds } },
      ],
    });
    void TestBed.inject(GuildsStore).load(); // what the shell does first
    const fixture = TestBed.createComponent(Landing);
    fixture.detectChanges();
    release({ items: [{ id: GUILD_A, name: null }] });
    await settle(fixture);
    await vi.waitFor(() => {
      expect(TestBed.inject(Router).url).toBe(`/g/${GUILD_A}/log`);
    });
  });

  it('shows a loading state while it finds out', () => {
    listGuilds.mockReturnValue(new Promise(() => undefined));
    const fixture = create();
    expect(query(fixture, '[role="status"]')).not.toBeNull();
    expect(textOf(fixture)).toContain('Loading your servers');
  });

  it('WHEN loading fails THE UI SHALL show the error with a retry that tries again', async () => {
    listGuilds.mockRejectedValueOnce(
      new AppError({
        code: 'INTERNAL',
        message: 'Something went wrong on our side. Please try again.',
        status: 500,
        requestId: 'r-1',
      }),
    );
    const fixture = create();
    await settle(fixture);
    fixture.detectChanges();
    expect(textOf(query(fixture, '[role="alert"]'))).toContain('Something went wrong on our side');
    expect(textOf(query(fixture, '[role="alert"]'))).toContain('Reference: r-1');

    listGuilds.mockResolvedValue({ items: [{ id: GUILD_A, name: null }] });
    query<HTMLButtonElement>(fixture, '[role="alert"] button')!.click();
    await settle(fixture);
    await vi.waitFor(() => {
      expect(TestBed.inject(Router).url).toBe(`/g/${GUILD_A}/log`);
    });
  });
});
