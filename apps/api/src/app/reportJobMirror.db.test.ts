import { describe, expect, it } from 'vitest';

import { useTestDatabase } from '../../test/helpers/db.js';
import { FAKE_INTERACTION_TOKEN, GUILD_ID, INTERACTION_ID } from '../../test/helpers/payloads.js';
import { thenOk } from '../../test/helpers/stubServer.js';
import {
  readAttempts,
  readJob,
  seedReport,
  slackWebhookUrl,
  usePipeline,
  WEBHOOK_SECRET,
} from '../../test/helpers/workerHarness.js';
import { MESSAGES } from '../domain/messages.js';

const db = useTestDatabase();
const pipeline = usePipeline(db);

const TOKEN = `${FAKE_INTERACTION_TOKEN}-${INTERACTION_ID}`;
const patches = () => pipeline().discord.requests.filter((request) => request.method === 'PATCH');
const slackTexts = () =>
  pipeline().slack.requests.map((request) => (JSON.parse(request.body) as { text: string }).text);

describe('report job: the Slack mirror', () => {
  it('WHEN Slack accepts the notification THE SYSTEM SHALL mark it sent, record one successful attempt and then edit the reply', async () => {
    const h = pipeline();
    await seedReport(db(), h);

    await h.drain();

    expect(h.slack.requests).toHaveLength(1);
    expect((await readJob(db())).mirror_status).toBe('sent');
    expect(await readAttempts(db())).toMatchObject([
      { attempt_no: 1, target: 'mirror', outcome: 'success', http_status: 200 },
      { attempt_no: 1, target: 'followup', outcome: 'success', http_status: 200 },
    ]);
    expect(patches()).toHaveLength(1);
  });

  it('WHEN Slack returns 500 then 200 THE SYSTEM SHALL record both attempts, post once successfully and fill the deferred reply', async () => {
    const h = pipeline();
    h.slack.behave(thenOk(500));
    await seedReport(db(), h);

    await h.drain();
    const afterFirstPass = await readJob(db());
    expect(afterFirstPass).toMatchObject({ status: 'pending', mirror_status: 'pending' });
    expect(afterFirstPass.next_run_at.getTime()).toBe(h.clock.nowMs() + 100);
    expect(patches()).toHaveLength(0);

    h.clock.advance(100);
    await h.drain();

    const mirrorAttempts = (await readAttempts(db())).filter((row) => row.target === 'mirror');
    expect(mirrorAttempts).toMatchObject([
      { attempt_no: 1, outcome: 'retryable', http_status: 500 },
      { attempt_no: 2, outcome: 'success', http_status: 200 },
    ]);
    expect(h.slack.requests).toHaveLength(2);
    expect(patches()).toHaveLength(1);
    expect(await readJob(db())).toMatchObject({
      status: 'done',
      interaction_status: 'followed_up',
    });
  });

  it('WHEN Slack is down through several backoff cycles and then recovers THE SYSTEM SHALL drain every job with none lost and none posted twice', async () => {
    const h = pipeline();
    h.slack.behave(() => ({ status: 503 }));
    const ids = Array.from(
      { length: 5 },
      (_unused, index) => `9300000000000000${String(index).padStart(2, '0')}`,
    );
    for (const id of ids) {
      await seedReport(db(), h, { id, text: `report ${id}` });
    }

    for (let cycle = 0; cycle < 4; cycle += 1) {
      await h.drain();
      h.clock.advance(1000);
    }
    expect(patches()).toHaveLength(0);
    for (const id of ids) {
      expect(await readJob(db(), id)).toMatchObject({ status: 'pending' });
    }

    h.slack.reset();
    await h.drain();

    // reset() cleared the outage's failed calls, so what Slack saw now is exactly the recovery: one per job.
    expect(h.slack.requests).toHaveLength(5);
    expect(new Set(h.slack.requests.map((request) => request.body)).size).toBe(5);
    expect(patches()).toHaveLength(5);
    expect(new Set(patches().map((request) => request.url)).size).toBe(5);
    for (const id of ids) {
      expect(await readJob(db(), id)).toMatchObject({
        status: 'done',
        mirror_status: 'sent',
        interaction_status: 'followed_up',
      });
    }
  });

  it('WHEN the mirror succeeded and the reply then fails THE SYSTEM SHALL make no further Slack call on the retry', async () => {
    const h = pipeline();
    h.discord.behave((request, call) =>
      request.method === 'PATCH' && call === 0 ? { status: 500 } : { status: 200 },
    );
    await seedReport(db(), h);

    await h.drain();
    h.clock.advance(1000);
    await h.drain();

    expect(h.slack.requests).toHaveLength(1);
    expect(patches()).toHaveLength(2);
    expect(await readJob(db())).toMatchObject({ status: 'done', mirror_status: 'sent' });
    expect((await readAttempts(db())).map((row) => `${row.target}:${row.outcome}`)).toEqual([
      'mirror:success',
      'followup:retryable',
      'followup:success',
    ]);
  });

  it('WHEN Slack returns 404 THE SYSTEM SHALL mark the mirror failed, still answer the user, end the job dead with a readable reason and never call Slack again', async () => {
    const h = pipeline();
    h.slack.behave(() => ({ status: 404, body: 'no_service' }));
    await seedReport(db(), h);

    await h.drain();
    h.clock.advance(60_000);
    await h.drain();

    const job = await readJob(db());
    expect(job).toMatchObject({
      status: 'dead',
      mirror_status: 'failed',
      interaction_status: 'followed_up',
      interaction_token: null,
    });
    expect(job.last_error).toBe(
      'Slack says the webhook no longer exists (HTTP 404). Set a new webhook URL on the dashboard.',
    );
    expect(h.slack.requests).toHaveLength(1);
    expect(patches()).toHaveLength(1);
    expect((JSON.parse(patches()[0]?.body ?? '') as { content: string }).content).toContain(
      MESSAGES.mirrorFailed,
    );
    expect(await readAttempts(db())).toMatchObject([
      { target: 'mirror', outcome: 'fatal', http_status: 404 },
      { target: 'followup', outcome: 'success' },
    ]);
  });

  it('WHEN Slack keeps failing until the attempts run out THE SYSTEM SHALL give up on the mirror, answer the user and end the job dead', async () => {
    const h = pipeline();
    h.slack.behave(() => ({ status: 500 }));
    await seedReport(db(), h);
    // maxAttempts is 8 in the default harness: eight passes, the last one gives up on the mirror.
    for (let pass = 0; pass < 8; pass += 1) {
      await h.drain();
      h.clock.advance(1000);
    }

    const job = await readJob(db());
    expect(job).toMatchObject({
      status: 'dead',
      mirror_status: 'failed',
      interaction_status: 'followed_up',
    });
    expect(job.last_error).toContain('Gave up after 8 attempts.');
    expect(h.slack.requests).toHaveLength(8);
    expect(patches()).toHaveLength(1);
  });

  it('WHEN the server has no webhook THE SYSTEM SHALL skip the mirror, record no mirror attempt and still deliver the reply', async () => {
    const h = pipeline();
    await seedReport(db(), h, { webhook: 'none' });

    await h.drain();

    expect(h.slack.requests).toEqual([]);
    expect(await readJob(db())).toMatchObject({ status: 'done', mirror_status: 'skipped' });
    expect((await readAttempts(db())).map((row) => row.target)).toEqual(['followup']);
    expect(patches()).toHaveLength(1);
  });

  it('WHEN the rule turns the mirror off THE SYSTEM SHALL not call Slack even though a webhook exists', async () => {
    const h = pipeline();
    await seedReport(db(), h, { mirror: false });

    await h.drain();

    expect(h.slack.requests).toEqual([]);
    expect(await readJob(db())).toMatchObject({ status: 'done', mirror_status: 'skipped' });
  });

  it('WHEN the stored webhook is garbage THE SYSTEM SHALL fail the mirror fatally without leaking anything and still answer the user', async () => {
    const h = pipeline();
    await seedReport(db(), h, {
      webhook: Buffer.from('definitely not a valid blob at all, sorry'),
    });

    await h.drain();

    const job = await readJob(db());
    expect(job).toMatchObject({
      status: 'dead',
      mirror_status: 'failed',
      interaction_status: 'followed_up',
    });
    expect(job.last_error).toBe(
      'The saved Slack webhook could not be read. Set the webhook URL again on the dashboard.',
    );
    expect(h.slack.requests).toEqual([]);
    expect(await readAttempts(db())).toMatchObject([
      { target: 'mirror', outcome: 'fatal', http_status: null },
      { target: 'followup', outcome: 'success' },
    ]);
    expect(h.logs.text()).not.toContain(WEBHOOK_SECRET);
  });

  it('WHEN the stored ciphertext was tampered with THE SYSTEM SHALL treat it as a fatal mirror failure with no URL in any log or error', async () => {
    const h = pipeline();
    const good = h.cipher.encrypt(slackWebhookUrl(h), GUILD_ID);
    good[good.length - 1] = (good[good.length - 1] ?? 0) ^ 0x01;
    await seedReport(db(), h, { webhook: good });

    await h.drain();

    const job = await readJob(db());
    expect(job).toMatchObject({ status: 'dead', mirror_status: 'failed' });
    const everything = [
      job.last_error ?? '',
      ...(await readAttempts(db())).map((row) => row.error ?? ''),
      h.logs.text(),
    ].join('\n');
    expect(everything).not.toContain(WEBHOOK_SECRET);
    expect(everything).not.toContain('hooks');
    expect(h.slack.requests).toEqual([]);
  });

  it('WHEN a stored webhook points outside the allowed prefix THE SYSTEM SHALL refuse to call it', async () => {
    const h = pipeline();
    const elsewhere = h.cipher.encrypt('http://169.254.169.254/latest/meta-data/', GUILD_ID);
    await seedReport(db(), h, { webhook: elsewhere });

    await h.drain();

    expect(await readJob(db())).toMatchObject({ status: 'dead', mirror_status: 'failed' });
    expect(h.slack.requests).toEqual([]);
  });

  it('WHEN the report contains Slack control sequences THE SYSTEM SHALL send them escaped', async () => {
    const h = pipeline();
    await seedReport(db(), h, { text: 'hi <!channel> and <@U123> & <https://evil.test|click>' });

    await h.drain();

    const [text] = slackTexts();
    expect(text).toContain(
      'hi &lt;!channel&gt; and &lt;@U123&gt; &amp; &lt;https://evil.test|click&gt;',
    );
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<@U123>');
  });

  it('WHEN Slack answers 429 with Retry-After THE SYSTEM SHALL schedule the next attempt no earlier than that, even past the backoff cap', async () => {
    const h = pipeline();
    h.slack.behave((_request, call) =>
      call === 0 ? { status: 429, headers: { 'retry-after': '120' } } : { status: 200 },
    );
    await seedReport(db(), h);
    const startedAt = h.clock.nowMs();

    await h.drain();
    const job = await readJob(db());

    expect(job.status).toBe('pending');
    expect(job.next_run_at.getTime()).toBe(startedAt + 120_000);
    h.clock.advance(119_999);
    expect(await h.drain()).toBe(0);
    h.clock.advance(1);
    expect(await h.drain()).toBe(1);
    expect(await readJob(db())).toMatchObject({ status: 'done' });
  });

  it('WHEN Slack is slower than the timeout THE SYSTEM SHALL record a retryable timeout and try again later', async () => {
    const h = pipeline();
    h.slack.behave((_request, call) =>
      call === 0 ? { status: 200, delayMs: 1500 } : { status: 200 },
    );
    await seedReport(db(), h);

    await h.drain();

    expect((await readAttempts(db()))[0]).toMatchObject({
      target: 'mirror',
      outcome: 'retryable',
      http_status: null,
      error: 'Slack did not answer in time.',
    });
    expect((await readJob(db())).status).toBe('pending');
  });

  it('SHALL use the interaction token only for the reply and keep the webhook URL out of every table and log', async () => {
    const h = pipeline();
    h.slack.behave(thenOk(500, 404));
    await seedReport(db(), h);
    await h.drain();
    h.clock.advance(1000);
    await h.drain();

    const stored = await db().query<{ hit: string }>(
      `SELECT 'attempt' AS hit FROM job_attempt WHERE job_attempt::text LIKE ANY ($1)
       UNION ALL SELECT 'job' FROM job WHERE job::text LIKE ANY ($1)
       UNION ALL SELECT 'interaction' FROM interaction WHERE interaction::text LIKE ANY ($1)
       UNION ALL SELECT 'action' FROM action WHERE action::text LIKE ANY ($1)
       UNION ALL SELECT 'guild' FROM guild WHERE guild::text LIKE ANY ($1)`,
      [[`%${WEBHOOK_SECRET}%`, `%${TOKEN}%`, '%hooks.slack.com%']],
    );
    expect(stored.rows).toEqual([]);
    expect(h.logs.text()).not.toContain(WEBHOOK_SECRET);
    expect(h.logs.text()).not.toContain(TOKEN);
  });
});
