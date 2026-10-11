import { describe, expect, it } from 'vitest';

import { COMMAND_DEFINITIONS } from '../domain/commands.js';
import {
  CommandRegistrationError,
  parseDiscordErrorBody,
  registerGuildCommands,
  registrationHint,
} from './discordCommands.js';

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
    captured.push({
      url: typeof input === 'string' ? input : '(non-string url)',
      init: init ?? {},
    });
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
    expect(JSON.parse(typeof call?.init.body === 'string' ? call.init.body : '')).toEqual(
      COMMAND_DEFINITIONS,
    );
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

  it('WHEN Discord answers 403 Missing Access THE SYSTEM SHALL show the status, code, message and the invite hint', async () => {
    const body = JSON.stringify({ code: 50001, message: 'Missing Access' });
    const missingAccess: typeof fetch = () => Promise.resolve(new Response(body, { status: 403 }));

    const failure = await registerGuildCommands({ ...baseOptions, fetchFn: missingAccess }).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ status: 403, discordCode: 50001 });
    const { message } = failure as CommandRegistrationError;
    expect(message).toContain('HTTP 403');
    expect(message).toContain('Discord code 50001');
    expect(message).toContain('"Missing Access"');
    expect(message).toContain('applications.commands');
    expect(message).toContain('Invite the bot');
  });

  it('WHEN Discord rejects the definitions THE SYSTEM SHALL name the invalid fields but not their values', async () => {
    const body = JSON.stringify({
      code: 50035,
      message: 'Invalid Form Body',
      errors: {
        1: { options: { 0: { min_length: { _errors: [{ code: 'X', message: 'secret-ish' }] } } } },
      },
    });
    const invalid: typeof fetch = () => Promise.resolve(new Response(body, { status: 400 }));

    const failure = await registerGuildCommands({ ...baseOptions, fetchFn: invalid }).catch(
      (error: unknown) => error,
    );

    const { message } = failure as CommandRegistrationError;
    expect(message).toContain('fields: 1.options.0.min_length');
    expect(message).not.toContain('secret-ish');
  });

  it('WHEN Discord rate limits THE SYSTEM SHALL say how long to wait', async () => {
    const limited: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 2.5 }), {
          status: 429,
        }),
      );

    const failure = await registerGuildCommands({ ...baseOptions, fetchFn: limited }).catch(
      (error: unknown) => error,
    );

    expect((failure as Error).message).toContain('retry after 2.5s');
  });

  it('WHEN a failure body echoes the bot token THE SYSTEM SHALL never print it', async () => {
    const echoing: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 0, message: `Bad header Bot ${FAKE_BOT_TOKEN}` }), {
          status: 401,
        }),
      );

    const failure = await registerGuildCommands({ ...baseOptions, fetchFn: echoing }).catch(
      (error: unknown) => error,
    );

    expect((failure as Error).message).not.toContain(FAKE_BOT_TOKEN);
    expect((failure as Error).message).toContain('[redacted]');
    expect(String((failure as Error).stack)).not.toContain(FAKE_BOT_TOKEN);
  });

  it('WHEN the error body is huge or not JSON THE SYSTEM SHALL still fail with the status and a hint', async () => {
    const junk: typeof fetch = () =>
      Promise.resolve(new Response('x'.repeat(100_000), { status: 502 }));

    const failure = await registerGuildCommands({ ...baseOptions, fetchFn: junk }).catch(
      (error: unknown) => error,
    );

    expect((failure as Error).message).toContain('HTTP 502');
    expect((failure as Error).message).toContain('again in a minute');
    expect((failure as Error).message.length).toBeLessThan(400);
  });
});

describe('parseDiscordErrorBody', () => {
  it('ignores values of the wrong type instead of throwing', () => {
    expect(parseDiscordErrorBody('{"code":"50001","message":42}')).toEqual({
      code: undefined,
      message: undefined,
      fields: [],
      retryAfterSeconds: undefined,
    });
  });

  it('returns empty details for empty input, arrays and null', () => {
    for (const text of ['', '[]', 'null', 'not json']) {
      expect(parseDiscordErrorBody(text).code).toBeUndefined();
    }
  });

  it('truncates a long Discord message', () => {
    const parsed = parseDiscordErrorBody(JSON.stringify({ message: 'm'.repeat(1000) }));

    expect(parsed.message).toHaveLength(200);
  });
});

describe('registrationHint', () => {
  it.each([
    [401, undefined, 'Reset it'],
    [403, 50001, 'applications.commands'],
    [404, 10004, 'DISCORD_GUILD_ID'],
    [404, 10002, 'DISCORD_APP_ID'],
    [429, undefined, 'rate limiting'],
    [503, undefined, 'again in a minute'],
    [418, undefined, 'environment file'],
  ])('maps status %i / code %s to advice containing "%s"', (status, code, expected) => {
    expect(registrationHint(status, code)).toContain(expected);
  });
});
