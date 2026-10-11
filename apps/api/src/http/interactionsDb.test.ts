import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import { truncateAll, useTestDatabase } from '../../test/helpers/db.js';
import {
  FAKE_INTERACTION_TOKEN,
  GUILD_ID,
  INTERACTION_ID,
  commandPayload,
} from '../../test/helpers/payloads.js';
import { NOW_MS, wire, type Reply } from '../../test/helpers/pgApp.js';

// Same wiring as src/index.ts, against real Postgres: no fake ledger, no fake reader.

const SECOND_GUILD = '900000000000000777';

const db = useTestDatabase();

const countRows = async (pool: pg.Pool, table: 'interaction' | 'action' | 'job'): Promise<number> =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ?? -1;

describe('POST /interactions with real Postgres', () => {
  it('WHEN /status runs THE SYSTEM SHALL record it as answered, with its action, before replying', async () => {
    const pool = db();
    await truncateAll(pool);
    const { send } = wire(pool);

    const res = await send(commandPayload('status')).expect(200);

    expect((res.body as Reply).type).toBe(4);
    const interaction = await pool.query(
      'SELECT id, guild_id, command_name, status FROM interaction',
    );
    expect(interaction.rows).toEqual([
      { id: INTERACTION_ID, guild_id: GUILD_ID, command_name: 'status', status: 'answered' },
    ]);
    const action = await pool.query('SELECT type, mirror_status FROM action');
    expect(action.rows).toEqual([{ type: 'status', mirror_status: 'skipped' }]);
    expect(await countRows(pool, 'job')).toBe(0);
  });

  it('WHEN the same /status is delivered 10 times concurrently THE SYSTEM SHALL record it once and answer every delivery normally', async () => {
    const pool = db();
    await truncateAll(pool);
    const { send, sink } = wire(pool);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => send(commandPayload('status'))),
    );

    expect(responses.map((res) => res.status)).toEqual(Array<number>(10).fill(200));
    expect(new Set(responses.map((res) => res.text)).size).toBe(1);
    expect((responses[0]?.body as Reply).data.content).toMatch(/^Reports today: 0/);
    expect(await countRows(pool, 'interaction')).toBe(1);
    expect(await countRows(pool, 'action')).toBe(1);
    expect(sink.messages().filter((msg) => msg === 'interaction.duplicate')).toHaveLength(9);
  });

  it('WHEN two servers have different activity THE SYSTEM SHALL show each its own /status numbers', async () => {
    const pool = db();
    await truncateAll(pool);
    await pool.query('INSERT INTO guild (id) VALUES ($1), ($2)', [GUILD_ID, SECOND_GUILD]);
    // Three of today's reports for the second server, none for the first.
    for (let index = 0; index < 3; index += 1) {
      const id = `90000000000009${String(index).padStart(4, '0')}`;
      await pool.query(
        `INSERT INTO interaction (id, guild_id, channel_id, user_id, type, status, created_at)
         VALUES ($1, $2, 'c', 'u', 2, 'answered', $3)`,
        [id, SECOND_GUILD, new Date(NOW_MS - 3_600_000)],
      );
      await pool.query(
        "INSERT INTO action (interaction_id, guild_id, type, mirror_status) VALUES ($1, $2, 'report', 'sent')",
        [id, SECOND_GUILD],
      );
    }
    const { send } = wire(pool);

    const first = await send(commandPayload('status')).expect(200);
    const second = await send({
      ...commandPayload('status'),
      id: '900000000000000555',
      guild_id: SECOND_GUILD,
    }).expect(200);

    expect((first.body as Reply).data.content).toMatch(/^Reports today: 0 · Retrying: 0/);
    expect((second.body as Reply).data.content).toMatch(/^Reports today: 3 · Retrying: 0/);
  });

  it('SHALL keep the interaction token out of the logs and out of every non-job table', async () => {
    const pool = db();
    await truncateAll(pool);
    const { send, sink } = wire(pool);

    await send(commandPayload('status')).expect(200);
    await send(commandPayload('nonsense')).expect(200);

    expect(sink.text()).not.toContain(FAKE_INTERACTION_TOKEN);
    const leaks = await pool.query(
      `SELECT 1 FROM interaction WHERE interaction::text LIKE $1
       UNION ALL SELECT 1 FROM action WHERE action::text LIKE $1`,
      [`%${FAKE_INTERACTION_TOKEN}%`],
    );
    expect(leaks.rows).toEqual([]);
  });
});
