import type pg from 'pg';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { PgLedger } from '../adapters/pg/pgLedger.js';
import { truncateAll, useTestDatabase } from '../../test/helpers/db.js';
import { reportInput } from '../../test/helpers/ledgerInput.js';
import {
  FAKE_INTERACTION_TOKEN,
  GUILD_ID,
  USER_ID,
  buttonPayload,
  commandPayload,
} from '../../test/helpers/payloads.js';
import { NOW_MS, wire, type Reply } from '../../test/helpers/pgApp.js';
import { signRequest, unixSeconds } from '../../test/helpers/signing.js';
import { MESSAGES } from '../domain/messages.js';

// Buttons (DESIGN §5.3, §5.5): real Postgres, the production wiring, signed requests.

const db = useTestDatabase();

const EPHEMERAL = 64;
const REPORT_ID = '900000000000000010';
const OTHER_GUILD = '900000000000000777';
const OTHER_GUILD_REPORT_ID = '900000000000000011';
const SECRET_REPORT_TEXT = 'the CFO is shredding the ledgers';
const USER_B = '900000000000000042';
const ACK = `rpt:ack:${REPORT_ID}`;
const ESC = `rpt:esc:${REPORT_ID}`;

interface UpdateReply {
  type: number;
  data: {
    content: string;
    flags?: number;
    allowed_mentions: { parse: string[] };
    components: { components: { custom_id: string }[] }[];
  };
}

let nextId = 900000000001000000n;
const clickId = (): string => String(nextId++);

const count = async (pool: pg.Pool, where = 'true'): Promise<number> =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM action WHERE ${where}`)).rows[0]
    ?.n ?? -1;
const interactions = async (pool: pg.Pool): Promise<number> =>
  (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM interaction')).rows[0]?.n ?? -1;

/** A processed report, recorded the way the request path does, with a secret report text in its job. */
async function seedReport(pool: pg.Pool, id = REPORT_ID, guildId = GUILD_ID): Promise<void> {
  const input = reportInput({ id, guildId });
  const job = input.job;
  if (job === undefined) {
    throw new Error('fixture has no job');
  }
  await new PgLedger(pool).recordAndEnqueue({
    ...input,
    job: { ...job, payload: { ...job.payload, text: SECRET_REPORT_TEXT, ephemeral: false } },
  });
}

beforeEach(async () => {
  await truncateAll(db());
  await seedReport(db());
});

const buttonsOf = (reply: UpdateReply): string[] =>
  reply.data.components.flatMap((row) => row.components.map((button) => button.custom_id));

describe('button clicks: signature', () => {
  it.each([
    ['a tampered body', (body: string) => body.replace('rpt:ack', 'rpt:esc')],
    ['an unchanged body but a bad signature', (body: string) => body],
  ])(
    'WHEN a click has %s THE SYSTEM SHALL answer 401 with no body and write nothing',
    async (name, mutate) => {
      const { app, keypair } = wire(db());
      const body = JSON.stringify(buttonPayload({ id: clickId(), customId: ACK }));
      const headers = signRequest(keypair, unixSeconds(NOW_MS), body);
      const sent = name === 'a tampered body' ? mutate(body) : body;
      const forged =
        name === 'a tampered body'
          ? headers
          : { ...headers, 'x-signature-ed25519': '00'.repeat(64) };

      const res = await request(app)
        .post('/interactions')
        .set('Content-Type', 'application/json')
        .set({ ...forged })
        .send(sent);

      expect(res.status).toBe(401);
      expect(res.text).toBe('');
      expect(await interactions(db())).toBe(1); // only the seeded report
    },
  );

  it('WHEN a click has no signature headers THE SYSTEM SHALL answer 401', async () => {
    const { app } = wire(db());
    const res = await request(app)
      .post('/interactions')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(buttonPayload({ id: clickId(), customId: ACK })));
    expect(res.status).toBe(401);
  });
});

describe('button clicks: Acknowledge', () => {
  it('WHEN a member clicks Acknowledge THE SYSTEM SHALL update the message (type 7), record the click and its action, and keep report text and token out of the body', async () => {
    const { send, sink } = wire(db());
    const id = clickId();

    const res = await send(buttonPayload({ id, customId: ACK, userId: USER_B })).expect(200);

    const reply = res.body as UpdateReply;
    expect(reply.type).toBe(7);
    expect(reply.data.content).toBe(
      `Report logged. The team has been notified.\n✅ Acknowledged by <@${USER_B}>`,
    );
    expect(reply.data.allowed_mentions).toEqual({ parse: [] });
    expect(reply.data.flags).toBeUndefined();
    expect(buttonsOf(reply)).toEqual([ESC]);
    expect(res.text).not.toContain(SECRET_REPORT_TEXT);
    expect(res.text).not.toContain(FAKE_INTERACTION_TOKEN);

    const click = await db().query(
      'SELECT type, command_name, custom_id, options, status, user_id FROM interaction WHERE id = $1',
      [id],
    );
    expect(click.rows).toEqual([
      {
        type: 3,
        command_name: null,
        custom_id: ACK,
        options: null,
        status: 'answered',
        user_id: USER_B,
      },
    ]);
    const action = await db().query(
      'SELECT type, report_id, mirror_status FROM action WHERE interaction_id = $1',
      [id],
    );
    expect(action.rows).toEqual([
      { type: 'acknowledged', report_id: REPORT_ID, mirror_status: 'skipped' },
    ]);
    expect(await db().query('SELECT 1 FROM job WHERE interaction_id = $1', [id])).toHaveProperty(
      'rowCount',
      0,
    );
    expect(sink.text()).not.toContain(FAKE_INTERACTION_TOKEN);
    expect(sink.text()).not.toContain(SECRET_REPORT_TEXT);
  });

  it('WHEN the same click is delivered twice THE SYSTEM SHALL write one action row and answer both the same way', async () => {
    const { send } = wire(db());
    const id = clickId();

    const first = await send(buttonPayload({ id, customId: ACK })).expect(200);
    const second = await send(buttonPayload({ id, customId: ACK })).expect(200);

    expect(second.text).toBe(first.text);
    expect(await count(db(), "type = 'acknowledged'")).toBe(1);
    expect(await interactions(db())).toBe(2);
  });

  it('WHEN the same click is delivered 10 times concurrently THE SYSTEM SHALL make one state change', async () => {
    const { send } = wire(db());
    const id = clickId();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => send(buttonPayload({ id, customId: ACK }))),
    );

    expect(new Set(responses.map((res) => res.text)).size).toBe(1);
    expect((responses[0]?.body as UpdateReply).type).toBe(7);
    expect(await count(db(), "type = 'acknowledged'")).toBe(1);
    expect(await interactions(db())).toBe(2);
  });

  it('WHEN 10 different users click Acknowledge at once THE SYSTEM SHALL accept exactly one and tell the others it is already acknowledged', async () => {
    const { send } = wire(db());

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        send(
          buttonPayload({
            id: clickId(),
            customId: ACK,
            userId: String(900000000002000000n + BigInt(index)),
          }),
        ),
      ),
    );

    const types = responses.map((res) => (res.body as Reply).type);
    expect(types.filter((type) => type === 7)).toHaveLength(1);
    const stale = responses.filter((res) => (res.body as Reply).type === 4);
    expect(stale).toHaveLength(9);
    for (const res of stale) {
      expect((res.body as Reply).data.flags).toBe(EPHEMERAL);
      expect((res.body as Reply).data.content).toMatch(
        /^This report was already acknowledged by </,
      );
    }
    expect(await count(db(), "type = 'acknowledged'")).toBe(1);
    expect(await interactions(db())).toBe(2); // the report and the one accepted click
  });
});

describe('button clicks: Escalate and state rules', () => {
  it('WHEN a report is acknowledged and then escalated THE SYSTEM SHALL show both, with no buttons left', async () => {
    const { send } = wire(db());
    await send(buttonPayload({ id: clickId(), customId: ACK, userId: USER_ID })).expect(200);

    const res = await send(buttonPayload({ id: clickId(), customId: ESC, userId: USER_B })).expect(
      200,
    );

    const reply = res.body as UpdateReply;
    expect(reply.type).toBe(7);
    expect(reply.data.content).toBe(
      `Report logged. The team has been notified.\n✅ Acknowledged by <@${USER_ID}>\n🚨 Escalated by <@${USER_B}>`,
    );
    expect(reply.data.components).toEqual([]);
  });

  it('WHEN Escalate is clicked on a fresh report THE SYSTEM SHALL escalate it directly, and make no outbound call', async () => {
    const { send } = wire(db());

    const res = await send(buttonPayload({ id: clickId(), customId: ESC })).expect(200);

    const reply = res.body as UpdateReply;
    expect(reply.data.content).toContain('🚨 Escalated by');
    expect(reply.data.components).toEqual([]);
    expect(await count(db(), "type = 'escalated'")).toBe(1);
    const jobs = await db().query('SELECT count(*)::int AS n FROM job');
    expect(jobs.rows).toEqual([{ n: 1 }]); // the report's own; a click never enqueues work
  });

  it('WHEN Acknowledge is clicked on an escalated report THE SYSTEM SHALL answer a clear ephemeral notice and write nothing', async () => {
    const { send } = wire(db());
    await send(buttonPayload({ id: clickId(), customId: ESC, userId: USER_B })).expect(200);
    const before = await interactions(db());

    const res = await send(buttonPayload({ id: clickId(), customId: ACK })).expect(200);

    expect(res.body).toEqual({
      type: 4,
      data: {
        content: `This report was already escalated by <@${USER_B}>.`,
        allowed_mentions: { parse: [] },
        flags: EPHEMERAL,
      },
    });
    expect(await interactions(db())).toBe(before);
    expect(await count(db(), "type = 'acknowledged'")).toBe(0);
  });

  it('WHEN Escalate is clicked twice THE SYSTEM SHALL escalate once', async () => {
    const { send } = wire(db());
    await send(buttonPayload({ id: clickId(), customId: ESC })).expect(200);

    const res = await send(buttonPayload({ id: clickId(), customId: ESC, userId: USER_B })).expect(
      200,
    );

    expect((res.body as Reply).type).toBe(4);
    expect(await count(db(), "type = 'escalated'")).toBe(1);
  });

  it('WHEN Acknowledge and Escalate race THE SYSTEM SHALL end in one consistent state, never acknowledging after escalating', async () => {
    const { send } = wire(db());
    for (let round = 0; round < 8; round += 1) {
      await truncateAll(db());
      await seedReport(db());
      const [ack, esc] = await Promise.all([
        send(buttonPayload({ id: clickId(), customId: ACK })),
        send(buttonPayload({ id: clickId(), customId: ESC, userId: USER_B })),
      ]);

      expect(await count(db(), "type = 'escalated'")).toBe(1);
      expect(await count(db(), "type = 'acknowledged'")).toBeLessThanOrEqual(1);
      expect((esc.body as Reply).type).toBe(7);
      // Either Acknowledge won first (7) or it arrived after Escalate and was refused (4).
      expect([4, 7]).toContain((ack.body as Reply).type);
      const acked = await count(db(), "type = 'acknowledged'");
      expect((ack.body as Reply).type).toBe(acked === 1 ? 7 : 4);
      // The state the next click sees is escalated either way.
      const probe = await send(buttonPayload({ id: clickId(), customId: ESC }));
      expect((probe.body as Reply).data.content).toMatch(/already escalated/);
    }
  });
});

describe('button clicks: custom_id is untrusted', () => {
  const FOREIGN_ID = OTHER_GUILD_REPORT_ID;
  const cases: [string, string][] = [
    ['a wrong prefix', `xxx:ack:${REPORT_ID}`],
    ['an unknown action', `rpt:del:${REPORT_ID}`],
    ['a non-snowflake id', 'rpt:ack:../../etc/passwd'],
    ['a too-short id', 'rpt:ack:12345'],
    ['trailing junk', `${ACK}:extra`],
    ['an over-length custom_id', `rpt:ack:${'9'.repeat(200)}`],
    ['a well-formed id of no report', 'rpt:ack:900000000000999999'],
    ['the id of a report in another server', `rpt:ack:${FOREIGN_ID}`],
  ];

  it.each(cases)(
    'WHEN custom_id is %s THE SYSTEM SHALL answer an ephemeral error and write nothing',
    async (_name, customId) => {
      await seedReport(db(), OTHER_GUILD_REPORT_ID, OTHER_GUILD);
      const { send } = wire(db());
      const before = await interactions(db());

      const res = await send(buttonPayload({ id: clickId(), customId })).expect(200);

      expect(res.body).toMatchObject({ type: 4, data: { flags: EPHEMERAL } });
      expect(await interactions(db())).toBe(before);
      expect(await count(db(), "type IN ('acknowledged', 'escalated')")).toBe(0);
    },
  );

  it('WHEN the id is a real interaction that is not a report (a /status) THE SYSTEM SHALL answer exactly like a missing report', async () => {
    const { send } = wire(db());
    const statusId = '900000000000000050';
    await send({ ...commandPayload('status'), id: statusId }).expect(200);

    const asStatus = await send(
      buttonPayload({ id: clickId(), customId: `rpt:ack:${statusId}` }),
    ).expect(200);
    const asMissing = await send(
      buttonPayload({ id: clickId(), customId: 'rpt:ack:900000000000999998' }),
    ).expect(200);

    expect(asStatus.text).toBe(asMissing.text);
    expect((asStatus.body as Reply).data.content).toBe(MESSAGES.reportNotFound);
  });

  it('WHEN the click comes from another server THE SYSTEM SHALL treat the report as not found even though the id is real', async () => {
    const { send } = wire(db());

    const res = await send(
      buttonPayload({ id: clickId(), customId: ACK, guildId: OTHER_GUILD }),
    ).expect(200);

    expect((res.body as Reply).data.content).toBe(MESSAGES.reportNotFound);
    expect(await count(db(), "type = 'acknowledged'")).toBe(0);
  });
});

describe('button clicks: rules', () => {
  it('WHEN /report is turned off THE SYSTEM SHALL refuse its buttons with the disabled notice and write nothing', async () => {
    await db().query(
      `INSERT INTO command_rule (guild_id, command_name, config, enabled) VALUES ($1, 'report', $2::jsonb, false)`,
      [
        GUILD_ID,
        JSON.stringify({
          version: 1,
          ephemeral: true,
          replyMessage: 'x',
          mirror: true,
          tag: false,
        }),
      ],
    );
    const { send } = wire(db());

    const res = await send(buttonPayload({ id: clickId(), customId: ACK })).expect(200);

    expect(res.body).toMatchObject({
      type: 4,
      data: { content: MESSAGES.disabled, flags: EPHEMERAL },
    });
    expect(await count(db(), "type = 'acknowledged'")).toBe(0);
  });
});
