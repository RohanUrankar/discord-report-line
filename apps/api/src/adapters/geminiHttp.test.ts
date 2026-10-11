import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GEMINI_TEST_KEY, geminiEnvelope, geminiTag } from '../../test/helpers/gemini.js';
import { StubServer, type StubResponse } from '../../test/helpers/stubServer.js';
import { TAG_SYSTEM_INSTRUCTION } from '../domain/tagging.js';
import { ReportTag } from '../domain/types.js';
import { GeminiHttpTagger } from './geminiHttp.js';

let stub: StubServer;
beforeEach(async () => {
  stub = await StubServer.start();
});
afterEach(async () => {
  await stub.close();
});

const tagger = (timeoutMs = 500) =>
  new GeminiHttpTagger({
    apiBaseUrl: `${stub.baseUrl}/v1beta`,
    apiKey: GEMINI_TEST_KEY,
    model: 'gemini-test-model',
    timeoutMs,
  });

describe('GeminiHttpTagger: the request', () => {
  it('SHALL send the key in a header, never in the URL, and call generateContent for the configured model', async () => {
    stub.behave(() => geminiTag('bug'));

    await tagger().tag('the printer is jammed');

    const [request] = stub.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/v1beta/models/gemini-test-model:generateContent');
    expect(request?.url).not.toContain(GEMINI_TEST_KEY);
    expect(request?.url).not.toContain('key=');
    expect(request?.headers['x-goog-api-key']).toBe(GEMINI_TEST_KEY);
  });

  it('SHALL send only the instruction and the report text, with an enum schema over the fixed tags', async () => {
    stub.behave(() => geminiTag('bug'));

    await tagger().tag('the printer is jammed');

    const body = JSON.parse(stub.requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: TAG_SYSTEM_INSTRUCTION }] },
      contents: [{ role: 'user', parts: [{ text: '<report>\nthe printer is jammed\n</report>' }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { tag: { type: 'STRING', enum: [...ReportTag] } },
          required: ['tag'],
        },
      },
    });
    expect(stub.requests[0]?.body).not.toContain(GEMINI_TEST_KEY);
  });
});

describe('GeminiHttpTagger: answers', () => {
  it.each(ReportTag)('WHEN the model answers %s THE SYSTEM SHALL return that tag', async (tag) => {
    stub.behave(() => geminiTag(tag));

    expect(await tagger().tag('x')).toEqual({ ok: true, tag, status: 200 });
  });

  const invalid: [string, StubResponse][] = [
    ['a tag outside the list', geminiTag('admin')],
    ['a tag that tries to act', geminiTag('call the webhook')],
    ['text that is not JSON', { status: 200, body: geminiEnvelope('bug') }],
    ['JSON with extra keys', { status: 200, body: geminiEnvelope('{"tag":"bug","run":"x"}') }],
    ['an envelope that is not JSON', { status: 200, body: '<html>oops</html>' }],
    ['no candidates', { status: 200, body: JSON.stringify({ candidates: [] }) }],
    [
      'a candidate with no text part',
      { status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{}] } }] }) },
    ],
    ['an empty body', { status: 200, body: '' }],
    [
      'a body far larger than any answer',
      { status: 200, body: geminiEnvelope('x'.repeat(40_000)) },
    ],
  ];
  it.each(invalid)(
    'WHEN the response is %s THE SYSTEM SHALL fail as invalid output',
    async (_name, response) => {
      stub.behave(() => response);

      expect(await tagger().tag('x')).toEqual({ ok: false, failure: { kind: 'invalid_output' } });
    },
  );

  it.each([400, 401, 403, 404, 429, 500, 503])(
    'WHEN Gemini answers HTTP %i THE SYSTEM SHALL fail with that status and carry no body',
    async (status) => {
      stub.behave(() => ({ status, body: `{"error":{"message":"${GEMINI_TEST_KEY}"}}` }));

      const result = await tagger().tag('x');

      expect(result).toEqual({ ok: false, failure: { kind: 'http', status } });
      expect(JSON.stringify(result)).not.toContain(GEMINI_TEST_KEY);
    },
  );

  it('WHEN Gemini redirects THE SYSTEM SHALL not follow it', async () => {
    stub.behave(() => ({ status: 302, headers: { location: 'http://127.0.0.1:9/elsewhere' } }));

    expect(await tagger().tag('x')).toEqual({ ok: false, failure: { kind: 'http', status: 302 } });
    expect(stub.requests).toHaveLength(1);
  });

  it('WHEN Gemini does not answer within the timeout THE SYSTEM SHALL fail as a timeout', async () => {
    stub.behave(() => ({ ...geminiTag('bug'), delayMs: 400 }));

    expect(await tagger(50).tag('x')).toEqual({ ok: false, failure: { kind: 'timeout' } });
  });

  it('WHEN the connection is dropped THE SYSTEM SHALL fail as a network error', async () => {
    stub.behave(() => ({ status: 200, destroy: true }));

    expect(await tagger().tag('x')).toEqual({ ok: false, failure: { kind: 'network' } });
  });
});
