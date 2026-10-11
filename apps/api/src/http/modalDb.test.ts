import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { truncateAll, useTestDatabase } from '../../test/helpers/db.js';
import {
  FAKE_INTERACTION_TOKEN,
  GUILD_ID,
  INTERACTION_ID,
  commandPayload,
  legacyModalSubmitPayload,
  modalSubmitPayload,
  reportPayload,
} from '../../test/helpers/payloads.js';
import { NOW_MS, makeJobsDue, wire, type Reply } from '../../test/helpers/pgApp.js';
import { slackWebhookUrl, usePipeline, type Harness } from '../../test/helpers/workerHarness.js';
import { MESSAGES } from '../domain/messages.js';

// Modal path (DESIGN §5.2): /report with no text opens a form; the submit is a fresh interaction. Real
// Postgres, the production wiring, signed requests.

const db = useTestDatabase();
const pipeline = usePipeline(db);

const EPHEMERAL = 64;
const REPORT_TEXT = 'the printer on floor 2 is jammed';
const SECOND_SUBMIT_ID = '900000000000000555';

const count = async (pool: pg.Pool, table: 'interaction' | 'action' | 'job'): Promise<number> =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ?? -1;

async function setRule(
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

async function configureWebhook(h: Harness): Promise<void> {
  h.clock.set(NOW_MS);
  await db().query(
    'INSERT INTO guild (id, mirror_webhook_enc) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET mirror_webhook_enc = EXCLUDED.mirror_webhook_enc',
    [GUILD_ID, h.cipher.encrypt(slackWebhookUrl(h), GUILD_ID)],
  );
}

describe('/report with no text: opening the modal', () => {
  it('WHEN /report runs with no text THE SYSTEM SHALL answer type 9 with a Label-wrapped paragraph input and create no job', async () => {
    const pool = db();
    await truncateAll(pool);
    const { send } = wire(pool);

    const res = await send(commandPayload('report')).expect(200);

    expect(res.body).toMatchObject({
      type: 9,
      data: {
        custom_id: 'report_modal',
        components: [
          {
            type: 18,
            component: {
              type: 4,
              custom_id: 'report_text',
              style: 2,
              min_length: 1,
              max_length: 1000,
              required: true,
            },
          },
        ],
      },
    });
    expect(await count(pool, 'interaction')).toBe(0);
    expect(await count(pool, 'action')).toBe(0);
    expect(await count(pool, 'job')).toBe(0);
  });

  it('WHEN /report is disabled THE SYSTEM SHALL answer the disabled notice and never open the modal', async () => {
    const pool = db();
    await truncateAll(pool);
    await setRule(
      pool,
      'report',
      { version: 1, ephemeral: true, replyMessage: 'x', mirror: true, tag: false },
      false,
    );
    const { send } = wire(pool);

    const res = await send(commandPayload('report')).expect(200);

    expect(res.body).toMatchObject({
      type: 4,
      data: { content: MESSAGES.disabled, flags: EPHEMERAL },
    });
    expect(await count(pool, 'job')).toBe(0);
  });

  it('WHEN the text option is present but blank THE SYSTEM SHALL say so rather than open the modal', async () => {
    const pool = db();
    await truncateAll(pool);
    const { send } = wire(pool);

    const res = await send(reportPayload('   ')).expect(200);

    expect((res.body as Reply).data.content).toBe(MESSAGES.emptyReport);
  });
});

describe('/report modal submit', () => {
  it.each([
    ['Label layout', () => modalSubmitPayload(`  ${REPORT_TEXT}  `)],
    ['legacy Action Row layout', () => legacyModalSubmitPayload(`  ${REPORT_TEXT}  `)],
  ])(
    'WHEN the %s is submitted THE SYSTEM SHALL defer, record one interaction and one job, and the worker SHALL finish it like the text option',
    async (_name, payload) => {
      const h = pipeline();
      await configureWebhook(h);
      const { send, sink } = wire(db());

      const res = await send(payload()).expect(200);

      expect(res.body).toEqual({ type: 5, data: { flags: EPHEMERAL } });
      const interaction = await db().query(
        'SELECT type, command_name, custom_id, options, status FROM interaction',
      );
      expect(interaction.rows).toEqual([
        {
          type: 5,
          command_name: 'report',
          custom_id: 'report_modal',
          options: null,
          status: 'deferred',
        },
      ]);
      expect(await count(db(), 'action')).toBe(1);
      expect(await count(db(), 'job')).toBe(1);
      const job = await db().query<{ payload: { text: string; ephemeral: boolean } }>(
        'SELECT payload FROM job',
      );
      expect(job.rows[0]?.payload).toMatchObject({ text: REPORT_TEXT, ephemeral: true });

      await makeJobsDue(db());
      await h.drain();

      const patches = h.discord.requests.filter((request) => request.method === 'PATCH');
      expect(patches).toHaveLength(1);
      expect(JSON.parse(patches[0]?.body ?? '{}')).toMatchObject({
        content: 'Report logged. The team has been notified.',
        allowed_mentions: { parse: [] },
      });
      expect(h.slack.requests).toHaveLength(1);
      const done = await db().query('SELECT status FROM job');
      expect(done.rows).toEqual([{ status: 'done' }]);
      expect(sink.text()).not.toContain(FAKE_INTERACTION_TOKEN);
    },
  );

  it.each([
    ['whitespace only', () => modalSubmitPayload(' \n\t '), MESSAGES.emptyReport],
    ['1001 characters', () => modalSubmitPayload('a'.repeat(1001)), MESSAGES.reportTooLong],
    ['the text field missing', () => modalSubmitPayload(undefined), MESSAGES.emptyReport],
    [
      'an unknown custom_id',
      () => modalSubmitPayload(REPORT_TEXT, INTERACTION_ID, 'other_modal'),
      MESSAGES.unknownForm,
    ],
  ])(
    'WHEN the submit has %s THE SYSTEM SHALL answer an ephemeral notice and record no row and no job',
    async (_name, payload, notice) => {
      const pool = db();
      await truncateAll(pool);
      const { send } = wire(pool);

      const res = await send(payload()).expect(200);

      expect(res.body).toMatchObject({ type: 4, data: { content: notice, flags: EPHEMERAL } });
      expect(await count(pool, 'interaction')).toBe(0);
      expect(await count(pool, 'job')).toBe(0);
    },
  );

  it('WHEN the same submit is delivered 10 times concurrently THE SYSTEM SHALL create one row and one job', async () => {
    const pool = db();
    await truncateAll(pool);
    const { send } = wire(pool);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => send(modalSubmitPayload(REPORT_TEXT))),
    );

    expect(new Set(responses.map((res) => res.text)).size).toBe(1);
    expect((responses[0]?.body as Reply).type).toBe(5);
    expect(await count(pool, 'interaction')).toBe(1);
    expect(await count(pool, 'action')).toBe(1);
    expect(await count(pool, 'job')).toBe(1);
  });

  it('WHEN /report is disabled between opening the modal and submitting it THE SYSTEM SHALL answer the disabled notice and enqueue nothing', async () => {
    const pool = db();
    await truncateAll(pool);
    const { send } = wire(pool);
    expect(((await send(commandPayload('report')).expect(200)).body as Reply).type).toBe(9);

    await setRule(
      pool,
      'report',
      { version: 1, ephemeral: true, replyMessage: 'x', mirror: true, tag: false },
      false,
    );
    const res = await send(modalSubmitPayload(REPORT_TEXT, SECOND_SUBMIT_ID)).expect(200);

    expect(res.body).toMatchObject({
      type: 4,
      data: { content: MESSAGES.disabled, flags: EPHEMERAL },
    });
    expect(await count(pool, 'job')).toBe(0);
    const rows = await pool.query(
      'SELECT i.type, i.command_name, i.status, a.type AS action FROM interaction i JOIN action a ON a.interaction_id = i.id',
    );
    expect(rows.rows).toEqual([
      { type: 5, command_name: 'report', status: 'answered', action: 'disabled' },
    ]);
  });

  it('WHEN the rule changes visibility between open and submit THE SYSTEM SHALL defer with the rule as it is at submit time', async () => {
    const pool = db();
    await truncateAll(pool);
    const { send } = wire(pool);
    const rule = { version: 1, replyMessage: 'Logged.', mirror: false, tag: false };

    await setRule(pool, 'report', { ...rule, ephemeral: false });
    const publicRes = await send(modalSubmitPayload(REPORT_TEXT, '900000000000000601')).expect(200);
    await setRule(pool, 'report', { ...rule, ephemeral: true });
    const privateRes = await send(modalSubmitPayload(REPORT_TEXT, '900000000000000602')).expect(
      200,
    );

    expect(publicRes.body).toEqual({ type: 5 });
    expect(privateRes.body).toEqual({ type: 5, data: { flags: EPHEMERAL } });
  });
});
