import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { truncateAll, useTestDatabase } from '../../test/helpers/db.js';
import {
  FAKE_INTERACTION_TOKEN,
  GUILD_ID,
  INTERACTION_ID,
  commandPayload,
  modalSubmitPayload,
  reportPayload,
} from '../../test/helpers/payloads.js';
import { NOW_MS, makeJobsDue, wire, type Reply } from '../../test/helpers/pgApp.js';
import { slackWebhookUrl, usePipeline } from '../../test/helpers/workerHarness.js';
import { MESSAGES } from '../domain/messages.js';

// Rules as data at runtime (DESIGN §8.3): every path goes through resolveAction, a corrupt stored row never
// breaks a command, and a rule edited after the defer cannot change an in-flight job.

const db = useTestDatabase();
const pipeline = usePipeline(db);

const EPHEMERAL = 64;
const SENTINEL = 'RULE-VALUE-SENTINEL-DO-NOT-LOG';
const REPORT_TEXT = 'the printer on floor 2 is jammed';
const DEFAULT_REPLY = 'Report logged. The team has been notified.';

const goodReport = {
  version: 1,
  ephemeral: true,
  replyMessage: 'Custom reply.',
  mirror: true,
  tag: false,
};

async function putRule(
  pool: pg.Pool,
  command: 'report' | 'status',
  config: unknown,
  enabled = true,
): Promise<void> {
  await pool.query('INSERT INTO guild (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [GUILD_ID]);
  await pool.query(
    `INSERT INTO command_rule (guild_id, command_name, config, enabled) VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (guild_id, command_name) DO UPDATE SET config = EXCLUDED.config, enabled = EXCLUDED.enabled`,
    [GUILD_ID, command, JSON.stringify(config), enabled],
  );
}

/** The corruption an admin cannot cause through the API: raw SQL against the stored row. */
async function corruptRule(pool: pg.Pool, command: string, rawJson: string): Promise<void> {
  const updated = await pool.query(
    'UPDATE command_rule SET config = $3::jsonb WHERE guild_id = $1 AND command_name = $2',
    [GUILD_ID, command, rawJson],
  );
  expect(updated.rowCount).toBe(1);
}

const patchesOf = (h: ReturnType<ReturnType<typeof usePipeline>>) =>
  h.discord.requests.filter((request) => request.method === 'PATCH');
const postsOf = (h: ReturnType<ReturnType<typeof usePipeline>>) =>
  h.discord.requests.filter((request) => request.method === 'POST');

describe('rules are read at runtime', () => {
  it('WHEN /status is stored as public THE SYSTEM SHALL reply without the ephemeral flag', async () => {
    const pool = db();
    await truncateAll(pool);
    await putRule(pool, 'status', { version: 1, ephemeral: false });
    const { send } = wire(pool);

    const res = await send(commandPayload('status')).expect(200);

    expect((res.body as Reply).type).toBe(4);
    expect((res.body as Reply).data.flags).toBeUndefined();
  });

  it('WHEN /report has a stored reply message and mirror off THE SYSTEM SHALL snapshot both into the job', async () => {
    const pool = db();
    await truncateAll(pool);
    await putRule(pool, 'report', { ...goodReport, mirror: false, ephemeral: false });
    const { send } = wire(pool);

    const res = await send(reportPayload(REPORT_TEXT)).expect(200);

    expect(res.body).toEqual({ type: 5 });
    const job = await pool.query('SELECT payload FROM job');
    expect(job.rows[0]).toMatchObject({
      payload: { replyMessage: 'Custom reply.', mirror: false, ephemeral: false },
    });
    const action = await pool.query('SELECT mirror_status FROM action');
    expect(action.rows).toEqual([{ mirror_status: 'skipped' }]);
  });

  it.each([
    ['/status', () => commandPayload('status')],
    ['/report with text', () => reportPayload(REPORT_TEXT)],
    ['/report with no text', () => commandPayload('report')],
    ['a modal submit', () => modalSubmitPayload(REPORT_TEXT)],
  ])(
    'WHEN the command is turned off THE SYSTEM SHALL answer the disabled notice on %s',
    async (name, payload) => {
      const pool = db();
      await truncateAll(pool);
      const command = name === '/status' ? 'status' : 'report';
      await putRule(
        pool,
        command,
        command === 'status' ? { version: 1, ephemeral: true } : goodReport,
        false,
      );
      const { send } = wire(pool);

      const res = await send(payload()).expect(200);

      expect(res.body).toMatchObject({
        type: 4,
        data: { content: MESSAGES.disabled, flags: EPHEMERAL },
      });
      expect((await pool.query('SELECT 1 FROM job')).rowCount).toBe(0);
    },
  );
});

describe('a corrupt stored rule', () => {
  const corruptions: [string, string][] = [
    ['an unknown version with a wrong type', JSON.stringify({ version: 2, ephemeral: SENTINEL })],
    ['an unknown key holding a value', JSON.stringify({ ...goodReport, [SENTINEL]: SENTINEL })],
    ['JSON null', 'null'],
    ['a string', JSON.stringify(SENTINEL)],
    ['an array', JSON.stringify([SENTINEL])],
    ['an empty object', '{}'],
    [
      'a reply message that is too long',
      JSON.stringify({ ...goodReport, replyMessage: SENTINEL.repeat(20) }),
    ],
  ];

  it.each(corruptions)(
    'WHEN the row is %s (set with a real UPDATE) THE SYSTEM SHALL keep /report and /status working on the defaults and warn with field paths only',
    async (_name, rawJson) => {
      const pool = db();
      await truncateAll(pool);
      await putRule(pool, 'report', goodReport);
      await putRule(pool, 'status', { version: 1, ephemeral: false });
      await corruptRule(pool, 'report', rawJson);
      await corruptRule(pool, 'status', rawJson);
      const { send, sink } = wire(pool);

      const status = await send(commandPayload('status')).expect(200);
      const report = await send(reportPayload(REPORT_TEXT, '900000000000000801')).expect(200);
      const modal = await send(modalSubmitPayload(REPORT_TEXT, '900000000000000802')).expect(200);

      // Defaults: both ephemeral, the default reply text.
      expect(status.body).toMatchObject({ type: 4, data: { flags: EPHEMERAL } });
      expect(report.body).toEqual({ type: 5, data: { flags: EPHEMERAL } });
      expect(modal.body).toEqual({ type: 5, data: { flags: EPHEMERAL } });
      const jobs = await pool.query<{ payload: { replyMessage: string; ephemeral: boolean } }>(
        'SELECT payload FROM job',
      );
      expect(jobs.rows).toHaveLength(2);
      for (const row of jobs.rows) {
        expect(row.payload).toMatchObject({ replyMessage: DEFAULT_REPLY, ephemeral: true });
      }

      const warnings = sink.records().filter((record) => record.msg === 'rule.invalid_stored');
      expect(warnings).toHaveLength(3); // /status, /report with text, the modal submit
      for (const warning of warnings) {
        expect(warning.level).toBe(40);
        expect(Array.isArray(warning.fields)).toBe(true);
      }
      expect(sink.text()).not.toContain(SENTINEL);
    },
  );

  it('WHEN the corrupt row is also switched off THE SYSTEM SHALL still honour the switch', async () => {
    const pool = db();
    await truncateAll(pool);
    await putRule(pool, 'report', goodReport, false);
    await corruptRule(pool, 'report', '"garbage"');
    const { send } = wire(pool);

    const res = await send(reportPayload(REPORT_TEXT)).expect(200);

    expect((res.body as Reply).data.content).toBe(MESSAGES.disabled);
  });
});

describe('a rule edited after the defer', () => {
  async function deferWith(h: ReturnType<ReturnType<typeof usePipeline>>, ephemeral: boolean) {
    h.clock.set(NOW_MS);
    await db().query('INSERT INTO guild (id, mirror_webhook_enc) VALUES ($1, $2)', [
      GUILD_ID,
      h.cipher.encrypt(slackWebhookUrl(h), GUILD_ID),
    ]);
    await putRule(db(), 'report', { ...goodReport, ephemeral });
    const { send } = wire(db());
    await send(reportPayload(REPORT_TEXT, INTERACTION_ID)).expect(200);
  }

  it('WHEN the rule is switched off, made public and re-worded before the worker runs THE SYSTEM SHALL finish the job with the rule as it was at the defer', async () => {
    const h = pipeline();
    await deferWith(h, true);

    await putRule(
      db(),
      'report',
      { ...goodReport, ephemeral: false, replyMessage: 'Edited later.', mirror: false },
      false,
    );
    await makeJobsDue(db());
    await h.drain();

    expect(h.slack.requests).toHaveLength(1); // the mirror still happens
    expect(JSON.parse(patchesOf(h)[0]?.body ?? '{}')).toMatchObject({ content: 'Custom reply.' });
    expect(patchesOf(h)[0]?.body).not.toContain('Edited later');
  });

  it('WHEN the rule is made public after an ephemeral defer and the token is dead THE SYSTEM SHALL still keep the report text out of the public fallback', async () => {
    const h = pipeline();
    await deferWith(h, true);

    await putRule(db(), 'report', { ...goodReport, ephemeral: false });
    await db().query('UPDATE job SET token_expires_at = $1', [new Date(NOW_MS - 1000)]);
    await makeJobsDue(db());
    await h.drain();

    expect(patchesOf(h)).toHaveLength(0);
    const fallback = postsOf(h).find((request) => request.url.includes('/channels/'));
    expect(fallback?.body).toBeDefined();
    expect(fallback?.body).not.toContain('printer');
    expect(fallback?.body).not.toContain(FAKE_INTERACTION_TOKEN);
  });
});
