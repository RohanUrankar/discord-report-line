import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StubServer } from '../../test/helpers/stubServer.js';
import { plainBody } from '../domain/discordResponses.js';
import { DiscordHttpClient } from './discordHttp.js';

const APP_ID = '900000000000000005';
const TOKEN = 'fake-interaction-token-do-not-leak';
const BOT_TOKEN = 'fake-bot-token-do-not-leak';
const CHANNEL = '900000000000000002';
const BODY = plainBody('Report logged.');

let stub: StubServer;

beforeAll(async () => {
  stub = await StubServer.start();
});
afterAll(async () => {
  await stub.close();
});

const client = (timeoutMs = 1000) =>
  new DiscordHttpClient({
    apiBaseUrl: `${stub.baseUrl}/api/v10/`, // trailing slash on purpose: it must not double up
    botToken: BOT_TOKEN,
    timeoutMs,
  });

describe('DiscordHttpClient.editOriginal', () => {
  it('SHALL PATCH the original message with the token in the URL and no bot token', async () => {
    stub.reset();

    const result = await client().editOriginal(APP_ID, TOKEN, BODY);

    expect(result).toEqual({ ok: true, status: 200 });
    const [request] = stub.requests;
    expect(request?.method).toBe('PATCH');
    expect(request?.url).toBe(`/api/v10/webhooks/${APP_ID}/${TOKEN}/messages/@original`);
    expect(request?.headers.authorization).toBeUndefined();
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers['user-agent']).toContain('DiscordBot');
    expect(JSON.parse(request?.body ?? '')).toEqual(BODY);
  });

  it('SHALL encode a token that contains URL-special characters instead of letting it change the path', async () => {
    stub.reset();

    await client().editOriginal(APP_ID, 'a/b?c#d', BODY);

    expect(stub.requests[0]?.url).toBe(
      `/api/v10/webhooks/${APP_ID}/a%2Fb%3Fc%23d/messages/@original`,
    );
  });

  it.each([401, 404])(
    'WHEN Discord answers %i THE SYSTEM SHALL report only the status, with no URL or token',
    async (status) => {
      stub.reset();
      stub.behave(() => ({ status, body: '{"message":"Unknown Webhook","code":10015}' }));

      const result = await client().editOriginal(APP_ID, TOKEN, BODY);

      expect(result).toEqual({ ok: false, failure: { status } });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    },
  );

  it('WHEN Discord answers 429 THE SYSTEM SHALL pass retry_after on in milliseconds', async () => {
    stub.reset();
    stub.behave(() => ({
      status: 429,
      headers: { 'retry-after': '2' },
      body: '{"message":"You are being rate limited.","retry_after":2.25,"global":false}',
    }));

    expect(await client().editOriginal(APP_ID, TOKEN, BODY)).toEqual({
      ok: false,
      failure: { status: 429, retryAfterMs: 2250 },
    });
  });

  it('WHEN Discord is slower than the timeout THE SYSTEM SHALL report a timeout', async () => {
    stub.reset();
    stub.behave(() => ({ status: 200, delayMs: 300 }));

    expect(await client(50).editOriginal(APP_ID, TOKEN, BODY)).toEqual({
      ok: false,
      failure: { kind: 'timeout' },
    });
  });
});

describe('DiscordHttpClient.postChannelMessage', () => {
  it('SHALL POST to the channel with the bot token', async () => {
    stub.reset();

    const result = await client().postChannelMessage(CHANNEL, BODY);

    expect(result).toEqual({ ok: true, status: 200 });
    const [request] = stub.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(`/api/v10/channels/${CHANNEL}/messages`);
    expect(request?.headers.authorization).toBe(`Bot ${BOT_TOKEN}`);
    expect(JSON.parse(request?.body ?? '')).toEqual(BODY);
  });

  it('WHEN the bot lacks permission THE SYSTEM SHALL report 403 without the bot token', async () => {
    stub.reset();
    stub.behave(() => ({ status: 403, body: '{"message":"Missing Permissions","code":50013}' }));

    const result = await client().postChannelMessage(CHANNEL, BODY);

    expect(result).toEqual({ ok: false, failure: { status: 403 } });
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
  });
});
