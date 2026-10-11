import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { InteractionController, type InteractionHandler } from '../app/interactions.js';
import { MESSAGES } from '../domain/reply.js';
import type { StatusCounts } from '../domain/reply.js';
import type { StatusReader } from '../ports/status.js';
import {
  FAKE_INTERACTION_TOKEN,
  GUILD_ID,
  commandPayload,
  componentPayload,
  dmCommandPayload,
  pingPayload,
} from '../../test/helpers/payloads.js';
import { LogSink } from '../../test/helpers/logging.js';
import {
  generateTestKeypair,
  signRequest,
  unixSeconds,
  type SignedHeaders,
} from '../../test/helpers/signing.js';
import { createLogger } from './middleware.js';
import { createServer } from './server.js';

const NOW_MS = 1_800_000_000_000;
const REPLAY_WINDOW_MS = 300_000;
const STATUS_TIMEOUT_MS = 50;
const EPHEMERAL = 64;
const IDLE_COUNTS: StatusCounts = { reportsToday: 3, retrying: 1, workerLastBeatSeconds: 4 };

interface ReplyJson {
  type: number;
  data: { content: string; flags?: number };
}
interface ErrorJson {
  error: { code: string; requestId: string };
}
const replyOf = (res: { text: string }): ReplyJson => JSON.parse(res.text) as ReplyJson;
const errorOf = (res: { text: string }): ErrorJson => JSON.parse(res.text) as ErrorJson;

class FakeStatusReader implements StatusReader {
  public readonly calls: string[] = [];
  public constructor(private readonly behaviour: () => Promise<StatusCounts>) {}

  public read(guildId: string): Promise<StatusCounts> {
    this.calls.push(guildId);
    return this.behaviour();
  }
}

function harness(behaviour: () => Promise<StatusCounts> = () => Promise.resolve(IDLE_COUNTS)) {
  const keypair = generateTestKeypair();
  const sink = new LogSink();
  const logger = createLogger('debug', sink);
  const reader = new FakeStatusReader(behaviour);
  const controller = new InteractionController({
    publicKeyHex: keypair.publicKeyHex,
    replayWindowMs: REPLAY_WINDOW_MS,
    statusTimeoutMs: STATUS_TIMEOUT_MS,
    clock: { nowMs: () => NOW_MS },
    statusReader: reader,
  });
  const app = createServer({ controller, logger });

  const post = (
    body: string | Buffer,
    headers: Partial<SignedHeaders>,
    contentType = 'application/json',
  ) => request(app).post('/interactions').set('Content-Type', contentType).set(headers).send(body);

  const signedPost = (payload: unknown, timestamp = unixSeconds(NOW_MS)) => {
    const body = JSON.stringify(payload);
    return post(body, signRequest(keypair, timestamp, body));
  };

  return { app, keypair, sink, reader, post, signedPost };
}

describe('POST /interactions: signature verification', () => {
  it('WHEN a request has a valid signature THE SYSTEM SHALL accept it', async () => {
    const { signedPost } = harness();
    await signedPost(pingPayload).expect(200);
  });

  it('WHEN the body is tampered after signing THE SYSTEM SHALL respond 401 with no body', async () => {
    const { post, keypair, reader } = harness();
    const signed = JSON.stringify(commandPayload('status'));
    const headers = signRequest(keypair, unixSeconds(NOW_MS), signed);

    const res = await post(signed.replace('status', 'statuz'), headers);

    expect(res.status).toBe(401);
    expect(res.text).toBe('');
    expect(reader.calls).toEqual([]);
  });

  it('WHEN the timestamp header is tampered THE SYSTEM SHALL respond 401', async () => {
    const { post, keypair } = harness();
    const body = JSON.stringify(pingPayload);
    const headers = signRequest(keypair, unixSeconds(NOW_MS), body);

    const res = await post(body, {
      ...headers,
      'x-signature-timestamp': unixSeconds(NOW_MS + 1000),
    });

    expect(res.status).toBe(401);
  });

  it('WHEN the request is signed with a different key THE SYSTEM SHALL respond 401', async () => {
    const { post } = harness();
    const body = JSON.stringify(pingPayload);
    const attacker = generateTestKeypair();

    const res = await post(body, signRequest(attacker, unixSeconds(NOW_MS), body));

    expect(res.status).toBe(401);
    expect(res.text).toBe('');
  });

  describe.each([
    ['both signature headers are missing', () => ({})],
    [
      'the signature header is missing',
      (h: SignedHeaders) => ({ 'x-signature-timestamp': h['x-signature-timestamp'] }),
    ],
    [
      'the timestamp header is missing',
      (h: SignedHeaders) => ({ 'x-signature-ed25519': h['x-signature-ed25519'] }),
    ],
    [
      'the signature is not hex',
      (h: SignedHeaders) => ({ ...h, 'x-signature-ed25519': 'zz'.repeat(64) }),
    ],
    [
      'the signature is too short',
      (h: SignedHeaders) => ({
        ...h,
        'x-signature-ed25519': h['x-signature-ed25519'].slice(0, 100),
      }),
    ],
    [
      'the signature is too long',
      (h: SignedHeaders) => ({ ...h, 'x-signature-ed25519': `${h['x-signature-ed25519']}00` }),
    ],
    ['the signature is empty', (h: SignedHeaders) => ({ ...h, 'x-signature-ed25519': '' })],
    [
      'the timestamp is not a number',
      (h: SignedHeaders) => ({ ...h, 'x-signature-timestamp': 'yesterday' }),
    ],
  ])('WHEN %s', (_name, mutate) => {
    it('THE SYSTEM SHALL respond 401 with no body, never a 500, and have no side effect', async () => {
      const { post, keypair, reader, sink } = harness();
      const body = JSON.stringify(commandPayload('status'));
      const headers = mutate(signRequest(keypair, unixSeconds(NOW_MS), body));

      const res = await post(body, headers);

      expect(res.status).toBe(401);
      expect(res.text).toBe('');
      expect(reader.calls).toEqual([]);
      expect(sink.messages()).toContain('interaction.signature_rejected');
    });
  });

  it('WHEN the body is empty THE SYSTEM SHALL respond 401', async () => {
    const { post, keypair } = harness();
    const res = await post('', signRequest(keypair, unixSeconds(NOW_MS), ''));
    expect(res.status).toBe(401);
    expect(res.text).toBe('');
  });

  it('WHEN a correctly signed body is not sent as application/json THE SYSTEM SHALL respond 401', async () => {
    const { post, keypair } = harness();
    const body = JSON.stringify(pingPayload);

    const res = await post(body, signRequest(keypair, unixSeconds(NOW_MS), body), 'text/plain');

    expect(res.status).toBe(401);
  });

  it('WHEN the body is larger than the limit THE SYSTEM SHALL refuse it with 413, not a 500', async () => {
    const { post, keypair } = harness();
    const body = JSON.stringify({ ...pingPayload, padding: 'x'.repeat(200_000) });

    const res = await post(body, signRequest(keypair, unixSeconds(NOW_MS), body));

    expect(res.status).toBe(413);
    expect(res.text).toBe('');
  });

  it('WHEN a signed body is not valid JSON THE SYSTEM SHALL respond 400 with no body', async () => {
    const { signedPost, post, keypair } = harness();
    const body = '{"type": 1';

    const res = await post(body, signRequest(keypair, unixSeconds(NOW_MS), body));
    const notAnInteraction = await signedPost(['not', 'an', 'interaction']);

    expect(res.status).toBe(400);
    expect(res.text).toBe('');
    expect(notAnInteraction.status).toBe(400);
  });
});

describe('POST /interactions: replay window', () => {
  it.each([
    ['older than 5 minutes', NOW_MS - REPLAY_WINDOW_MS - 1000],
    ['more than 5 minutes in the future', NOW_MS + REPLAY_WINDOW_MS + 1000],
  ])(
    'WHEN a validly signed request is %s THE SYSTEM SHALL reject it with 401',
    async (_name, sentAtMs) => {
      const { signedPost, reader } = harness();

      const res = await signedPost(commandPayload('status'), unixSeconds(sentAtMs));

      expect(res.status).toBe(401);
      expect(res.text).toBe('');
      expect(reader.calls).toEqual([]);
    },
  );

  it('WHEN a validly signed request is 4 minutes old THE SYSTEM SHALL accept it', async () => {
    const { signedPost } = harness();
    await signedPost(pingPayload, unixSeconds(NOW_MS - 240_000)).expect(200);
  });

  it('THE SYSTEM SHALL verify the signature before it looks at the timestamp', async () => {
    const { post, keypair, signedPost, sink } = harness();
    const body = JSON.stringify(pingPayload);
    const staleTimestamp = unixSeconds(NOW_MS - 3_600_000);

    // Stale AND forged: only the signature failure may be reported, so a forger learns nothing about the clock.
    await post(body, {
      ...signRequest(keypair, staleTimestamp, body),
      'x-signature-ed25519': '00'.repeat(64),
    });
    expect(sink.messages()).toEqual(expect.arrayContaining(['interaction.signature_rejected']));
    expect(sink.messages()).not.toContain('interaction.timestamp_rejected');

    // Stale but authentic: now, and only now, the replay check fires.
    await signedPost(pingPayload, staleTimestamp);
    expect(sink.messages()).toContain('interaction.timestamp_rejected');
  });
});

describe('POST /interactions: PING', () => {
  it('WHEN Discord sends a PING THE SYSTEM SHALL answer 200 {"type":1} as application/json', async () => {
    const { signedPost, reader } = harness();

    const res = await signedPost(pingPayload);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.text).toBe('{"type":1}');
    expect(reader.calls).toEqual([]);
  });

  it('WHEN a PING has no member, data or guild THE SYSTEM SHALL still answer it', async () => {
    const { signedPost } = harness();
    const bare = { id: pingPayload.id, type: 1 };

    const res = await signedPost(bare);

    expect(res.body).toEqual({ type: 1 });
  });
});

describe('POST /interactions: /status', () => {
  it('WHEN a user runs /status THE SYSTEM SHALL reply inline with an ephemeral type 4 message', async () => {
    const { signedPost, reader } = harness();

    const res = await signedPost(commandPayload('status'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: 4,
      data: {
        content: 'Reports today: 3 · Retrying: 1 · Worker last active 4 s ago.',
        allowed_mentions: { parse: [] },
        flags: EPHEMERAL,
      },
    });
    expect(reader.calls).toEqual([GUILD_ID]);
  });

  it('WHEN the status read hangs THE SYSTEM SHALL still reply well inside the 3 s limit', async () => {
    const { signedPost } = harness(() => new Promise<StatusCounts>(() => undefined));
    const startedAt = performance.now();

    const res = await signedPost(commandPayload('status'));

    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(replyOf(res).data.content).toBe(MESSAGES.statusUnavailable);
    expect(replyOf(res).data.flags).toBe(EPHEMERAL);
  });

  it('WHEN the status read fails THE SYSTEM SHALL reply with a plain notice, not a 500, and log once', async () => {
    const { signedPost, sink } = harness(() =>
      Promise.reject(new Error('connect ECONNREFUSED db.internal')),
    );

    const res = await signedPost(commandPayload('status'));

    expect(res.status).toBe(200);
    expect(replyOf(res).data.content).toBe(MESSAGES.statusUnavailable);
    expect(sink.messages().filter((m) => m === 'status.read_failed')).toHaveLength(1);
    expect(sink.text()).not.toContain('db.internal');
  });
});

describe('POST /interactions: other interactions', () => {
  it.each([
    ['an unknown command', commandPayload('nonsense'), MESSAGES.unknownCommand],
    ['/report, which is not registered yet', commandPayload('report'), MESSAGES.unknownCommand],
    [
      'a button click, which is not built yet',
      componentPayload('rpt:ack:1'),
      MESSAGES.unknownCommand,
    ],
    ['a command sent in a DM', dmCommandPayload('status'), MESSAGES.dmUnsupported],
  ])(
    'WHEN the interaction is %s THE SYSTEM SHALL reply with an ephemeral notice',
    async (_name, payload, expected) => {
      const { signedPost, reader } = harness();

      const res = await signedPost(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        type: 4,
        data: { content: expected, allowed_mentions: { parse: [] }, flags: EPHEMERAL },
      });
      expect(reader.calls).toEqual([]);
    },
  );
});

describe('server wiring', () => {
  it('serves GET /healthz without touching any dependency', async () => {
    const { app, reader } = harness();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(reader.calls).toEqual([]);
  });

  it('answers an unknown route with a JSON 404 carrying a request id', async () => {
    const { app } = harness();
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(errorOf(res).error.code).toBe('NOT_FOUND');
    expect(errorOf(res).error.requestId).toBe(res.headers['x-request-id']);
  });

  it('does not advertise Express', async () => {
    const { app } = harness();
    const res = await request(app).get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('keeps a well-formed x-request-id and replaces a hostile one', async () => {
    const { app } = harness();
    const kept = await request(app).get('/healthz').set('x-request-id', 'req-abc_123');
    const replaced = await request(app).get('/healthz').set('x-request-id', 'bad id with spaces');
    expect(kept.headers['x-request-id']).toBe('req-abc_123');
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('WHEN a handler throws THE SYSTEM SHALL answer a generic 500, log once, and leak no detail', async () => {
    const sink = new LogSink();
    const throwing: InteractionHandler = {
      handle: () => Promise.reject(new Error('relation "interaction" does not exist')),
    };
    const app = createServer({ controller: throwing, logger: createLogger('debug', sink) });

    const res = await request(app)
      .post('/interactions')
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).toBe(500);
    expect(errorOf(res).error.code).toBe('INTERNAL');
    expect(JSON.stringify(res.body)).not.toContain('relation');
    expect(sink.messages().filter((m) => m === 'http.unhandled_error')).toHaveLength(1);
  });
});

describe('logs never contain the interaction token', () => {
  it('across success, rejection and failure paths', async () => {
    const { signedPost, post, keypair, sink } = harness();
    const failing = harness(() => Promise.reject(new Error('boom')));

    await signedPost(commandPayload('status'));
    await signedPost(pingPayload);
    await signedPost(commandPayload('nonsense'));
    await signedPost(commandPayload('status'), unixSeconds(NOW_MS - 3_600_000));
    await failing.signedPost(commandPayload('status'));
    const body = JSON.stringify(commandPayload('status'));
    await post(body, {
      ...signRequest(keypair, unixSeconds(NOW_MS), body),
      'x-signature-ed25519': 'zz',
    });

    for (const text of [sink.text(), failing.sink.text()]) {
      expect(text).not.toContain(FAKE_INTERACTION_TOKEN);
    }
    expect(sink.records().length).toBeGreaterThan(0);
  });

  it('correlates interaction logs by interaction_id and request_id', async () => {
    const { signedPost, sink } = harness();
    await signedPost(commandPayload('status'));
    const received = sink.records().find((record) => record.msg === 'interaction.received');
    expect(received).toMatchObject({
      interaction_id: '900000000000000004',
      command: 'status',
      guild_id: GUILD_ID,
    });
    expect(received?.request_id).toEqual(expect.any(String));
  });
});
