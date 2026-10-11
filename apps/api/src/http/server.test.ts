import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { InteractionController, type InteractionHandler } from '../app/interactions.js';
import { ACTION_SUMMARIES, MESSAGES } from '../domain/messages.js';
import type { StatusCounts } from '../domain/status.js';
import type { LedgerService, RecordInput, RecordOutcome } from '../ports/ledger.js';
import type { StatusReader } from '../ports/status.js';
import {
  CHANNEL_ID,
  FAKE_INTERACTION_TOKEN,
  GUILD_ID,
  INTERACTION_ID,
  USER_ID,
  commandPayload,
  componentPayload,
  dmCommandPayload,
  pingPayload,
  reportPayload,
} from '../../test/helpers/payloads.js';
import { inertAuth } from '../../test/helpers/authFakes.js';
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
const RECORD_TIMEOUT_MS = 50;
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

class FakeLedger implements LedgerService {
  public readonly inputs: RecordInput[] = [];
  public constructor(private readonly behaviour: () => Promise<RecordOutcome>) {}

  public recordAndEnqueue(input: RecordInput): Promise<RecordOutcome> {
    this.inputs.push(input);
    return this.behaviour();
  }
}

function harness(
  behaviour: () => Promise<StatusCounts> = () => Promise.resolve(IDLE_COUNTS),
  ledgerBehaviour: () => Promise<RecordOutcome> = () => Promise.resolve('won'),
  onJobEnqueued?: () => void,
) {
  const keypair = generateTestKeypair();
  const sink = new LogSink();
  const logger = createLogger('debug', sink);
  const reader = new FakeStatusReader(behaviour);
  const ledger = new FakeLedger(ledgerBehaviour);
  const controller = new InteractionController({
    publicKeyHex: keypair.publicKeyHex,
    replayWindowMs: REPLAY_WINDOW_MS,
    statusTimeoutMs: STATUS_TIMEOUT_MS,
    recordTimeoutMs: RECORD_TIMEOUT_MS,
    clock: { nowMs: () => NOW_MS },
    ledger,
    statusReader: reader,
    ...(onJobEnqueued ? { onJobEnqueued } : {}),
  });
  const app = createServer({ controller, logger, ...inertAuth() });

  const post = (
    body: string | Buffer,
    headers: Partial<SignedHeaders>,
    contentType = 'application/json',
  ) => request(app).post('/interactions').set('Content-Type', contentType).set(headers).send(body);

  const signedPost = (payload: unknown, timestamp = unixSeconds(NOW_MS)) => {
    const body = JSON.stringify(payload);
    return post(body, signRequest(keypair, timestamp, body));
  };

  return { app, keypair, sink, reader, ledger, post, signedPost };
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

describe('POST /interactions: recording before replying', () => {
  it('WHEN a user runs /status THE SYSTEM SHALL record it as answered with a skipped mirror and no job', async () => {
    const { signedPost, ledger } = harness();

    await signedPost(commandPayload('status')).expect(200);

    expect(ledger.inputs).toEqual([
      {
        interaction: {
          id: INTERACTION_ID,
          guildId: GUILD_ID,
          channelId: CHANNEL_ID,
          userId: USER_ID,
          type: 2,
          commandName: 'status',
          customId: null,
          options: {},
          status: 'answered',
        },
        action: {
          type: 'status',
          summary: ACTION_SUMMARIES.status,
          mirrorStatus: 'skipped',
        },
      },
    ]);
  });

  it('WHEN a command is unknown THE SYSTEM SHALL record it as an unknown_command action before the notice', async () => {
    const { signedPost, ledger } = harness();

    const res = await signedPost(commandPayload('nonsense'));

    expect(replyOf(res).data.content).toBe(MESSAGES.unknownCommand);
    expect(ledger.inputs).toHaveLength(1);
    expect(ledger.inputs[0]?.action.type).toBe('unknown_command');
    expect(ledger.inputs[0]?.interaction.commandName).toBe('nonsense');
    expect(ledger.inputs[0]?.job).toBeUndefined();
  });

  it('THE SYSTEM SHALL finish recording before it reads the status or replies', async () => {
    const events: string[] = [];
    const { signedPost } = harness(
      () => {
        events.push('read');
        return Promise.resolve(IDLE_COUNTS);
      },
      () => {
        events.push('record');
        return Promise.resolve('won');
      },
    );

    await signedPost(commandPayload('status')).expect(200);

    expect(events).toEqual(['record', 'read']);
  });

  it('WHEN the ledger reports a duplicate THE SYSTEM SHALL still give the normal reply and not treat it as a failure', async () => {
    const { signedPost, sink } = harness(undefined, () => Promise.resolve('duplicate'));

    const res = await signedPost(commandPayload('status'));

    expect(replyOf(res).data.content).toBe(
      'Reports today: 3 · Retrying: 1 · Worker last active 4 s ago.',
    );
    expect(sink.messages()).toContain('interaction.duplicate');
    expect(sink.messages()).not.toContain('ledger.record_failed');
  });

  it('WHEN recording fails THE SYSTEM SHALL say it was not recorded, ephemerally, and never claim success', async () => {
    const { signedPost, reader, sink } = harness(undefined, () =>
      Promise.reject(
        Object.assign(new Error(`Failing row contains (${FAKE_INTERACTION_TOKEN})`), {
          code: '08006',
        }),
      ),
    );

    const res = await signedPost(commandPayload('status'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: 4,
      data: {
        content: MESSAGES.notRecorded,
        allowed_mentions: { parse: [] },
        flags: EPHEMERAL,
      },
    });
    expect(reader.calls).toEqual([]);
    const failures = sink.records().filter((record) => record.msg === 'ledger.record_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ errorName: 'Error', errorCode: '08006' });
    expect(sink.text()).not.toContain(FAKE_INTERACTION_TOKEN);
  });

  it('WHEN recording hangs THE SYSTEM SHALL answer not-recorded well inside the 3 s limit', async () => {
    const { signedPost, reader } = harness(
      undefined,
      () => new Promise<RecordOutcome>(() => undefined),
    );
    const startedAt = performance.now();

    const res = await signedPost(commandPayload('status'));

    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(replyOf(res).data.content).toBe(MESSAGES.notRecorded);
    expect(replyOf(res).data.flags).toBe(EPHEMERAL);
    expect(reader.calls).toEqual([]);
  });

  it('WHEN a request is forged, stale, a PING, a DM or not yet supported THE SYSTEM SHALL record nothing', async () => {
    const { signedPost, post, keypair, ledger } = harness();
    const body = JSON.stringify(commandPayload('status'));

    await post(body, {
      ...signRequest(keypair, unixSeconds(NOW_MS), body),
      'x-signature-ed25519': '00'.repeat(64),
    });
    await signedPost(commandPayload('status'), unixSeconds(NOW_MS - 3_600_000));
    await signedPost(pingPayload);
    await signedPost(dmCommandPayload('status'));
    await signedPost(componentPayload('rpt:ack:1'));
    await signedPost(commandPayload('report'));

    expect(ledger.inputs).toEqual([]);
  });
});

describe('POST /interactions: /report with text', () => {
  const DEFER_EPHEMERAL = { type: 5, data: { flags: EPHEMERAL } };

  it('WHEN /report text:... runs THE SYSTEM SHALL record interaction, action and job, then defer with the rule visibility', async () => {
    const { signedPost, ledger } = harness();

    const res = await signedPost(reportPayload('  the printer is jammed  ')).expect(200);

    expect(res.body).toEqual(DEFER_EPHEMERAL);
    expect(ledger.inputs).toHaveLength(1);
    const [input] = ledger.inputs;
    expect(input?.interaction).toMatchObject({
      id: INTERACTION_ID,
      guildId: GUILD_ID,
      commandName: 'report',
      status: 'deferred',
    });
    expect(input?.action).toEqual({
      type: 'report',
      summary: ACTION_SUMMARIES.report,
      mirrorStatus: 'pending',
    });
    expect(input?.job?.kind).toBe('report');
    expect(input?.job?.interactionToken).toBe(FAKE_INTERACTION_TOKEN);
    expect(input?.job?.payload).toEqual({
      text: 'the printer is jammed',
      userId: USER_ID,
      channelId: CHANNEL_ID,
      ephemeral: true,
      replyMessage: 'Report logged. The team has been notified.',
      mirror: true,
      tag: false,
    });
  });

  it('SHALL expire the stored token 14 minutes 30 seconds after the request arrived', async () => {
    const { signedPost, ledger } = harness();

    await signedPost(reportPayload('x')).expect(200);

    expect(ledger.inputs[0]?.job?.tokenExpiresAt.getTime()).toBe(NOW_MS + 14.5 * 60_000);
  });

  it('WHEN the deferred reply is recorded THE SYSTEM SHALL nudge the worker once', async () => {
    let nudges = 0;
    const { signedPost } = harness(undefined, undefined, () => {
      nudges += 1;
    });

    await signedPost(reportPayload('x')).expect(200);

    expect(nudges).toBe(1);
  });

  it('WHEN the interaction is a duplicate THE SYSTEM SHALL give the same defer and not nudge the worker', async () => {
    let nudges = 0;
    const { signedPost } = harness(
      undefined,
      () => Promise.resolve('duplicate'),
      () => {
        nudges += 1;
      },
    );

    const res = await signedPost(reportPayload('x')).expect(200);

    expect(res.body).toEqual(DEFER_EPHEMERAL);
    expect(nudges).toBe(0);
  });

  it.each([
    ['no text option', commandPayload('report'), MESSAGES.emptyReport],
    ['only whitespace', reportPayload('   \n '), MESSAGES.emptyReport],
    [
      'a non-string text value',
      commandPayload('report', [{ name: 'text', type: 3, value: 7 }]),
      MESSAGES.emptyReport,
    ],
    ['1001 characters', reportPayload('a'.repeat(1001)), MESSAGES.reportTooLong],
  ])(
    'WHEN /report has %s THE SYSTEM SHALL answer with an ephemeral notice and record nothing',
    async (_name, payload, notice) => {
      const { signedPost, ledger } = harness();

      const res = await signedPost(payload).expect(200);

      expect(replyOf(res)).toMatchObject({ type: 4, data: { content: notice, flags: EPHEMERAL } });
      expect(ledger.inputs).toEqual([]);
    },
  );

  it('WHEN the report is exactly 1000 characters THE SYSTEM SHALL accept it', async () => {
    const { signedPost, ledger } = harness();

    const res = await signedPost(reportPayload('é'.repeat(1000))).expect(200);

    expect((res.body as { type: number }).type).toBe(5);
    expect(ledger.inputs).toHaveLength(1);
  });

  it('WHEN the ledger write fails THE SYSTEM SHALL say the report was not logged and not defer', async () => {
    let nudges = 0;
    const { signedPost } = harness(
      undefined,
      () => Promise.reject(new Error('db down')),
      () => {
        nudges += 1;
      },
    );

    const res = await signedPost(reportPayload('x')).expect(200);

    expect(replyOf(res)).toMatchObject({
      type: 4,
      data: { content: MESSAGES.notRecorded, flags: EPHEMERAL },
    });
    expect(nudges).toBe(0);
  });

  it('WHEN recording is slower than the record timeout THE SYSTEM SHALL answer notRecorded within the budget', async () => {
    const slow = () =>
      new Promise<RecordOutcome>((resolve) => {
        setTimeout(() => {
          resolve('won');
        }, RECORD_TIMEOUT_MS * 4);
      });
    const { signedPost } = harness(undefined, slow);

    const res = await signedPost(reportPayload('x')).expect(200);

    expect(replyOf(res).data.content).toBe(MESSAGES.notRecorded);
  });
});

describe('POST /interactions: other interactions', () => {
  it.each([
    ['an unknown command', commandPayload('nonsense'), MESSAGES.unknownCommand],
    ['/report with no text', commandPayload('report'), MESSAGES.emptyReport],
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
    const app = createServer({
      controller: throwing,
      logger: createLogger('debug', sink),
      ...inertAuth(),
    });

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
