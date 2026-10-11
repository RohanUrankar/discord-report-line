import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StubServer } from '../../test/helpers/stubServer.js';
import { performCall } from './httpCall.js';

let stub: StubServer;

beforeAll(async () => {
  stub = await StubServer.start();
});
afterAll(async () => {
  await stub.close();
});

const call = (timeoutMs = 1000) =>
  performCall({
    url: `${stub.baseUrl}/x`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
    timeoutMs,
    fetchFn: fetch,
  });

describe('performCall', () => {
  it('WHEN the server answers 2xx THE SYSTEM SHALL report success with the status', async () => {
    stub.reset();
    stub.behave(() => ({ status: 204 }));

    expect(await call()).toEqual({ ok: true, status: 204 });
    expect(stub.requests[0]?.body).toBe('{"a":1}');
  });

  it.each([400, 401, 403, 404, 408, 410, 425, 500, 503])(
    'WHEN the server answers %i THE SYSTEM SHALL report that status and nothing else',
    async (status) => {
      stub.reset();
      stub.behave(() => ({ status, body: 'secret-looking body must not travel' }));

      const result = await call();

      expect(result).toEqual({ ok: false, failure: { status } });
    },
  );

  it('WHEN the server redirects THE SYSTEM SHALL NOT follow the redirect and SHALL report the 3xx', async () => {
    const target = await StubServer.start();
    try {
      stub.reset();
      stub.behave(() => ({ status: 302, headers: { location: `${target.baseUrl}/internal` } }));

      const result = await call();

      expect(result).toEqual({ ok: false, failure: { status: 302 } });
      expect(target.requests).toEqual([]);
    } finally {
      await target.close();
    }
  });

  it('WHEN the server is slower than the timeout THE SYSTEM SHALL report a timeout', async () => {
    stub.reset();
    stub.behave(() => ({ status: 200, delayMs: 300 }));

    expect(await call(50)).toEqual({ ok: false, failure: { kind: 'timeout' } });
  });

  it('WHEN the connection is dropped THE SYSTEM SHALL report a network error', async () => {
    stub.reset();
    stub.behave(() => ({ status: 200, destroy: true }));

    expect(await call()).toEqual({ ok: false, failure: { kind: 'network' } });
  });

  it('WHEN nothing is listening THE SYSTEM SHALL report a network error', async () => {
    const result = await performCall({
      url: 'http://127.0.0.1:1/x',
      method: 'POST',
      headers: {},
      body: '{}',
      timeoutMs: 1000,
      fetchFn: fetch,
    });

    expect(result).toEqual({ ok: false, failure: { kind: 'network' } });
  });
});

describe('performCall: 429 and Retry-After', () => {
  const rateLimited = (headers: Record<string, string>, body = '') => {
    stub.reset();
    stub.behave(() => ({ status: 429, headers, body }));
  };

  it('reads Retry-After seconds from the header', async () => {
    rateLimited({ 'retry-after': '65' });

    expect(await call()).toEqual({ ok: false, failure: { status: 429, retryAfterMs: 65_000 } });
  });

  it('reads Discord’s fractional retry_after from the JSON body, rounded up to the millisecond', async () => {
    rateLimited(
      { 'content-type': 'application/json' },
      '{"message":"x","retry_after":64.5701,"global":false}',
    );

    expect(await call()).toEqual({ ok: false, failure: { status: 429, retryAfterMs: 64_571 } });
  });

  it('WHEN header and body disagree THE SYSTEM SHALL use the later of the two', async () => {
    rateLimited({ 'retry-after': '2' }, '{"retry_after":7.5}');

    expect(await call()).toEqual({ ok: false, failure: { status: 429, retryAfterMs: 7500 } });
  });

  it.each([
    ['no hint at all', {}, ''],
    ['a header that is not a number', { 'retry-after': 'soon' }, ''],
    ['a negative header', { 'retry-after': '-5' }, ''],
    ['a body that is not JSON', {}, '<html>nope</html>'],
    ['a retry_after that is not a number', {}, '{"retry_after":"later"}'],
  ])(
    'WHEN a 429 has %s THE SYSTEM SHALL leave retryAfterMs unset so normal backoff applies',
    async (_label, headers, body) => {
      rateLimited(headers, body);

      expect(await call()).toEqual({ ok: false, failure: { status: 429 } });
    },
  );

  it('SHALL NOT buffer an unbounded body when looking for retry_after', async () => {
    rateLimited({ 'retry-after': '3' }, `{"padding":"${'x'.repeat(2_000_000)}","retry_after":99}`);

    expect(await call()).toEqual({ ok: false, failure: { status: 429, retryAfterMs: 3000 } });
  });

  it('does not treat a 5xx as rate limiting even if it carries Retry-After', async () => {
    stub.reset();
    stub.behave(() => ({ status: 503, headers: { 'retry-after': '9' } }));

    expect(await call()).toEqual({ ok: false, failure: { status: 503 } });
  });
});
