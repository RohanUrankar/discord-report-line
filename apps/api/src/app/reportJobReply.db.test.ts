import { describe, expect, it } from 'vitest';

import { useTestDatabase } from '../../test/helpers/db.js';
import {
  CHANNEL_ID,
  FAKE_INTERACTION_TOKEN,
  GUILD_ID,
  INTERACTION_ID,
  USER_ID,
  reportPayload,
} from '../../test/helpers/payloads.js';
import { NOW_MS, makeJobsDue, wire } from '../../test/helpers/pgApp.js';
import {
  APP_ID,
  BOT_TOKEN,
  NOTIFICATION_CHANNEL_ID,
  readAttempts,
  readJob,
  seedReport,
  slackWebhookUrl,
  usePipeline,
} from '../../test/helpers/workerHarness.js';
import type { StubRequest } from '../../test/helpers/stubServer.js';

const db = useTestDatabase();
const pipeline = usePipeline(db);

const TOKEN = `${FAKE_INTERACTION_TOKEN}-${INTERACTION_ID}`;
const REPORT_TEXT = 'the printer on floor 2 is jammed';

const patches = () => pipeline().discord.requests.filter((request) => request.method === 'PATCH');
const posts = () => pipeline().discord.requests.filter((request) => request.method === 'POST');
const bodyOf = (request: StubRequest | undefined) =>
  JSON.parse(request?.body ?? '{}') as {
    content: string;
    allowed_mentions: { parse: string[]; users?: string[] };
    flags?: number;
  };

describe('report job: filling the deferred reply', () => {
  it('WHEN /report text:... runs THE SYSTEM SHALL defer within 3 s and the worker SHALL later edit the original with the result', async () => {
    const h = pipeline();
    h.clock.set(NOW_MS); // the HTTP path stamps token expiry from its own fixed clock
    await db().query('INSERT INTO guild (id, mirror_webhook_enc) VALUES ($1, $2)', [
      GUILD_ID,
      h.cipher.encrypt(slackWebhookUrl(h), GUILD_ID),
    ]);
    const { send } = wire(db());

    const startedAt = Date.now();
    const res = await send(reportPayload(REPORT_TEXT)).expect(200);
    const elapsedMs = Date.now() - startedAt;

    expect(res.body).toEqual({ type: 5, data: { flags: 64 } });
    expect(elapsedMs).toBeLessThan(3000);
    expect(h.discord.requests).toEqual([]);

    await makeJobsDue(db());
    await h.drain();

    const [patch] = patches();
    expect(patch?.url).toBe(
      `/api/v10/webhooks/${APP_ID}/${FAKE_INTERACTION_TOKEN}/messages/@original`,
    );
    expect(bodyOf(patch)).toEqual({
      content: 'Report logged. The team has been notified.',
      allowed_mentions: { parse: [] },
    });
    expect(h.slack.requests).toHaveLength(1);
    expect(await readJob(db())).toMatchObject({
      status: 'done',
      interaction_status: 'followed_up',
      interaction_token: null,
      mirror_status: 'sent',
    });
  });

  it('WHEN the same /report is delivered 10 times concurrently THE SYSTEM SHALL end with one row, one job, one Slack post and one edited reply', async () => {
    const h = pipeline();
    h.clock.set(NOW_MS);
    await db().query('INSERT INTO guild (id, mirror_webhook_enc) VALUES ($1, $2)', [
      GUILD_ID,
      h.cipher.encrypt(slackWebhookUrl(h), GUILD_ID),
    ]);
    const { send } = wire(db());

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => send(reportPayload(REPORT_TEXT))),
    );
    await makeJobsDue(db());
    await h.drain();

    expect(new Set(responses.map((res) => res.text)).size).toBe(1);
    expect(responses[0]?.body).toEqual({ type: 5, data: { flags: 64 } });
    expect((await db().query('SELECT 1 FROM interaction')).rows).toHaveLength(1);
    expect((await db().query('SELECT 1 FROM job')).rows).toHaveLength(1);
    expect(h.slack.requests).toHaveLength(1);
    expect(patches()).toHaveLength(1);
  });

  it('WHEN the record is slower than the record timeout but still commits THE SYSTEM SHALL tell the user it was not logged and the worker SHALL later edit that message with the result', async () => {
    const h = pipeline();
    h.clock.set(NOW_MS);
    const { send } = wire(db(), { recordDelayMs: 300, recordTimeoutMs: 100 });

    const res = await send(reportPayload(REPORT_TEXT)).expect(200);

    expect(res.body).toMatchObject({
      type: 4,
      data: { content: "We couldn't log that right now. Please try again in a minute.", flags: 64 },
    });
    await waitUntil(async () => (await db().query('SELECT 1 FROM job')).rows.length === 1);

    await makeJobsDue(db());
    await h.drain();

    expect(patches()).toHaveLength(1);
    expect(await readJob(db())).toMatchObject({
      status: 'done',
      interaction_status: 'followed_up',
    });
  });

  it.each([401, 404])(
    'WHEN PATCH @original returns %i THE SYSTEM SHALL send exactly one PATCH, clear the token and post one fallback in the same pass with no retry',
    async (status) => {
      const h = pipeline();
      h.discord.behave((request) => (request.method === 'PATCH' ? { status } : { status: 200 }));
      await seedReport(db(), h, { postChannelId: NOTIFICATION_CHANNEL_ID });

      await h.drain();
      h.clock.advance(60_000);
      await h.drain();

      expect(patches()).toHaveLength(1);
      expect(posts()).toHaveLength(1);
      expect(posts()[0]?.url).toBe(`/api/v10/channels/${NOTIFICATION_CHANNEL_ID}/messages`);
      expect(posts()[0]?.headers.authorization).toBe(`Bot ${BOT_TOKEN}`);
      expect(await readJob(db())).toMatchObject({
        status: 'done',
        interaction_status: 'fallback_posted',
        interaction_token: null,
        attempts: 1,
      });
      expect(await readAttempts(db())).toMatchObject([
        { target: 'mirror', outcome: 'success' },
        { target: 'followup', outcome: 'fatal', http_status: status },
        { target: 'fallback', outcome: 'success' },
      ]);
    },
  );

  it('WHEN the server has no notification channel THE SYSTEM SHALL post the fallback in the channel the command ran in', async () => {
    const h = pipeline();
    h.discord.behave((request) => (request.method === 'PATCH' ? { status: 404 } : { status: 200 }));
    await seedReport(db(), h, { postChannelId: null });

    await h.drain();

    expect(posts()[0]?.url).toBe(`/api/v10/channels/${CHANNEL_ID}/messages`);
  });

  it('WHEN token_expires_at has passed THE SYSTEM SHALL make no webhook call to Discord and post via the bot token', async () => {
    const h = pipeline();
    await seedReport(db(), h, { tokenExpiresInMs: -1000 });

    await h.drain();

    expect(patches()).toEqual([]);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.headers.authorization).toBe(`Bot ${BOT_TOKEN}`);
    expect(await readJob(db())).toMatchObject({
      status: 'done',
      interaction_status: 'fallback_posted',
      interaction_token: null,
    });
    expect((await readAttempts(db())).map((row) => row.target)).toEqual(['mirror', 'fallback']);
  });

  it('WHEN the token expires at exactly this moment THE SYSTEM SHALL treat it as expired', async () => {
    const h = pipeline();
    await seedReport(db(), h, { tokenExpiresInMs: 0 });

    await h.drain();

    expect(patches()).toEqual([]);
    expect(posts()).toHaveLength(1);
  });

  it('WHEN the token expires while the job waits for a retry THE SYSTEM SHALL fall back on the next pass', async () => {
    const h = pipeline();
    h.discord.behave((request) => (request.method === 'PATCH' ? { status: 503 } : { status: 200 }));
    await seedReport(db(), h, { tokenExpiresInMs: 5000 });

    await h.drain();
    expect(patches()).toHaveLength(1);
    h.clock.advance(10_000);
    await h.drain();

    expect(patches()).toHaveLength(1);
    expect(posts()).toHaveLength(1);
    expect(await readJob(db())).toMatchObject({
      status: 'done',
      interaction_status: 'fallback_posted',
    });
  });

  it('WHEN an ephemeral report falls back THE SYSTEM SHALL NOT include the report text, and SHALL ping only the reporter', async () => {
    const h = pipeline();
    await seedReport(db(), h, { tokenExpiresInMs: -1, ephemeral: true, text: REPORT_TEXT });

    await h.drain();

    const body = bodyOf(posts()[0]);
    expect(body.content).toBe(`<@${USER_ID}>, your report was logged (ref \`${INTERACTION_ID}\`)`);
    expect(body.content).not.toContain('printer');
    expect(posts()[0]?.body).not.toContain('printer');
    expect(body.allowed_mentions).toEqual({ parse: [], users: [USER_ID] });
  });

  it('WHEN a public report falls back THE SYSTEM SHALL quote it, still pinging only the reporter and never anyone named in the text', async () => {
    const h = pipeline();
    await seedReport(db(), h, {
      tokenExpiresInMs: -1,
      ephemeral: false,
      text: 'hey @everyone <@999999999999999999>',
    });

    await h.drain();

    const body = bodyOf(posts()[0]);
    expect(body.content).toContain('hey @everyone');
    expect(body.allowed_mentions).toEqual({ parse: [], users: [USER_ID] });
  });

  it('WHEN Discord answers 429 with retry_after THE SYSTEM SHALL schedule the next attempt no earlier than that', async () => {
    const h = pipeline();
    h.discord.behave((request, call) =>
      request.method === 'PATCH' && call === 0
        ? {
            status: 429,
            headers: { 'retry-after': '91' },
            body: '{"retry_after":90.5,"global":false}',
          }
        : { status: 200 },
    );
    await seedReport(db(), h);
    const startedAt = h.clock.nowMs();

    await h.drain();

    expect((await readJob(db())).next_run_at.getTime()).toBe(startedAt + 91_000);
    h.clock.advance(90_999);
    expect(await h.drain()).toBe(0);
    h.clock.advance(1);
    expect(await h.drain()).toBe(1);
    expect(h.slack.requests).toHaveLength(1);
    expect(await readJob(db())).toMatchObject({ status: 'done' });
  });

  it('WHEN PATCH keeps failing with 5xx until the attempts run out THE SYSTEM SHALL end the job dead and the interaction failed, with the reason visible', async () => {
    const h = pipeline();
    h.discord.behave(() => ({ status: 502 }));
    await seedReport(db(), h);

    for (let pass = 0; pass < 8; pass += 1) {
      await h.drain();
      h.clock.advance(1000);
    }

    const job = await readJob(db());
    expect(job).toMatchObject({
      status: 'dead',
      interaction_status: 'failed',
      interaction_token: null,
    });
    expect(job.last_error).toBe(
      'Discord had a problem on its side (HTTP 502). Gave up after 8 attempts.',
    );
    expect(patches()).toHaveLength(8);
    expect(posts()).toEqual([]);
    expect(h.slack.requests).toHaveLength(1);
  });

  it('WHEN Discord is slower than the timeout THE SYSTEM SHALL record a retryable timeout and retry', async () => {
    const h = pipeline();
    h.discord.behave((_request, call) =>
      call === 0 ? { status: 200, delayMs: 1500 } : { status: 200 },
    );
    await seedReport(db(), h);

    await h.drain();
    h.clock.advance(1000);
    await h.drain();

    expect(await readAttempts(db())).toMatchObject([
      { target: 'mirror', outcome: 'success' },
      { target: 'followup', outcome: 'retryable', error: 'Discord did not answer in time.' },
      { target: 'followup', outcome: 'success' },
    ]);
  });

  it('WHEN the channel fallback fails with a retryable error THE SYSTEM SHALL retry only the fallback, skipping the mirror and the edit', async () => {
    const h = pipeline();
    h.discord.behave((request, call) => {
      if (request.method === 'PATCH') {
        return { status: 404 };
      }
      return call === 1 ? { status: 500 } : { status: 200 };
    });
    await seedReport(db(), h);

    await h.drain();
    h.clock.advance(1000);
    await h.drain();

    expect(h.slack.requests).toHaveLength(1);
    expect(patches()).toHaveLength(1);
    expect(posts()).toHaveLength(2);
    expect(await readJob(db())).toMatchObject({
      status: 'done',
      interaction_status: 'fallback_posted',
    });
  });

  it('WHEN the bot may not post in the channel THE SYSTEM SHALL end the job dead and the interaction failed, naming the permissions', async () => {
    const h = pipeline();
    h.discord.behave((request) => (request.method === 'PATCH' ? { status: 404 } : { status: 403 }));
    await seedReport(db(), h);

    await h.drain();
    h.clock.advance(60_000);
    await h.drain();

    const job = await readJob(db());
    expect(job).toMatchObject({
      status: 'dead',
      interaction_status: 'failed',
      interaction_token: null,
    });
    expect(job.last_error).toBe(
      'The bot cannot post in that channel (HTTP 403). Give it View Channel and Send Messages.',
    );
    expect(posts()).toHaveLength(1);
  });

  it('WHEN the saved payload is unreadable THE SYSTEM SHALL end the job dead without calling anyone', async () => {
    const h = pipeline();
    await seedReport(db(), h);
    await db().query('UPDATE job SET payload = \'{"text": 5}\'::jsonb');

    await h.drain();

    expect(await readJob(db())).toMatchObject({
      status: 'dead',
      interaction_status: 'failed',
      interaction_token: null,
    });
    expect(h.slack.requests).toEqual([]);
    expect(h.discord.requests).toEqual([]);
  });

  it('WHEN a job has been orphaned by too many dead workers THE SYSTEM SHALL stop retrying it and end it dead', async () => {
    const h = pipeline();
    await seedReport(db(), h);
    await db().query('UPDATE job SET attempts = 8');

    await h.drain();

    const job = await readJob(db());
    expect(job).toMatchObject({ status: 'dead', interaction_status: 'failed', attempts: 9 });
    expect(job.last_error).toBe('The worker stopped before finishing. Gave up after 8 attempts.');
    expect(h.discord.requests).toEqual([]);
  });

  it('SHALL keep the interaction token and the bot token out of every log line', async () => {
    const h = pipeline();
    h.discord.behave((request) => (request.method === 'PATCH' ? { status: 404 } : { status: 200 }));
    await seedReport(db(), h);

    await h.drain();

    expect(h.logs.text()).not.toContain(TOKEN);
    expect(h.logs.text()).not.toContain(BOT_TOKEN);
    expect(h.logs.messages()).toEqual(expect.arrayContaining(['job.attempt', 'job.done']));
  });
});

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
