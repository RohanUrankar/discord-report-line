import { beforeEach, describe, expect, it } from 'vitest';

import { truncateAll, useTestDatabase } from '../../../test/helpers/db.js';
import { PgGuildConfigStore } from './pgGuildConfigStore.js';

const db = useTestDatabase();

const GUILD_A = '900000000000000101';
const GUILD_B = '900000000000000102';
const BLOB = Buffer.from('ciphertext-stand-in');
const REPORT_CONFIG = {
  version: 1,
  ephemeral: true,
  replyMessage: 'Hello',
  mirror: true,
  tag: false,
};

let adminA: string;
let adminB: string;
let store: PgGuildConfigStore;

beforeEach(async () => {
  const pool = db();
  await truncateAll(pool);
  store = new PgGuildConfigStore(pool);
  const admins = await pool.query<{ id: string }>(
    `INSERT INTO admin (email, password_hash) VALUES ('a@example.test', 'x'), ('b@example.test', 'x') RETURNING id`,
  );
  adminA = admins.rows[0]?.id ?? '';
  adminB = admins.rows[1]?.id ?? '';
  await pool.query(`INSERT INTO guild (id, name) VALUES ($1, 'A'), ($2, 'B')`, [GUILD_A, GUILD_B]);
  await pool.query(`INSERT INTO admin_guild (admin_id, guild_id) VALUES ($1, $2)`, [
    adminA,
    GUILD_A,
  ]);
  await pool.query(`INSERT INTO admin_guild (admin_id, guild_id) VALUES ($1, $2)`, [
    adminB,
    GUILD_B,
  ]);
});

// The HTTP tests cannot tell whether this SQL checks admin_guild itself, because TenantGuard stops a foreign
// guild first. These call the store directly, as a route that forgot the guard would.
describe('PgGuildConfigStore tenancy (the second lock)', () => {
  it('WHEN admin A reads or updates the settings of B’s server THE SYSTEM SHALL return nothing and change nothing', async () => {
    expect(await store.readSettings(adminA, GUILD_B)).toBeUndefined();

    const updated = await store.updateSettings(adminA, GUILD_B, {
      postChannelId: '900000000000000555',
      mirrorWebhookEnc: BLOB,
    });

    expect(updated).toBeUndefined();
    const row = await db().query(
      'SELECT post_channel_id, mirror_webhook_enc FROM guild WHERE id = $1',
      [GUILD_B],
    );
    expect(row.rows).toEqual([{ post_channel_id: null, mirror_webhook_enc: null }]);
  });

  it('WHEN admin A lists or saves the rules of B’s server THE SYSTEM SHALL return nothing and write nothing', async () => {
    await db().query(
      `INSERT INTO command_rule (guild_id, command_name, config) VALUES ($1, 'report', '{}')`,
      [GUILD_B],
    );

    expect(await store.listRules(adminA, GUILD_B)).toEqual([]);
    expect(await store.saveRule(adminA, GUILD_B, 'report', REPORT_CONFIG, false)).toBe(false);

    const row = await db().query('SELECT config, enabled FROM command_rule WHERE guild_id = $1', [
      GUILD_B,
    ]);
    expect(row.rows).toEqual([{ config: {}, enabled: true }]);
  });

  it('WHEN admin A saves a rule for a server that does not exist THE SYSTEM SHALL create nothing', async () => {
    const saved = await store.saveRule(
      adminA,
      '900000000000000199',
      'status',
      { version: 1 },
      true,
    );

    expect(saved).toBe(false);
    expect((await db().query('SELECT 1 FROM command_rule')).rowCount).toBe(0);
  });
});

describe('PgGuildConfigStore.claimGuild', () => {
  it('WHEN B claims a server A manages THE SYSTEM SHALL return nothing and leave A as the owner', async () => {
    expect(await store.claimGuild(adminB, GUILD_A)).toBeUndefined();

    const owners = await db().query('SELECT admin_id FROM admin_guild WHERE guild_id = $1', [
      GUILD_A,
    ]);
    expect(owners.rows).toEqual([{ admin_id: adminA }]);
  });

  it('WHEN the owner claims their own server again THE SYSTEM SHALL return it without error', async () => {
    expect(await store.claimGuild(adminA, GUILD_A)).toEqual({ id: GUILD_A, name: 'A' });
  });

  it('WHEN the same admin claims the same free server many times at once THE SYSTEM SHALL succeed every time with one link', async () => {
    const pool = db();
    await pool.query(`INSERT INTO guild (id) VALUES ('900000000000000301')`);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.claimGuild(adminA, '900000000000000301')),
    );

    expect(results.every((result) => result?.id === '900000000000000301')).toBe(true);
    const links = await pool.query(
      `SELECT 1 FROM admin_guild WHERE guild_id = '900000000000000301'`,
    );
    expect(links.rowCount).toBe(1);
  });

  it('WHEN the database is asked to link two admins to one server THE SYSTEM SHALL refuse (the constraint, not the code, is the guarantee)', async () => {
    await expect(
      db().query(`INSERT INTO admin_guild (admin_id, guild_id) VALUES ($1, $2)`, [adminB, GUILD_A]),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
