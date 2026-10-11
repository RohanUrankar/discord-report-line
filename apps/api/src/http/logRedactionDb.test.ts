import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { PgJobRepository } from '../adapters/pg/pgJobRepository.js';
import { useTestDatabase } from '../../test/helpers/db.js';
import { GEMINI_TEST_KEY, geminiTag } from '../../test/helpers/gemini.js';
import { GUILD_ID, reportPayload } from '../../test/helpers/payloads.js';
import { NOW_MS, makeJobsDue, wire } from '../../test/helpers/pgApp.js';
import { signRequest, unixSeconds, type SignedHeaders } from '../../test/helpers/signing.js';
import {
  BOT_TOKEN,
  TEST_ENC_KEY,
  WEBHOOK_SECRET,
  seedReport,
  slackWebhookUrl,
  usePipeline,
} from '../../test/helpers/workerHarness.js';
import { createLogger } from './middleware.js';
import { LogSink } from '../../test/helpers/logging.js';

// F (secret sweep): the log is judged on what pino REALLY wrote while the whole system ran, not on a unit test
// of the redact list. Every leg of the report job is driven, including a Discord failure, the channel fallback
// and a dead job, and the request path with a forged and a stale request. Sentinels are fake values that look
// like the real secrets, so a leak shows up as an exact string.

const db = useTestDatabase();
const pipeline = usePipeline(db, { llm: { timeoutMs: 300 } });

const REPORT_SENTINEL = 'report-text-sentinel-7731';
/** Every interaction token in these tests starts with this prefix (see FAKE_INTERACTION_TOKEN). */
const TOKEN_PREFIX = 'fake-interaction-token-do-not-log';
const AUTHORIZATION_SENTINEL = 'authorization-sentinel-4410';

describe('log redaction against real pino output', () => {
  it('WHEN every leg of /report runs (success, retries, Gemini failure, Discord failure, fallback, dead job) THE SYSTEM SHALL log no secret and no report text', async () => {
    const h = pipeline();
    h.clock.set(NOW_MS);
    await db().query(
      'INSERT INTO guild (id, mirror_webhook_enc, post_channel_id) VALUES ($1, $2, $3)',
      [GUILD_ID, h.cipher.encrypt(slackWebhookUrl(h), GUILD_ID), '900000000000000099'],
    );
    const { app, sink, keypair, send } = wire(db());

    // Request path: forged, stale, then a real /report and its duplicate.
    const body = JSON.stringify(reportPayload(`${REPORT_SENTINEL} http`, '900000000000000701'));
    const post = (headers: Partial<SignedHeaders>) =>
      request(app)
        .post('/interactions')
        .set('Content-Type', 'application/json')
        .set(headers)
        .send(body);
    await post({
      ...signRequest(keypair, unixSeconds(NOW_MS), body),
      'x-signature-ed25519': '00'.repeat(64),
    });
    await post(signRequest(keypair, unixSeconds(NOW_MS - 3_600_000), body)).set(
      'authorization',
      `Bot ${AUTHORIZATION_SENTINEL}`,
    );
    await send(reportPayload(`${REPORT_SENTINEL} http`, '900000000000000701')).expect(200);
    await send(reportPayload(`${REPORT_SENTINEL} http`, '900000000000000701')).expect(200);
    await makeJobsDue(db());
    await h.drain();

    // Worker legs. Each leg sets what Slack, Gemini and Discord do, then drains.
    await seedReport(db(), h, {
      id: '900000000000000702',
      tag: true,
      text: `${REPORT_SENTINEL} a`,
    });
    h.gemini.behave(() => geminiTag('bug'));
    let slackCalls = 0;
    h.slack.behave(() => ({ status: (slackCalls += 1) === 1 ? 500 : 200 }));
    await h.drain();
    h.clock.advance(1000);
    await h.drain();

    await seedReport(db(), h, {
      id: '900000000000000703',
      tag: true,
      text: `${REPORT_SENTINEL} b`,
    });
    h.gemini.behave(() => ({ status: 503 }));
    h.slack.reset();
    h.discord.behave((request_) =>
      request_.method === 'PATCH' ? { status: 404 } : { status: 200 },
    );
    await h.drain();

    await seedReport(db(), h, {
      id: '900000000000000704',
      tag: true,
      text: `${REPORT_SENTINEL} c`,
    });
    h.gemini.behave(() => ({ status: 200, body: 'not json' }));
    h.discord.behave((request_) =>
      request_.method === 'PATCH' ? { status: 404 } : { status: 403 },
    );
    await h.drain();

    await seedReport(db(), h, {
      id: '900000000000000705',
      tag: true,
      text: `${REPORT_SENTINEL} d`,
    });
    h.gemini.behave(() => ({ status: 200, destroy: true }));
    h.slack.behave(() => ({ status: 404 }));
    h.discord.reset();
    await h.drain();

    const combined = `${sink.text()}\n${h.logs.text()}`;
    const messages = [...sink.messages(), ...h.logs.messages()];

    // The run really happened: the legs left their log lines (a silent logger would pass the checks below).
    expect(messages).toEqual(
      expect.arrayContaining([
        'interaction.signature_rejected',
        'interaction.timestamp_rejected',
        'interaction.received',
        'job.attempt',
        'job.retry_scheduled',
        'job.done',
        'job.dead',
      ]),
    );
    const attempts = await db().query<{ target: string }>(
      'SELECT DISTINCT target FROM job_attempt',
    );
    expect(attempts.rows.map((row) => row.target).sort()).toEqual([
      'fallback',
      'followup',
      'mirror',
      'tag',
    ]);

    const secrets: [string, string][] = [
      ['interaction token', TOKEN_PREFIX],
      ['bot token', BOT_TOKEN],
      ['Slack webhook secret', WEBHOOK_SECRET],
      ['Slack webhook URL', slackWebhookUrl(h)],
      ['Gemini key', GEMINI_TEST_KEY],
      ['webhook encryption key', TEST_ENC_KEY],
      ['authorization header value', AUTHORIZATION_SENTINEL],
      ['report text', REPORT_SENTINEL],
    ];
    for (const [name, value] of secrets) {
      expect(combined.includes(value), `${name} must not appear in any log line`).toBe(false);
    }
  });

  it('WHEN a whole claimed job or a stored row is logged by mistake THE SYSTEM SHALL redact the token in the CURRENT job shape', async () => {
    const h = pipeline();
    await seedReport(db(), h, { id: '900000000000000711', tag: true });
    const claimed = await new PgJobRepository(db()).claim({
      limit: 5,
      nowMs: h.clock.nowMs(),
      leaseMs: 60_000,
    });
    expect(claimed[0]?.interactionToken).toContain(TOKEN_PREFIX);
    const row = await db().query<Record<string, unknown>>('SELECT * FROM job');
    const sink = new LogSink();
    const logger = createLogger('debug', sink);

    logger.info({ job: claimed[0] }, 'one.job');
    logger.info({ jobs: claimed }, 'many.jobs');
    logger.info({ row: row.rows[0] }, 'one.row');
    logger.info({ input: { job: claimed[0] } }, 'deep.job');
    logger.info(
      { req: { headers: { authorization: `Bot ${AUTHORIZATION_SENTINEL}` } } },
      'headers',
    );

    expect(sink.lines).toHaveLength(5);
    expect(sink.text()).not.toContain(TOKEN_PREFIX);
    expect(sink.text()).not.toContain(AUTHORIZATION_SENTINEL);
    expect(sink.text()).toContain('[redacted]');
  });
});
