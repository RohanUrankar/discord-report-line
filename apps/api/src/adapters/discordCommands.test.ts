import { describe, expect, it } from 'vitest';

import { COMMAND_DEFINITIONS } from '../domain/commands.js';
import { CommandRegistrationError, registerGuildCommands } from './discordCommands.js';

const FAKE_BOT_TOKEN = 'fake-bot-token-do-not-leak';
const baseOptions = {
  apiBaseUrl: 'https://discord.test/api/v10',
  appId: '111111111111111111',
  guildId: '222222222222222222',
  botToken: FAKE_BOT_TOKEN,
  commands: COMMAND_DEFINITIONS,
  timeoutMs: 1000,
};

interface Captured {
  url: string;
  init: RequestInit;
}

function fetchReturning(status: number, captured: Captured[] = []): typeof fetch {
  return (input, init) => {
    captured.push({ url: typeof input === 'string' ? input : '(non-string url)', init: init ?? {} });
    return Promise.resolve(new Response('{"echo":"body must not be read"}', { status }));
  };
}

describe('registerGuildCommands', () => {
  it('PUTs the whole command set to the guild endpoint with the bot token and a timeout', async () => {
    const captured: Captured[] = [];

    await registerGuildCommands({ ...baseOptions, fetchFn: fetchReturning(200, captured) });

    const [call] = captured;
    expect(call?.url).toBe(
      'https://discord.test/api/v10/applications/111111111111111111/guilds/222222222222222222/commands',
    );
    expect(call?.init.method).toBe('PUT');
    expect(call?.init.headers).toMatchObject({ authorization: `Bot ${FAKE_BOT_TOKEN}` });
    expect(JSON.parse(typeof call?.init.body === 'string' ? call.init.body : '')).toEqual(COMMAND_DEFINITIONS);
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(call?.init.redirect).toBe('manual');
  });

  it.each([401, 403, 429, 500])(
    'WHEN Discord answers %i THE SYSTEM SHALL fail with the status and without leaking the token',
    async (status) => {
      const failure = await registerGuildCommands({
        ...baseOptions,
        fetchFn: fetchReturning(status),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CommandRegistrationError);
      expect((failure as CommandRegistrationError).status).toBe(status);
      expect((failure as CommandRegistrationError).message).not.toContain(FAKE_BOT_TOKEN);
      expect((failure as CommandRegistrationError).message).not.toContain('echo');
    },
  );

  it('WHEN the call times out THE SYSTEM SHALL report a timeout', async () => {
    const timedOut: typeof fetch = () =>
      Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));

    const failure = await registerGuildCommands({ ...baseOptions, fetchFn: timedOut }).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ name: 'CommandRegistrationError', kind: 'timeout' });
  });

  it('WHEN the network is down THE SYSTEM SHALL report a network error without the raw cause', async () => {
    const down: typeof fetch = () =>
      Promise.reject(new TypeError(`fetch failed for Bot ${FAKE_BOT_TOKEN}`));

    const failure = await registerGuildCommands({ ...baseOptions, fetchFn: down }).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ kind: 'network' });
    expect((failure as Error).message).not.toContain(FAKE_BOT_TOKEN);
  });
});
