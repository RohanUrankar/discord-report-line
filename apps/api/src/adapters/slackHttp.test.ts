import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StubServer } from '../../test/helpers/stubServer.js';
import { SlackHttpClient } from './slackHttp.js';

let stub: StubServer;

beforeAll(async () => {
  stub = await StubServer.start();
});
afterAll(async () => {
  await stub.close();
});

const prefix = () => `${stub.baseUrl}/services/`;
const client = (timeoutMs = 1000) => new SlackHttpClient({ timeoutMs, allowedUrlPrefix: prefix() });
const webhook = () => `${prefix()}T000/B000/fake-secret-do-not-leak`;

describe('SlackHttpClient', () => {
  it('SHALL post the text as JSON to the webhook URL', async () => {
    stub.reset();

    const result = await client().send(webhook(), 'hello <b>');

    expect(result).toEqual({ ok: true, status: 200 });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.method).toBe('POST');
    expect(stub.requests[0]?.url).toBe('/services/T000/B000/fake-secret-do-not-leak');
    expect(stub.requests[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(stub.requests[0]?.body ?? '')).toEqual({ text: 'hello <b>' });
  });

  it('WHEN Slack answers 429 with Retry-After THE SYSTEM SHALL report it in milliseconds', async () => {
    stub.reset();
    stub.behave(() => ({ status: 429, headers: { 'retry-after': '30' } }));

    expect(await client().send(webhook(), 'x')).toEqual({
      ok: false,
      failure: { status: 429, retryAfterMs: 30_000 },
    });
  });

  it('WHEN Slack redirects THE SYSTEM SHALL fail with the 3xx and call nothing else', async () => {
    const elsewhere = await StubServer.start();
    try {
      stub.reset();
      stub.behave(() => ({ status: 301, headers: { location: `${elsewhere.baseUrl}/x` } }));

      const result = await client().send(webhook(), 'x');

      expect(result).toEqual({ ok: false, failure: { status: 301 } });
      expect(elsewhere.requests).toEqual([]);
    } finally {
      await elsewhere.close();
    }
  });

  it('WHEN Slack is slower than the timeout THE SYSTEM SHALL report a timeout', async () => {
    stub.reset();
    stub.behave(() => ({ status: 200, delayMs: 300 }));

    expect(await client(50).send(webhook(), 'x')).toEqual({
      ok: false,
      failure: { kind: 'timeout' },
    });
  });

  it.each([
    ['another host', () => 'https://example.com/services/T/B/x'],
    ['an internal address', () => 'http://169.254.169.254/latest/meta-data/'],
    ['credentials in the URL', () => `http://user:pass@${new URL(prefix()).host}/services/T/B/x`],
  ])(
    'WHEN the stored URL is %s THE SYSTEM SHALL refuse to send and make no request',
    async (_label, makeUrl) => {
      stub.reset();

      const result = await client().send(makeUrl(), 'x');

      expect(result).toEqual({ ok: false, failure: {} });
      expect(stub.requests).toEqual([]);
    },
  );
});
